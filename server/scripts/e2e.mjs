// End-to-end API check of the PRD acceptance criteria. Usage: node scripts/e2e.mjs [baseUrl]
const BASE = process.argv[2] || 'http://localhost:4000';
let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✔', msg); } else { fail++; console.log('  ✘', msg, extra ?? ''); }
};
async function api(method, path, body, token, extraHeaders = {}) {
  const res = await fetch(BASE + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }

console.log('Auth & devices');
const login = await api('POST', '/auth/login', { email: 'owner@demo.com', password: 'demo123' });
ok(login.status === 200, 'owner logs in to back office');
const owner = login.data.token;
const store = login.data.stores[0];
const dev = await api('POST', '/auth/devices', { store_id: store.id, name: 'E2E POS' }, owner);
ok(dev.status === 201, 'register POS device');
const devToken = dev.data.token;
const bad = await api('POST', '/auth/pin', { pin: '9999' }, devToken);
ok(bad.status === 401, 'wrong PIN rejected');
const cashier = (await api('POST', '/auth/pin', { pin: '3333' }, devToken)).data;
const manager = (await api('POST', '/auth/pin', { pin: '2222' }, devToken)).data;
ok(cashier?.user?.name === 'José Rodríguez', 'cashier PIN login');
const C = cashier.token, M = manager.token;

console.log('Shift & catalog');
await api('POST', '/shifts/open', { opening_cash: 2000 }, C);
const cat = (await api('GET', '/pos/catalog', null, C)).data;
ok(cat.products.length > 10, `catalog has ${cat.products.length} products`);
const croissant = cat.products.find((p) => p.name === 'Empanada de queso');
const capp = cat.products.find((p) => p.name === 'Capuchino');
const cash = cat.paymentMethods.find((m) => m.type === 'cash');
const card = cat.paymentMethods.find((m) => m.type === 'card');
const stockBefore = croissant.variants[0].stock;

console.log('Checkout');
const sugar = cat.modifierGroups.find((g) => g.name === 'Azúcar');
const noMod = await api('POST', '/sales', { client_uuid: crypto.randomUUID(), items: [{ variant_id: capp.variants[0].id, qty: 1 }], payments: [{ method_id: cash.id, amount: 500 }] }, C);
ok(noMod.status === 400 && /Azúcar/.test(noMod.data.error), 'required modifier group enforced');
const uuid = crypto.randomUUID();
const salePayload = {
  client_uuid: uuid,
  items: [
    { variant_id: croissant.variants[0].id, qty: 2 },
    { variant_id: capp.variants[1].id, qty: 1, modifier_ids: [sugar.options[1].id, 'e1'] },
  ],
  payments: [{ method_id: card.id, amount: 3000 }, { method_id: cash.id, amount: 5000 }],
  customer_id: null,
};
const sale = await api('POST', '/sales', salePayload, C);
ok(sale.status === 201, 'sale completed with 2 payment methods', sale.data);
// IVA 13% included: 2 x 1200 empanada + Capuchino Grande 2800 + extra shot 500 = 5700 (takeaway, no service)
ok(Math.abs(sale.data.total - 5700) < 0.01, `totals computed server-side (${sale.data.total})`);
ok(Math.abs(sale.data.change - 2300) < 0.01, `change calculated (${sale.data.change})`);
const dup = await api('POST', '/sales', salePayload, C);
ok(dup.data.duplicate && dup.data.id === sale.data.id, 'resubmitting same client_uuid does not duplicate sale');
const cat2 = (await api('GET', '/pos/catalog', null, C)).data;
const stockAfter = cat2.products.find((p) => p.name === 'Empanada de queso').variants[0].stock;
ok(stockAfter === stockBefore - 2, `stock deducted (${stockBefore} → ${stockAfter})`);

console.log('Permissions & approvals');
const disc = await api('POST', '/sales', { ...salePayload, client_uuid: crypto.randomUUID(), order_discount: { type: 'percent', value: 50 } }, C);
ok(disc.status === 403, 'cashier cannot apply custom discount without approval');
const appr = await api('POST', '/auth/approve', { pin: '2222', permission: 'pos.discount' }, C);
ok(!!appr.data.approval_token, 'manager PIN override issues approval');
const disc2 = await api('POST', '/sales', { ...salePayload, client_uuid: crypto.randomUUID(), order_discount: { type: 'percent', value: 10 }, approvals: { discount: appr.data.approval_token }, payments: [{ method_id: cash.id, amount: 10000 }] }, C);
ok(disc2.status === 201 && disc2.data.discount_total > 0, `discounted sale with approval (discount ${disc2.data.discount_total})`);
const rep = await api('GET', '/reports/summary', null, C);
ok(rep.status === 403, 'cashier blocked from reports');

console.log('Refunds');
const stockPreRefund = (await api('GET', '/pos/catalog', null, C)).data.products.find((p) => p.name === 'Empanada de queso').variants[0].stock;
const ref1 = await api('POST', `/sales/${sale.data.id}/refund`, { reason: 'Customer returned', items: [{ sale_item_id: sale.data.items[0].id, qty: 1 }] }, C);
ok(ref1.status === 403, 'cashier refund needs approval');
const ref = await api('POST', `/sales/${sale.data.id}/refund`, { reason: 'Customer returned', items: [{ sale_item_id: sale.data.items[0].id, qty: 1 }] }, M);
ok(ref.status === 201 && Math.abs(ref.data.total - 1200) < 0.01, `partial item refund by manager (${ref.data.total})`);
const over = await api('POST', `/sales/${sale.data.id}/refund`, { reason: 'x', items: [{ sale_item_id: sale.data.items[0].id, qty: 5 }] }, M);
ok(over.status === 400, 'cannot refund more than sold');
const cat3 = (await api('GET', '/pos/catalog', null, C)).data;
ok(cat3.products.find((p) => p.name === 'Empanada de queso').variants[0].stock === stockPreRefund + 1, 'refund returns stock');

console.log('Loyalty');
const cust = (await api('POST', '/customers', { name: 'E2E Customer', phone: '9' + Date.now().toString().slice(-9) }, C)).data;
const ls = await api('POST', '/sales', { client_uuid: crypto.randomUUID(), customer_id: cust.id, items: [{ variant_id: croissant.variants[0].id, qty: 10 }], payments: [{ method_id: cash.id, amount: 12000 }] }, C);
ok(ls.data.points_earned === 12, `customer earned ${ls.data.points_earned} points on ${ls.data.total}`);
const redeem = await api('POST', '/sales', { client_uuid: crypto.randomUUID(), customer_id: cust.id, items: [{ variant_id: croissant.variants[0].id, qty: 1 }], payments: [{ method_type: 'loyalty', amount: 120 }, { method_id: cash.id, amount: 1080 }] }, C);
ok(redeem.status === 201 && redeem.data.points_redeemed === 12, 'points redeemed at checkout', redeem.data);
const custAfter = (await api('GET', `/customers/${cust.id}`, null, M)).data;
ok(custAfter.points === 1, `points balance correct (${custAfter.points})`);

console.log('Restaurant & kitchen');
const table = cat.tables[0];
const sandwich = cat.products.find((p) => p.name === 'Casado con pollo');
const t = await api('POST', '/tickets', { table_id: table.id, dining_option: 'dine_in', send_to_kitchen: true, cart: { items: [{ line_id: 'l1', variant_id: sandwich.variants[0].id, qty: 2, note: 'sin cebolla' }] } }, C);
ok(t.status === 200 && t.data.cart.items[0].sent, 'ticket saved & sent to kitchen');
const kdsDev = (await api('POST', '/auth/devices', { store_id: store.id, name: 'Kitchen', kind: 'kds' }, owner)).data.token;
const ko = (await api('GET', '/kitchen/orders', null, kdsDev)).data;
const mine = ko.find((k) => k.ticket_id === t.data.id);
ok(mine && mine.station === 'Cocina' && mine.items[0].note === 'sin cebolla', 'KDS device receives order without re-entry');
const upd = await api('PUT', `/kitchen/orders/${mine.id}`, { status: 'ready' }, kdsDev);
ok(upd.data.status === 'ready', 'KDS marks order ready');
const tablesNow = (await api('GET', '/pos/catalog', null, C)).data.tables;
ok(tablesNow.find((x) => x.id === table.id).status === 'occupied', 'table occupied');
const pay = await api('POST', '/sales', { client_uuid: crypto.randomUUID(), ticket_id: t.data.id, table_id: table.id, dining_option: 'dine_in', items: t.data.cart.items, payments: [{ method_id: cash.id, amount: 20000 }] }, C);
ok(pay.status === 201, 'ticket checked out');
const tablesAfter = (await api('GET', '/pos/catalog', null, C)).data.tables;
ok(tablesAfter.find((x) => x.id === table.id).status === 'available', 'table freed after payment');

const t2 = (await api('POST', '/tickets', { dining_option: 'takeaway', cart: { items: [{ line_id: 'a', variant_id: sandwich.variants[0].id, qty: 3, preview_total: 16500 }] } }, C)).data;
const sp = await api('POST', `/tickets/${t2.id}/split`, { lines: { a: 1 } }, C);
ok(sp.status === 200 && sp.data.cart.items[0].qty === 1, 'split bill moves 1 of 3 items to a new ticket');
const dtok = await api('POST', '/auth/display-token', {}, C);
ok(!!dtok.data.token, 'customer display pairing token issued');
const dtRest = await api('GET', '/pos/catalog', null, dtok.data.token);
ok(dtRest.status === 401, 'display token cannot call the REST API');

console.log('Inventory: PO, transfer, adjustment');
const store2 = login.data.stores[1];
const mug = cat.products.find((p) => p.name === 'Taza Rio Lindo');
const po = (await api('POST', '/purchase-orders', { items: [{ variant_id: mug.variants[0].id, qty: 10, cost: 110 }] }, owner, { 'X-Store-Id': store.id })).data;
const rcv = await api('POST', `/purchase-orders/${po.id}/receive`, { items: [{ variant_id: mug.variants[0].id, qty: 4 }] }, owner, { 'X-Store-Id': store.id });
ok(rcv.data.status === 'partial', 'PO partially received');
const stock1 = (await api('GET', '/stock?q=Taza', null, owner, { 'X-Store-Id': store.id })).data.find((s) => s.variant_id === mug.variants[0].id);
ok(stock1.qty === 64, `PO receive updates stock (${stock1.qty})`);
const tr = (await api('POST', '/transfers', { from_store_id: store.id, to_store_id: store2.id, items: [{ variant_id: mug.variants[0].id, qty: 5 }] }, owner)).data;
await api('POST', `/transfers/${tr.id}/approve`, {}, owner);
await api('POST', `/transfers/${tr.id}/dispatch`, {}, owner);
await api('POST', `/transfers/${tr.id}/receive`, { items: [{ variant_id: mug.variants[0].id, received_qty: 5 }] }, owner);
const s1 = (await api('GET', '/stock?q=Taza', null, owner, { 'X-Store-Id': store.id })).data.find((s) => s.variant_id === mug.variants[0].id);
const s2 = (await api('GET', '/stock?q=Taza', null, owner, { 'X-Store-Id': store2.id })).data.find((s) => s.variant_id === mug.variants[0].id);
ok(s1.qty === 59 && s2.qty === 35, `transfer moves stock between isolated stores (${s1.qty} / ${s2.qty})`);
const adj = await api('POST', '/adjustments', { reason: 'damage', items: [{ variant_id: mug.variants[0].id, qty_change: -1 }] }, owner, { 'X-Store-Id': store.id });
ok(adj.data.status === 'approved', 'owner damage adjustment auto-approved');

console.log('Shift close & reports');
const cur = (await api('GET', '/shifts/current', null, C)).data;
ok(cur.cash.expected > 2000, `expected cash computed (${cur.cash.expected})`);
const closed = (await api('POST', `/shifts/${cur.id}/close`, { actual_cash: cur.cash.expected }, C)).data;
ok(closed.status === 'closed' && closed.difference === 0, 'shift closed with zero variance');
const sum = (await api('GET', '/reports/summary', null, owner, { 'X-Store-Id': store.id })).data;
const byItem = (await api('GET', '/reports/sales-by?by=item', null, owner, { 'X-Store-Id': store.id })).data;
const itemNet = byItem.reduce((a, r) => a + r.net_sales, 0);
ok(Math.abs(itemNet - sum.net_sales) < 0.05, `item report reconciles with summary (${itemNet.toFixed(2)} = ${sum.net_sales})`);
const byPay = (await api('GET', '/reports/sales-by?by=payment', null, owner, { 'X-Store-Id': store.id })).data;
const payNet = byPay.reduce((a, r) => a + r.net, 0);
ok(Math.abs(payNet - sum.collected) < 0.05, `payment report reconciles with collected (${payNet.toFixed(2)} = ${sum.collected})`);
const byHour = await api('GET', '/reports/sales-by?by=hour', null, owner, { 'X-Store-Id': store.id });
ok(byHour.status === 200 && Math.abs(byHour.data.reduce((a, r) => a + r.net_sales, 0) - sum.net_sales) < 0.05, 'hourly report (business time zone) reconciles');
for (const rp of ['taxes', 'pnl', 'kitchen', 'discounts', 'loyalty']) ok((await api('GET', `/reports/${rp}`, null, owner, { 'X-Store-Id': store.id })).status === 200, `${rp} report loads`);
const audit = (await api('GET', '/settings/audit', null, owner)).data;
ok(audit.some((a) => a.action === 'refund') && audit.some((a) => a.action === 'manager_approval'), 'sensitive actions are audited');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
