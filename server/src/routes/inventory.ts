import { Router } from 'express';
import { db, json, tx } from '../db.ts';
import { requirePerm, requireStore } from '../auth.ts';
import { crud } from '../crud.ts';
import { HttpError, ah, audit, bad, notFound, notify, num, range } from '../util.ts';
import { applyStock, type StockCtx } from '../stock.ts';
import { r2 } from '../../../shared/pricing.ts';

const r = Router();
const ctxFor = (req: any, storeId = req.storeId): StockCtx => ({
  businessId: req.auth.businessId, storeId, userId: req.auth.userId, allowNegative: true, lowStock: [], conflicts: [],
});
const flushAlerts = async (req: any, c: StockCtx) => {
  for (const ls of c.lowStock) await notify(req.auth.businessId, c.storeId, ls.qty <= 0 ? 'out_of_stock' : 'low_stock', `${ls.name}: ${ls.qty <= 0 ? 'out of stock' : `low stock (${ls.qty} left)`}`, ls);
};

// ---------------------------------------------------------------- Stock levels & valuation
r.get('/stock', requirePerm('inventory.manage', 'reports.view'), requireStore, ah(async (req, res) => {
  const params: any[] = [req.auth.businessId, req.storeId];
  let where = '';
  if (req.query.q) {
    const i = params.push(`%${req.query.q}%`);
    where += ` AND (p.name ILIKE $${i} OR v.sku ILIKE $${i} OR v.barcode ILIKE $${i})`;
  }
  if (req.query.low) where += ` AND COALESCE(i.qty,0) <= v.reorder_level`;
  if (req.query.category_id) where += ` AND p.category_id=$${params.push(req.query.category_id)}`;
  res.json(await db.query(
    `SELECT v.id AS variant_id, p.id AS product_id, p.name AS product_name, v.name AS variant_name, v.sku, v.barcode, p.unit,
            c.name AS category_name, COALESCE(i.qty,0) AS qty, v.reorder_level, v.cost, COALESCE(sp.price, v.price) AS price,
            ROUND(COALESCE(i.qty,0) * v.cost, 2) AS stock_value, ROUND(COALESCE(i.qty,0) * (COALESCE(sp.price, v.price) - v.cost), 2) AS potential_profit,
            (SELECT COALESCE(SUM(qty_change),0) FROM stock_movements m WHERE m.variant_id=v.id AND m.store_id=$2 AND m.reason='sale' AND m.created_at > now() - interval '30 days') AS sold_30d
       FROM variants v JOIN products p ON p.id=v.product_id LEFT JOIN categories c ON c.id=p.category_id
       LEFT JOIN inventory i ON i.variant_id=v.id AND i.store_id=$2
       LEFT JOIN store_prices sp ON sp.variant_id=v.id AND sp.store_id=$2
      WHERE v.business_id=$1 AND v.active AND p.active AND p.track_stock ${where}
      ORDER BY p.name, v.sort`, params));
}));

r.get('/movements', requirePerm('inventory.manage', 'reports.view'), requireStore, ah(async (req, res) => {
  const { from, to } = range(req);
  const params: any[] = [req.storeId, from, to];
  let where = '';
  if (req.query.variant_id) where += ` AND m.variant_id=$${params.push(req.query.variant_id)}`;
  if (req.query.reason) where += ` AND m.reason=$${params.push(req.query.reason)}`;
  res.json(await db.query(
    `SELECT m.*, p.name AS product_name, v.name AS variant_name, u.name AS user_name
       FROM stock_movements m JOIN variants v ON v.id=m.variant_id JOIN products p ON p.id=v.product_id LEFT JOIN users u ON u.id=m.user_id
      WHERE m.store_id=$1 AND m.created_at >= $2 AND m.created_at < $3 ${where} ORDER BY m.created_at DESC LIMIT 2000`, params));
}));

// ---------------------------------------------------------------- Adjustments (with manager approval)
const ADJ_REASONS = ['receive', 'damage', 'loss', 'theft', 'expiry', 'correction', 'internal_use', 'wastage'];
r.get('/adjustments', requirePerm('inventory.manage'), requireStore, ah(async (req, res) => {
  res.json(await db.query(
    `SELECT a.*, u.name AS created_by_name, ap.name AS approved_by_name FROM stock_adjustments a
       LEFT JOIN users u ON u.id=a.created_by LEFT JOIN users ap ON ap.id=a.approved_by
      WHERE a.store_id=$1 ORDER BY a.created_at DESC LIMIT 500`, [req.storeId]));
}));

async function applyAdjustment(req: any, adj: any) {
  const c = ctxFor(req, adj.store_id);
  await tx(async (q) => {
    for (const it of adj.items) await applyStock(q, c, it.variant_id, num(it.qty_change), adj.reason, { type: 'adjustment', id: adj.id }, adj.note);
    await q.query(`UPDATE stock_adjustments SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1`, [adj.id, req.auth.userId]);
  });
  await flushAlerts(req, c);
}

r.post('/adjustments', requirePerm('inventory.manage'), requireStore, ah(async (req, res) => {
  const { reason, note, items } = req.body || {};
  if (!ADJ_REASONS.includes(reason)) throw bad('Choose a valid reason');
  const clean = (items || []).filter((i: any) => i.variant_id && num(i.qty_change) !== 0).map((i: any) => ({ variant_id: i.variant_id, qty_change: num(i.qty_change), name: i.name }));
  if (!clean.length) throw bad('Add at least one item');
  const adj = await db.one(
    `INSERT INTO stock_adjustments (business_id, store_id, reason, note, items, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.auth.businessId, req.storeId, reason, note || null, json(clean), req.auth.userId],
  );
  await audit(req, 'create_adjustment', 'stock_adjustments', adj!.id, { reason, items: clean });
  // Stock received is applied immediately; decreases need approval unless the user can approve
  if (reason === 'receive' || req.auth.permissions.has('inventory.approve')) await applyAdjustment(req, adj);
  else await notify(req.auth.businessId, req.storeId, 'adjustment_pending', `Stock adjustment (${reason}) awaiting approval`, { id: adj!.id });
  res.status(201).json(await db.one(`SELECT * FROM stock_adjustments WHERE id=$1`, [adj!.id]));
}));

r.post('/adjustments/:id/:decision(approve|reject)', requirePerm('inventory.approve'), ah(async (req, res) => {
  const adj = await db.one(`SELECT * FROM stock_adjustments WHERE id=$1 AND business_id=$2 AND status='pending'`, [req.params.id, req.auth.businessId]);
  if (!adj) throw notFound('Pending adjustment');
  if (req.params.decision === 'approve') await applyAdjustment(req, adj);
  else await db.query(`UPDATE stock_adjustments SET status='rejected', approved_by=$2, approved_at=now() WHERE id=$1`, [adj.id, req.auth.userId]);
  await audit(req, `${req.params.decision}_adjustment`, 'stock_adjustments', adj.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Inventory count (expected vs actual)
r.post('/counts', requirePerm('inventory.manage'), requireStore, ah(async (req, res) => {
  const counted: { variant_id: string; counted: number }[] = req.body?.items || [];
  if (!counted.length) throw bad('Nothing counted');
  const rows = await db.query(`SELECT variant_id, qty FROM inventory WHERE store_id=$1 AND variant_id = ANY($2::uuid[])`, [req.storeId, counted.map((c) => c.variant_id)]);
  const items = counted.map((c) => {
    const expected = Number(rows.find((r) => r.variant_id === c.variant_id)?.qty ?? 0);
    return { variant_id: c.variant_id, expected, counted: num(c.counted), qty_change: r2(num(c.counted) - expected) };
  }).filter((i) => i.qty_change !== 0);
  if (!items.length) return res.json({ ok: true, variances: [] });
  const adj = await db.one(
    `INSERT INTO stock_adjustments (business_id, store_id, reason, note, items, created_by) VALUES ($1,$2,'correction',$3,$4,$5) RETURNING *`,
    [req.auth.businessId, req.storeId, req.body?.note || 'Inventory count', json(items), req.auth.userId],
  );
  if (req.body?.apply && req.auth.permissions.has('inventory.approve')) await applyAdjustment(req, adj);
  await audit(req, 'inventory_count', 'stock_adjustments', adj!.id, { variances: items.length });
  res.json({ ok: true, adjustment_id: adj!.id, variances: items });
}));

// ---------------------------------------------------------------- Transfers between stores
r.get('/transfers', requirePerm('inventory.manage'), ah(async (req, res) => {
  res.json(await db.query(
    `SELECT t.*, f.name AS from_name, s.name AS to_name, u.name AS created_by_name FROM stock_transfers t
       JOIN stores f ON f.id=t.from_store_id JOIN stores s ON s.id=t.to_store_id LEFT JOIN users u ON u.id=t.created_by
      WHERE t.business_id=$1 ORDER BY t.created_at DESC LIMIT 500`, [req.auth.businessId]));
}));

r.post('/transfers', requirePerm('inventory.manage'), ah(async (req, res) => {
  const { from_store_id, to_store_id, items, note } = req.body || {};
  if (!from_store_id || !to_store_id || from_store_id === to_store_id) throw bad('Choose two different stores');
  const n = await db.one(`SELECT COUNT(*) AS n FROM stores WHERE business_id=$1 AND id = ANY($2::uuid[])`, [req.auth.businessId, [from_store_id, to_store_id]]);
  if (Number(n!.n) !== 2) throw bad('Invalid stores');
  const clean = (items || []).filter((i: any) => i.variant_id && num(i.qty) > 0).map((i: any) => ({ variant_id: i.variant_id, name: i.name, qty: num(i.qty), received_qty: 0 }));
  if (!clean.length) throw bad('Add items to transfer');
  const t = await db.one(`INSERT INTO stock_transfers (business_id, from_store_id, to_store_id, items, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [
    req.auth.businessId, from_store_id, to_store_id, json(clean), note || null, req.auth.userId,
  ]);
  await audit(req, 'create_transfer', 'stock_transfers', t!.id, { from_store_id, to_store_id, items: clean });
  res.status(201).json(t);
}));

// approve -> dispatch (deduct source) -> receive (add destination, partial allowed)
r.post('/transfers/:id/:action(approve|reject|dispatch|receive)', requirePerm('inventory.manage'), ah(async (req, res) => {
  const t = await db.one(`SELECT * FROM stock_transfers WHERE id=$1 AND business_id=$2`, [req.params.id, req.auth.businessId]);
  if (!t) throw notFound('Transfer');
  const a = req.params.action;
  const flow: Record<string, string[]> = { approve: ['requested'], reject: ['requested', 'approved'], dispatch: ['approved'], receive: ['dispatched'] };
  if (!flow[a].includes(t.status)) throw bad(`Cannot ${a} a ${t.status} transfer`);
  if ((a === 'approve' || a === 'reject') && !req.auth.permissions.has('inventory.approve')) throw new HttpError(403, 'Approval permission required');
  let items = t.items;
  const from = ctxFor(req, t.from_store_id);
  const to = ctxFor(req, t.to_store_id);
  await tx(async (q) => {
    if (a === 'dispatch') for (const it of items) await applyStock(q, from, it.variant_id, -it.qty, 'transfer_out', { type: 'transfer', id: t.id });
    if (a === 'receive') {
      const received: Record<string, number> = Object.fromEntries((req.body?.items || []).map((i: any) => [i.variant_id, num(i.received_qty)]));
      items = items.map((it: any) => ({ ...it, received_qty: received[it.variant_id] ?? it.qty }));
      for (const it of items) {
        await applyStock(q, to, it.variant_id, it.received_qty, 'transfer_in', { type: 'transfer', id: t.id });
        // Discrepancy: short-received stock is written off at destination as loss in transit
        if (it.received_qty < it.qty)
          await q.query(`INSERT INTO stock_movements (business_id, store_id, variant_id, qty_change, reason, ref_type, ref_id, user_id, note) VALUES ($1,$2,$3,0,'transfer_discrepancy','transfer',$4,$5,$6)`, [
            req.auth.businessId, t.to_store_id, it.variant_id, t.id, req.auth.userId, `Short by ${r2(it.qty - it.received_qty)}`,
          ]);
      }
    }
    const status = { approve: 'approved', reject: 'rejected', dispatch: 'dispatched', receive: 'received' }[a];
    await q.query(`UPDATE stock_transfers SET status=$2, items=$3, updated_at=now() WHERE id=$1`, [t.id, status, json(items)]);
  });
  await flushAlerts(req, from);
  await audit(req, `${a}_transfer`, 'stock_transfers', t.id);
  res.json(await db.one(`SELECT * FROM stock_transfers WHERE id=$1`, [t.id]));
}));

// ---------------------------------------------------------------- Production (recipes -> finished goods)
r.post('/production', requirePerm('inventory.manage'), requireStore, ah(async (req, res) => {
  const { variant_id, qty, note } = req.body || {};
  const q0 = num(qty);
  if (!variant_id || q0 <= 0) throw bad('Choose product and quantity');
  const comps = await db.query(`SELECT pc.*, v.cost FROM product_components pc JOIN variants v ON v.id=pc.component_variant_id WHERE pc.variant_id=$1`, [variant_id]);
  if (!comps.length) throw bad('This item has no recipe (components)');
  const c = ctxFor(req);
  const batchCost = r2(comps.reduce((s, x) => s + Number(x.cost) * Number(x.qty) * q0, 0));
  await tx(async (q) => {
    const ref = { type: 'production', id: crypto.randomUUID() };
    for (const x of comps) await applyStock(q, c, x.component_variant_id, -Number(x.qty) * q0, 'production', ref, note);
    // Add finished goods directly (bypass recipe expansion)
    const row = await q.one(`INSERT INTO inventory (store_id, variant_id, qty) VALUES ($1,$2,$3) ON CONFLICT (store_id, variant_id) DO UPDATE SET qty=inventory.qty+EXCLUDED.qty RETURNING qty`, [req.storeId, variant_id, q0]);
    await q.query(`INSERT INTO stock_movements (business_id, store_id, variant_id, qty_change, qty_after, reason, ref_type, ref_id, user_id, note) VALUES ($1,$2,$3,$4,$5,'production',$6,$7,$8,$9)`, [
      req.auth.businessId, req.storeId, variant_id, q0, row!.qty, ref.type, ref.id, req.auth.userId, `Batch cost ${batchCost}${note ? ' - ' + note : ''}`,
    ]);
    await q.query(`UPDATE variants SET cost=$2 WHERE id=$1`, [variant_id, r2(batchCost / q0)]);
  });
  await flushAlerts(req, c);
  await audit(req, 'production', 'variants', variant_id, { qty: q0, batchCost });
  res.json({ ok: true, batch_cost: batchCost, unit_cost: r2(batchCost / q0) });
}));

// ---------------------------------------------------------------- Suppliers & purchase orders
r.use('/suppliers', crud({
  table: 'suppliers', fields: ['name', 'contact_person', 'phone', 'email', 'gstin', 'address', 'notes', 'balance'], required: ['name'],
  perm: 'purchases.manage', readPerm: 'purchases.manage', search: ['name', 'phone', 'gstin'],
}));

r.get('/purchase-orders', requirePerm('purchases.manage'), ah(async (req, res) => {
  const params: any[] = [req.auth.businessId];
  let where = '';
  if (req.storeId) where += ` AND po.store_id=$${params.push(req.storeId)}`;
  if (req.query.supplier_id) where += ` AND po.supplier_id=$${params.push(req.query.supplier_id)}`;
  res.json(await db.query(
    `SELECT po.*, s.name AS supplier_name, st.name AS store_name FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id=po.supplier_id JOIN stores st ON st.id=po.store_id
      WHERE po.business_id=$1 ${where} ORDER BY po.created_at DESC LIMIT 500`, params));
}));

const poTotal = (items: any[]) => r2(items.reduce((s, i) => s + num(i.qty) * num(i.cost) * (1 + num(i.tax_pct) / 100) - num(i.discount), 0));

r.post('/purchase-orders', requirePerm('purchases.manage'), requireStore, ah(async (req, res) => {
  const b = req.body || {};
  const items = (b.items || []).filter((i: any) => i.variant_id && num(i.qty) > 0)
    .map((i: any) => ({ variant_id: i.variant_id, name: i.name, qty: num(i.qty), cost: num(i.cost), tax_pct: num(i.tax_pct), discount: num(i.discount), received_qty: 0 }));
  if (!items.length) throw bad('Add at least one item');
  const n = await db.one(`SELECT COUNT(*) AS n FROM purchase_orders WHERE business_id=$1`, [req.auth.businessId]);
  const po = await db.one(
    `INSERT INTO purchase_orders (business_id, store_id, supplier_id, po_no, status, expected_date, notes, items, total, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.auth.businessId, req.storeId, b.supplier_id || null, `PO-${String(Number(n!.n) + 1).padStart(5, '0')}`, b.status === 'sent' ? 'sent' : 'draft',
     b.expected_date || null, b.notes || null, json(items), poTotal(items), req.auth.userId],
  );
  await audit(req, 'create_po', 'purchase_orders', po!.id, { po_no: po!.po_no, total: po!.total });
  res.status(201).json(po);
}));

r.put('/purchase-orders/:id', requirePerm('purchases.manage'), ah(async (req, res) => {
  const po = await db.one(`SELECT * FROM purchase_orders WHERE id=$1 AND business_id=$2`, [req.params.id, req.auth.businessId]);
  if (!po) throw notFound('Purchase order');
  const b = req.body || {};
  if (b.status === 'cancelled' || b.status === 'sent') {
    if (!['draft', 'sent'].includes(po.status)) throw bad('Only draft/sent orders can change status');
    await db.query(`UPDATE purchase_orders SET status=$2 WHERE id=$1`, [po.id, b.status]);
  } else {
    if (po.status !== 'draft') throw bad('Only draft orders can be edited');
    const items = (b.items || po.items).map((i: any) => ({ ...i, qty: num(i.qty), cost: num(i.cost), received_qty: 0 }));
    await db.query(`UPDATE purchase_orders SET supplier_id=$2, expected_date=$3, notes=$4, items=$5, total=$6 WHERE id=$1`, [
      po.id, b.supplier_id ?? po.supplier_id, b.expected_date || null, b.notes ?? po.notes, json(items), poTotal(items),
    ]);
  }
  await audit(req, 'update_po', 'purchase_orders', po.id, b);
  res.json(await db.one(`SELECT * FROM purchase_orders WHERE id=$1`, [po.id]));
}));

// Receive full or partial quantities; updates stock, cost price and supplier balance
r.post('/purchase-orders/:id/receive', requirePerm('purchases.manage'), ah(async (req, res) => {
  const po = await db.one(`SELECT * FROM purchase_orders WHERE id=$1 AND business_id=$2`, [req.params.id, req.auth.businessId]);
  if (!po) throw notFound('Purchase order');
  if (!['draft', 'sent', 'partial'].includes(po.status)) throw bad(`Order is ${po.status}`);
  const recv: Record<string, number> = Object.fromEntries((req.body?.items || []).map((i: any) => [i.variant_id, num(i.qty)]));
  const c = ctxFor(req, po.store_id);
  let value = 0;
  const items = po.items.map((it: any) => {
    const remaining = it.qty - (it.received_qty || 0);
    const q = Math.min(remaining, recv[it.variant_id] ?? (req.body?.all ? remaining : 0));
    value += q * it.cost * (1 + num(it.tax_pct) / 100);
    return { ...it, _now: q, received_qty: (it.received_qty || 0) + q };
  });
  if (!items.some((i: any) => i._now > 0)) throw bad('Nothing to receive');
  await tx(async (q) => {
    for (const it of items) {
      if (it._now <= 0) continue;
      await applyStock(q, c, it.variant_id, it._now, 'receive', { type: 'purchase_order', id: po.id }, po.po_no);
      if (it.cost > 0) await q.query(`UPDATE variants SET cost=$2 WHERE id=$1`, [it.variant_id, it.cost]);
    }
    const done = items.every((i: any) => i.received_qty >= i.qty);
    await q.query(`UPDATE purchase_orders SET items=$2, status=$3, invoice_no=COALESCE($4, invoice_no) WHERE id=$1`, [
      po.id, json(items.map(({ _now, ...rest }: any) => rest)), done ? 'received' : 'partial', req.body?.invoice_no || null,
    ]);
    if (po.supplier_id) await q.query(`UPDATE suppliers SET balance = balance + $2 WHERE id=$1`, [po.supplier_id, r2(value)]);
  });
  await notify(req.auth.businessId, po.store_id, 'po_received', `${po.po_no} received (${r2(value)})`, { id: po.id });
  await audit(req, 'receive_po', 'purchase_orders', po.id, { value: r2(value) });
  res.json(await db.one(`SELECT * FROM purchase_orders WHERE id=$1`, [po.id]));
}));

// Supplier payment (reduces outstanding balance; optionally from the cash drawer)
r.post('/suppliers/:id/payments', requirePerm('purchases.manage'), ah(async (req, res) => {
  const amount = num(req.body?.amount);
  if (amount <= 0) throw bad('Enter an amount');
  const s = await db.one(`UPDATE suppliers SET balance = balance - $3 WHERE id=$1 AND business_id=$2 RETURNING *`, [req.params.id, req.auth.businessId, amount]);
  if (!s) throw notFound('Supplier');
  if (req.body?.from_cash && req.storeId) {
    const shift = await db.one(`SELECT id FROM shifts WHERE store_id=$1 AND status='open' ORDER BY opened_at DESC LIMIT 1`, [req.storeId]);
    await db.query(`INSERT INTO cash_movements (business_id, store_id, shift_id, user_id, type, amount, reason) VALUES ($1,$2,$3,$4,'supplier_payment',$5,$6)`, [
      req.auth.businessId, req.storeId, shift?.id ?? null, req.auth.userId, amount, `Payment to ${s.name}`,
    ]);
  }
  // Not booked as an expense: purchase cost reaches P&L through COGS on sale.
  await audit(req, 'supplier_payment', 'suppliers', s.id, { amount });
  res.json(s);
}));

export default r;
