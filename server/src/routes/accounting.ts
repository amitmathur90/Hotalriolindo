import { Router } from 'express';
import { db, json, tx } from '../db.ts';
import { requirePerm } from '../auth.ts';
import { ah, audit, bad, notFound } from '../util.ts';
import { accountsByKey, ensureChart, postEntry, reverseEntry, r2 } from '../accounting/ledger.ts';
import { ensureAccountingFresh, syncAccounting } from '../accounting/engine.ts';
import { ageing, balanceSheet, cashFlow, generalLedger, ivaSummary, profitAndLoss, trialBalance } from '../accounting/reports.ts';
import {
  autoMatch, closeYear, createOpenItem, entryFromLine, ignoreLine, importStatement, lockPeriod, matchLine, reconciliation, recordPayment, revalue, unmatchLine, voidPayment,
} from '../accounting/ops.ts';

/** Contabilidad: chart of accounts, journal, receivables/payables, banks, statements and closing. */
const r = Router();
const VIEW = requirePerm('accounting.view', 'accounting.manage');
const MANAGE = requirePerm('accounting.manage');
const user = (req: any) => ({ id: req.auth.userId ?? null, name: req.auth.userName ?? null });
const today = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
const D = (v: any, def: string) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : def);
const yearStart = () => today().slice(0, 4) + '-01-01';

// Every request: make sure the chart exists and the automatic postings are recent
r.use(VIEW, ah(async (req, _res, next) => {
  await ensureChart(req.auth.businessId);
  if (req.method === 'GET') await ensureAccountingFresh(req.auth.businessId);
  next();
}));

// ---------------------------------------------------------------- settings & chart
r.get('/settings', ah(async (req, res) => {
  const s = await db.one(`SELECT * FROM acc_settings WHERE business_id=$1`, [req.auth.businessId]);
  const cats = await db.query(`SELECT DISTINCT category FROM expenses WHERE business_id=$1 ORDER BY 1`, [req.auth.businessId]);
  res.json({ ...s, expense_categories: cats.map((c) => c.category) });
}));
r.put('/settings', MANAGE, ah(async (req, res) => {
  const b = req.body || {};
  const bid = req.auth.businessId;
  const f: Record<string, any> = {};
  if ('start_date' in b) f.start_date = b.start_date || null;
  if ('employer_ccss_rate' in b) f.employer_ccss_rate = Math.max(0, Number(b.employer_ccss_rate) || 0);
  if ('expense_paid_from' in b) f.expense_paid_from = ['cash', 'petty_cash', 'bank_crc'].includes(b.expense_paid_from) ? b.expense_paid_from : 'cash';
  if (b.category_map && typeof b.category_map === 'object') f.category_map = json(b.category_map);
  const k = Object.keys(f);
  if (k.length) await db.query(`UPDATE acc_settings SET ${k.map((x, i) => `${x}=$${i + 2}`).join(', ')}, updated_at=now() WHERE business_id=$1`, [bid, ...k.map((x) => f[x])]);
  await audit(req, 'accounting_settings', 'acc_settings', bid, b);
  res.json(await db.one(`SELECT * FROM acc_settings WHERE business_id=$1`, [bid]));
}));

r.get('/accounts', ah(async (req, res) => {
  res.json(await db.query(
    `SELECT a.*, COALESCE(SUM(l.debit-l.credit),0) AS balance, COALESCE(SUM(l.amount_fc),0) AS balance_fc, count(l.id)::int AS lines
       FROM acc_accounts a LEFT JOIN acc_lines l ON l.account_id=a.id WHERE a.business_id=$1 GROUP BY a.id ORDER BY a.code`, [req.auth.businessId]));
}));
const TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];
const SUBTYPES = ['cash', 'bank', 'receivable', 'payable', 'inventory', 'fixed', 'tax', 'cogs', 'other', ''];
function accountFields(b: any) {
  const f: Record<string, any> = {};
  if ('code' in b) { if (!/^[\w.-]{1,20}$/.test(String(b.code || ''))) throw bad('Código inválido'); f.code = String(b.code); }
  if ('name' in b) { if (String(b.name || '').trim().length < 2) throw bad('Nombre requerido'); f.name = String(b.name).trim().slice(0, 120); }
  if ('type' in b) { if (!TYPES.includes(b.type)) throw bad('Tipo inválido'); f.type = b.type; }
  if ('subtype' in b) { if (!SUBTYPES.includes(b.subtype || '')) throw bad('Subtipo inválido'); f.subtype = b.subtype || null; }
  if ('currency' in b) f.currency = b.currency === 'USD' ? 'USD' : 'CRC';
  if ('cash_flow' in b) f.cash_flow = ['operating', 'investing', 'financing'].includes(b.cash_flow) ? b.cash_flow : 'operating';
  for (const k of ['bank_name', 'bank_account']) if (k in b) f[k] = b[k] ? String(b[k]).slice(0, 80) : null;
  if ('active' in b) f.active = !!b.active;
  return f;
}
r.post('/accounts', MANAGE, ah(async (req, res) => {
  const f = accountFields(req.body || {});
  if (!f.code || !f.name || !f.type) throw bad('Código, nombre y tipo requeridos');
  const k = Object.keys(f);
  const a = await db.one(`INSERT INTO acc_accounts (business_id, ${k.join(', ')}) VALUES ($1, ${k.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`, [req.auth.businessId, ...k.map((x) => f[x])]);
  await audit(req, 'accounting_account_create', 'acc_accounts', a!.id, f);
  res.status(201).json(a);
}));
r.put('/accounts/:id', MANAGE, ah(async (req, res) => {
  const cur = await db.one(`SELECT * FROM acc_accounts WHERE id=$1 AND business_id=$2`, [req.params.id, req.auth.businessId]);
  if (!cur) throw notFound('Cuenta');
  const f = accountFields(req.body || {});
  const used = await db.one(`SELECT count(*)::int AS n FROM acc_lines WHERE account_id=$1`, [cur.id]);
  if (Number(used?.n) && (('type' in f && f.type !== cur.type) || ('currency' in f && f.currency !== cur.currency))) throw bad('La cuenta tiene movimientos: no se puede cambiar su tipo ni su moneda');
  if (cur.key && f.active === false) throw bad('Esta cuenta la usa la contabilidad automática: no se puede desactivar');
  const k = Object.keys(f);
  if (k.length) await db.query(`UPDATE acc_accounts SET ${k.map((x, i) => `${x}=$${i + 2}`).join(', ')} WHERE id=$1`, [cur.id, ...k.map((x) => f[x])]);
  await audit(req, 'accounting_account_update', 'acc_accounts', cur.id, f);
  res.json(await db.one(`SELECT * FROM acc_accounts WHERE id=$1`, [cur.id]));
}));

r.post('/sync', MANAGE, ah(async (req, res) => res.json(await syncAccounting(req.auth.businessId))));

// ---------------------------------------------------------------- journal
r.get('/entries', ah(async (req, res) => {
  const bid = req.auth.businessId;
  const params: any[] = [bid, D(req.query.from, yearStart()), D(req.query.to, today())];
  let where = 'e.business_id=$1 AND e.entry_date BETWEEN $2 AND $3';
  if (req.query.source) where += ` AND e.source=$${params.push(req.query.source)}`;
  if (req.query.account_id) where += ` AND EXISTS (SELECT 1 FROM acc_lines x WHERE x.entry_id=e.id AND x.account_id=$${params.push(req.query.account_id)})`;
  if (req.query.q) {
    const i = params.push(`%${req.query.q}%`);
    where += ` AND (e.memo ILIKE $${i} OR e.number::text=$${params.push(String(req.query.q).replace('#', ''))} OR EXISTS (SELECT 1 FROM acc_lines x WHERE x.entry_id=e.id AND (x.partner ILIKE $${i} OR x.description ILIKE $${i})))`;
  }
  const entries = await db.query(`SELECT e.* FROM acc_entries e WHERE ${where} ORDER BY e.entry_date DESC, e.number DESC LIMIT 500`, params);
  const lines = entries.length ? await db.query(
    `SELECT l.*, a.code, a.name AS account_name FROM acc_lines l JOIN acc_accounts a ON a.id=l.account_id WHERE l.entry_id = ANY($1::uuid[]) ORDER BY l.debit DESC`, [entries.map((e) => e.id)]) : [];
  res.json(entries.map((e) => ({ ...e, lines: lines.filter((l) => l.entry_id === e.id), total: r2(lines.filter((l) => l.entry_id === e.id).reduce((s, l) => s + Number(l.debit), 0)) })));
}));

r.post('/entries', MANAGE, ah(async (req, res) => {
  const b = req.body || {};
  const bid = req.auth.businessId;
  const lines = (Array.isArray(b.lines) ? b.lines : []).map((l: any) => ({ account_id: String(l.account_id || ''), debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, amount_fc: l.amount_fc != null && l.amount_fc !== '' ? Number(l.amount_fc) : null, description: l.description || null, partner: l.partner || null }));
  if (lines.length < 2) throw bad('El asiento necesita al menos dos líneas');
  const k = await accountsByKey(db, bid);
  for (const l of lines) if (!k.byId[l.account_id]) throw bad('Cuenta inválida en una línea');
  const dr = r2(lines.reduce((s: number, l: any) => s + l.debit, 0)), cr = r2(lines.reduce((s: number, l: any) => s + l.credit, 0));
  if (Math.abs(dr - cr) >= 0.01) throw bad(`El asiento no cuadra: débitos ₡${dr} ≠ créditos ₡${cr}`);
  if (!(dr > 0)) throw bad('Montos requeridos');
  if (String(b.memo || '').trim().length < 3) throw bad('Escriba la descripción del asiento');
  const e = await tx((q) => postEntry(q, bid, { date: D(b.date, today()), memo: String(b.memo).trim(), source: b.opening ? 'opening' : 'manual', lines, userId: req.auth.userId, userName: req.auth.userName }));
  await audit(req, 'accounting_entry', 'acc_entries', e!.id, { number: e!.number, total: dr });
  res.status(201).json(e);
}));

r.post('/entries/:id/reverse', MANAGE, ah(async (req, res) => {
  const e = await db.one(`SELECT * FROM acc_entries WHERE id=$1 AND business_id=$2`, [req.params.id, req.auth.businessId]);
  if (!e) throw notFound('Asiento');
  if (!['manual', 'opening', 'bank'].includes(e.source)) throw bad('Los asientos automáticos se corrigen en su documento de origen (venta, factura, planilla…)');
  const rev = await tx((q) => reverseEntry(q, req.auth.businessId, e.id, { date: D(req.body?.date, today()), userId: req.auth.userId, userName: req.auth.userName }));
  if (e.source === 'bank') await db.query(`UPDATE acc_bank_lines SET status='open', acc_line_id=NULL WHERE business_id=$1 AND acc_line_id IN (SELECT id FROM acc_lines WHERE entry_id=$2)`, [req.auth.businessId, e.id]);
  await audit(req, 'accounting_entry_reverse', 'acc_entries', e.id, { number: e.number });
  res.json(rev);
}));

// ---------------------------------------------------------------- reports
r.get('/reports/trial-balance', ah(async (req, res) => res.json(await trialBalance(req.auth.businessId, D(req.query.from, yearStart()), D(req.query.to, today())))));
r.get('/reports/ledger', ah(async (req, res) => {
  const g = await generalLedger(req.auth.businessId, String(req.query.account_id || ''), D(req.query.from, yearStart()), D(req.query.to, today()));
  if (!g) throw notFound('Cuenta');
  res.json(g);
}));
r.get('/reports/pnl', ah(async (req, res) => res.json(await profitAndLoss(req.auth.businessId, D(req.query.from, yearStart()), D(req.query.to, today()), req.query.by_month === '1'))));
r.get('/reports/balance-sheet', ah(async (req, res) => res.json(await balanceSheet(req.auth.businessId, D(req.query.as_of, today())))));
r.get('/reports/cash-flow', ah(async (req, res) => res.json(await cashFlow(req.auth.businessId, D(req.query.from, yearStart()), D(req.query.to, today())))));
r.get('/reports/ageing', ah(async (req, res) => res.json(await ageing(req.auth.businessId, req.query.kind === 'ap' ? 'ap' : 'ar', D(req.query.as_of, today())))));
r.get('/reports/iva', ah(async (req, res) => {
  const m = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : today().slice(0, 7);
  res.json(await ivaSummary(req.auth.businessId, m));
}));

// ---------------------------------------------------------------- receivables / payables
r.get('/open-items', ah(async (req, res) => {
  const params: any[] = [req.auth.businessId, req.query.kind === 'ap' ? 'ap' : 'ar'];
  let where = 'business_id=$1 AND kind=$2';
  if (req.query.status) where += ` AND status=$${params.push(req.query.status)}`;
  if (req.query.q) { const i = params.push(`%${req.query.q}%`); where += ` AND (partner_name ILIKE $${i} OR number ILIKE $${i} OR partner_id ILIKE $${i})`; }
  const rows = await db.query(`SELECT *, (total-credited-paid) AS balance FROM acc_open_items WHERE ${where} ORDER BY status='open' DESC, due_date NULLS LAST, issue_date DESC LIMIT 1000`, params);
  res.json(rows);
}));
r.post('/open-items', MANAGE, ah(async (req, res) => {
  const it = await createOpenItem(req.auth.businessId, req.body || {}, user(req));
  await audit(req, 'accounting_open_item', 'acc_open_items', it!.id, req.body);
  res.status(201).json(it);
}));
r.get('/payments', ah(async (req, res) => {
  res.json(await db.query(
    `SELECT p.*, a.name AS account_name FROM acc_payments p JOIN acc_accounts a ON a.id=p.account_id WHERE p.business_id=$1 AND ($2::text IS NULL OR p.kind=$2) ORDER BY p.payment_date DESC, p.created_at DESC LIMIT 500`,
    [req.auth.businessId, req.query.kind || null]));
}));
r.post('/payments', MANAGE, ah(async (req, res) => {
  const p = await recordPayment(req.auth.businessId, req.body || {}, user(req));
  await audit(req, 'accounting_payment', 'acc_payments', p!.id, { kind: p!.kind, amount: p!.amount, currency: p!.currency });
  res.status(201).json(p);
}));
r.post('/payments/:id/void', MANAGE, ah(async (req, res) => {
  const out = await voidPayment(req.auth.businessId, req.params.id, user(req));
  await audit(req, 'accounting_payment_void', 'acc_payments', req.params.id, {});
  res.json(out);
}));

// ---------------------------------------------------------------- banks
r.get('/banks', ah(async (req, res) => {
  res.json(await db.query(
    `SELECT a.*, COALESCE((SELECT SUM(debit-credit) FROM acc_lines WHERE account_id=a.id),0) AS balance, COALESCE((SELECT SUM(amount_fc) FROM acc_lines WHERE account_id=a.id),0) AS balance_fc,
       (SELECT count(*)::int FROM acc_bank_lines b WHERE b.account_id=a.id AND b.status='open') AS unmatched
       FROM acc_accounts a WHERE a.business_id=$1 AND a.subtype='bank' AND a.active ORDER BY a.code`, [req.auth.businessId]));
}));
r.post('/banks/:id/import', MANAGE, ah(async (req, res) => {
  const text = String(req.body?.content || '');
  if (!text) throw bad('Seleccione el archivo del estado de cuenta (CSV)');
  const out = await importStatement(req.auth.businessId, req.params.id, text);
  await audit(req, 'accounting_bank_import', 'acc_accounts', req.params.id, out);
  res.json(out);
}));
r.get('/banks/:id/reconciliation', ah(async (req, res) => res.json(await reconciliation(req.auth.businessId, req.params.id))));
r.post('/banks/:id/auto-match', MANAGE, ah(async (req, res) => res.json({ matched: await autoMatch(req.auth.businessId, req.params.id) })));
r.post('/bank-lines/:id/match', MANAGE, ah(async (req, res) => res.json(await matchLine(req.auth.businessId, req.params.id, String(req.body?.acc_line_id || '')))));
r.post('/bank-lines/:id/unmatch', MANAGE, ah(async (req, res) => res.json(await unmatchLine(req.auth.businessId, req.params.id))));
r.post('/bank-lines/:id/ignore', MANAGE, ah(async (req, res) => res.json(await ignoreLine(req.auth.businessId, req.params.id))));
r.post('/bank-lines/:id/entry', MANAGE, ah(async (req, res) => {
  const e = await entryFromLine(req.auth.businessId, req.params.id, String(req.body?.account_id || ''), String(req.body?.memo || ''), user(req));
  res.status(201).json(e);
}));

// ---------------------------------------------------------------- closing
r.post('/close/lock', MANAGE, ah(async (req, res) => {
  const date = req.body?.date ? D(req.body.date, '') : null;
  if (req.body?.date && !date) throw bad('Fecha inválida');
  const out = await lockPeriod(req.auth.businessId, date);
  await audit(req, 'accounting_lock', 'acc_settings', req.auth.businessId, out);
  res.json(out);
}));
r.post('/close/year', MANAGE, ah(async (req, res) => {
  const year = Number(req.body?.year);
  if (!(year > 2000 && year < 2100)) throw bad('Año inválido');
  await syncAccounting(req.auth.businessId);
  const out = await closeYear(req.auth.businessId, year, user(req));
  await audit(req, 'accounting_close_year', 'acc_entries', out.entry?.id, { year, result: out.result });
  res.json(out);
}));
r.post('/close/revalue', MANAGE, ah(async (req, res) => {
  const out = await revalue(req.auth.businessId, D(req.body?.date, today()), Number(req.body?.rate) || null, user(req));
  await audit(req, 'accounting_revalue', 'acc_entries', null, { date: req.body?.date, rate: out.rate, net: out.net });
  res.json(out);
}));

export default r;
