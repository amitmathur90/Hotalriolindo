import { Router } from 'express';
import { db, json, tx, type Q } from '../db.ts';
import { hasPermOrApproval, requirePerm, requireStore, requireUser } from '../auth.ts';
import { HttpError, ah, audit, bad, notFound, notify, num, range, receiptSig } from '../util.ts';
import { applyStock, type StockCtx } from '../stock.ts';
import { emit } from '../realtime.ts';
import { computeCart, r2, type Discount, type TaxDef } from '../../../shared/pricing.ts';
import { cleanReceptor, issueDocument, issueRefundNote, kickQueue } from '../hacienda/service.ts';
import { DEFAULT_RESOLUTION } from '../hacienda/codes.ts';

const r = Router();
export { receiptSig };

// ---------------------------------------------------------------- POS catalog (cached offline by the POS)
r.get('/pos/catalog', requireStore, ah(async (req, res) => {
  const bid = req.auth.businessId;
  const sid = req.storeId;
  const [business, store, categories, products, modifierGroups, taxes, paymentMethods, discounts, tables] = await Promise.all([
    db.one(`SELECT * FROM businesses WHERE id=$1`, [bid]),
    db.one(`SELECT * FROM stores WHERE id=$1`, [sid]),
    db.query(`SELECT * FROM categories WHERE business_id=$1 ORDER BY sort, name`, [bid]),
    db.query(
      `SELECT p.id, p.name, p.category_id, p.type, p.unit, p.track_stock, p.tax_ids, p.image_url, p.color, p.is_favorite,
         COALESCE((SELECT json_agg(g.group_id) FROM product_modifier_groups g WHERE g.product_id=p.id), '[]') AS modifier_group_ids,
         (SELECT json_agg(json_build_object('id', v.id, 'name', v.name, 'sku', v.sku, 'barcode', v.barcode,
             'price', COALESCE(sp.price, v.price), 'stock', i.qty) ORDER BY v.sort)
            FROM variants v LEFT JOIN inventory i ON i.variant_id=v.id AND i.store_id=$2
            LEFT JOIN store_prices sp ON sp.variant_id=v.id AND sp.store_id=$2
           WHERE v.product_id=p.id AND v.active) AS variants
       FROM products p WHERE p.business_id=$1 AND p.active
        AND (jsonb_array_length(p.available_store_ids)=0 OR p.available_store_ids ? $2::text)
       ORDER BY p.name`, [bid, sid]),
    db.query(`SELECT * FROM modifier_groups WHERE business_id=$1`, [bid]),
    db.query(`SELECT * FROM taxes WHERE business_id=$1 AND active`, [bid]),
    db.query(`SELECT * FROM payment_methods WHERE business_id=$1 AND active AND (jsonb_array_length(store_ids)=0 OR store_ids ? $2::text) ORDER BY sort`, [bid, sid]),
    db.query(`SELECT * FROM discounts WHERE business_id=$1 AND active ORDER BY name`, [bid]),
    db.query(`SELECT * FROM restaurant_tables WHERE store_id=$1 ORDER BY sort, name`, [sid]),
  ]);
  const hs = await db.one(`SELECT enabled, environment FROM hacienda_settings WHERE business_id=$1`, [bid]);
  const einvoice = { enabled: !!hs?.enabled, environment: hs?.environment ?? null };
  res.json({ business, store, categories, products: products.filter((p) => p.variants?.length), modifierGroups, taxes, paymentMethods, discounts, tables, einvoice, at: new Date().toISOString() });
}));

// ---------------------------------------------------------------- line resolution shared by checkout & tickets
interface CartItemIn {
  variant_id: string;
  qty: number;
  modifier_ids?: string[];
  discount?: Discount & { discount_id?: string };
  custom_price?: number | null;
  note?: string;
  sent?: boolean;
  line_id?: string;
}

async function resolveDiscount(q: Q, req: any, d: any, approvals: any): Promise<Discount> {
  if (!d) return null;
  if (d.discount_id) {
    const row = await q.one(`SELECT * FROM discounts WHERE id=$1 AND business_id=$2 AND active`, [d.discount_id, req.auth.businessId]);
    if (!row) throw bad('Discount no longer available');
    if (row.restricted && !hasPermOrApproval(req, 'pos.discount', approvals?.discount).ok) throw new HttpError(403, `"${row.name}" needs manager approval`);
    return { type: row.type, value: Number(row.value) };
  }
  if (!num(d.value)) return null;
  if (!hasPermOrApproval(req, 'pos.discount', approvals?.discount).ok) throw new HttpError(403, 'Custom discounts need manager approval');
  return { type: d.type === 'fixed' ? 'fixed' : 'percent', value: num(d.value) };
}

async function resolveLines(q: Q, req: any, items: CartItemIn[], storeId: string, approvals: any, trustPrices = false) {
  if (!Array.isArray(items) || !items.length) throw bad('Cart is empty');
  const ids = [...new Set(items.map((i) => i.variant_id))];
  const variants = await q.query(
    `SELECT v.id, v.name AS variant_name, v.cost, COALESCE(sp.price, v.price) AS price, p.id AS product_id, p.name AS product_name,
            p.category_id, p.tax_ids, p.type, c.kitchen_station,
            COALESCE((SELECT json_agg(g.group_id) FROM product_modifier_groups g WHERE g.product_id=p.id), '[]') AS group_ids
       FROM variants v JOIN products p ON p.id=v.product_id LEFT JOIN categories c ON c.id=p.category_id
       LEFT JOIN store_prices sp ON sp.variant_id=v.id AND sp.store_id=$3
      WHERE v.business_id=$1 AND v.id = ANY($2::uuid[])`,
    [req.auth.businessId, ids, storeId],
  );
  const vmap = new Map(variants.map((v) => [v.id, v]));
  const taxRows = await q.query(`SELECT * FROM taxes WHERE business_id=$1`, [req.auth.businessId]);
  const taxMap = new Map(taxRows.map((t) => [t.id, t]));
  const groups = await q.query(`SELECT * FROM modifier_groups WHERE business_id=$1`, [req.auth.businessId]);
  const gmap = new Map(groups.map((g) => [g.id, g]));

  const lines: any[] = [];
  for (const it of items) {
    const v = vmap.get(it.variant_id);
    if (!v) throw bad('An item in the cart no longer exists');
    const qty = num(it.qty);
    if (qty <= 0) throw bad(`Invalid quantity for ${v.product_name}`);
    // Modifiers: only options belonging to this product's groups; enforce min/max per group
    const mods: { id: string; name: string; price: number; group: string }[] = [];
    for (const gid of v.group_ids as string[]) {
      const g = gmap.get(gid);
      if (!g) continue;
      const chosen = (g.options as any[]).filter((o) => (it.modifier_ids || []).includes(o.id));
      if (chosen.length < g.min_select) throw bad(`${v.product_name}: choose at least ${g.min_select} ${g.name}`);
      if (g.max_select > 0 && chosen.length > g.max_select) throw bad(`${v.product_name}: choose at most ${g.max_select} ${g.name}`);
      for (const o of chosen) mods.push({ id: o.id, name: o.name, price: num(o.price), group: g.name });
    }
    let base = Number(v.price);
    if (it.custom_price != null && it.custom_price !== ('' as any) && num(it.custom_price) !== base) {
      if (!trustPrices && !hasPermOrApproval(req, 'pos.custom_price', approvals?.price).ok) throw new HttpError(403, 'Changing prices needs manager approval');
      base = num(it.custom_price);
    }
    const unit_price = r2(base + mods.reduce((s, m) => s + m.price, 0));
    const taxes: TaxDef[] = (v.tax_ids as string[]).map((id) => taxMap.get(id)).filter(Boolean).map((t: any) => ({
      id: t.id, name: t.name, rate: Number(t.rate), inclusive: t.inclusive, is_gst: t.is_gst,
    }));
    lines.push({
      v, qty, mods, unit_price, taxes, note: it.note || null, sent: !!it.sent, line_id: it.line_id,
      discount: await resolveDiscount(q, req, it.discount, approvals),
    });
  }
  return lines;
}

async function sendToKitchen(q: Q, req: any, storeId: string, label: string, lines: any[], meta: { ticket_id?: string | null; sale_id?: string | null; dining_option?: string; table_name?: string | null; priority?: string }) {
  const byStation = new Map<string, any[]>();
  for (const l of lines) {
    const st = l.v?.kitchen_station ?? l.kitchen_station;
    if (!st) continue;
    if (!byStation.has(st)) byStation.set(st, []);
    byStation.get(st)!.push({ name: l.v ? l.v.product_name + (l.v.variant_name ? ` (${l.v.variant_name})` : '') : l.name, qty: l.qty, modifiers: (l.mods || []).map((m: any) => m.name), note: l.note, done: false });
  }
  const created: any[] = [];
  for (const [station, items] of byStation) {
    const ko = await q.one(
      `INSERT INTO kitchen_orders (business_id, store_id, ticket_id, sale_id, order_label, dining_option, table_name, station, items, priority, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.auth.businessId, storeId, meta.ticket_id ?? null, meta.sale_id ?? null, label, meta.dining_option ?? null, meta.table_name ?? null,
       station, json(items), meta.priority || 'normal', req.auth.userId ?? null],
    );
    created.push(ko);
  }
  return created;
}

// ---------------------------------------------------------------- Checkout
r.post('/sales', requireUser, requirePerm('pos.sell'), requireStore, ah(async (req, res) => {
  const b = req.body || {};
  const storeId = req.storeId!;
  const bid = req.auth.businessId;
  if (!b.client_uuid) throw bad('client_uuid is required');

  // Idempotency: a retried / re-synced sale returns the original instead of creating a duplicate
  const existing = await db.one(`SELECT id FROM sales WHERE business_id=$1 AND client_uuid=$2`, [bid, b.client_uuid]);
  if (existing) return res.json({ ...(await loadSale(existing.id, bid)), duplicate: true });

  const offline = !!b.offline;
  // Hacienda: factura electrónica when the customer gave tax details, otherwise a tiquete electrónico
  const feReceptor = b.einvoice?.type === 'FE' ? cleanReceptor(b.einvoice.receptor || {}) : null;
  const kitchenOrders: any[] = [];
  const stockCtx: StockCtx = { businessId: bid, storeId, userId: req.auth.userId, allowNegative: true, lowStock: [], conflicts: [] };

  const saleId = await tx(async (q) => {
    const biz = await q.one(`SELECT * FROM businesses WHERE id=$1`, [bid]);
    stockCtx.allowNegative = offline || biz!.allow_negative_stock;
    const approvals = b.approvals || {};
    const lines = await resolveLines(q, req, b.items, storeId, approvals, offline);
    const orderDiscount = await resolveDiscount(q, req, b.order_discount, approvals);
    const cart = computeCart(
      lines.map((l) => ({ unit_price: l.unit_price, qty: l.qty, discount: l.discount, taxes: l.taxes })),
      orderDiscount,
      { service_charge_pct: b.dining_option === 'dine_in' ? Number(biz!.service_charge_pct) : 0, tip: num(b.tip) },
    );

    // Customer & loyalty
    let customer: any = null;
    if (b.customer_id) {
      customer = await q.one(`SELECT * FROM customers WHERE id=$1 AND business_id=$2`, [b.customer_id, bid]);
      if (!customer) throw bad('Customer not found');
    }

    // Payments
    const methods = await q.query(`SELECT * FROM payment_methods WHERE business_id=$1`, [bid]);
    const pays: any[] = [];
    for (const p of b.payments || []) {
      const amount = r2(num(p.amount));
      if (amount <= 0) continue;
      if (p.method_type === 'loyalty') {
        if (!customer) throw bad('Select a customer to redeem points');
        const points = r2(amount / Number(biz!.point_value));
        if (points > Number(customer.points)) throw bad(`Customer has only ${customer.points} points`);
        if (points < biz!.min_redeem_points) throw bad(`Minimum ${biz!.min_redeem_points} points to redeem`);
        pays.push({ method_id: null, method_name: 'Loyalty points', method_type: 'loyalty', amount, reference: `${points} pts`, points });
        continue;
      }
      const m = methods.find((x) => x.id === p.method_id);
      if (!m) throw bad('Unknown payment method');
      pays.push({ method_id: m.id, method_name: m.name, method_type: m.type, amount, reference: p.reference || null });
    }
    const paid = r2(pays.reduce((s, p) => s + p.amount, 0));
    if (paid + 0.004 < cart.total) throw bad(`Payment short by ${r2(cart.total - paid)}`);
    const change = r2(paid - cart.total);
    const cashPaid = pays.filter((p) => p.method_type === 'cash').reduce((s, p) => s + p.amount, 0);
    if (change > 0.004 && change > cashPaid + 0.004) throw bad('Only cash payments can give change');

    // Gift cards & store credit
    for (const p of pays) {
      if (p.method_type === 'gift_card') {
        const gc = await q.one(`SELECT * FROM gift_cards WHERE business_id=$1 AND upper(code)=upper($2) AND active`, [bid, p.reference || '']);
        if (!gc) throw bad('Gift card not found');
        if (gc.expires_on && new Date(gc.expires_on) < new Date()) throw bad('Gift card expired');
        if (Number(gc.balance) + 0.004 < p.amount) throw bad(`Gift card balance is only ${gc.balance}`);
        p.gift_card_id = gc.id;
      }
      if (p.method_type === 'store_credit') {
        if (!customer) throw bad('Select a customer to use store credit');
        if (Number(customer.store_credit) + 0.004 < p.amount) throw bad(`Store credit is only ${customer.store_credit}`);
      }
    }

    // Receipt number (per store sequence)
    const seqRow = await q.one(`UPDATE stores SET receipt_seq = receipt_seq + 1 WHERE id=$1 RETURNING receipt_seq`, [storeId]);
    const receiptNo = `${String(seqRow!.receipt_seq).padStart(6, '0')}`;
    const shift = await q.one(
      `SELECT id FROM shifts WHERE store_id=$1 AND status='open' ORDER BY (device_id IS NOT DISTINCT FROM $2) DESC, opened_at DESC LIMIT 1`,
      [storeId, req.auth.deviceId ?? null],
    );
    const costTotal = r2(lines.reduce((s, l) => s + Number(l.v.cost) * l.qty, 0));
    const ticket = b.ticket_id ? await q.one(`SELECT * FROM open_tickets WHERE id=$1 AND store_id=$2`, [b.ticket_id, storeId]) : null;
    const table = b.table_id ? await q.one(`SELECT * FROM restaurant_tables WHERE id=$1 AND store_id=$2`, [b.table_id, storeId]) : null;

    const pointsRedeemed = pays.filter((p) => p.method_type === 'loyalty').reduce((s, p) => s + p.points, 0);
    const earnBase = cart.total - pays.filter((p) => p.method_type === 'loyalty').reduce((s, p) => s + p.amount, 0);
    const pointsEarned = customer && biz!.loyalty_enabled ? Math.floor(earnBase / Number(biz!.points_per_amount)) : 0;

    const sale = await q.one(
      `INSERT INTO sales (business_id, store_id, client_uuid, device_id, receipt_no, user_id, customer_id, shift_id, dining_option, table_name, ticket_name,
         subtotal, discount_total, tax_total, service_charge, tip, total, cost_total, paid, change, points_earned, points_redeemed, order_discount, tax_summary,
         note, offline, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26, COALESCE($27::timestamptz, now()))
       RETURNING id, created_at`,
      [bid, storeId, b.client_uuid, req.auth.deviceId ?? null, receiptNo, req.auth.userId, customer?.id ?? null, shift?.id ?? null,
       b.dining_option || null, table?.name ?? null, ticket?.name ?? null, cart.subtotal, cart.discount_total, cart.tax_total, cart.service_charge,
       cart.tip, cart.total, costTotal, paid, change, pointsEarned, pointsRedeemed, json(orderDiscount), json(cart.tax_summary), b.note || null,
       offline, offline && b.created_at ? b.created_at : null],
    );
    const sid = sale!.id;

    for (const [i, l] of lines.entries()) {
      const c = cart.lines[i];
      await q.query(
        `INSERT INTO sale_items (sale_id, variant_id, product_id, category_id, product_name, variant_name, qty, unit_price, modifiers, gross, discount, tax, total, cost, taxes, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [sid, l.v.id, l.v.product_id, l.v.category_id, l.v.product_name, l.v.variant_name || null, l.qty, l.unit_price, json(l.mods), c.gross,
         r2(c.line_discount + c.order_discount), c.tax, c.total, r2(Number(l.v.cost) * l.qty), json(c.taxes), l.note],
      );
      await applyStock(q, stockCtx, l.v.id, -l.qty, 'sale', { type: 'sale', id: sid });
    }
    for (const p of pays) {
      await q.query(`INSERT INTO sale_payments (sale_id, method_id, method_name, method_type, amount, reference) VALUES ($1,$2,$3,$4,$5,$6)`, [
        sid, p.method_id, p.method_name, p.method_type, p.method_type === 'cash' ? r2(p.amount - Math.min(change, p.amount)) : p.amount, p.reference,
      ]);
      if (p.gift_card_id) {
        await q.query(`UPDATE gift_cards SET balance = balance - $2 WHERE id=$1`, [p.gift_card_id, p.amount]);
        await q.query(`INSERT INTO gift_card_transactions (gift_card_id, sale_id, amount, type, user_id) VALUES ($1,$2,$3,'redeem',$4)`, [p.gift_card_id, sid, -p.amount, req.auth.userId]);
      }
      if (p.method_type === 'store_credit') await q.query(`UPDATE customers SET store_credit = store_credit - $2 WHERE id=$1`, [customer.id, p.amount]);
    }
    if (customer) {
      await q.query(
        `UPDATE customers SET total_spent = total_spent + $2, visits = visits + 1, last_visit_at = now(), points = points + $3 - $4 WHERE id=$1`,
        [customer.id, cart.total, pointsEarned, pointsRedeemed],
      );
      if (pointsEarned) await q.query(`INSERT INTO loyalty_transactions (business_id, customer_id, sale_id, points, type, user_id) VALUES ($1,$2,$3,$4,'earn',$5)`, [bid, customer.id, sid, pointsEarned, req.auth.userId]);
      if (pointsRedeemed) await q.query(`INSERT INTO loyalty_transactions (business_id, customer_id, sale_id, points, type, user_id) VALUES ($1,$2,$3,$4,'redeem',$5)`, [bid, customer.id, sid, -pointsRedeemed, req.auth.userId]);
    }

    // Electronic invoicing (no-op until enabled in Settings → Hacienda)
    const edoc = await issueDocument(q, {
      businessId: bid, storeId, saleId: sid, docType: feReceptor ? '01' : '04', issuedAt: new Date(sale!.created_at), offline,
      receptor: feReceptor, userId: req.auth.userId,
    });
    if (feReceptor && !edoc && !offline) throw bad('La facturación electrónica no está activada (Configuración → Hacienda)');
    if (feReceptor && customer) {
      await q.query(`UPDATE customers SET tax_id=$2, id_type=$3, email=COALESCE(NULLIF($4,''), email), activity_code=COALESCE($5, activity_code) WHERE id=$1`,
        [customer.id, feReceptor.id_number, feReceptor.id_type, feReceptor.email || '', feReceptor.activity_code]);
    }

    // Restaurant: send unsent items to kitchen, close ticket, free table
    const label = ticket?.name || table?.name || `#${receiptNo}`;
    if (b.send_to_kitchen !== false) {
      const unsent = lines.filter((l) => !l.sent);
      kitchenOrders.push(...(await sendToKitchen(q, req, storeId, label, unsent, { sale_id: sid, ticket_id: ticket?.id, dining_option: b.dining_option, table_name: table?.name })));
    }
    if (ticket) {
      await q.query(`UPDATE kitchen_orders SET sale_id=$2 WHERE ticket_id=$1`, [ticket.id, sid]);
      await q.query(`DELETE FROM open_tickets WHERE id=$1`, [ticket.id]);
    }
    const tableId = table?.id ?? ticket?.table_id;
    if (tableId) {
      const others = await q.one(`SELECT 1 FROM open_tickets WHERE table_id=$1`, [tableId]);
      if (!others) await q.query(`UPDATE restaurant_tables SET status='available' WHERE id=$1`, [tableId]);
    }
    await audit(req, 'sale', 'sales', sid, { receipt_no: receiptNo, total: cart.total, offline }, q);
    return sid;
  });

  kickQueue();
  for (const ko of kitchenOrders) emit(`store:${storeId}`, 'kitchen:new', ko);
  for (const ls of stockCtx.lowStock)
    await notify(bid, storeId, ls.qty <= 0 ? 'out_of_stock' : 'low_stock', `${ls.name}: ${ls.qty <= 0 ? 'out of stock' : `low stock (${ls.qty} left)`}`, ls);
  if (stockCtx.conflicts.length)
    await notify(bid, storeId, 'negative_stock', `Offline sale caused negative stock: ${stockCtx.conflicts.map((c) => c.name).join(', ')}`, stockCtx.conflicts);
  const sale = await loadSale(saleId, bid);
  emit(`business:${bid}`, 'sale:created', { id: saleId, store_id: storeId, total: sale.total });
  emit(`store:${storeId}`, 'tables:changed', {});
  res.status(201).json(sale);
}));

export async function loadSale(id: string, businessId: string): Promise<any> {
  const sale = await db.one(
    `SELECT s.*, u.name AS employee_name, c.name AS customer_name, c.phone AS customer_phone, c.tax_id AS customer_tax_id, c.email AS customer_email, c.id_type AS customer_id_type, c.points AS customer_points, st.name AS store_name,
            st.address AS store_address, st.phone AS store_phone, st.gstin AS store_gstin, st.gst_mode, st.receipt_header
       FROM sales s LEFT JOIN users u ON u.id=s.user_id LEFT JOIN customers c ON c.id=s.customer_id JOIN stores st ON st.id=s.store_id
      WHERE s.id=$1 AND s.business_id=$2`, [id, businessId]);
  if (!sale) throw notFound('Receipt');
  const [items, payments, refunds, e_documents, hs] = await Promise.all([
    db.query(`SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY ctid`, [id]),
    db.query(`SELECT * FROM sale_payments WHERE sale_id=$1`, [id]),
    db.query(`SELECT id, receipt_no, total, created_at, refund_reason FROM sales WHERE original_sale_id=$1 ORDER BY created_at`, [id]),
    db.query(`SELECT id, doc_type, clave, consecutivo, status, message, issued_at, receptor, reference, replaced_by, emailed_at, environment
                FROM e_documents WHERE sale_id=$1 ORDER BY created_at`, [id]),
    db.one(`SELECT resolution_text FROM hacienda_settings WHERE business_id=$1`, [businessId]),
  ]);
  return { ...sale, items, payments, refunds, e_documents, e_resolution: e_documents.length ? hs?.resolution_text || DEFAULT_RESOLUTION : null, share_sig: receiptSig(id) };
}

// ---------------------------------------------------------------- Receipts / history
r.get('/sales', ah(async (req, res) => {
  if (!req.auth.permissions.has('reports.view') && !req.auth.permissions.has('pos.sell')) throw new HttpError(403, 'Not allowed');
  const { from, to } = range(req);
  const params: any[] = [req.auth.businessId, from, to];
  let where = `s.business_id=$1 AND s.created_at >= $2 AND s.created_at < $3`;
  const store = req.query.store_id || (req.query.all_stores ? null : req.storeId);
  if (store) where += ` AND s.store_id=$${params.push(store)}`;
  if (req.query.employee_id) where += ` AND s.user_id=$${params.push(req.query.employee_id)}`;
  if (req.query.type) where += ` AND s.type=$${params.push(req.query.type)}`;
  if (req.query.q) {
    const i = params.push(`%${req.query.q}%`);
    where += ` AND (s.receipt_no ILIKE $${i} OR c.name ILIKE $${i} OR c.phone ILIKE $${i})`;
  }
  // Cashiers without report access only see their own store's last 200 receipts
  res.json(await db.query(
    `SELECT s.id, s.receipt_no, s.type, s.status, s.total, s.created_at, s.dining_option, s.offline, s.store_id, st.name AS store_name,
            u.name AS employee_name, c.name AS customer_name,
            (SELECT string_agg(DISTINCT p.method_name, ', ') FROM sale_payments p WHERE p.sale_id=s.id) AS methods
       FROM sales s LEFT JOIN users u ON u.id=s.user_id LEFT JOIN customers c ON c.id=s.customer_id JOIN stores st ON st.id=s.store_id
      WHERE ${where} ORDER BY s.created_at DESC LIMIT ${Math.min(num(req.query.limit, 500), 2000)}`, params));
}));

r.get('/sales/:id', ah(async (req, res) => res.json(await loadSale(req.params.id, req.auth.businessId))));

// ---------------------------------------------------------------- Refunds
r.post('/sales/:id/refund', requireUser, ah(async (req, res) => {
  const b = req.body || {};
  const bid = req.auth.businessId;
  const approval = hasPermOrApproval(req, 'pos.refund', b.approval_token);
  if (!approval.ok) throw new HttpError(403, 'Refunds need manager approval');
  if (!b.reason) throw bad('Refund reason is required');
  const clientUuid = b.client_uuid || crypto.randomUUID();
  const dup = await db.one(`SELECT id FROM sales WHERE business_id=$1 AND client_uuid=$2`, [bid, clientUuid]);
  if (dup) return res.json(await loadSale(dup.id, bid));
  const stockCtx: StockCtx = { businessId: bid, storeId: '', userId: req.auth.userId, allowNegative: true, lowStock: [], conflicts: [] };

  const refundId = await tx(async (q) => {
    const sale = await q.one(`SELECT * FROM sales WHERE id=$1 AND business_id=$2 AND type='sale' FOR UPDATE`, [req.params.id, bid]);
    if (!sale) throw notFound('Sale');
    stockCtx.storeId = sale.store_id;
    const items = await q.query(`SELECT * FROM sale_items WHERE sale_id=$1`, [sale.id]);
    const req_items: { sale_item_id: string; qty: number }[] = b.items?.length
      ? b.items
      : items.map((i) => ({ sale_item_id: i.id, qty: Number(i.qty) - Number(i.refunded_qty) })); // full refund
    let amount = 0, tax = 0, discount = 0, gross = 0, cost = 0;
    const out: any[] = [];
    for (const ri of req_items) {
      const it = items.find((x) => x.id === ri.sale_item_id);
      const qty = num(ri.qty);
      if (!it || qty <= 0) continue;
      const remaining = Number(it.qty) - Number(it.refunded_qty);
      if (qty > remaining + 1e-9) throw bad(`Only ${remaining} of ${it.product_name} can be refunded`);
      const f = qty / Number(it.qty);
      const line = { it, qty, f, total: r2(Number(it.total) * f), tax: r2(Number(it.tax) * f), discount: r2(Number(it.discount) * f), gross: r2(Number(it.gross) * f), cost: r2(Number(it.cost) * f) };
      amount += line.total; tax += line.tax; discount += line.discount; gross += line.gross; cost += line.cost;
      out.push(line);
    }
    if (!out.length) throw bad('Nothing to refund');
    const fullyRefunded = items.every((it) => {
      const line = out.find((o) => o.it.id === it.id);
      return Number(it.refunded_qty) + (line?.qty || 0) >= Number(it.qty) - 1e-9;
    });
    // Service charge and tip are returned on the final refund
    const extras = fullyRefunded ? r2(Number(sale.service_charge) + Number(sale.tip)) : 0;
    amount = r2(amount + extras);

    const seqRow = await q.one(`UPDATE stores SET receipt_seq = receipt_seq + 1 WHERE id=$1 RETURNING receipt_seq`, [sale.store_id]);
    const shift = await q.one(`SELECT id FROM shifts WHERE store_id=$1 AND status='open' ORDER BY opened_at DESC LIMIT 1`, [sale.store_id]);
    const ref = await q.one(
      `INSERT INTO sales (business_id, store_id, client_uuid, device_id, receipt_no, type, original_sale_id, user_id, customer_id, shift_id, status,
         subtotal, discount_total, tax_total, service_charge, tip, total, cost_total, paid, refund_reason)
       VALUES ($1,$2,$3,$4,$5,'refund',$6,$7,$8,$9,'completed',$10,$11,$12,$13,$14,$15,$16,$15,$17) RETURNING id`,
      [bid, sale.store_id, clientUuid, req.auth.deviceId ?? null, `${String(seqRow!.receipt_seq).padStart(6, '0')}`, sale.id, req.auth.userId,
       sale.customer_id, shift?.id ?? null, r2(gross), r2(discount), r2(tax), fullyRefunded ? sale.service_charge : 0, fullyRefunded ? sale.tip : 0,
       amount, r2(cost), b.reason],
    );
    for (const l of out) {
      await q.query(
        `INSERT INTO sale_items (sale_id, original_item_id, variant_id, product_id, category_id, product_name, variant_name, qty, unit_price, modifiers, gross, discount, tax, total, cost, taxes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [ref!.id, l.it.id, l.it.variant_id, l.it.product_id, l.it.category_id, l.it.product_name, l.it.variant_name, l.qty, l.it.unit_price,
         json(l.it.modifiers), l.gross, l.discount, l.tax, l.total, l.cost,
         json((l.it.taxes || []).map((t: any) => ({ ...t, taxable: r2(t.taxable * l.f), amount: r2(t.amount * l.f) })))],
      );
      await q.query(`UPDATE sale_items SET refunded_qty = refunded_qty + $2 WHERE id=$1`, [l.it.id, l.qty]);
      if (b.restock !== false && l.it.variant_id) await applyStock(q, stockCtx, l.it.variant_id, l.qty, 'refund', { type: 'refund', id: ref!.id });
    }

    // Return money to the original payment methods, proportionally (or all to one chosen method)
    const pays = await q.query(`SELECT * FROM sale_payments WHERE sale_id=$1`, [sale.id]);
    const prevRefunded = Number((await q.one(`SELECT COALESCE(SUM(total),0) AS t FROM sales WHERE original_sale_id=$1 AND id<>$2`, [sale.id, ref!.id]))!.t);
    const paidTotal = pays.reduce((s, p) => s + Number(p.amount), 0);
    let left = amount;
    const refundPays: any[] = [];
    if (b.method_id) {
      const m = await q.one(`SELECT * FROM payment_methods WHERE id=$1 AND business_id=$2`, [b.method_id, bid]);
      if (!m) throw bad('Unknown refund method');
      refundPays.push({ method_id: m.id, method_name: m.name, method_type: m.type, amount, reference: null });
    } else {
      for (const [i, p] of pays.entries()) {
        const share = i === pays.length - 1 ? r2(left) : r2((amount * Number(p.amount)) / paidTotal);
        left = r2(left - share);
        if (share > 0) refundPays.push({ method_id: p.method_id, method_name: p.method_name, method_type: p.method_type, amount: share, reference: p.reference });
      }
    }
    if (prevRefunded + amount > Number(sale.total) + 0.01) throw bad('Refund exceeds sale total');
    for (const p of refundPays) {
      await q.query(`INSERT INTO sale_payments (sale_id, method_id, method_name, method_type, amount, reference) VALUES ($1,$2,$3,$4,$5,$6)`, [
        ref!.id, p.method_id, p.method_name, p.method_type, p.amount, p.reference,
      ]);
      if (p.method_type === 'gift_card' && p.reference) {
        const gc = await q.one(`UPDATE gift_cards SET balance = balance + $3 WHERE business_id=$1 AND upper(code)=upper($2) RETURNING id`, [bid, p.reference, p.amount]);
        if (gc) await q.query(`INSERT INTO gift_card_transactions (gift_card_id, sale_id, amount, type, user_id) VALUES ($1,$2,$3,'refund',$4)`, [gc.id, ref!.id, p.amount, req.auth.userId]);
      }
      if (p.method_type === 'store_credit' && sale.customer_id) await q.query(`UPDATE customers SET store_credit = store_credit + $2 WHERE id=$1`, [sale.customer_id, p.amount]);
      if (p.method_type === 'loyalty' && sale.customer_id) {
        const biz = await q.one(`SELECT point_value FROM businesses WHERE id=$1`, [bid]);
        const pts = r2(p.amount / Number(biz!.point_value));
        await q.query(`UPDATE customers SET points = points + $2 WHERE id=$1`, [sale.customer_id, pts]);
        await q.query(`INSERT INTO loyalty_transactions (business_id, customer_id, sale_id, points, type, user_id, note) VALUES ($1,$2,$3,$4,'refund',$5,'Redeemed points returned')`, [bid, sale.customer_id, ref!.id, pts, req.auth.userId]);
      }
    }
    if (sale.customer_id) {
      const ptsBack = Math.floor((Number(sale.points_earned) * amount) / Number(sale.total || 1));
      await q.query(`UPDATE customers SET total_spent = GREATEST(0, total_spent - $2), points = GREATEST(0, points - $3) WHERE id=$1`, [sale.customer_id, amount, ptsBack]);
      if (ptsBack) await q.query(`INSERT INTO loyalty_transactions (business_id, customer_id, sale_id, points, type, user_id, note) VALUES ($1,$2,$3,$4,'refund',$5,'Earned points reversed')`, [bid, sale.customer_id, ref!.id, -ptsBack, req.auth.userId]);
    }
    await q.query(`UPDATE sales SET status=$2 WHERE id=$1`, [sale.id, fullyRefunded ? 'refunded' : 'partially_refunded']);
    // Nota de crédito electrónica referencing the sale's tiquete / factura
    await issueRefundNote(q, { businessId: bid, storeId: sale.store_id, refundSaleId: ref!.id, originalSaleId: sale.id, full: fullyRefunded, reason: b.reason, userId: req.auth.userId });
    await audit(req, 'refund', 'sales', ref!.id, { original: sale.receipt_no, amount, reason: b.reason, approved_by: approval.approver }, q);
    return ref!.id;
  });
  kickQueue();
  emit(`business:${bid}`, 'sale:created', { id: refundId, type: 'refund' });
  res.status(201).json(await loadSale(refundId, bid));
}));

// ---------------------------------------------------------------- Open tickets (saved / held orders)
r.get('/tickets', requireStore, ah(async (req, res) => {
  const mine = !req.auth.permissions.has('pos.all_tickets') && req.auth.kind === 'user';
  const params: any[] = [req.storeId];
  res.json(await db.query(
    `SELECT t.*, u.name AS employee_name, rt.name AS table_name, c.name AS customer_name FROM open_tickets t
       LEFT JOIN users u ON u.id=t.user_id LEFT JOIN restaurant_tables rt ON rt.id=t.table_id LEFT JOIN customers c ON c.id=t.customer_id
      WHERE t.store_id=$1 ${mine ? `AND t.user_id=$${params.push(req.auth.userId)}` : ''} ORDER BY t.updated_at DESC`, params));
}));

// Save (create/update) a ticket; optionally send new items to the kitchen
r.post('/tickets', requireUser, requirePerm('pos.sell'), requireStore, ah(async (req, res) => {
  const b = req.body || {};
  const storeId = req.storeId!;
  let kitchen: any[] = [];
  const ticket = await tx(async (q) => {
    const lines = await resolveLines(q, req, b.cart?.items, storeId, b.cart?.approvals || {});
    const cart = computeCart(lines.map((l) => ({ unit_price: l.unit_price, qty: l.qty, discount: l.discount, taxes: l.taxes })));
    const table = b.table_id ? await q.one(`SELECT * FROM restaurant_tables WHERE id=$1 AND store_id=$2`, [b.table_id, storeId]) : null;
    const name = b.name || table?.name || `Order ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
    let t: any;
    if (b.id) {
      const prev = await q.one(`SELECT * FROM open_tickets WHERE id=$1 AND store_id=$2`, [b.id, storeId]);
      if (!prev) throw notFound('Ticket');
      if (prev.user_id !== req.auth.userId && !req.auth.permissions.has('pos.all_tickets')) throw new HttpError(403, 'This ticket belongs to another employee');
      // Removing items that were already sent to the kitchen needs void permission
      const sentBefore = (prev.cart.items || []).filter((i: any) => i.sent).map((i: any) => i.line_id);
      const stillThere = new Set((b.cart.items || []).filter((i: any) => i.sent).map((i: any) => i.line_id));
      if (sentBefore.some((id: string) => !stillThere.has(id)) && !hasPermOrApproval(req, 'pos.void', b.cart?.approvals?.void).ok)
        throw new HttpError(403, 'Removing items already sent to the kitchen needs manager approval');
      t = await q.one(`UPDATE open_tickets SET name=$2, table_id=$3, customer_id=$4, dining_option=$5, cart=$6, total=$7, updated_at=now() WHERE id=$1 RETURNING *`, [
        b.id, name, table?.id ?? null, b.customer_id || null, b.dining_option || 'dine_in', json(b.cart), cart.total,
      ]);
      if (prev.table_id && prev.table_id !== t.table_id) {
        const others = await q.one(`SELECT 1 FROM open_tickets WHERE table_id=$1`, [prev.table_id]);
        if (!others) await q.query(`UPDATE restaurant_tables SET status='available' WHERE id=$1`, [prev.table_id]);
      }
    } else {
      t = await q.one(
        `INSERT INTO open_tickets (business_id, store_id, user_id, name, table_id, customer_id, dining_option, cart, total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.auth.businessId, storeId, req.auth.userId, name, table?.id ?? null, b.customer_id || null, b.dining_option || 'dine_in', json(b.cart), cart.total],
      );
    }
    if (table) await q.query(`UPDATE restaurant_tables SET status='occupied' WHERE id=$1`, [table.id]);
    if (b.send_to_kitchen) {
      const unsent = lines.filter((l) => !l.sent);
      kitchen = await sendToKitchen(q, req, storeId, name, unsent, { ticket_id: t.id, dining_option: t.dining_option, table_name: table?.name, priority: b.priority });
      const items = (b.cart.items || []).map((i: any) => ({ ...i, sent: true }));
      t = await q.one(`UPDATE open_tickets SET cart=$2 WHERE id=$1 RETURNING *`, [t.id, json({ ...b.cart, items })]);
    }
    await audit(req, b.id ? 'update_ticket' : 'create_ticket', 'open_tickets', t.id, { name, total: cart.total }, q);
    return t;
  });
  for (const ko of kitchen) emit(`store:${storeId}`, 'kitchen:new', ko);
  emit(`store:${storeId}`, 'tables:changed', {});
  res.json(ticket);
}));

r.delete('/tickets/:id', requireUser, requireStore, ah(async (req, res) => {
  const t = await db.one(`SELECT * FROM open_tickets WHERE id=$1 AND store_id=$2`, [req.params.id, req.storeId]);
  if (!t) throw notFound('Ticket');
  if (!hasPermOrApproval(req, 'pos.void', req.body?.approval_token).ok) throw new HttpError(403, 'Voiding a ticket needs manager approval');
  await db.query(`DELETE FROM open_tickets WHERE id=$1`, [t.id]);
  await db.query(`UPDATE kitchen_orders SET status='cancelled' WHERE ticket_id=$1 AND status IN ('new','preparing')`, [t.id]);
  if (t.table_id && !(await db.one(`SELECT 1 FROM open_tickets WHERE table_id=$1`, [t.table_id])))
    await db.query(`UPDATE restaurant_tables SET status='available' WHERE id=$1`, [t.table_id]);
  await audit(req, 'void_ticket', 'open_tickets', t.id, { name: t.name, total: t.total });
  emit(`store:${req.storeId}`, 'kitchen:refresh', {});
  emit(`store:${req.storeId}`, 'tables:changed', {});
  res.json({ ok: true });
}));

// Merge tickets: move all items of `source_ids` into target ticket
r.post('/tickets/:id/merge', requireUser, requirePerm('pos.sell'), requireStore, ah(async (req, res) => {
  const result = await tx(async (q) => {
    const target = await q.one(`SELECT * FROM open_tickets WHERE id=$1 AND store_id=$2`, [req.params.id, req.storeId]);
    if (!target) throw notFound('Ticket');
    const items = [...(target.cart.items || [])];
    for (const sid of req.body?.source_ids || []) {
      const s = await q.one(`SELECT * FROM open_tickets WHERE id=$1 AND store_id=$2`, [sid, req.storeId]);
      if (!s || s.id === target.id) continue;
      items.push(...(s.cart.items || []));
      await q.query(`UPDATE kitchen_orders SET ticket_id=$2 WHERE ticket_id=$1`, [s.id, target.id]);
      await q.query(`DELETE FROM open_tickets WHERE id=$1`, [s.id]);
      if (s.table_id && s.table_id !== target.table_id && !(await q.one(`SELECT 1 FROM open_tickets WHERE table_id=$1`, [s.table_id])))
        await q.query(`UPDATE restaurant_tables SET status='available' WHERE id=$1`, [s.table_id]);
    }
    const total = r2(items.reduce((s, i: any) => s + num(i.preview_total), 0));
    await audit(req, 'merge_tickets', 'open_tickets', target.id, { sources: req.body?.source_ids }, q);
    return q.one(`UPDATE open_tickets SET cart=$2, total=$3, updated_at=now() WHERE id=$1 RETURNING *`, [target.id, json({ ...target.cart, items }), total || target.total]);
  });
  emit(`store:${req.storeId}`, 'tables:changed', {});
  res.json(result);
}));

// Split bill: move selected lines (optionally partial qty) into a new ticket that is paid separately
r.post('/tickets/:id/split', requireUser, requirePerm('pos.sell'), requireStore, ah(async (req, res) => {
  const moves: Record<string, number> = req.body?.lines || {}; // line_id -> qty to move
  const result = await tx(async (q) => {
    const t = await q.one(`SELECT * FROM open_tickets WHERE id=$1 AND store_id=$2 FOR UPDATE`, [req.params.id, req.storeId]);
    if (!t) throw notFound('Ticket');
    const keep: any[] = [];
    const moved: any[] = [];
    for (const it of t.cart.items || []) {
      const mq = Math.min(num(moves[it.line_id]), num(it.qty));
      if (mq > 0) moved.push({ ...it, qty: mq, line_id: crypto.randomUUID(), preview_total: r2((num(it.preview_total) * mq) / num(it.qty, 1)) });
      if (num(it.qty) - mq > 0) keep.push({ ...it, qty: r2(num(it.qty) - mq), preview_total: r2((num(it.preview_total) * (num(it.qty) - mq)) / num(it.qty, 1)) });
    }
    if (!moved.length) throw bad('Select items to split');
    if (!keep.length) throw bad('Leave at least one item on the original ticket');
    const sum = (xs: any[]) => r2(xs.reduce((s, i) => s + num(i.preview_total), 0));
    await q.query(`UPDATE open_tickets SET cart=$2, total=$3, updated_at=now() WHERE id=$1`, [t.id, json({ ...t.cart, items: keep }), sum(keep)]);
    const n = await q.one(
      `INSERT INTO open_tickets (business_id, store_id, user_id, name, table_id, dining_option, cart, total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [t.business_id, t.store_id, req.auth.userId, `${t.name} (split)`, t.table_id, t.dining_option, json({ items: moved }), sum(moved)],
    );
    await audit(req, 'split_ticket', 'open_tickets', t.id, { new_ticket: n!.id, lines: moves }, q);
    return n;
  });
  res.json(result);
}));

// ---------------------------------------------------------------- Kitchen display
r.get('/kitchen/orders', requirePerm('kitchen.view', 'pos.sell'), requireStore, ah(async (req, res) => {
  const params: any[] = [req.storeId];
  let where = `store_id=$1 AND (status IN ('new','preparing','ready') OR (status IN ('served') AND completed_at > now() - interval '30 minutes'))`;
  if (req.query.station) where += ` AND station=$${params.push(req.query.station)}`;
  res.json(await db.query(`SELECT * FROM kitchen_orders WHERE ${where} ORDER BY (priority='rush') DESC, created_at`, params));
}));

r.put('/kitchen/orders/:id', requirePerm('kitchen.view', 'pos.sell'), requireStore, ah(async (req, res) => {
  const { status, items, priority } = req.body || {};
  const allowed = ['new', 'preparing', 'ready', 'served', 'cancelled'];
  if (status && !allowed.includes(status)) throw bad('Invalid status');
  const row = await db.one(
    `UPDATE kitchen_orders SET
       status = COALESCE($3, status),
       items = COALESCE($4::jsonb, items),
       priority = COALESCE($5, priority),
       started_at = CASE WHEN $3 = 'preparing' AND started_at IS NULL THEN now() ELSE started_at END,
       ready_at = CASE WHEN $3 = 'ready' THEN now() ELSE ready_at END,
       completed_at = CASE WHEN $3 IN ('served','cancelled') THEN now() ELSE completed_at END
     WHERE id=$1 AND store_id=$2 RETURNING *`,
    [req.params.id, req.storeId, status ?? null, items ? json(items) : null, priority ?? null],
  );
  if (!row) throw notFound('Kitchen order');
  emit(`store:${req.storeId}`, 'kitchen:update', row);
  res.json(row);
}));

export default r;
