import { db } from '../db.ts';
import { usdRate } from '../hacienda/fx.ts';
import { accountsByKey, ensureChart, r2, upsertAuto, type EntryInput, type Line } from './ledger.ts';

/**
 * Automatic postings. Every source document produces exactly one active journal entry:
 *   POS sale / refund · manual & Cloudbeds invoices (and their notas de crédito) · supplier invoices accepted in
 *   "Recibidos" · expenses entered by hand · approved payroll periods · payroll payments.
 * Credit invoices open a receivable; supplier invoices open a payable. Re-running is safe (idempotent); when a
 * source changes (rejected by Hacienda, payroll reopened, payment voided) its entry is reversed and re-posted.
 */
export const crDate = (d: any) => new Date(new Date(d).getTime() - 6 * 3600 * 1000).toISOString().slice(0, 10);
const isoDate = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

type K = Awaited<ReturnType<typeof accountsByKey>>;
const acc = (k: K, key: string) => {
  const a = k.byKey[key];
  if (!a) throw new Error(`Falta la cuenta contable "${key}" en el catálogo`);
  return a.id as string;
};

/** POS payment method → account. */
function paymentAccount(k: K, type: string, name: string, currency = 'CRC') {
  const n = String(name || '').toLowerCase();
  if (type === 'cash') return acc(k, 'cash');
  if (type === 'card') return acc(k, 'card_clearing');
  if (type === 'gift_card' || type === 'store_credit') return acc(k, 'gift_cards');
  if (currency === 'USD' && k.byKey.bank_usd) return acc(k, 'bank_usd');
  if (/sinpe|transfer|banco|bank|deposit/.test(n) || type === 'bank' || type === 'upi' || type === 'sinpe') return acc(k, 'bank_crc');
  return acc(k, 'bank_crc');
}

/** Expense category → account: settings map, then an account whose name matches, then "Compras y suministros". */
function expenseAccount(k: K, map: Record<string, string>, category: string | null) {
  const c = String(category || '').trim();
  if (c && map[c] && k.byId[map[c]]) return map[c];
  const low = c.toLowerCase();
  if (low) {
    const hit = k.all.find((a: any) => a.type === 'expense' && a.active && (a.name.toLowerCase().includes(low) || low.includes(a.name.toLowerCase().split(' ')[0])));
    if (hit) return hit.id;
  }
  return acc(k, 'expense_default');
}

// ------------------------------------------------------------------ POS sales
async function postSales(bid: string, k: K, start: string | null) {
  const sales = await db.query(
    `SELECT s.* FROM sales s WHERE s.business_id=$1 AND ($2::date IS NULL OR s.created_at >= $2::date + interval '6 hours')
       AND NOT EXISTS (SELECT 1 FROM acc_entries e WHERE e.business_id=s.business_id AND e.source='sale' AND e.source_id=s.id::text)
     ORDER BY s.created_at LIMIT 3000`, [bid, start]);
  let n = 0;
  for (const s of sales) {
    const pays = await db.query(`SELECT method_name, method_type, amount FROM sale_payments WHERE sale_id=$1`, [s.id]);
    const sign = s.type === 'refund' ? -1 : 1;
    const total = Number(s.total), tax = Number(s.tax_total), svc = Number(s.service_charge), tip = Number(s.tip);
    const lines: Line[] = [];
    const memo = `${s.type === 'refund' ? 'Devolución' : 'Venta'} POS #${s.receipt_no}`;
    // payments are normally stored net of change; only remove change if the stored amounts exceed the total
    const tendered = pays.reduce((a, p) => a + Number(p.amount), 0);
    let change = s.type === 'refund' ? 0 : Math.max(0, Math.min(Number(s.change) || 0, tendered - total));
    let paid = 0;
    for (const p of pays) {
      let amt = Number(p.amount);
      if (p.method_type === 'cash' && change > 0) { const c = Math.min(change, amt); amt -= c; change -= c; }
      paid += amt;
      lines.push({ account_id: paymentAccount(k, p.method_type, p.method_name), debit: sign * amt, description: p.method_name });
    }
    if (Math.abs(paid - total) >= 0.01) lines.push({ account_id: acc(k, 'cash_over_short'), debit: sign * (total - paid), description: 'Diferencia de cobro' });
    lines.push({ account_id: acc(k, 'sales_pos'), credit: sign * (total - tax - svc - tip), description: 'Ventas' });
    if (tax) lines.push({ account_id: acc(k, 'iva_payable'), credit: sign * tax, description: 'IVA' });
    if (svc) lines.push({ account_id: acc(k, 'service_payable'), credit: sign * svc, description: 'Impuesto de servicio 10%' });
    if (tip) lines.push({ account_id: acc(k, 'tips_payable'), credit: sign * tip, description: 'Propina' });
    const cost = Number(s.cost_total) || 0;
    if (cost) {
      lines.push({ account_id: acc(k, 'cogs'), debit: sign * cost, description: 'Costo de ventas' });
      lines.push({ account_id: acc(k, 'inventory'), credit: sign * cost, description: 'Salida de inventario' });
    }
    await upsertAuto(bid, 'sale', s.id, { date: crDate(s.created_at), memo, source: 'sale', source_id: s.id, lines });
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ manual / Cloudbeds invoices
function payloadTotals(p: any) {
  let sub = 0, tax = 0;
  for (const l of p?.lines || []) {
    const s = Math.max(0, Number(l.qty) * Number(l.price) - (Number(l.discount) || 0));
    sub += s;
    tax += (s * (Number(l.tax_rate) || 0)) / 100;
  }
  const svc = Number(p?.service_charge) || 0, tip = Number(p?.tip) || 0;
  return { sub, tax, svc, tip, total: sub + tax + svc + tip };
}

async function upsertItem(bid: string, it: { kind: 'ar' | 'ap'; source: string; source_id: string; partner_name: string; partner_id?: string | null; partner_email?: string | null; number?: string | null; issue_date: string; due_date?: string | null; currency: string; exchange_rate: number; total: number; void?: boolean }) {
  await db.query(
    `INSERT INTO acc_open_items (business_id, kind, source, source_id, partner_name, partner_id, partner_email, number, issue_date, due_date, currency, exchange_rate, total, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (business_id, source, source_id) DO UPDATE SET partner_name=EXCLUDED.partner_name, partner_id=EXCLUDED.partner_id, partner_email=EXCLUDED.partner_email,
       number=EXCLUDED.number, issue_date=EXCLUDED.issue_date, due_date=EXCLUDED.due_date, currency=EXCLUDED.currency, exchange_rate=EXCLUDED.exchange_rate, total=EXCLUDED.total,
       status=CASE WHEN EXCLUDED.status='void' THEN 'void' WHEN acc_open_items.status='void' THEN 'open' ELSE acc_open_items.status END`,
    [bid, it.kind, it.source, it.source_id, it.partner_name, it.partner_id ?? null, it.partner_email ?? null, it.number ?? null, it.issue_date, it.due_date ?? null,
      it.currency, it.exchange_rate, r2(it.total), it.void ? 'void' : 'open'],
  );
  await refreshItem(bid, it.source, it.source_id);
}

/** Recomputes credited (notas de crédito) and status of an open item. */
export async function refreshItem(bid: string, source: string, sourceId: string) {
  const item = await db.one(`SELECT * FROM acc_open_items WHERE business_id=$1 AND source=$2 AND source_id=$3`, [bid, source, sourceId]);
  if (!item) return;
  let credited = 0;
  if (source === 'edoc') {
    const ncs = await db.query(`SELECT payload FROM e_documents WHERE business_id=$1 AND doc_type='03' AND status <> 'rejected' AND reference->>'doc_id'=$2`, [bid, sourceId]);
    credited = ncs.reduce((s, n) => s + payloadTotals(n.payload).total, 0);
  }
  if (source === 'received') {
    const r = await db.one(`SELECT clave FROM received_documents WHERE id=$1`, [sourceId]);
    if (r) {
      const ncs = await db.query(`SELECT total FROM received_documents WHERE business_id=$1 AND doc_type='03' AND decision IN ('05','06') AND xml LIKE $2`, [bid, `%<Numero>${r.clave}</Numero>%`]);
      credited = ncs.reduce((s, n) => s + Number(n.total), 0);
    }
  }
  const open = Number(item.total) - credited - Number(item.paid);
  const status = item.status === 'void' ? 'void' : open <= 0.005 ? 'paid' : 'open';
  await db.query(`UPDATE acc_open_items SET credited=$2, status=$3 WHERE id=$1`, [item.id, r2(credited), status]);
}

async function postDocuments(bid: string, k: K) {
  const docs = await db.query(`SELECT * FROM e_documents WHERE business_id=$1 AND sale_id IS NULL AND payload IS NOT NULL ORDER BY created_at`, [bid]);
  const byId = new Map(docs.map((d) => [d.id, d]));
  let n = 0;
  for (const d of docs) {
    const rate = d.currency === 'USD' ? Number(d.exchange_rate) || 1 : 1;
    const t = payloadTotals(d.payload);
    const credit = ['02', '10'].includes(d.payload?.condition);
    const isNC = d.doc_type === '03';
    const orig = isNC && d.reference?.doc_id ? byId.get(d.reference.doc_id) : null;
    const againstAR = isNC ? !!orig && ['02', '10'].includes(orig.payload?.condition) : credit;
    const sign = isNC ? -1 : 1;
    const date = crDate(d.issued_at);
    const name = d.receptor?.nombre || 'Cliente contado';
    const income = d.source === 'cloudbeds' ? acc(k, 'sales_lodging') : acc(k, 'sales_other');
    const build = (): EntryInput | null => {
      if (d.status === 'rejected') return null;
      const lines: Line[] = [];
      if (againstAR) lines.push({ account_id: acc(k, 'ar'), debit: sign * t.total * rate, partner: name, description: `${d.consecutivo}${d.currency === 'USD' ? ` · US$${r2(t.total)}` : ''}` });
      else {
        const pays = (d.payload?.payments || []).filter((p: any) => Number(p.amount) > 0);
        const sum = pays.reduce((s: number, p: any) => s + Number(p.amount), 0) || 1;
        if (!pays.length) pays.push({ type: 'cash', amount: 1 });
        for (const p of pays) {
          const share = (t.total * Number(p.amount)) / (pays.length === 1 ? Number(p.amount) : sum);
          const account = paymentAccount(k, p.type, p.name || p.type, d.currency);
          const usd = d.currency === 'USD' && k.byId[account]?.currency === 'USD';
          lines.push({ account_id: account, debit: sign * share * rate, amount_fc: usd ? sign * r2(share) : null, partner: name, description: p.name || p.type });
        }
      }
      lines.push({ account_id: income, credit: sign * t.sub * rate, description: d.source === 'cloudbeds' ? 'Hospedaje' : 'Ventas' });
      if (t.tax) lines.push({ account_id: acc(k, 'iva_payable'), credit: sign * t.tax * rate, description: 'IVA' });
      if (t.svc) lines.push({ account_id: acc(k, 'service_payable'), credit: sign * t.svc * rate, description: 'Impuesto de servicio' });
      if (t.tip) lines.push({ account_id: acc(k, 'tips_payable'), credit: sign * t.tip * rate, description: 'Propina' });
      const kind = d.doc_type === '01' ? 'Factura' : d.doc_type === '04' ? 'Tiquete' : 'Nota de crédito';
      return { date, memo: `${kind} ${d.consecutivo} · ${name}${d.external_ref ? ` · Cloudbeds ${d.external_ref}` : ''}`, source: 'edoc', source_id: d.id, lines };
    };
    const r = await upsertAuto(bid, 'edoc', d.id, build);
    if (r !== 'same') n++;
    if (credit && !isNC) {
      const days = Number(d.payload?.credit_days) || 30;
      await upsertItem(bid, {
        kind: 'ar', source: 'edoc', source_id: d.id, partner_name: name, partner_id: d.receptor?.id_number, partner_email: d.receptor?.email, number: d.consecutivo,
        issue_date: date, due_date: new Date(new Date(date + 'T12:00:00Z').getTime() + days * 86400000).toISOString().slice(0, 10),
        currency: d.currency, exchange_rate: rate, total: t.total, void: d.status === 'rejected',
      });
    }
    if (isNC && orig && againstAR) await refreshItem(bid, 'edoc', orig.id);
  }
  return n;
}

// ------------------------------------------------------------------ supplier invoices
async function postReceived(bid: string, k: K, map: Record<string, string>) {
  const docs = await db.query(`SELECT r.*, e.amount AS expense_amount FROM received_documents r LEFT JOIN expenses e ON e.id=r.expense_id WHERE r.business_id=$1 AND r.decision IS NOT NULL ORDER BY r.created_at`, [bid]);
  let n = 0;
  for (const r of docs) {
    const valid = r.decision !== '07' && r.mr_status !== 'rejected';
    const rate = Number(r.exchange_rate) || 1;
    const total = Number(r.total), tax = Number(r.total_tax);
    const sign = r.doc_type === '03' ? -1 : 1;
    const date = crDate(r.issued_at || r.created_at);
    // partial acceptance: only the accepted amount is owed
    const factor = r.decision === '06' && Number(r.expense_amount) > 0 ? Math.min(1, Number(r.expense_amount) / (total * rate)) : 1;
    const creditTax = r.condicion_impuesto !== '04';
    const build = (): EntryInput | null => {
      if (!valid) return null;
      const lines: Line[] = [
        { account_id: expenseAccount(k, map, r.expense_category), debit: sign * (creditTax ? total - tax : total) * rate * factor, description: r.expense_category || 'Compras', partner: r.emisor_name },
        { account_id: acc(k, 'ap'), credit: sign * total * rate * factor, description: r.consecutivo, partner: r.emisor_name },
      ];
      if (creditTax && tax) lines.push({ account_id: acc(k, 'iva_credit'), debit: sign * tax * rate * factor, description: 'IVA soportado' });
      return { date, memo: `${sign < 0 ? 'Nota de crédito' : 'Factura'} proveedor ${r.consecutivo} · ${r.emisor_name}`, source: 'received', source_id: r.id, lines };
    };
    const res = await upsertAuto(bid, 'received', r.id, build);
    if (res !== 'same') n++;
    if (sign > 0) {
      const plazo = Number(/<PlazoCredito>(\d+)<\/PlazoCredito>/.exec(r.xml || '')?.[1] || 0);
      await upsertItem(bid, {
        kind: 'ap', source: 'received', source_id: r.id, partner_name: r.emisor_name || 'Proveedor', partner_id: r.emisor_id, partner_email: r.emisor_email, number: r.consecutivo,
        issue_date: date, due_date: new Date(new Date(date + 'T12:00:00Z').getTime() + plazo * 86400000).toISOString().slice(0, 10),
        currency: r.currency, exchange_rate: rate, total: total * factor, void: !valid,
      });
    } else {
      const m = /<InformacionReferencia>[\s\S]*?<Numero>(\d{50})<\/Numero>/.exec(r.xml || '');
      if (m) {
        const orig = await db.one(`SELECT id FROM received_documents WHERE business_id=$1 AND clave=$2`, [bid, m[1]]);
        if (orig) await refreshItem(bid, 'received', orig.id);
      }
    }
  }
  return n;
}

// ------------------------------------------------------------------ expenses entered by hand / petty cash
async function postExpenses(bid: string, k: K, map: Record<string, string>, paidFrom: string, start: string | null) {
  const rows = await db.query(`SELECT * FROM expenses WHERE business_id=$1 AND received_doc_id IS NULL AND ($2::date IS NULL OR spent_on >= $2::date)`, [bid, start]);
  let n = 0;
  for (const e of rows) {
    const from = e.category === 'Petty cash' ? acc(k, 'cash') : acc(k, k.byKey[paidFrom] ? paidFrom : 'cash');
    const res = await upsertAuto(bid, 'expense', e.id, {
      date: isoDate(e.spent_on), memo: `Gasto: ${e.category}${e.note ? ' · ' + e.note : ''}`, source: 'expense', source_id: e.id,
      lines: [{ account_id: expenseAccount(k, map, e.category), debit: Number(e.amount), description: e.category }, { account_id: from, credit: Number(e.amount), description: e.note }],
    });
    if (res !== 'same') n++;
  }
  // expenses deleted by hand: reverse their entries
  const gone = await db.query(`SELECT source_id FROM acc_entries a WHERE business_id=$1 AND source='expense' AND active AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.id::text=a.source_id)`, [bid]);
  for (const g of gone) await upsertAuto(bid, 'expense', g.source_id, null);
  return n;
}

// ------------------------------------------------------------------ payroll
async function postPayroll(bid: string, k: K, employerRate: number) {
  const exists = await db.one(`SELECT to_regclass('pr_periods') AS t`);
  if (!exists?.t) return 0;
  const periods = await db.query(`SELECT * FROM pr_periods WHERE business_id=$1`, [bid]);
  let usd: number | null = null;
  let n = 0;
  for (const p of periods) {
    const posted = ['approved', 'partially_paid', 'paid', 'closed'].includes(p.status);
    const recs = posted ? await db.query(`SELECT * FROM pr_records WHERE period_id=$1`, [p.id]) : [];
    if (recs.some((r) => r.currency === 'USD') && usd == null) usd = (await usdRate(bid).catch(() => ({ rate: 1 }))).rate;
    const t = { earn: 0, net: 0, caja: 0, vales: 0 };
    for (const r of recs) {
      const f = r.currency === 'USD' ? usd! : 1;
      t.earn += Number(r.earnings) * f; t.net += Number(r.net_payable) * f; t.caja += Number(r.caja) * f; t.vales += Number(r.vales) * f;
    }
    const employer = (t.earn * employerRate) / 100;
    const other = t.earn - t.net - t.caja - t.vales;
    const res = await upsertAuto(bid, 'payroll', p.id, posted && t.earn > 0 ? {
      date: isoDate(p.pay_date || p.end_date), memo: `Planilla ${p.code} · ${p.name}`, source: 'payroll', source_id: p.id,
      lines: [
        { account_id: acc(k, 'payroll'), debit: t.earn, description: 'Salarios devengados' },
        ...(employer ? [{ account_id: acc(k, 'payroll_employer'), debit: employer, description: `Cargas sociales patronales ${employerRate}%` }] : []),
        { account_id: acc(k, 'salaries_payable'), credit: t.net, description: 'Salario neto por pagar' },
        { account_id: acc(k, 'ccss_payable'), credit: t.caja + employer, description: 'CCSS obrero + patronal' },
        ...(t.vales ? [{ account_id: acc(k, 'advances'), credit: t.vales, description: 'Rebajo de vales' }] : []),
        ...(Math.abs(other) >= 0.01 ? [{ account_id: acc(k, 'withholdings'), credit: other, description: 'Otras deducciones' }] : []),
      ],
    } : null);
    if (res !== 'same' && res !== 'none') n++;
  }
  const pays = await db.query(`SELECT p.*, e.full_name FROM pr_payments p LEFT JOIN pr_employees e ON e.id=p.employee_id WHERE p.business_id=$1`, [bid]);
  for (const p of pays) {
    const from = /cash|efectivo/i.test(p.method) ? acc(k, 'cash') : acc(k, 'bank_crc');
    const res = await upsertAuto(bid, 'payroll_payment', p.id, p.voided ? null : {
      date: isoDate(p.payment_date), memo: `Pago de planilla · ${p.full_name || ''}`, source: 'payroll_payment', source_id: p.id,
      lines: [{ account_id: acc(k, 'salaries_payable'), debit: Number(p.amount_crc), partner: p.full_name }, { account_id: from, credit: Number(p.amount_crc), description: p.method, partner: p.full_name }],
    });
    if (res !== 'same' && res !== 'none') n++;
  }
  return n;
}

// ------------------------------------------------------------------ run
const running = new Map<string, Promise<any>>();
const lastRun = new Map<string, number>();

export async function syncAccounting(bid: string) {
  const cur = running.get(bid);
  if (cur) return cur;
  const p = (async () => {
    await ensureChart(bid);
    const st = (await db.one(`SELECT * FROM acc_settings WHERE business_id=$1`, [bid]))!;
    const k = await accountsByKey(db, bid);
    const start = st.start_date ? isoDate(st.start_date) : null;
    const map = st.category_map || {};
    const out = {
      sales: await postSales(bid, k, start),
      documents: await postDocuments(bid, k),
      supplier_invoices: await postReceived(bid, k, map),
      expenses: await postExpenses(bid, k, map, st.expense_paid_from || 'cash', start),
      payroll: await postPayroll(bid, k, Number(st.employer_ccss_rate ?? 26.67)),
    };
    await db.query(`UPDATE acc_settings SET last_sync_at=now() WHERE business_id=$1`, [bid]);
    lastRun.set(bid, Date.now());
    return out;
  })().finally(() => running.delete(bid));
  running.set(bid, p);
  return p;
}

export async function ensureAccountingFresh(bid: string, maxAgeMs = 30000) {
  if (Date.now() - (lastRun.get(bid) || 0) > maxAgeMs) await syncAccounting(bid);
}

export function startAccountingWorker() {
  const all = async () => {
    for (const b of await db.query(`SELECT id FROM businesses WHERE status='active'`)) await syncAccounting(b.id).catch((e) => console.error('[accounting]', e.message || e));
  };
  setTimeout(() => all().catch(console.error), 15000);
  setInterval(() => all().catch(console.error), Number(process.env.ACCOUNTING_POLL_MS || 5 * 60 * 1000));
}
