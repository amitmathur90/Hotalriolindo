import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initDb } from './db.ts';
import { authenticate } from './auth.ts';
import { HttpError } from './errors.ts';
import { initRealtime } from './realtime.ts';
import { seedDemo } from './seed.ts';
import authRoutes from './routes/auth.ts';
import catalogRoutes from './routes/catalog.ts';
import salesRoutes, { loadSale, receiptSig } from './routes/sales.ts';
import inventoryRoutes from './routes/inventory.ts';
import peopleRoutes, { expirePoints } from './routes/people.ts';
import reportRoutes from './routes/reports.ts';
import settingsRoutes, { admin } from './routes/settings.ts';
import haciendaRoutes from './routes/hacienda.ts';
import { startHaciendaWorker } from './hacienda/service.ts';
import { documentPdf } from './hacienda/pdf.ts';
import integrationRoutes, { quickbooksCallback } from './routes/integrations.ts';
import { startIntegrationWorker } from './integrations/worker.ts';
import payrollRoutes, { startPayrollWorker } from './payroll/index.ts';
import { db } from './db.ts';
import { APP_NAME, MULTI_TENANT } from './config.ts';

const PORT = Number(process.env.PORT || 4000);
const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '6mb' }));

// Public app config: lets the login page show first-run setup, sign-up (SaaS mode only) and the demo hint.
app.get('/api/public/config', async (_req, res, next) => {
  try {
    const b = await db.one(`SELECT name FROM businesses ORDER BY created_at LIMIT 1`);
    const demo = !!(await db.one(`SELECT 1 FROM users WHERE lower(email)='owner@demo.com' AND active`));
    res.json({ app_name: APP_NAME, multi_tenant: MULTI_TENANT, setup_needed: !b, business_name: b?.name ?? null, demo });
  } catch (e) {
    next(e);
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Public digital receipt (shared via link / WhatsApp / email). Signed id prevents enumeration.
app.get('/api/public/receipt/:id/:sig', async (req, res, next) => {
  try {
    if (receiptSig(req.params.id) !== req.params.sig) throw new HttpError(404, 'Receipt not found');
    const s = await db.one(`SELECT business_id FROM sales WHERE id=$1`, [req.params.id]);
    if (!s) throw new HttpError(404, 'Receipt not found');
    const sale = await loadSale(req.params.id, s.business_id);
    const business = await db.one(`SELECT name, logo_url, address, phone, gstin, receipt_footer, currency_symbol, locale, tax_id_label, terms, country FROM businesses WHERE id=$1`, [s.business_id]);
    res.json({ sale, business });
  } catch (e) {
    next(e);
  }
});

// Public PDF of an electronic document (QR code on the PDF, link in e-mails)
app.get('/api/public/edoc/:id/:sig.pdf', async (req, res, next) => {
  try {
    if (receiptSig(req.params.id) !== req.params.sig) throw new HttpError(404, 'Documento no encontrado');
    const d = await db.one('SELECT * FROM e_documents WHERE id=$1', [req.params.id]);
    if (!d) throw new HttpError(404, 'Documento no encontrado');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + d.consecutivo + '.pdf"');
    res.send(await documentPdf(d));
  } catch (e) {
    next(e);
  }
});
// QuickBooks OAuth redirect (browser, no session header)
app.get('/api/public/quickbooks/callback', quickbooksCallback);

app.use('/api/auth', authRoutes);
if (MULTI_TENANT) app.use('/api/admin', authenticate, admin);
app.use('/api/reports', authenticate, reportRoutes);
app.use('/api/settings', authenticate, settingsRoutes);
app.use('/api/hacienda', authenticate, haciendaRoutes);
app.use('/api/payroll', authenticate, payrollRoutes);
app.use('/api/integrations', authenticate, integrationRoutes);
app.use('/api', authenticate, catalogRoutes, salesRoutes, inventoryRoutes, peopleRoutes);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the built web app (single-port production deployment)
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err instanceof HttpError ? err.status : err.status || 500;
  if (status >= 500) console.error(err);
  // Unique violations (e.g. duplicate barcode) are reported as 409s
  if (err.code === '23505') return res.status(409).json({ error: 'Duplicate value: ' + (err.detail || 'record already exists') });
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

const kind = await initDb();
console.log(`[db] ${kind}`);
if (process.env.SEED_DEMO !== 'false' && (await seedDemo())) console.log('[seed] demo business created (owner@demo.com / demo123)');
if (!MULTI_TENANT) {
  // Single-hotel mode has no platform admin: lock any account left over from SaaS mode (e.g. admin@itspos.local).
  const off = await db.query(`UPDATE users SET active=false WHERE is_super_admin AND active RETURNING email`);
  if (off.length) console.log(`[mode] single hotel — disabled platform admin: ${off.map((u) => u.email).join(', ')}`);
}
const server = http.createServer(app);
initRealtime(server);
server.listen(PORT, () => console.log(`[api] ${APP_NAME} listening on http://localhost:${PORT}`));

// Hacienda e-invoicing queue: signs, sends and checks electronic documents in the background
startHaciendaWorker();
// Payroll: payslip e-mail queue
startPayrollWorker();
// Supplier invoices (mailbox + Mensaje Receptor), Cloudbeds check-outs, QuickBooks postings
startIntegrationWorker();

// Daily housekeeping: loyalty point expiry
setInterval(() => expirePoints().catch(console.error), 24 * 3600 * 1000);
