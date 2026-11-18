import { createHmac } from 'node:crypto';
import { db } from '../db.ts';
import { bad } from '../util.ts';
import { parseComprobante } from '../hacienda/pdf.ts';
import { getIntegration, saveIntegration, sealed, secret } from './store.ts';

/**
 * QuickBooks Online. The hotel connects its QuickBooks company once (Intuit sign-in, OAuth 2.0) and maps accounts; then:
 *  - every closed day is posted as one journal entry built from the documents Hacienda accepted that day
 *    (sales, IVA, 10 % service, tips against the cash / card / other deposit accounts; notas de crédito reverse),
 *  - every supplier factura accepted in "Documentos recibidos" is posted as a bill to its vendor.
 * Amounts are posted in colones (USD documents converted at the document's exchange rate).
 * QB_AUTH_URL / QB_TOKEN_URL / QB_API_URL override Intuit's endpoints (tests).
 */
const AUTH_URL = () => process.env.QB_AUTH_URL || 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = () => process.env.QB_TOKEN_URL || 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const apiBase = (env: string) => (process.env.QB_API_URL || (env === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com')).replace(/\/$/, '');
const MINOR = 'minorversion=75';

const sign = (s: string) => createHmac('sha256', process.env.JWT_SECRET || 'dev-only-change-me').update('qb:' + s).digest('hex').slice(0, 24);
export const makeState = (businessId: string) => `${businessId}.${sign(businessId)}`;
export function readState(state: string) {
  const [bid, sig] = String(state || '').split('.');
  if (!bid || sig !== sign(bid)) throw bad('Estado de autorización inválido');
  return bid;
}

export function authorizeUrl(cfg: any, businessId: string, redirectUri: string) {
  if (!cfg.client_id || !secret(cfg, 'client_secret')) throw bad('Ingrese el Client ID y Client Secret de su app de Intuit');
  const q = new URLSearchParams({ client_id: cfg.client_id, response_type: 'code', scope: 'com.intuit.quickbooks.accounting', redirect_uri: redirectUri, state: makeState(businessId) });
  return `${AUTH_URL()}?${q}`;
}

async function tokenRequest(cfg: any, body: Record<string, string>) {
  const basic = Buffer.from(`${cfg.client_id}:${secret(cfg, 'client_secret')}`).toString('base64');
  const res = await fetch(TOKEN_URL(), {
    method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(body),
  });
  const b: any = await res.json().catch(() => ({}));
  if (!res.ok || !b.access_token) throw bad(`QuickBooks: ${b.error_description || b.error || res.status}`);
  return { config: { access_token: b.access_token, access_exp: Date.now() + Number(b.expires_in || 3600) * 1000, refresh_token_enc: sealed(b.refresh_token) } };
}

export async function finishConnect(businessId: string, code: string, realmId: string, redirectUri: string) {
  const it = await getIntegration(businessId, 'quickbooks');
  const t = await tokenRequest(it.config, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  await saveIntegration(businessId, 'quickbooks', { enabled: true, config: { ...t.config, realm_id: realmId, connected_at: new Date().toISOString() }, last_error: null });
  const info = await qb(businessId, 'GET', `/companyinfo/${realmId}`).catch(() => null);
  if (info?.CompanyInfo?.CompanyName) await saveIntegration(businessId, 'quickbooks', { config: { company_name: info.CompanyInfo.CompanyName, home_currency: info.CompanyInfo?.Country } });
}

async function accessToken(businessId: string) {
  const it = await getIntegration(businessId, 'quickbooks');
  const cfg = it.config;
  if (!cfg.realm_id || !cfg.refresh_token_enc) throw bad('QuickBooks no está conectado');
  if (cfg.access_token && Number(cfg.access_exp) > Date.now() + 60000) return { token: cfg.access_token, cfg };
  const t = await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: secret(cfg, 'refresh_token') });
  const saved = await saveIntegration(businessId, 'quickbooks', t);
  return { token: t.config.access_token, cfg: saved.config };
}

async function qb(businessId: string, method: 'GET' | 'POST', path: string, body?: any) {
  const { token, cfg } = await accessToken(businessId);
  const url = `${apiBase(cfg.environment)}/v3/company/${cfg.realm_id}${path}${path.includes('?') ? '&' : '?'}${MINOR}`;
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const b: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const f = b?.Fault?.Error?.[0];
    throw bad(`QuickBooks ${res.status}: ${f ? `${f.Message}${f.Detail ? ' — ' + f.Detail : ''}` : res.statusText}`);
  }
  return b;
}
const query = (businessId: string, sql: string) => qb(businessId, 'GET', `/query?query=${encodeURIComponent(sql)}`);

export async function listAccounts(businessId: string) {
  const r = await query(businessId, `select Id, Name, AccountType, AccountSubType, CurrencyRef from Account where Active = true maxresults 1000`);
  return (r.QueryResponse?.Account || []).map((a: any) => ({ id: a.Id, name: a.Name, type: a.AccountType, subtype: a.AccountSubType, currency: a.CurrencyRef?.value }));
}

// ------------------------------------------------------------------ daily sales journal
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const crDay = (d: Date) => new Date(d.getTime() - 6 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(new Date(d + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

/** Totals in colones of the documents Hacienda accepted on one Costa Rica calendar day. */
export async function dayTotals(businessId: string, day: string) {
  const from = new Date(day + 'T06:00:00Z'), to = new Date(addDays(day, 1) + 'T06:00:00Z');
  const docs = await db.query(`SELECT id, doc_type, status, xml_signed, exchange_rate FROM e_documents WHERE business_id=$1 AND issued_at >= $2 AND issued_at < $3`, [businessId, from, to]);
  const t = { income: 0, tax: 0, service: 0, tips: 0, cash: 0, card: 0, other: 0, docs: 0, pending: 0 };
  for (const d of docs) {
    if (d.status === 'pending' || d.status === 'sent') { t.pending++; continue; }
    if (d.status !== 'accepted' || !d.xml_signed) continue;
    const p = parseComprobante(d.xml_signed);
    const k = (d.doc_type === '03' ? -1 : 1) * (p.tipoCambio || Number(d.exchange_rate) || 1);
    t.docs++;
    t.income += p.resumen.ventaNeta * k;
    t.tax += p.resumen.impuesto * k;
    for (const o of p.otros) o.tipo === '06' ? (t.service += o.monto * k) : (t.tips += o.monto * k);
    const medios = p.medios.length ? p.medios : [{ code: '01', amount: p.resumen.total }];
    for (const m of medios) m.code === '01' ? (t.cash += m.amount * k) : m.code === '02' ? (t.card += m.amount * k) : (t.other += m.amount * k);
  }
  return t;
}

function journalLines(t: Awaited<ReturnType<typeof dayTotals>>, acc: any, day: string) {
  const lines: any[] = [];
  const add = (amount: number, side: 'Debit' | 'Credit', account: string, desc: string) => {
    const a = r2(amount);
    if (!a) return;
    if (!account) throw bad(`Falta asignar la cuenta de QuickBooks para "${desc}"`);
    lines.push({ DetailType: 'JournalEntryLineDetail', Amount: Math.abs(a), Description: `${desc} ${day}`, JournalEntryLineDetail: { PostingType: a >= 0 ? side : side === 'Debit' ? 'Credit' : 'Debit', AccountRef: { value: account } } });
  };
  add(t.cash, 'Debit', acc.deposit_cash, 'Ventas en efectivo');
  add(t.card, 'Debit', acc.deposit_card, 'Ventas con tarjeta');
  add(t.other, 'Debit', acc.deposit_other || acc.deposit_card, 'Ventas SINPE/transferencia/otros');
  add(t.income, 'Credit', acc.income, 'Ventas netas');
  add(t.tax, 'Credit', acc.tax, 'IVA por pagar');
  add(t.service, 'Credit', acc.service || acc.income, 'Impuesto de servicio 10%');
  add(t.tips, 'Credit', acc.tips || acc.service || acc.income, 'Propinas');
  // Rounding: make debits equal credits on the sales line
  const bal = lines.reduce((s, l) => s + (l.JournalEntryLineDetail.PostingType === 'Debit' ? l.Amount : -l.Amount), 0);
  const inc = lines.find((l) => l.JournalEntryLineDetail.AccountRef.value === acc.income && l.Description.startsWith('Ventas netas'));
  if (inc && Math.abs(bal) > 0 && Math.abs(bal) < 1) inc.Amount = r2(inc.Amount + (inc.JournalEntryLineDetail.PostingType === 'Credit' ? bal : -bal));
  return lines;
}

async function posted(businessId: string, kind: string, ref: string) {
  return db.one(`SELECT * FROM qb_postings WHERE business_id=$1 AND kind=$2 AND ref=$3 AND status='ok'`, [businessId, kind, ref]);
}
const saveposting = (businessId: string, kind: string, ref: string, f: { qb_id?: string | null; status: string; message?: string | null; amount?: number | null }) =>
  db.query(
    `INSERT INTO qb_postings (business_id, kind, ref, qb_id, status, message, amount) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (business_id, kind, ref) DO UPDATE SET qb_id=EXCLUDED.qb_id, status=EXCLUDED.status, message=EXCLUDED.message, amount=EXCLUDED.amount, created_at=now()`,
    [businessId, kind, ref, f.qb_id ?? null, f.status, f.message ?? null, f.amount ?? null],
  );

export async function postSalesDay(businessId: string, day: string) {
  if (await posted(businessId, 'sales_day', day)) return { day, status: 'already' };
  const it = await getIntegration(businessId, 'quickbooks');
  const t = await dayTotals(businessId, day);
  if (t.pending) return { day, status: 'waiting', message: `${t.pending} comprobante(s) aún sin respuesta de Hacienda` };
  if (!t.docs) return { day, status: 'empty' };
  try {
    const Line = journalLines(t, it.config.accounts || {}, day);
    if (!Line.length) return { day, status: 'empty' };
    const r = await qb(businessId, 'POST', '/journalentry', { TxnDate: day, DocNumber: `VENTAS-${day.replace(/-/g, '')}`, PrivateNote: `Ventas del ${day} (${t.docs} comprobantes electrónicos aceptados por Hacienda)`, Line });
    await saveposting(businessId, 'sales_day', day, { qb_id: r.JournalEntry?.Id, status: 'ok', amount: r2(t.cash + t.card + t.other) });
    return { day, status: 'posted', id: r.JournalEntry?.Id };
  } catch (e: any) {
    await saveposting(businessId, 'sales_day', day, { status: 'error', message: e.message });
    return { day, status: 'error', message: e.message };
  }
}

// ------------------------------------------------------------------ supplier bills
async function vendorId(businessId: string, name: string, taxId: string | null) {
  const display = String(name || 'Proveedor').replace(/[:'"\\]/g, ' ').trim().slice(0, 100);
  const found = await query(businessId, `select Id from Vendor where DisplayName = '${display}'`);
  const v = found.QueryResponse?.Vendor?.[0];
  if (v) return v.Id;
  const r = await qb(businessId, 'POST', '/vendor', { DisplayName: display, CompanyName: display, ...(taxId ? { TaxIdentifier: taxId } : {}) });
  return r.Vendor.Id;
}

export async function postBill(businessId: string, doc: any) {
  if (await posted(businessId, 'bill', doc.id)) return { id: doc.id, status: 'already' };
  const acc = (await getIntegration(businessId, 'quickbooks')).config.accounts || {};
  try {
    if (!acc.expense) throw bad('Falta asignar la cuenta de gastos de QuickBooks');
    const rate = Number(doc.exchange_rate) || 1;
    const tax = Number(doc.total_tax) || 0, total = Number(doc.total) || 0;
    const sign = doc.doc_type === '03' ? -1 : 1;
    const Line: any[] = [];
    const line = (amount: number, account: string, desc: string) => Line.push({ DetailType: 'AccountBasedExpenseLineDetail', Amount: r2(amount * rate), Description: desc, AccountBasedExpenseLineDetail: { AccountRef: { value: account } } });
    if (acc.tax_credit && tax > 0) {
      line(total - tax, acc.expense, `${doc.expense_category || 'Gasto'} · ${doc.consecutivo}`);
      line(tax, acc.tax_credit, 'IVA soportado (crédito fiscal)');
    } else line(total, acc.expense, `${doc.expense_category || 'Gasto'} · ${doc.consecutivo}`);
    const vid = await vendorId(businessId, doc.emisor_name, doc.emisor_id);
    const entity = sign < 0 ? 'vendorcredit' : 'bill';
    const r = await qb(businessId, 'POST', `/${entity}`, {
      VendorRef: { value: vid }, TxnDate: (doc.issued_at ? new Date(doc.issued_at) : new Date()).toISOString().slice(0, 10), DocNumber: String(doc.consecutivo || '').slice(-21),
      PrivateNote: `Clave Hacienda ${doc.clave}`, Line,
    });
    await saveposting(businessId, 'bill', doc.id, { qb_id: (r.Bill || r.VendorCredit)?.Id, status: 'ok', amount: r2(total * rate) });
    return { id: doc.id, status: 'posted' };
  } catch (e: any) {
    await saveposting(businessId, 'bill', doc.id, { status: 'error', message: e.message });
    return { id: doc.id, status: 'error', message: e.message };
  }
}

/** Posts every closed day and accepted supplier document not yet in QuickBooks. */
export async function pushQuickBooks(businessId: string, opts: { from?: string; to?: string } = {}) {
  const it = await getIntegration(businessId, 'quickbooks');
  if (!it.enabled || !it.config.realm_id) return { days: [], bills: [] };
  // Only closed days are posted (QB_CLOSE_DAY_OFFSET=0 lets the automated tests post today)
  const yesterday = addDays(crDay(new Date()), -Number(process.env.QB_CLOSE_DAY_OFFSET ?? 1));
  const to = opts.to && opts.to < yesterday ? opts.to : yesterday;
  const from = [opts.from || addDays(to, -45), it.config.start_date].filter(Boolean).sort().pop()!;
  const days: any[] = [];
  try {
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const r = await postSalesDay(businessId, d);
      if (r.status !== 'empty' && r.status !== 'already') days.push(r);
    }
    const docs = await db.query(
      `SELECT r.* FROM received_documents r WHERE r.business_id=$1 AND r.decision IN ('05','06') AND coalesce(r.mr_status,'') <> 'rejected'
         AND ($2::date IS NULL OR r.issued_at >= $2::date)
         AND NOT EXISTS (SELECT 1 FROM qb_postings p WHERE p.business_id=r.business_id AND p.kind='bill' AND p.ref=r.id::text AND p.status='ok') ORDER BY r.issued_at LIMIT 200`,
      [businessId, it.config.start_date || null],
    );
    const bills: any[] = [];
    for (const doc of docs) bills.push(await postBill(businessId, doc));
    const errs = [...days, ...bills].filter((x) => x.status === 'error');
    await saveIntegration(businessId, 'quickbooks', { last_sync_at: new Date(), last_error: errs.length ? errs.map((e) => e.message).slice(0, 3).join(' · ') : null });
    return { days, bills };
  } catch (e: any) {
    await saveIntegration(businessId, 'quickbooks', { last_sync_at: new Date(), last_error: e.message });
    throw e;
  }
}

export async function disconnectQuickBooks(businessId: string) {
  const it = await getIntegration(businessId, 'quickbooks');
  const tok = secret(it.config, 'refresh_token');
  if (tok && !process.env.QB_TOKEN_URL) {
    const basic = Buffer.from(`${it.config.client_id}:${secret(it.config, 'client_secret')}`).toString('base64');
    await fetch('https://developer.api.intuit.com/v2/oauth2/tokens/revoke', { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ token: tok }) }).catch(() => null);
  }
  await saveIntegration(businessId, 'quickbooks', { enabled: false, config: { realm_id: undefined, refresh_token_enc: undefined, access_token: undefined, access_exp: undefined, company_name: undefined } });
}
