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
import { db } from './db.ts';

const PORT = Number(process.env.PORT || 4000);
const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '6mb' }));

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

app.use('/api/auth', authRoutes);
app.use('/api/admin', authenticate, admin);
app.use('/api/reports', authenticate, reportRoutes);
app.use('/api/settings', authenticate, settingsRoutes);
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
const server = http.createServer(app);
initRealtime(server);
server.listen(PORT, () => console.log(`[api] ITS POS listening on http://localhost:${PORT}`));

// Daily housekeeping: loyalty point expiry
setInterval(() => expirePoints().catch(console.error), 24 * 3600 * 1000);
