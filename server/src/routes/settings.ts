import { Router } from 'express';
import { db } from '../db.ts';
import { requirePerm, requireSuperAdmin } from '../auth.ts';
import { crud } from '../crud.ts';
import { HttpError, ah, audit, bad, notFound, pick, setClause } from '../util.ts';
import { emit } from '../realtime.ts';

const r = Router();

// ---------------------------------------------------------------- Business settings
const BIZ_FIELDS = ['name', 'currency', 'currency_symbol', 'timezone', 'date_format', 'address', 'phone', 'email', 'gstin', 'logo_url',
  'receipt_footer', 'allow_negative_stock', 'loyalty_enabled', 'points_per_amount', 'point_value', 'min_redeem_points', 'points_expiry_days',
  'service_charge_pct', 'upi_id', 'country', 'locale', 'tax_id_label', 'terms'];
r.get('/business', ah(async (req, res) => res.json(await db.one(`SELECT * FROM businesses WHERE id=$1`, [req.auth.businessId]))));
r.put('/business', requirePerm('settings.manage'), ah(async (req, res) => {
  const data = pick(req.body, BIZ_FIELDS);
  if (!Object.keys(data).length) throw bad('Nothing to update');
  const { sql, values } = setClause(data, 2);
  const b = await db.one(`UPDATE businesses SET ${sql} WHERE id=$1 RETURNING *`, [req.auth.businessId, ...values]);
  await audit(req, 'update_settings', 'businesses', req.auth.businessId, { ...data, logo_url: data.logo_url ? '[image]' : undefined });
  res.json(b);
}));

// ---------------------------------------------------------------- Stores (limited by subscription)
const storeCrud = crud({
  table: 'stores', fields: ['name', 'address', 'phone', 'gstin', 'state', 'gst_mode', 'receipt_header', 'active'], required: ['name'],
  perm: 'settings.manage', orderBy: 'created_at',
});
r.post('/stores', requirePerm('settings.manage'), ah(async (req, _res, next) => {
  const b = await db.one(`SELECT max_stores, (SELECT COUNT(*) FROM stores WHERE business_id=$1 AND active) AS n FROM businesses WHERE id=$1`, [req.auth.businessId]);
  if (Number(b!.n) >= b!.max_stores) throw new HttpError(402, `Your plan allows ${b!.max_stores} stores. Contact support to upgrade.`);
  next();
}));
r.use('/stores', storeCrud);

r.use('/payment-methods', crud({ table: 'payment_methods', fields: ['name', 'type', 'store_ids', 'sort', 'active'], jsonFields: ['store_ids'], required: ['name', 'type'], perm: 'settings.manage', orderBy: 'sort, name' }));
r.use('/discounts', crud({ table: 'discounts', fields: ['name', 'type', 'value', 'scope', 'coupon_code', 'restricted', 'active'], required: ['name', 'value'], perm: 'settings.manage' }));
r.use('/tables', crud({ table: 'restaurant_tables', fields: ['name', 'area', 'capacity', 'status', 'sort'], required: ['name'], perm: 'settings.manage', storeScoped: true, orderBy: 'sort, name' }));
// Table status change from POS (reserve / free)
r.post('/tables/:id/status', requirePerm('pos.sell'), ah(async (req, res) => {
  if (!['available', 'reserved', 'occupied'].includes(req.body?.status)) throw bad('Invalid status');
  const t = await db.one(`UPDATE restaurant_tables SET status=$3 WHERE id=$1 AND business_id=$2 RETURNING *`, [req.params.id, req.auth.businessId, req.body.status]);
  if (!t) throw notFound('Table');
  emit(`store:${t.store_id}`, 'tables:changed', {});
  res.json(t);
}));

// ---------------------------------------------------------------- Notifications & audit
r.get('/notifications', ah(async (req, res) => {
  res.json(await db.query(`SELECT * FROM notifications WHERE business_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.auth.businessId]));
}));
r.post('/notifications/read', ah(async (req, res) => {
  await db.query(`UPDATE notifications SET read=true WHERE business_id=$1 AND (CARDINALITY($2::uuid[])=0 OR id = ANY($2::uuid[]))`, [req.auth.businessId, req.body?.ids || []]);
  res.json({ ok: true });
}));
r.get('/audit', requirePerm('audit.view'), ah(async (req, res) => {
  const params: any[] = [req.auth.businessId];
  let where = '';
  if (req.query.action) where += ` AND action=$${params.push(req.query.action)}`;
  if (req.query.user_id) where += ` AND user_id=$${params.push(req.query.user_id)}`;
  res.json(await db.query(`SELECT * FROM audit_logs WHERE business_id=$1 ${where} ORDER BY created_at DESC LIMIT 1000`, params));
}));
r.get('/login-history', requirePerm('audit.view', 'employees.manage'), ah(async (req, res) => {
  res.json(await db.query(`SELECT l.*, u.name AS user_name FROM login_history l LEFT JOIN users u ON u.id=l.user_id WHERE l.business_id=$1 ORDER BY l.created_at DESC LIMIT 500`, [req.auth.businessId]));
}));

// ---------------------------------------------------------------- Backup: full JSON export of this tenant
r.get('/backup', requirePerm('settings.manage'), ah(async (req, res) => {
  if (!req.auth.isOwner) throw new HttpError(403, 'Only the owner can export a backup');
  const bid = req.auth.businessId;
  const tables = ['stores', 'roles', 'categories', 'taxes', 'products', 'variants', 'modifier_groups', 'customers', 'suppliers', 'payment_methods',
    'discounts', 'gift_cards', 'shifts', 'cash_movements', 'sales', 'purchase_orders', 'stock_movements', 'expenses', 'restaurant_tables', 'time_entries'];
  const out: Record<string, any> = { exported_at: new Date().toISOString(), business: await db.one(`SELECT * FROM businesses WHERE id=$1`, [bid]) };
  for (const t of tables) out[t] = await db.query(`SELECT * FROM ${t} WHERE business_id=$1`, [bid]);
  out.sale_items = await db.query(`SELECT i.* FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.business_id=$1`, [bid]);
  out.sale_payments = await db.query(`SELECT p.* FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE s.business_id=$1`, [bid]);
  out.inventory = await db.query(`SELECT i.* FROM inventory i JOIN stores s ON s.id=i.store_id WHERE s.business_id=$1`, [bid]);
  out.users = await db.query(`SELECT id, name, email, role_id, employee_code, designation, store_ids, active FROM users WHERE business_id=$1`, [bid]);
  await audit(req, 'backup_export', 'businesses', bid);
  res.setHeader('Content-Disposition', `attachment; filename="its-pos-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(out);
}));

// ---------------------------------------------------------------- Super admin (platform)
export const admin = Router();
admin.use(requireSuperAdmin);
admin.get('/businesses', ah(async (_req, res) => {
  res.json(await db.query(
    `SELECT b.id, b.name, b.email, b.phone, b.status, b.plan, b.max_stores, b.created_at,
       (SELECT COUNT(*) FROM stores s WHERE s.business_id=b.id) AS stores,
       (SELECT COUNT(*) FROM users u WHERE u.business_id=b.id) AS users,
       (SELECT COALESCE(SUM(total),0) FROM sales s WHERE s.business_id=b.id AND s.type='sale' AND s.created_at > now() - interval '30 days') AS sales_30d
     FROM businesses b ORDER BY b.created_at DESC`));
}));
admin.put('/businesses/:id', ah(async (req, res) => {
  const data = pick(req.body, ['status', 'plan', 'max_stores']);
  if (data.status && !['active', 'suspended'].includes(data.status)) throw bad('Invalid status');
  const { sql, values } = setClause(data, 2);
  const b = await db.one(`UPDATE businesses SET ${sql} WHERE id=$1 RETURNING *`, [req.params.id, ...values]);
  if (!b) throw notFound('Business');
  await audit(req, 'admin_update_business', 'businesses', b.id, data);
  res.json(b);
}));

export default r;
