import { Router } from 'express';
import { db, json, tx, type Q } from '../db.ts';
import { requirePerm } from '../auth.ts';
import { crud } from '../crud.ts';
import { ah, audit, bad, notFound, num } from '../util.ts';

const r = Router();

r.use('/categories', crud({
  table: 'categories', fields: ['name', 'color', 'kitchen_station', 'sort'], required: ['name'],
  perm: 'products.manage', orderBy: 'sort, name',
}));
r.use('/taxes', crud({
  table: 'taxes', fields: ['name', 'rate', 'inclusive', 'is_gst', 'active'], required: ['name', 'rate'], perm: 'settings.manage',
}));
r.use('/modifier-groups', crud({
  table: 'modifier_groups', fields: ['name', 'min_select', 'max_select', 'options'], jsonFields: ['options'], required: ['name'],
  perm: 'products.manage',
}));

const PRODUCT_FIELDS = ['name', 'category_id', 'description', 'type', 'unit', 'track_stock', 'image_url', 'color', 'is_favorite', 'active'];

const productQuery = (where: string) => `
  SELECT p.*, c.name AS category_name, c.color AS category_color,
    COALESCE((SELECT json_agg(g.group_id) FROM product_modifier_groups g WHERE g.product_id=p.id), '[]') AS modifier_group_ids,
    COALESCE((SELECT json_agg(json_build_object(
        'id', v.id, 'name', v.name, 'sku', v.sku, 'barcode', v.barcode, 'price', COALESCE(sp.price, v.price),
        'base_price', v.price, 'store_price', sp.price, 'cost', v.cost, 'wholesale_price', v.wholesale_price,
        'reorder_level', v.reorder_level, 'stock', COALESCE(i.qty, 0),
        'components', COALESCE((SELECT json_agg(json_build_object('component_variant_id', pc.component_variant_id, 'qty', pc.qty))
                                 FROM product_components pc WHERE pc.variant_id=v.id), '[]')
      ) ORDER BY v.sort, v.name)
      FROM variants v
      LEFT JOIN inventory i ON i.variant_id=v.id AND i.store_id=$2
      LEFT JOIN store_prices sp ON sp.variant_id=v.id AND sp.store_id=$2
      WHERE v.product_id=p.id AND v.active), '[]') AS variants
  FROM products p LEFT JOIN categories c ON c.id=p.category_id
  WHERE p.business_id=$1 ${where}`;

r.get('/products', ah(async (req, res) => {
  const params: any[] = [req.auth.businessId, req.storeId];
  let where = req.query.include_inactive ? '' : ' AND p.active';
  if (req.query.q) {
    const i = params.push(`%${req.query.q}%`);
    where += ` AND (p.name ILIKE $${i} OR EXISTS (SELECT 1 FROM variants v WHERE v.product_id=p.id AND (v.sku ILIKE $${i} OR v.barcode ILIKE $${i})))`;
  }
  if (req.query.category_id) where += ` AND p.category_id=$${params.push(req.query.category_id)}`;
  res.json(await db.query(productQuery(where) + ' ORDER BY p.name', params));
}));

r.get('/products/:id', ah(async (req, res) => {
  const p = await db.one(productQuery(' AND p.id=$3'), [req.auth.businessId, req.storeId, req.params.id]);
  if (!p) throw notFound('Product');
  res.json(p);
}));

async function saveProduct(q: Q, req: any, id: string | null) {
  const b = req.body || {};
  if (!b.name) throw bad('Name is required');
  const variants: any[] = Array.isArray(b.variants) && b.variants.length ? b.variants : [{ name: '', price: b.price || 0, cost: b.cost || 0 }];
  for (const v of variants) {
    if (v.barcode) {
      const dup = await q.one(`SELECT p.name FROM variants v JOIN products p ON p.id=v.product_id WHERE v.business_id=$1 AND v.barcode=$2 AND v.active AND v.id <> COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000')`, [req.auth.businessId, v.barcode, v.id || null]);
      if (dup) throw bad(`Barcode ${v.barcode} is already used by ${dup.name}`);
    }
  }
  const vals = [b.name, b.category_id || null, b.description || null, b.type || 'standard', b.unit || 'pcs', b.track_stock !== false,
    json(b.tax_ids || []), b.image_url || null, b.color || null, !!b.is_favorite, json(b.available_store_ids || []), b.active !== false];
  let productId = id;
  if (id) {
    const row = await q.one(
      `UPDATE products SET name=$3, category_id=$4, description=$5, type=$6, unit=$7, track_stock=$8, tax_ids=$9, image_url=$10, color=$11,
         is_favorite=$12, available_store_ids=$13, active=$14 WHERE id=$1 AND business_id=$2 RETURNING id`,
      [id, req.auth.businessId, ...vals],
    );
    if (!row) throw notFound('Product');
  } else {
    const row = await q.one(
      `INSERT INTO products (business_id, name, category_id, description, type, unit, track_stock, tax_ids, image_url, color, is_favorite, available_store_ids, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [req.auth.businessId, ...vals],
    );
    productId = row!.id;
  }
  const keep: string[] = [];
  for (const [i, v] of variants.entries()) {
    const vv = [v.name || '', v.sku || null, v.barcode || null, num(v.price), num(v.cost), v.wholesale_price === '' || v.wholesale_price == null ? null : num(v.wholesale_price), num(v.reorder_level), i];
    let vid = v.id;
    if (vid) {
      const row = await q.one(
        `UPDATE variants SET name=$3, sku=$4, barcode=$5, price=$6, cost=$7, wholesale_price=$8, reorder_level=$9, sort=$10, active=true
          WHERE id=$1 AND product_id=$2 RETURNING id`, [vid, productId, ...vv]);
      if (!row) vid = null;
    }
    if (!vid) {
      const row = await q.one(
        `INSERT INTO variants (business_id, product_id, name, sku, barcode, price, cost, wholesale_price, reorder_level, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [req.auth.businessId, productId, ...vv]);
      vid = row!.id;
      if (req.storeId && num(v.stock) && b.track_stock !== false) {
        await q.query(`INSERT INTO inventory (store_id, variant_id, qty) VALUES ($1,$2,$3) ON CONFLICT (store_id, variant_id) DO UPDATE SET qty=inventory.qty+$3`, [req.storeId, vid, num(v.stock)]);
        await q.query(`INSERT INTO stock_movements (business_id, store_id, variant_id, qty_change, qty_after, reason, user_id, note) VALUES ($1,$2,$3,$4,$4,'opening',$5,'Opening stock')`, [req.auth.businessId, req.storeId, vid, num(v.stock), req.auth.userId]);
      }
    }
    keep.push(vid);
    // Store-specific price override for the current store
    if (req.storeId && v.store_price !== undefined) {
      if (v.store_price === null || v.store_price === '') await q.query(`DELETE FROM store_prices WHERE store_id=$1 AND variant_id=$2`, [req.storeId, vid]);
      else await q.query(`INSERT INTO store_prices VALUES ($1,$2,$3) ON CONFLICT (store_id, variant_id) DO UPDATE SET price=$3`, [req.storeId, vid, num(v.store_price)]);
    }
    if (Array.isArray(v.components)) {
      await q.query(`DELETE FROM product_components WHERE variant_id=$1`, [vid]);
      for (const c of v.components)
        if (c.component_variant_id && num(c.qty) > 0 && c.component_variant_id !== vid)
          await q.query(`INSERT INTO product_components VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [vid, c.component_variant_id, num(c.qty)]);
    }
  }
  await q.query(`UPDATE variants SET active=false WHERE product_id=$1 AND NOT (id = ANY($2::uuid[]))`, [productId, keep]);
  if (Array.isArray(b.modifier_group_ids)) {
    await q.query(`DELETE FROM product_modifier_groups WHERE product_id=$1`, [productId]);
    for (const g of b.modifier_group_ids) await q.query(`INSERT INTO product_modifier_groups VALUES ($1,$2) ON CONFLICT DO NOTHING`, [productId, g]);
  }
  return productId!;
}

r.post('/products', requirePerm('products.manage'), ah(async (req, res) => {
  const id = await tx((q) => saveProduct(q, req, null));
  await audit(req, 'create', 'products', id, { name: req.body.name });
  res.status(201).json(await db.one(productQuery(' AND p.id=$3'), [req.auth.businessId, req.storeId, id]));
}));

r.put('/products/:id', requirePerm('products.manage'), ah(async (req, res) => {
  const id = await tx((q) => saveProduct(q, req, req.params.id));
  await audit(req, 'update', 'products', id, { name: req.body.name });
  res.json(await db.one(productQuery(' AND p.id=$3'), [req.auth.businessId, req.storeId, id]));
}));

r.delete('/products/:id', requirePerm('products.manage'), ah(async (req, res) => {
  await db.query(`UPDATE products SET active=false WHERE id=$1 AND business_id=$2`, [req.params.id, req.auth.businessId]);
  await audit(req, 'deactivate', 'products', req.params.id);
  res.json({ ok: true });
}));

// Bulk operations: activate/deactivate, category, tax, price change by percent
r.post('/products/bulk', requirePerm('products.manage'), ah(async (req, res) => {
  const { ids, action, value } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) throw bad('Select products');
  const bid = req.auth.businessId;
  if (action === 'activate' || action === 'deactivate')
    await db.query(`UPDATE products SET active=$3 WHERE business_id=$1 AND id = ANY($2::uuid[])`, [bid, ids, action === 'activate']);
  else if (action === 'category')
    await db.query(`UPDATE products SET category_id=$3 WHERE business_id=$1 AND id = ANY($2::uuid[])`, [bid, ids, value || null]);
  else if (action === 'tax')
    await db.query(`UPDATE products SET tax_ids=$3 WHERE business_id=$1 AND id = ANY($2::uuid[])`, [bid, ids, json(value || [])]);
  else if (action === 'price_pct')
    await db.query(`UPDATE variants SET price=ROUND(price * (1 + $3::numeric/100), 2) WHERE business_id=$1 AND product_id = ANY($2::uuid[])`, [bid, ids, num(value)]);
  else throw bad('Unknown action');
  await audit(req, `bulk_${action}`, 'products', null, { ids, value });
  res.json({ ok: true, count: ids.length });
}));

// Generate internal EAN-13 barcodes (prefix 200) for variants without one
r.post('/products/generate-barcodes', requirePerm('products.manage'), ah(async (req, res) => {
  const rows = await db.query(`SELECT v.id FROM variants v WHERE v.business_id=$1 AND v.active AND (v.barcode IS NULL OR v.barcode='')`, [req.auth.businessId]);
  let n = 0;
  for (const v of rows) {
    let code = '';
    do {
      const body = '200' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
      const sum = body.split('').reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
      code = body + ((10 - (sum % 10)) % 10);
    } while (await db.one(`SELECT 1 FROM variants WHERE business_id=$1 AND barcode=$2`, [req.auth.businessId, code]));
    await db.query(`UPDATE variants SET barcode=$2 WHERE id=$1`, [v.id, code]);
    n++;
  }
  await audit(req, 'generate_barcodes', 'variants', null, { count: n });
  res.json({ ok: true, count: n });
}));

// CSV import (rows parsed client-side). Rows sharing a name become variants of one product.
r.post('/products/import', requirePerm('products.manage'), ah(async (req, res) => {
  const rows: any[] = req.body?.rows || [];
  if (!rows.length) throw bad('No rows to import');
  const bid = req.auth.businessId;
  const result = await tx(async (q) => {
    const catCache = new Map<string, string>();
    const taxes = await q.query(`SELECT id, name FROM taxes WHERE business_id=$1`, [bid]);
    const groups = new Map<string, any[]>();
    for (const row of rows) {
      const name = String(row.name || row.Name || '').trim();
      if (!name) continue;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(row);
    }
    let created = 0;
    for (const [name, items] of groups) {
      const first = items[0];
      const catName = String(first.category || '').trim();
      let catId: string | null = null;
      if (catName) {
        catId = catCache.get(catName) ?? (await q.one(`SELECT id FROM categories WHERE business_id=$1 AND lower(name)=lower($2)`, [bid, catName]))?.id ?? null;
        if (!catId) catId = (await q.one(`INSERT INTO categories (business_id, name) VALUES ($1,$2) RETURNING id`, [bid, catName]))!.id;
        catCache.set(catName, catId!);
      }
      const tax = taxes.find((t) => t.name.toLowerCase() === String(first.tax || '').toLowerCase());
      const fakeReq = {
        ...req,
        body: {
          name, category_id: catId, description: first.description, track_stock: String(first.track_stock ?? 'true') !== 'false',
          tax_ids: tax ? [tax.id] : [], unit: first.unit || 'pcs',
          variants: items.map((it) => ({ name: it.variant || '', sku: it.sku, barcode: it.barcode, price: num(it.price), cost: num(it.cost), stock: num(it.stock), reorder_level: num(it.reorder_level) })),
        },
      };
      const existing = await q.one(`SELECT id FROM products WHERE business_id=$1 AND lower(name)=lower($2) AND active`, [bid, name]);
      await saveProduct(q, fakeReq, existing?.id ?? null);
      created++;
    }
    return created;
  });
  await audit(req, 'import', 'products', null, { count: result });
  res.json({ ok: true, count: result });
}));

export default r;
