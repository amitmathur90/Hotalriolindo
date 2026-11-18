import { db } from '../db.ts';
import { pollInbox, processReceivedQueue } from '../hacienda/received.ts';
import { syncCloudbeds } from './cloudbeds.ts';
import { pushQuickBooks } from './quickbooks.ts';

/**
 * Background jobs that replace the manual work done in Cubo:
 *  - every 15 s: send pending Mensajes Receptor (supplier invoices) to Hacienda and read their answers
 *  - every 10 min: read the invoices mailbox, issue documents for Cloudbeds check-outs, post to QuickBooks
 */
const each = async (fn: (id: string) => Promise<any>, label: string) => {
  for (const b of await db.query(`SELECT id FROM businesses WHERE status='active'`)) {
    await fn(b.id).catch((e) => console.error(`[${label}]`, e.message || e));
  }
};

export async function runIntegrations() {
  await each(async (id) => {
    const s = await db.one(`SELECT imap_host FROM hacienda_settings WHERE business_id=$1`, [id]);
    if (s?.imap_host) await pollInbox(id);
  }, 'inbox');
  await each(syncCloudbeds, 'cloudbeds');
  await each((id) => pushQuickBooks(id), 'quickbooks');
}

export function startIntegrationWorker() {
  setInterval(() => processReceivedQueue().catch(console.error), Number(process.env.HACIENDA_POLL_MS || 15000));
  const every = Number(process.env.INTEGRATIONS_POLL_MS || 10 * 60 * 1000);
  setTimeout(() => runIntegrations().catch(console.error), 20000);
  setInterval(() => runIntegrations().catch(console.error), every);
}
