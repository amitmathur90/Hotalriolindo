import { createHash } from 'node:crypto';
import { db, json, tx } from '../db.ts';
import { bad } from '../util.ts';
import { usdRate } from '../hacienda/fx.ts';
import { accountsByKey, postEntry, r2, reverseEntry, type Line } from './ledger.ts';
import { refreshItem } from './engine.ts';

type User = { id: string | null; name: string | null };
const isoDate = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const addDay = (d: string, n = 1) => new Date(new Date(d + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

// ================================================================== Receivables / payables: payments
/**
 * Customer receipt (kind "receipt") or supplier payment ("payment") applied to open items of the same currency.
 * Dollar items are carried at the invoice's exchange rate; paying at another rate books the difference as
 * diferencial cambiario (gain / loss).
 */
export async function recordPayment(bid: string, b: any, user: User) {
  const kind = b.kind === 'payment' ? 'payment' : 'receipt';
  const date = isoDate(b.date || new Date(Date.now() - 6 * 3600e3));
  const currency = b.currency === 'USD' ? 'USD' : 'CRC';
  const allocs: { item_id: string; amount: number }[] = (b.allocations || []).map((a: any) => ({ item_id: String(a.item_id), amount: r2(Number(a.amount)) })).filter((a: any) => a.amount > 0);
  if (!allocs.length) throw bad('Seleccione las facturas y montos a aplicar');
  const amount = r2(allocs.reduce((s, a) => s + a.amount, 0));
  const rate = currency === 'USD' ? Number(b.exchange_rate) || (await usdRate(bid)).rate : 1;
  return tx(async (q) => {
    const k = await accountsByKey(q, bid);
    const account = k.byId[b.account_id];
    if (!account || !['cash', 'bank'].includes(account.subtype)) throw bad('Seleccione una cuenta de caja o banco');
    const lines: Line[] = [];
    let partner = '';
    let fx = 0;
    for (const a of allocs) {
      const it = await q.one(`SELECT * FROM acc_open_items WHERE id=$1 AND business_id=$2 FOR UPDATE`, [a.item_id, bid]);
      if (!it || it.kind !== (kind === 'receipt' ? 'ar' : 'ap')) throw bad('Factura no encontrada');
      if (it.status !== 'open') throw bad(`La factura ${it.number} no está pendiente`);
      if (it.currency !== currency) throw bad(`La factura ${it.number} está en ${it.currency}: registre el pago en esa moneda`);
      const balance = r2(Number(it.total) - Number(it.credited) - Number(it.paid));
      if (a.amount > balance + 0.005) throw bad(`El monto aplicado a ${it.number} supera su saldo (${balance})`);
      partner = it.partner_name;
      const booked = a.amount * Number(it.exchange_rate);
      fx += a.amount * rate - booked;
      lines.push({ account_id: k.byKey[kind === 'receipt' ? 'ar' : 'ap'].id, [kind === 'receipt' ? 'credit' : 'debit']: booked, partner: it.partner_name, description: it.number } as Line);
      await q.query(`UPDATE acc_open_items SET paid=paid+$2, status=CASE WHEN total-credited-paid-$2 <= 0.005 THEN 'paid' ELSE 'open' END WHERE id=$1`, [it.id, a.amount]);
    }
    const usdAccount = account.currency === 'USD';
    if (usdAccount && currency !== 'USD') throw bad('Use una cuenta en colones para pagos en colones');
    lines.push({ account_id: account.id, [kind === 'receipt' ? 'debit' : 'credit']: amount * rate, amount_fc: usdAccount ? (kind === 'receipt' ? amount : -amount) : null, partner, description: b.reference || null } as Line);
    // receipts: more colones than booked = gain; payments: more colones than booked = loss
    const gain = kind === 'receipt' ? fx : -fx;
    if (Math.abs(gain) >= 0.01) lines.push(gain > 0 ? { account_id: k.byKey.fx_gain.id, credit: gain, description: 'Diferencial cambiario' } : { account_id: k.byKey.fx_loss.id, debit: -gain, description: 'Diferencial cambiario' });
    const p = await q.one(
      `INSERT INTO acc_payments (business_id, kind, payment_date, account_id, currency, exchange_rate, amount, partner_name, reference, memo, allocations, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [bid, kind, date, account.id, currency, rate, amount, partner, b.reference || null, b.memo || null, json(allocs), user.id, user.name],
    );
    await postEntry(q, bid, { date, memo: `${kind === 'receipt' ? 'Cobro a' : 'Pago a'} ${partner}${b.reference ? ' · ' + b.reference : ''}`, source: 'payment', source_id: p!.id, lines, userId: user.id, userName: user.name });
    return p;
  });
}

export async function voidPayment(bid: string, id: string, user: User) {
  return tx(async (q) => {
    const p = await q.one(`SELECT * FROM acc_payments WHERE id=$1 AND business_id=$2 FOR UPDATE`, [id, bid]);
    if (!p) throw bad('Pago no encontrado');
    if (p.voided) throw bad('El pago ya fue anulado');
    for (const a of p.allocations || []) {
      await q.query(`UPDATE acc_open_items SET paid=paid-$2, status=CASE WHEN status='void' THEN 'void' ELSE 'open' END WHERE id=$1`, [a.item_id, a.amount]);
    }
    const e = await q.one(`SELECT id FROM acc_entries WHERE business_id=$1 AND source='payment' AND source_id=$2 AND active`, [bid, id]);
    if (e) await reverseEntry(q, bid, e.id, { date: isoDate(new Date(Date.now() - 6 * 3600e3)), userId: user.id, userName: user.name, memo: `Anulación de ${p.kind === 'receipt' ? 'cobro' : 'pago'} a ${p.partner_name}` });
    await q.query(`UPDATE acc_payments SET voided=true WHERE id=$1`, [id]);
    return { ok: true };
  });
}

/** Manual open item, e.g. balances carried over from QuickBooks / Cubo (posted against "Saldos de apertura"). */
export async function createOpenItem(bid: string, b: any, user: User) {
  const kind = b.kind === 'ap' ? 'ap' : 'ar';
  const total = r2(Number(b.total));
  if (!(total > 0)) throw bad('Monto inválido');
  if (String(b.partner_name || '').trim().length < 2) throw bad('Indique el cliente o proveedor');
  const currency = b.currency === 'USD' ? 'USD' : 'CRC';
  const rate = currency === 'USD' ? Number(b.exchange_rate) || (await usdRate(bid)).rate : 1;
  const date = isoDate(b.issue_date || new Date());
  return tx(async (q) => {
    const k = await accountsByKey(q, bid);
    const id = crypto.randomUUID();
    await q.query(
      `INSERT INTO acc_open_items (id, business_id, kind, source, source_id, partner_name, partner_id, number, issue_date, due_date, currency, exchange_rate, total)
       VALUES ($1,$2,$3,'manual',$1,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, bid, kind, String(b.partner_name).trim(), b.partner_id || null, b.number || null, date, b.due_date || null, currency, rate, total],
    );
    const counter = b.counter_account_id && k.byId[b.counter_account_id] ? b.counter_account_id : k.byKey.opening.id;
    const crc = total * rate;
    await postEntry(q, bid, {
      date, memo: `${kind === 'ar' ? 'Cuenta por cobrar' : 'Cuenta por pagar'} ${b.number || ''} · ${b.partner_name}`, source: 'manual', source_id: id, userId: user.id, userName: user.name,
      lines: kind === 'ar'
        ? [{ account_id: k.byKey.ar.id, debit: crc, partner: b.partner_name }, { account_id: counter, credit: crc }]
        : [{ account_id: counter, debit: crc }, { account_id: k.byKey.ap.id, credit: crc, partner: b.partner_name }],
    });
    return q.one(`SELECT * FROM acc_open_items WHERE id=$1`, [id]);
  });
}
export { refreshItem };

// ================================================================== Banks: statement import & reconciliation
const num = (s: string) => {
  let t = String(s ?? '').trim().replace(/[₡$\s]|CRC|USD/g, '');
  if (!t) return NaN;
  const neg = /^\(.*\)$/.test(t) || t.endsWith('-');
  t = t.replace(/[()]/g, '').replace(/-$/, '');
  // 1.234.567,89 (es) vs 1,234,567.89 (en)
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return neg ? -Math.abs(n) : n;
};
const parseDate = (s: string) => {
  const t = String(s || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(t);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
};
function splitCsv(line: string, sep: string) {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === sep && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/** Parses a bank statement export (CSV / TXT with ; , or tab). Recognises Spanish and English column names. */
export function parseStatement(text: string) {
  const rows = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (rows.length < 2) throw bad('El archivo no tiene movimientos');
  const sep = [';', '\t', ','].map((s) => [s, rows[0].split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const norm = (h: string) => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  let hi = rows.findIndex((r) => /fecha|date/.test(norm(r)));
  if (hi < 0) hi = 0;
  const head = splitCsv(rows[hi], sep).map(norm);
  const find = (...re: RegExp[]) => head.findIndex((h) => re.some((r) => r.test(h)));
  const cDate = find(/^fecha( contable| de (operacion|movimiento|transaccion))?$/, /fecha/, /date/);
  const cDesc = find(/descrip|concepto|detalle|description|memo/);
  const cRef = find(/referencia|^ref|documento|comprobante|reference|numero/);
  const cDebit = find(/debito|cargo|retiro|debit|withdraw/);
  const cCredit = find(/credito|abono|deposito|credit|deposit/);
  const cAmount = find(/^monto|importe|amount|valor/);
  const cBal = find(/saldo|balance/);
  if (cDate < 0 || (cAmount < 0 && cDebit < 0 && cCredit < 0)) throw bad('No se reconocen las columnas: se necesitan "Fecha" y "Monto" (o "Débito" y "Crédito")');
  const out: { date: string; description: string; reference: string; amount: number; balance: number | null }[] = [];
  for (const r of rows.slice(hi + 1)) {
    const c = splitCsv(r, sep);
    const date = parseDate(c[cDate]);
    if (!date) continue;
    let amount = cAmount >= 0 && c[cAmount] ? num(c[cAmount]) : NaN;
    if (Number.isNaN(amount)) {
      const d = cDebit >= 0 ? num(c[cDebit]) : NaN, cr = cCredit >= 0 ? num(c[cCredit]) : NaN;
      amount = (Number.isNaN(cr) ? 0 : Math.abs(cr)) - (Number.isNaN(d) ? 0 : Math.abs(d));
    }
    if (!amount || Number.isNaN(amount)) continue;
    out.push({ date, description: cDesc >= 0 ? c[cDesc] : '', reference: cRef >= 0 ? c[cRef] : '', amount: r2(amount), balance: cBal >= 0 && !Number.isNaN(num(c[cBal])) ? num(c[cBal]) : null });
  }
  if (!out.length) throw bad('No se encontraron movimientos con fecha y monto');
  return out;
}

export async function importStatement(bid: string, accountId: string, text: string) {
  const account = await db.one(`SELECT * FROM acc_accounts WHERE id=$1 AND business_id=$2 AND subtype='bank'`, [accountId, bid]);
  if (!account) throw bad('Cuenta bancaria no encontrada');
  const lines = parseStatement(text);
  const batch = new Date().toISOString();
  const seen = new Map<string, number>();
  let created = 0;
  for (const l of lines) {
    const base = `${l.date}|${l.amount}|${l.description}|${l.reference}`;
    const k = (seen.get(base) || 0) + 1;
    seen.set(base, k);
    const fp = createHash('sha1').update(`${base}|${k}`).digest('hex').slice(0, 24);
    const r = await db.query(
      `INSERT INTO acc_bank_lines (business_id, account_id, line_date, description, reference, amount, balance, fingerprint, batch) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (business_id, account_id, fingerprint) DO NOTHING RETURNING id`,
      [bid, accountId, l.date, l.description.slice(0, 300), l.reference.slice(0, 100), l.amount, l.balance, fp, batch],
    );
    if (r.length) created++;
  }
  const matched = await autoMatch(bid, accountId);
  return { lines: lines.length, created, duplicates: lines.length - created, matched };
}

/** Book amount of a ledger line on a bank account, in the account currency (+ = money in). */
const bookAmount = (l: any, usd: boolean) => (usd ? Number(l.amount_fc) || 0 : r2(Number(l.debit) - Number(l.credit)));

/** Pairs statement lines with ledger lines of the same amount within 5 days (closest date first). */
export async function autoMatch(bid: string, accountId: string) {
  const account = await db.one(`SELECT * FROM acc_accounts WHERE id=$1`, [accountId]);
  const usd = account?.currency === 'USD';
  const bank = await db.query(`SELECT * FROM acc_bank_lines WHERE business_id=$1 AND account_id=$2 AND status='open' ORDER BY line_date`, [bid, accountId]);
  const book = await db.query(
    `SELECT l.*, e.entry_date FROM acc_lines l JOIN acc_entries e ON e.id=l.entry_id WHERE l.business_id=$1 AND l.account_id=$2 AND l.bank_line_id IS NULL`, [bid, accountId]);
  let n = 0;
  for (const b of bank) {
    const bd = new Date(isoDate(b.line_date) + 'T12:00:00Z').getTime();
    const cands = book
      .filter((l) => !l._used && Math.abs(bookAmount(l, usd) - Number(b.amount)) < 0.005)
      .map((l) => ({ l, dist: Math.abs(new Date(isoDate(l.entry_date) + 'T12:00:00Z').getTime() - bd) / 86400000 }))
      .filter((x) => x.dist <= 5)
      .sort((a, c) => a.dist - c.dist);
    if (!cands.length) continue;
    const l = cands[0].l;
    l._used = true;
    await db.query(`UPDATE acc_bank_lines SET status='matched', acc_line_id=$2 WHERE id=$1`, [b.id, l.id]);
    await db.query(`UPDATE acc_lines SET bank_line_id=$2 WHERE id=$1`, [l.id, b.id]);
    n++;
  }
  return n;
}

export async function matchLine(bid: string, lineId: string, accLineId: string) {
  const b = await db.one(`SELECT * FROM acc_bank_lines WHERE id=$1 AND business_id=$2`, [lineId, bid]);
  const l = await db.one(`SELECT * FROM acc_lines WHERE id=$1 AND business_id=$2`, [accLineId, bid]);
  if (!b || !l || l.account_id !== b.account_id) throw bad('Movimiento no encontrado en esta cuenta');
  if (b.status !== 'open' || l.bank_line_id) throw bad('Alguno de los movimientos ya está conciliado');
  await db.query(`UPDATE acc_bank_lines SET status='matched', acc_line_id=$2 WHERE id=$1`, [b.id, l.id]);
  await db.query(`UPDATE acc_lines SET bank_line_id=$2 WHERE id=$1`, [l.id, b.id]);
  return { ok: true };
}
export async function unmatchLine(bid: string, lineId: string) {
  const b = await db.one(`SELECT * FROM acc_bank_lines WHERE id=$1 AND business_id=$2`, [lineId, bid]);
  if (!b) throw bad('Movimiento no encontrado');
  if (b.acc_line_id) await db.query(`UPDATE acc_lines SET bank_line_id=NULL WHERE id=$1`, [b.acc_line_id]);
  await db.query(`UPDATE acc_bank_lines SET status='open', acc_line_id=NULL WHERE id=$1`, [b.id]);
  return { ok: true };
}
export async function ignoreLine(bid: string, lineId: string) {
  await db.query(`UPDATE acc_bank_lines SET status='ignored' WHERE id=$1 AND business_id=$2 AND status='open'`, [lineId, bid]);
  return { ok: true };
}

/** Records a statement line that is not in the books yet (bank fee, interest, transfer…) against another account. */
export async function entryFromLine(bid: string, lineId: string, counterId: string, memo: string, user: User) {
  return tx(async (q) => {
    const b = await q.one(`SELECT * FROM acc_bank_lines WHERE id=$1 AND business_id=$2 FOR UPDATE`, [lineId, bid]);
    if (!b || b.status !== 'open') throw bad('Movimiento no disponible');
    const k = await accountsByKey(q, bid);
    const bankAcc = k.byId[b.account_id];
    if (!k.byId[counterId] || counterId === b.account_id) throw bad('Seleccione la cuenta contrapartida');
    const usd = bankAcc.currency === 'USD';
    const rate = usd ? (await usdRate(bid)).rate : 1;
    const crc = Math.abs(Number(b.amount)) * rate;
    const inflow = Number(b.amount) > 0;
    const e = await postEntry(q, bid, {
      date: isoDate(b.line_date), memo: memo || b.description || 'Movimiento bancario', source: 'bank', source_id: b.id, userId: user.id, userName: user.name,
      lines: [
        { account_id: b.account_id, [inflow ? 'debit' : 'credit']: crc, amount_fc: usd ? Number(b.amount) : null, description: b.description } as Line,
        { account_id: counterId, [inflow ? 'credit' : 'debit']: crc, description: b.description } as Line,
      ],
    });
    const line = await q.one(`SELECT id FROM acc_lines WHERE entry_id=$1 AND account_id=$2`, [e!.id, b.account_id]);
    await q.query(`UPDATE acc_bank_lines SET status='matched', acc_line_id=$2 WHERE id=$1`, [b.id, line!.id]);
    await q.query(`UPDATE acc_lines SET bank_line_id=$2 WHERE id=$1`, [line!.id, b.id]);
    return e;
  });
}

export async function reconciliation(bid: string, accountId: string) {
  const account = await db.one(`SELECT * FROM acc_accounts WHERE id=$1 AND business_id=$2`, [accountId, bid]);
  if (!account) throw bad('Cuenta no encontrada');
  const usd = account.currency === 'USD';
  const bank = await db.query(`SELECT * FROM acc_bank_lines WHERE business_id=$1 AND account_id=$2 ORDER BY line_date DESC, created_at DESC LIMIT 1000`, [bid, accountId]);
  const book = await db.query(
    `SELECT l.id, l.debit, l.credit, l.amount_fc, l.description, l.partner, l.bank_line_id, e.entry_date, e.memo, e.number
       FROM acc_lines l JOIN acc_entries e ON e.id=l.entry_id WHERE l.business_id=$1 AND l.account_id=$2 ORDER BY e.entry_date DESC, e.number DESC LIMIT 1500`, [bid, accountId]);
  const tot = await db.one(`SELECT COALESCE(SUM(debit-credit),0) AS crc, COALESCE(SUM(amount_fc),0) AS fc FROM acc_lines WHERE business_id=$1 AND account_id=$2`, [bid, accountId]);
  const lastBal = bank.find((b) => b.balance != null);
  return {
    account, book_balance: usd ? Number(tot!.fc) : Number(tot!.crc), book_balance_crc: Number(tot!.crc),
    statement_balance: lastBal ? Number(lastBal.balance) : null, statement_date: lastBal ? isoDate(lastBal.line_date) : null,
    bank_lines: bank,
    book_lines: book.map((l) => ({ ...l, amount: bookAmount(l, usd) })),
    unmatched_bank: bank.filter((b) => b.status === 'open').length,
    unmatched_book: book.filter((l) => !l.bank_line_id).length,
  };
}

// ================================================================== Closing
export async function lockPeriod(bid: string, date: string | null) {
  await db.query(`UPDATE acc_settings SET locked_until=$2, updated_at=now() WHERE business_id=$1`, [bid, date || null]);
  return { locked_until: date };
}

/** Year-end close: income and expense balances are moved to retained earnings, then the year is locked. */
export async function closeYear(bid: string, year: number, user: User) {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const done = await db.one(`SELECT id FROM acc_entries WHERE business_id=$1 AND source='closing' AND source_id=$2 AND active`, [bid, String(year)]);
  if (done) throw bad(`El año ${year} ya fue cerrado`);
  const bal = await db.query(
    `SELECT a.id, a.type, SUM(l.debit-l.credit) AS bal FROM acc_lines l JOIN acc_entries e ON e.id=l.entry_id JOIN acc_accounts a ON a.id=l.account_id
      WHERE l.business_id=$1 AND e.entry_date BETWEEN $2 AND $3 AND a.type IN ('income','expense') GROUP BY a.id, a.type`, [bid, from, to]);
  const k = await accountsByKey(db, bid);
  const lines: Line[] = bal.filter((b) => Math.abs(Number(b.bal)) >= 0.005).map((b) => ({ account_id: b.id, credit: Number(b.bal), description: 'Cierre del período' }));
  const result = -bal.reduce((s, b) => s + Number(b.bal), 0);
  if (!lines.length) throw bad('No hay movimientos de resultados en ese año');
  lines.push({ account_id: k.byKey.retained.id, credit: result, description: result >= 0 ? 'Utilidad del período' : 'Pérdida del período' });
  const e = await tx((q) => postEntry(q, bid, { date: to, memo: `Cierre contable ${year}`, source: 'closing', source_id: String(year), lines, userId: user.id, userName: user.name }, { allowLocked: true }));
  const st = await db.one(`SELECT locked_until FROM acc_settings WHERE business_id=$1`, [bid]);
  if (!st?.locked_until || isoDate(st.locked_until) < to) await lockPeriod(bid, to);
  return { entry: e, result: r2(result) };
}

/**
 * Month-end revaluation of dollar balances (bank accounts in USD, receivables and payables in USD) at the given
 * rate, with an automatic reversal the next day (so payments keep their original invoice rate).
 */
export async function revalue(bid: string, date: string, rateIn: number | null, user: User) {
  const rate = Number(rateIn) > 0 ? Number(rateIn) : (await usdRate(bid)).rate;
  const k = await accountsByKey(db, bid);
  const lines: Line[] = [];
  let net = 0;
  const usdBanks = k.all.filter((a: any) => a.currency === 'USD' && a.subtype === 'bank');
  for (const a of usdBanks) {
    const t = await db.one(`SELECT COALESCE(SUM(l.debit-l.credit),0) AS crc, COALESCE(SUM(l.amount_fc),0) AS fc FROM acc_lines l JOIN acc_entries e ON e.id=l.entry_id WHERE l.account_id=$1 AND e.entry_date <= $2`, [a.id, date]);
    const diff = r2(Number(t!.fc) * rate - Number(t!.crc));
    if (Math.abs(diff) >= 0.01) { lines.push({ account_id: a.id, debit: diff, description: `Revaluación US$${r2(Number(t!.fc))} a ₡${rate}` }); net += diff; }
  }
  for (const kind of ['ar', 'ap'] as const) {
    const items = await db.query(`SELECT * FROM acc_open_items WHERE business_id=$1 AND kind=$2 AND currency='USD' AND status='open' AND issue_date <= $3`, [bid, kind, date]);
    const diff = r2(items.reduce((s, i) => s + (Number(i.total) - Number(i.credited) - Number(i.paid)) * (rate - Number(i.exchange_rate)), 0));
    if (Math.abs(diff) >= 0.01) {
      lines.push({ account_id: k.byKey[kind].id, [kind === 'ar' ? 'debit' : 'credit']: diff, description: `Revaluación ${kind === 'ar' ? 'cuentas por cobrar' : 'cuentas por pagar'} US$` } as Line);
      net += kind === 'ar' ? diff : -diff;
    }
  }
  if (!lines.length) return { rate, posted: false, net: 0 };
  lines.push(net >= 0 ? { account_id: k.byKey.fx_gain.id, credit: net, description: 'Diferencial cambiario no realizado' } : { account_id: k.byKey.fx_loss.id, debit: -net, description: 'Diferencial cambiario no realizado' });
  const e = await tx(async (q) => {
    const prev = await q.one(`SELECT id FROM acc_entries WHERE business_id=$1 AND source='reval' AND source_id=$2 AND active`, [bid, date]);
    if (prev) throw bad(`Ya existe una revaluación al ${date}`);
    const entry = await postEntry(q, bid, { date, memo: `Revaluación de saldos en dólares al ${date} (₡${rate})`, source: 'reval', source_id: date, lines, userId: user.id, userName: user.name });
    await reverseEntry(q, bid, entry!.id, { date: addDay(date), memo: `Reversión automática de la revaluación al ${date}`, userId: user.id, userName: user.name });
    return entry;
  });
  return { rate, posted: true, net: r2(net), entry: e };
}
