import { Router } from 'express';
import { db } from '../db.ts';
import { requirePerm } from '../auth.ts';
import { ah, bad, range } from '../util.ts';
import { r2 } from '../../../shared/pricing.ts';

const r = Router();
r.use(requirePerm('reports.view'));

/**
 * Definitions (reconcile with transaction records):
 *  gross_sales  = Σ item list value of sales (before discounts)
 *  discounts    = Σ item discounts of sales
 *  refunds      = Σ amount returned on refund receipts
 *  net_sales    = Σ pre-tax item revenue of sales − Σ pre-tax item revenue of refunds
 *  taxes        = Σ item taxes of sales − Σ item taxes of refunds
 *  cogs         = Σ item cost of sales − Σ item cost of refunds
 *  gross_profit = net_sales − cogs
 */
function scope(req: any, alias = 's') {
  const { from, to } = range(req);
  const params: any[] = [req.auth.businessId, from, to];
  let where = `${alias}.business_id=$1 AND ${alias}.created_at >= $2 AND ${alias}.created_at < $3`;
  const store = req.query.store_id || (req.query.all_stores ? null : req.storeId);
  if (store) where += ` AND ${alias}.store_id=$${params.push(store)}`;
  if (req.query.employee_id) where += ` AND ${alias}.user_id=$${params.push(req.query.employee_id)}`;
  return { where, params, from, to };
}
const sign = `CASE WHEN s.type='refund' THEN -1 ELSE 1 END`;
// Group hours/days in the business's own time zone, not the database server's
const LOCAL = `(s.created_at AT TIME ZONE bz.timezone)`;

r.get('/summary', ah(async (req, res) => {
  const { where, params } = scope(req);
  const t = await db.one(
    `SELECT
       COALESCE(SUM(i.gross) FILTER (WHERE s.type='sale'),0) AS gross_sales,
       COALESCE(SUM(i.discount) FILTER (WHERE s.type='sale'),0) AS discounts,
       COALESCE(SUM((i.total - i.tax) * ${sign}),0) AS net_sales,
       COALESCE(SUM(i.tax * ${sign}),0) AS taxes,
       COALESCE(SUM(i.cost * ${sign}),0) AS cogs
     FROM sales s JOIN sale_items i ON i.sale_id=s.id WHERE ${where}`, params);
  const s = await db.one(
    `SELECT COUNT(*) FILTER (WHERE s.type='sale') AS orders, COUNT(*) FILTER (WHERE s.type='refund') AS refund_count,
       COALESCE(SUM(s.total) FILTER (WHERE s.type='refund'),0) AS refunds,
       COALESCE(SUM(s.total * ${sign}),0) AS collected,
       COALESCE(SUM(s.service_charge * ${sign}),0) AS service_charge, COALESCE(SUM(s.tip * ${sign}),0) AS tips,
       COUNT(DISTINCT s.customer_id) AS customers, COUNT(*) FILTER (WHERE s.offline) AS offline_orders
     FROM sales s WHERE ${where}`, params);
  const net = Number(t!.net_sales);
  res.json({
    ...t, ...s,
    gross_profit: r2(net - Number(t!.cogs)),
    margin_pct: net ? r2(((net - Number(t!.cogs)) / net) * 100) : 0,
    avg_order: Number(s!.orders) ? r2(Number(s!.collected) / Number(s!.orders)) : 0,
  });
}));

// Grouped sales: ?by=item|category|employee|payment|hour|day|store|customer|dining
r.get('/sales-by', ah(async (req, res) => {
  const { where, params } = scope(req);
  const by = String(req.query.by || 'item');
  const itemDims: Record<string, [string, string]> = {
    item: [`i.product_name || COALESCE(' (' || NULLIF(i.variant_name,'') || ')', '')`, 'i.variant_id::text'],
    category: [`COALESCE(c.name, 'Uncategorized')`, 'i.category_id::text'],
    employee: [`COALESCE(u.name, 'Unknown')`, 's.user_id::text'],
    store: ['st.name', 's.store_id::text'],
    customer: [`COALESCE(cu.name, 'Walk-in')`, 's.customer_id::text'],
    hour: [`LPAD(EXTRACT(HOUR FROM ${LOCAL})::text, 2, '0') || ':00'`, `LPAD(EXTRACT(HOUR FROM ${LOCAL})::text, 2, '0')`],
    day: [`TO_CHAR(${LOCAL}, 'YYYY-MM-DD')`, `TO_CHAR(${LOCAL}, 'YYYY-MM-DD')`],
    dining: [`COALESCE(s.dining_option, 'counter')`, `COALESCE(s.dining_option, 'counter')`],
  };
  if (by === 'payment') {
    return res.json(await db.query(
      `SELECT p.method_name AS label, COUNT(DISTINCT s.id) FILTER (WHERE s.type='sale') AS transactions,
              COALESCE(SUM(p.amount) FILTER (WHERE s.type='sale'),0) AS amount,
              COALESCE(SUM(p.amount) FILTER (WHERE s.type='refund'),0) AS refunds,
              COALESCE(SUM(p.amount * ${sign}),0) AS net
         FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE ${where} GROUP BY 1 ORDER BY net DESC`, params));
  }
  const d = itemDims[by];
  if (!d) throw bad('Unknown grouping');
  const rows = await db.query(
    `SELECT ${d[0]} AS label, ${d[1]} AS key,
        COALESCE(SUM(i.qty * ${sign}),0) AS qty,
        COUNT(DISTINCT s.id) FILTER (WHERE s.type='sale') AS orders,
        COALESCE(SUM(i.gross) FILTER (WHERE s.type='sale'),0) AS gross_sales,
        COALESCE(SUM(i.discount) FILTER (WHERE s.type='sale'),0) AS discounts,
        COALESCE(SUM(i.total) FILTER (WHERE s.type='refund'),0) AS refunds,
        COALESCE(SUM((i.total - i.tax) * ${sign}),0) AS net_sales,
        COALESCE(SUM(i.tax * ${sign}),0) AS taxes,
        COALESCE(SUM(i.cost * ${sign}),0) AS cogs,
        COALESCE(SUM((i.total - i.tax - i.cost) * ${sign}),0) AS gross_profit
       FROM sales s JOIN sale_items i ON i.sale_id=s.id
       LEFT JOIN categories c ON c.id=i.category_id LEFT JOIN users u ON u.id=s.user_id
       LEFT JOIN customers cu ON cu.id=s.customer_id JOIN stores st ON st.id=s.store_id JOIN businesses bz ON bz.id=s.business_id
      WHERE ${where} GROUP BY 1,2 ORDER BY ${by === 'hour' || by === 'day' ? 'key' : 'net_sales DESC'} LIMIT 500`, params);
  res.json(rows);
}));

// Tax report, GST components per rate
r.get('/taxes', ah(async (req, res) => {
  const { where, params } = scope(req);
  res.json(await db.query(
    `SELECT t->>'name' AS name, (t->>'rate')::numeric AS rate, (t->>'is_gst')::boolean AS is_gst, (t->>'inclusive')::boolean AS inclusive, st.gst_mode,
            ROUND(SUM((t->>'taxable')::numeric * ${sign}), 2) AS taxable,
            ROUND(SUM((t->>'amount')::numeric * ${sign}), 2) AS amount
       FROM sales s JOIN stores st ON st.id=s.store_id JOIN sale_items i ON i.sale_id=s.id, jsonb_array_elements(i.taxes) t
      WHERE ${where} GROUP BY 1,2,3,4,5 ORDER BY 2`, params));
}));

r.get('/discounts', ah(async (req, res) => {
  const { where, params } = scope(req);
  res.json(await db.query(
    `SELECT COALESCE(s.order_discount->>'type','item') AS type, COALESCE(s.order_discount->>'value','-') AS value,
            COUNT(*) AS orders, ROUND(SUM(s.discount_total),2) AS amount
       FROM sales s WHERE ${where} AND s.type='sale' AND s.discount_total > 0 GROUP BY 1,2 ORDER BY amount DESC`, params));
}));

r.get('/kitchen', ah(async (req, res) => {
  const { where, params } = scope(req, 'k');
  res.json(await db.query(
    `SELECT k.station, COUNT(*) AS orders,
            ROUND(AVG(EXTRACT(EPOCH FROM (k.ready_at - k.created_at))/60)::numeric, 1) AS avg_prep_minutes,
            ROUND(MAX(EXTRACT(EPOCH FROM (k.ready_at - k.created_at))/60)::numeric, 1) AS max_prep_minutes,
            COUNT(*) FILTER (WHERE k.ready_at - k.created_at > interval '15 minutes') AS delayed,
            COUNT(*) FILTER (WHERE k.status='cancelled') AS cancelled
       FROM kitchen_orders k WHERE ${where.replace('k.user_id', 'k.created_by')} GROUP BY 1 ORDER BY 1`, params));
}));

// Profit & loss summary
r.get('/pnl', ah(async (req, res) => {
  const { where, params, from, to } = scope(req);
  const t = await db.one(
    `SELECT COALESCE(SUM((i.total - i.tax) * ${sign}),0) AS net_sales, COALESCE(SUM(i.cost * ${sign}),0) AS cogs
       FROM sales s JOIN sale_items i ON i.sale_id=s.id WHERE ${where}`, params);
  const sc = await db.one(`SELECT COALESCE(SUM(s.service_charge * ${sign}),0) AS sc FROM sales s WHERE ${where}`, params);
  const ep: any[] = [req.auth.businessId, from.slice(0, 10), to.slice(0, 10)];
  const store = req.query.store_id || (req.query.all_stores ? null : req.storeId);
  const exp = await db.query(
    `SELECT category, ROUND(SUM(amount),2) AS amount FROM expenses WHERE business_id=$1 AND spent_on >= $2::date AND spent_on < $3::date
     ${store ? `AND store_id=$${ep.push(store)}` : ''} GROUP BY 1 ORDER BY 2 DESC`, ep);
  const expenses = exp.reduce((a, e) => a + Number(e.amount), 0);
  const revenue = Number(t!.net_sales) + Number(sc!.sc);
  const gp = revenue - Number(t!.cogs);
  res.json({ revenue: r2(revenue), net_sales: t!.net_sales, service_charge: sc!.sc, cogs: t!.cogs, gross_profit: r2(gp), expenses_by_category: exp, expenses: r2(expenses), net_profit: r2(gp - expenses) });
}));

r.get('/loyalty', ah(async (req, res) => {
  const { from, to } = range(req);
  res.json(await db.query(
    `SELECT type, COUNT(*) AS transactions, ROUND(SUM(points),2) AS points FROM loyalty_transactions
      WHERE business_id=$1 AND created_at >= $2 AND created_at < $3 GROUP BY 1`, [req.auth.businessId, from, to]));
}));

export default r;
