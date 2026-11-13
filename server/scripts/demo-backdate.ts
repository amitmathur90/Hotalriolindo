// Spreads the demo sales created by demo-data.ts across the last 30 days (business hours, IST).
// Run with the server STOPPED (the embedded database allows one process at a time).
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { db, initDb } from '../src/db.ts';

await initDb();
const ids: string[] = JSON.parse(readFileSync(new URL('./.demo-sales.json', import.meta.url), 'utf8'));
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const now = Date.now();
// Ascending dates so receipt numbers stay in chronological order; today keeps a few sales
const dates = ids.map((_, i) => {
  const daysAgo = Math.max(0, Math.round(29 - (i / ids.length) * 30));
  const d = new Date(now - daysAgo * 86400000);
  const localHour = 7 + Math.floor(rnd() * 15); // 07:00–21:59 Costa Rica time (UTC-6)
  d.setUTCHours(localHour + 6, Math.floor(rnd() * 59), Math.floor(rnd() * 59), 0);
  return d.getTime() > now ? new Date(now - (ids.length - i) * 600000) : d;
});
for (const [i, id] of ids.entries()) {
  const at = dates[i].toISOString();
  await db.query(`UPDATE sales SET created_at=$2, synced_at=$2 WHERE id=$1`, [id, at]);
  await db.query(`UPDATE stock_movements SET created_at=$2 WHERE ref_id=$1`, [id, at]);
  await db.query(`UPDATE loyalty_transactions SET created_at=$2 WHERE sale_id=$1`, [id, at]);
}
// Customer "last visit" follows their latest sale
await db.query(`UPDATE customers c SET last_visit_at = s.m FROM (SELECT customer_id, MAX(created_at) m FROM sales WHERE type='sale' GROUP BY 1) s WHERE s.customer_id=c.id`);
console.log(`Backdated ${ids.length} sales across the last 30 days.`);
process.exit(0);
