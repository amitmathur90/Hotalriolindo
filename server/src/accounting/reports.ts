import { db } from '../db.ts';
import { parseComprobante } from '../hacienda/pdf.ts';
import { documentXml } from '../hacienda/service.ts';
import { r2 } from './ledger.ts';

/** Financial statements and tax summaries, all in colones (dollar accounts also show their US$ balance). */
const isoDate = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const TYPE_ORDER = ['asset', 'liability', 'equity', 'income', 'expense'];
const normalSign = (type: string) => (type === 'asset' || type === 'expense' ? 1 : -1); // debit-nature vs credit-nature

async function sums(bid: string, from: string | null, to: string) {
  return db.query(
    `SELECT a.id, a.code, a.name, a.type, a.subtype, a.currency, a.key,
        COALESCE(SUM(CASE WHEN $2::date IS NOT NULL AND e.entry_date < $2::date THEN l.debit - l.credit END),0) AS opening,
        COALESCE(SUM(CASE WHEN ($2::date IS NULL OR e.entry_date >= $2::date) THEN l.debit END),0) AS debit,
        COALESCE(SUM(CASE WHEN ($2::date IS NULL OR e.entry_date >= $2::date) THEN l.credit END),0) AS credit,
        COALESCE(SUM(l.amount_fc),0) AS fc
       FROM acc_accounts a
       LEFT JOIN acc_lines l ON l.account_id=a.id
       LEFT JOIN acc_entries e ON e.id=l.entry_id AND e.entry_date <= $3::date
      WHERE a.business_id=$1 AND (l.id IS NULL OR e.id IS NOT NULL)
      GROUP BY a.id ORDER BY a.code`,
    [bid, from, to],
  );
}

export async function trialBalance(bid: string, from: string, to: string) {
  const rows = (await sums(bid, from, to)).map((r) => {
    const closing = r2(Number(r.opening) + Number(r.debit) - Number(r.credit));
    return { ...r, opening: r2(Number(r.opening)), debit: r2(Number(r.debit)), credit: r2(Number(r.credit)), closing };
  }).filter((r) => r.opening || r.debit || r.credit);
  const tot = rows.reduce((s, r) => ({ debit: s.debit + r.debit, credit: s.credit + r.credit }), { debit: 0, credit: 0 });
  return { from, to, rows, totals: { debit: r2(tot.debit), credit: r2(tot.credit), balanced: Math.abs(tot.debit - tot.credit) < 0.01 } };
}

export async function generalLedger(bid: string, accountId: string, from: string, to: string) {
  const a = await db.one(`SELECT * FROM acc_accounts WHERE id=$1 AND business_id=$2`, [accountId, bid]);
  if (!a) return null;
  const op = await db.one(`SELECT COALESCE(SUM(l.debit-l.credit),0) AS b, COALESCE(SUM(l.amount_fc),0) AS fc FROM acc_lines l JOIN acc_entries e ON e.id=l.entry_id WHERE l.account_id=$1 AND e.entry_date < $2`, [accountId, from]);
  const lines = await db.query(
    `SELECT l.*, e.entry_date, e.number, e.memo, e.source, e.id AS entry_id FROM acc_lines l JOIN acc_entries e ON e.id=l.entry_id
      WHERE l.account_id=$1 AND e.entry_date BETWEEN $2 AND $3 ORDER BY e.entry_date, e.number`, [accountId, from, to]);
  let bal = Number(op!.b), fc = Number(op!.fc);
  return {
    account: a, from, to, opening: r2(bal), opening_fc: r2(fc),
    lines: lines.map((l) => {
      bal += Number(l.debit) - Number(l.credit);
      fc += Number(l.amount_fc) || 0;
      return { ...l, balance: r2(bal), balance_fc: r2(fc) };
    }),
    closing: r2(bal), closing_fc: r2(fc),
  };
}

/** Estado de resultados. With by_month, also one column per month. */
export async function profitAndLoss(bid: string, from: string, to: string, byMonth = false) {
  const rows = await db.query(
    `SELECT a.id, a.code, a.name, a.type, a.subtype, to_char(e.entry_date,'YYYY-MM') AS month, SUM(l.credit-l.debit) AS amount
       FROM acc_lines l JOIN acc_entries e ON e.id=l.entry_id JOIN acc_accounts a ON a.id=l.account_id
      WHERE l.business_id=$1 AND e.entry_date BETWEEN $2 AND $3 AND a.type IN ('income','expense') AND e.source <> 'closing'
      GROUP BY a.id, month ORDER BY a.code`, [bid, from, to]);
  const accounts = new Map<string, any>();
  const months = new Set<string>();
  for (const r of rows) {
    months.add(r.month);
    const x = accounts.get(r.id) || { id: r.id, code: r.code, name: r.name, type: r.type, subtype: r.subtype, total: 0, months: {} as Record<string, number> };
    const v = r.type === 'income' ? Number(r.amount) : -Number(r.amount);
    x.total = r2(x.total + v);
    x.months[r.month] = r2((x.months[r.month] || 0) + v);
    accounts.set(r.id, x);
  }
  const list = [...accounts.values()].filter((a) => Math.abs(a.total) >= 0.005);
  const income = list.filter((a) => a.type === 'income');
  const cogs = list.filter((a) => a.type === 'expense' && a.subtype === 'cogs');
  const expenses = list.filter((a) => a.type === 'expense' && a.subtype !== 'cogs');
  const sum = (l: any[]) => r2(l.reduce((s, a) => s + a.total, 0));
  const mSum = (l: any[], m: string) => r2(l.reduce((s, a) => s + (a.months[m] || 0), 0));
  const ms = [...months].sort();
  const t = { income: sum(income), cogs: sum(cogs), expenses: sum(expenses) };
  return {
    from, to, income, cogs, expenses,
    totals: { ...t, gross_profit: r2(t.income - t.cogs), net: r2(t.income - t.cogs - t.expenses) },
    months: byMonth ? ms.map((m) => ({ month: m, income: mSum(income, m), cogs: mSum(cogs, m), expenses: mSum(expenses, m), net: r2(mSum(income, m) - mSum(cogs, m) - mSum(expenses, m)) })) : undefined,
  };
}

/** Balance general at a date; the result of the open (not yet closed) years is shown inside equity. */
export async function balanceSheet(bid: string, asOf: string) {
  const rows = await sums(bid, null, asOf);
  const val = (r: any) => r2((Number(r.debit) - Number(r.credit)) * normalSign(r.type));
  const pick = (type: string) => rows.filter((r) => r.type === type).map((r) => ({ id: r.id, code: r.code, name: r.name, subtype: r.subtype, currency: r.currency, balance: val(r), balance_fc: r.currency === 'USD' ? r2(Number(r.fc)) : null })).filter((r) => Math.abs(r.balance) >= 0.005 || (r.balance_fc && Math.abs(r.balance_fc) >= 0.005));
  const assets = pick('asset'), liabilities = pick('liability'), equity = pick('equity');
  const result = r2(rows.filter((r) => r.type === 'income' || r.type === 'expense').reduce((s, r) => s + (Number(r.credit) - Number(r.debit)), 0));
  const sum = (l: any[]) => r2(l.reduce((s, a) => s + a.balance, 0));
  const t = { assets: sum(assets), liabilities: sum(liabilities), equity: r2(sum(equity) + result) };
  return { as_of: asOf, assets, liabilities, equity, current_result: result, totals: { ...t, liabilities_equity: r2(t.liabilities + t.equity), balanced: Math.abs(t.assets - t.liabilities - t.equity) < 0.01 } };
}

/** Flujo de efectivo (método directo): movements of cash and bank accounts classified by what they paid / collected. */
export async function cashFlow(bid: string, from: string, to: string) {
  const lines = await db.query(
    `SELECT e.id AS entry_id, e.source, a.id AS account_id, a.subtype, a.type, a.cash_flow, a.key, (l.debit - l.credit) AS amount
       FROM acc_lines l JOIN acc_entries e ON e.id=l.entry_id JOIN acc_accounts a ON a.id=l.account_id
      WHERE l.business_id=$1 AND e.entry_date BETWEEN $2 AND $3`, [bid, from, to]);
  const byEntry = new Map<string, any[]>();
  for (const l of lines) (byEntry.get(l.entry_id) || byEntry.set(l.entry_id, []).get(l.entry_id)!).push(l);
  const groups: Record<string, Record<string, number>> = { operating: {}, investing: {}, financing: {} };
  const add = (sec: string, label: string, v: number) => { groups[sec][label] = r2((groups[sec][label] || 0) + v); };
  for (const ls of byEntry.values()) {
    const cash = ls.filter((l) => l.subtype === 'cash' || l.subtype === 'bank');
    const net = cash.reduce((s, l) => s + Number(l.amount), 0);
    if (Math.abs(net) < 0.005) continue; // e.g. transfers between banks
    const other = ls.filter((l) => !(l.subtype === 'cash' || l.subtype === 'bank')).sort((a, b) => Math.abs(Number(b.amount)) - Math.abs(Number(a.amount)))[0];
    const src = ls[0].source;
    const sec = other?.cash_flow === 'investing' ? 'investing' : other?.cash_flow === 'financing' ? 'financing' : 'operating';
    const label = sec !== 'operating' ? (net > 0 ? 'Entradas' : 'Salidas')
      : src === 'sale' || src === 'edoc' || (src === 'payment' && net > 0) ? 'Cobros a clientes'
      : src === 'payroll_payment' ? 'Pagos de planilla'
      : src === 'received' || src === 'expense' || src === 'payment' ? 'Pagos a proveedores y gastos'
      : other?.key === 'iva_payable' || other?.key === 'ccss_payable' ? 'Pagos de impuestos y cargas sociales'
      : net > 0 ? 'Otros cobros' : 'Otros pagos';
    add(sec, label, net);
  }
  const opening = await db.one(
    `SELECT COALESCE(SUM(l.debit-l.credit),0) AS b FROM acc_lines l JOIN acc_entries e ON e.id=l.entry_id JOIN acc_accounts a ON a.id=l.account_id
      WHERE l.business_id=$1 AND e.entry_date < $2 AND a.subtype IN ('cash','bank')`, [bid, from]);
  const total = (g: Record<string, number>) => r2(Object.values(g).reduce((s, v) => s + v, 0));
  const sections = Object.entries(groups).map(([k, g]) => ({ section: k, lines: Object.entries(g).map(([label, amount]) => ({ label, amount })), total: total(g) }));
  const change = r2(sections.reduce((s, x) => s + x.total, 0));
  return { from, to, sections, opening: r2(Number(opening!.b)), change, closing: r2(Number(opening!.b) + change) };
}

/** Antigüedad de saldos (receivables or payables) at a date. */
export async function ageing(bid: string, kind: 'ar' | 'ap', asOf: string) {
  const items = await db.query(`SELECT * FROM acc_open_items WHERE business_id=$1 AND kind=$2 AND status='open' AND issue_date <= $3 ORDER BY due_date NULLS LAST, issue_date`, [bid, kind, asOf]);
  const at = new Date(asOf + 'T12:00:00Z').getTime();
  const B = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90'] as const;
  const totals: Record<string, Record<string, number>> = {};
  const rows = items.map((i) => {
    const balance = r2(Number(i.total) - Number(i.credited) - Number(i.paid));
    const due = i.due_date ? new Date(isoDate(i.due_date) + 'T12:00:00Z').getTime() : at;
    const days = Math.floor((at - due) / 86400000);
    const bucket = days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90';
    const t = (totals[i.currency] ||= Object.fromEntries([...B, 'total'].map((b) => [b, 0])));
    t[bucket] = r2(t[bucket] + balance);
    t.total = r2(t.total + balance);
    return { ...i, balance, days_overdue: Math.max(0, days), bucket, balance_crc: r2(balance * Number(i.exchange_rate)) };
  });
  return { kind, as_of: asOf, rows, totals };
}

/**
 * Resumen para la declaración del IVA (D-104) de un mes: ventas por tarifa (from our electronic documents) and IVA
 * acreditable (from supplier documents accepted with tax credit). Amounts in colones.
 */
export async function ivaSummary(bid: string, month: string) {
  const from = new Date(`${month}-01T06:00:00Z`);
  const to = new Date(from);
  to.setUTCMonth(to.getUTCMonth() + 1);
  // a tiquete replaced by a factura is offset by its nota de crédito, so every non-rejected document counts
  const docs = await db.query(`SELECT * FROM e_documents WHERE business_id=$1 AND issued_at >= $2 AND issued_at < $3 AND status <> 'rejected'`, [bid, from, to]);
  const sales: Record<string, { rate: number; base: number; iva: number; docs: number }> = {};
  let exempt = 0, otros = 0, count = 0, unread = 0;
  for (const d of docs) {
    let p;
    try { p = parseComprobante(await documentXml(d)); } catch { unread++; continue; }
    const sign = d.doc_type === '03' ? -1 : 1;
    const fx = p.tipoCambio || 1;
    count++;
    for (const l of p.lines) {
      if (l.tarifa > 0) {
        const k = String(l.tarifa);
        const s = (sales[k] ||= { rate: l.tarifa, base: 0, iva: 0, docs: 0 });
        s.base += sign * l.subTotal * fx;
        s.iva += sign * l.impuesto * fx;
      } else exempt += sign * l.subTotal * fx;
    }
    otros += sign * p.resumen.otros * fx;
  }
  const rec = await db.query(`SELECT * FROM received_documents WHERE business_id=$1 AND decision IN ('05','06') AND coalesce(mr_status,'') <> 'rejected' AND issued_at >= $2 AND issued_at < $3`, [bid, from, to]);
  const purchases: Record<string, { rate: number; base: number; iva: number; credit: number }> = {};
  for (const r of rec) {
    let p;
    try { p = parseComprobante(r.xml); } catch { continue; }
    const sign = r.doc_type === '03' ? -1 : 1;
    const fx = p.tipoCambio || 1;
    const creditable = r.condicion_impuesto !== '04';
    for (const l of p.lines) {
      const k = String(l.tarifa);
      const s = (purchases[k] ||= { rate: l.tarifa, base: 0, iva: 0, credit: 0 });
      s.base += sign * l.subTotal * fx;
      s.iva += sign * l.impuesto * fx;
      if (creditable) s.credit += sign * l.impuesto * fx;
    }
  }
  const round = (o: Record<string, any>) => Object.values(o).map((x: any) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'number' && k !== 'rate' ? r2(v) : v]))).sort((a: any, b: any) => b.rate - a.rate);
  const debit = r2(Object.values(sales).reduce((s, x) => s + x.iva, 0));
  const credit = r2(Object.values(purchases).reduce((s, x) => s + x.credit, 0));
  return {
    month, documents: count, unreadable: unread, sales: round(sales), exempt_sales: r2(exempt), other_charges: r2(otros),
    purchases: round(purchases), supplier_documents: rec.length,
    iva_debit: debit, iva_credit: credit, iva_payable: r2(debit - credit),
  };
}

export const ACCOUNT_TYPES = TYPE_ORDER;
