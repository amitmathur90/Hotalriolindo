import { Router, type Request } from 'express';
import { db } from '../db.ts';
import { requirePerm } from '../auth.ts';
import { ah, audit, bad } from '../util.ts';
import { digits } from '../hacienda/codes.ts';
import { getIntegration, publicConfig, saveIntegration, sealed } from '../integrations/store.ts';
import { issueReservation, syncCloudbeds, testCloudbeds } from '../integrations/cloudbeds.ts';
import { authorizeUrl, disconnectQuickBooks, finishConnect, listAccounts, pushQuickBooks, readState } from '../integrations/quickbooks.ts';

const r = Router();
const MANAGE = requirePerm('settings.manage');

export const qbRedirectUri = (req: Request) =>
  `${(process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/api/public/quickbooks/callback`;

const view = (it: any) => ({ enabled: it.enabled, config: publicConfig(it.config), last_sync_at: it.last_sync_at, last_error: it.last_error });

r.get('/', MANAGE, ah(async (req, res) => {
  const bid = req.auth.businessId;
  const [cb, qb] = await Promise.all([getIntegration(bid, 'cloudbeds'), getIntegration(bid, 'quickbooks')]);
  res.json({ cloudbeds: view(cb), quickbooks: { ...view(qb), connected: !!qb.config.realm_id }, qb_redirect_uri: qbRedirectUri(req) });
}));

// ---------------------------------------------------------------- Cloudbeds
const CB_FIELDS = ['property_id', 'currency', 'cabys', 'extras_cabys', 'tax_rate', 'payment_type', 'auto_issue', 'start_date', 'store_id', 'lookback_days'];
r.put('/cloudbeds', MANAGE, ah(async (req, res) => {
  const b = req.body || {};
  const config: Record<string, any> = {};
  for (const k of CB_FIELDS) if (k in b) config[k] = b[k] === '' ? undefined : b[k];
  if (config.cabys && !/^\d{13}$/.test(digits(config.cabys))) throw bad('El CABYS de hospedaje debe tener 13 dígitos');
  if (config.extras_cabys && !/^\d{13}$/.test(digits(config.extras_cabys))) throw bad('El CABYS de cargos adicionales debe tener 13 dígitos');
  if (config.currency && !['USD', 'CRC'].includes(config.currency)) throw bad('Moneda inválida');
  if ('tax_rate' in config) config.tax_rate = Number(config.tax_rate ?? 13);
  if ('auto_issue' in config) config.auto_issue = !!config.auto_issue;
  if (b.api_key) config.api_key_enc = sealed(String(b.api_key).trim());
  let it = await saveIntegration(req.auth.businessId, 'cloudbeds', { config });
  if ('enabled' in b) {
    if (b.enabled && (!it.config.api_key_enc || !/^\d{13}$/.test(digits(it.config.cabys)))) throw bad('Para activar ingrese la API key y el CABYS de hospedaje');
    it = await saveIntegration(req.auth.businessId, 'cloudbeds', { enabled: !!b.enabled, config: !it.config.start_date && b.enabled ? { start_date: new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10) } : {} });
  }
  await audit(req, 'integration_cloudbeds', 'integrations', null, { ...config, api_key_enc: config.api_key_enc ? '***' : undefined, enabled: it.enabled });
  res.json(view(it));
}));
r.post('/cloudbeds/test', MANAGE, ah(async (req, res) => res.json(await testCloudbeds(req.auth.businessId))));
r.post('/cloudbeds/sync', MANAGE, ah(async (req, res) => res.json(await syncCloudbeds(req.auth.businessId))));
r.get('/cloudbeds/reservations', MANAGE, ah(async (req, res) => {
  res.json(await db.query(
    `SELECT c.reservation_id, c.guest_name, c.check_in, c.check_out, c.total, c.status, c.message, c.updated_at, d.id AS doc_id, d.doc_type, d.consecutivo, d.status AS doc_status, d.currency
       FROM cloudbeds_reservations c LEFT JOIN e_documents d ON d.id=c.e_document_id WHERE c.business_id=$1 ORDER BY c.check_out DESC NULLS LAST, c.updated_at DESC LIMIT 300`,
    [req.auth.businessId]));
}));
r.post('/cloudbeds/reservations/:id/issue', MANAGE, ah(async (req, res) => {
  const out = await issueReservation(req.auth.businessId, req.params.id);
  await audit(req, 'cloudbeds_issue', 'cloudbeds_reservations', null, { reservation: req.params.id, status: out.status });
  res.json(out);
}));
r.post('/cloudbeds/reservations/:id/skip', MANAGE, ah(async (req, res) => {
  await db.query(`UPDATE cloudbeds_reservations SET status='skipped', message=$3, updated_at=now() WHERE business_id=$1 AND reservation_id=$2 AND status <> 'issued'`,
    [req.auth.businessId, req.params.id, String(req.body?.reason || 'Omitida manualmente')]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- QuickBooks Online
r.put('/quickbooks', MANAGE, ah(async (req, res) => {
  const b = req.body || {};
  const config: Record<string, any> = {};
  if ('client_id' in b) config.client_id = String(b.client_id || '').trim() || undefined;
  if (b.client_secret) config.client_secret_enc = sealed(String(b.client_secret).trim());
  if ('environment' in b) config.environment = b.environment === 'production' ? 'production' : 'sandbox';
  if ('start_date' in b) config.start_date = b.start_date || undefined;
  if (b.accounts && typeof b.accounts === 'object') config.accounts = Object.fromEntries(Object.entries(b.accounts).filter(([, v]) => v).map(([k, v]) => [k, String(v)]));
  const it = await saveIntegration(req.auth.businessId, 'quickbooks', { config });
  await audit(req, 'integration_quickbooks', 'integrations', null, { ...config, client_secret_enc: config.client_secret_enc ? '***' : undefined });
  res.json({ ...view(it), connected: !!it.config.realm_id });
}));
r.get('/quickbooks/connect', MANAGE, ah(async (req, res) => {
  const it = await getIntegration(req.auth.businessId, 'quickbooks');
  res.json({ url: authorizeUrl(it.config, req.auth.businessId, qbRedirectUri(req)), redirect_uri: qbRedirectUri(req) });
}));
r.get('/quickbooks/accounts', MANAGE, ah(async (req, res) => res.json(await listAccounts(req.auth.businessId))));
r.post('/quickbooks/sync', MANAGE, ah(async (req, res) => {
  const out = await pushQuickBooks(req.auth.businessId, { from: req.body?.from, to: req.body?.to });
  await audit(req, 'quickbooks_sync', 'integrations', null, { days: out.days.length, bills: out.bills.length });
  res.json(out);
}));
r.get('/quickbooks/postings', MANAGE, ah(async (req, res) => {
  res.json(await db.query(`SELECT kind, ref, qb_id, status, message, amount, created_at FROM qb_postings WHERE business_id=$1 ORDER BY created_at DESC LIMIT 200`, [req.auth.businessId]));
}));
r.post('/quickbooks/disconnect', MANAGE, ah(async (req, res) => {
  await disconnectQuickBooks(req.auth.businessId);
  await audit(req, 'quickbooks_disconnect', 'integrations', null, {});
  res.json({ ok: true });
}));

/** Intuit redirects the browser here after the user authorises the app (no session header on this request). */
export const quickbooksCallback = ah(async (req, res) => {
  const back = (q: string) => res.redirect(`/backoffice/integrations?${q}`);
  if (req.query.error) return back(`qb_error=${encodeURIComponent(String(req.query.error))}`);
  try {
    const bid = readState(String(req.query.state || ''));
    await finishConnect(bid, String(req.query.code || ''), String(req.query.realmId || ''), qbRedirectUri(req));
    back('qb=connected');
  } catch (e: any) {
    back(`qb_error=${encodeURIComponent(e.message)}`);
  }
});

export default r;
