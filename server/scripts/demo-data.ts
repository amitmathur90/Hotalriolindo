// Hotel Rio Lindo demo data through the real API: 50 products, 50 customers, 50 sales (+ refunds).
// Usage: npx tsx scripts/demo-data.ts [baseUrl]   (server must be running)
// Then stop the server and run: npx tsx scripts/demo-backdate.ts   (spreads the sales over the last 30 days)
import { writeFileSync } from 'node:fs';
import { computeCart, r2 } from '../../shared/pricing.ts';

const BASE = process.argv[2] || 'http://localhost:4000';
async function api(method: string, path: string, body?: any, token?: string, store?: string) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(store ? { 'X-Store-Id': store } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${data?.error || res.status}`);
  return data;
}
let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

const login = await api('POST', '/auth/login', { email: 'owner@demo.com', password: 'demo123' });
const owner = login.token;
const store = login.stores[0].id;
const O = (m: string, p: string, b?: any) => api(m, p, b, owner, store);

// ---------------------------------------------------------------- 50 products (prices in ₡, IVA included)
const cats: any[] = await O('GET', '/categories');
const taxes: any[] = await O('GET', '/taxes');
const tax = (r: number) => taxes.find((t) => Number(t.rate) === r)!.id;
const ensureCat = async (name: string, color: string, station: string | null) =>
  cats.find((c) => c.name === name) ?? (cats.push(await O('POST', '/categories', { name, color, kitchen_station: station, sort: cats.length })), cats[cats.length - 1]);
await ensureCat('Bocas', '#b91c1c', 'Cocina');
await ensureCat('Cócteles y licores', '#7c3aed', 'Bar');
await ensureCat('Postres', '#db2777', 'Cocina');
const catId = (n: string) => cats.find((c) => c.name === n)!.id;

const P: [string, string, number, number, number, boolean][] = [
  // name, category, price ₡, cost ₡, IVA %, track stock
  ['Espresso', 'Bebidas calientes', 1500, 350, 13, false], ['Americano', 'Bebidas calientes', 1700, 380, 13, false], ['Moka', 'Bebidas calientes', 2700, 750, 13, false],
  ['Agua dulce', 'Bebidas calientes', 1200, 200, 13, false], ['Té chai latte', 'Bebidas calientes', 2500, 700, 13, false],
  ['Huevos rancheros', 'Desayunos', 4800, 1700, 13, false], ['Pancakes con miel', 'Desayunos', 3900, 1200, 13, false], ['Bowl de frutas tropicales', 'Desayunos', 3500, 1300, 13, false],
  ['Tostadas francesas', 'Desayunos', 3900, 1200, 13, false], ['Omelette de vegetales', 'Desayunos', 4200, 1400, 13, false],
  ['Chifrijo', 'Bocas', 4500, 1600, 13, false], ['Ceviche de pescado', 'Bocas', 5200, 2100, 13, false], ['Patacones con guacamole', 'Bocas', 3800, 1100, 13, false],
  ['Yuca frita', 'Bocas', 2900, 800, 13, false], ['Tacos ticos', 'Bocas', 3600, 1200, 13, false], ['Alitas BBQ', 'Bocas', 5400, 2000, 13, false],
  ['Casado con res', 'Platos fuertes', 6200, 2400, 13, false], ['Casado vegetariano', 'Platos fuertes', 5200, 1800, 13, false], ['Olla de carne', 'Platos fuertes', 6500, 2500, 13, false],
  ['Arroz con pollo', 'Platos fuertes', 5600, 2000, 13, false], ['Filete de pescado al ajillo', 'Platos fuertes', 8900, 3700, 13, false], ['Pasta a la marinera', 'Platos fuertes', 8500, 3500, 13, false],
  ['Hamburguesa Rio Lindo', 'Platos fuertes', 6900, 2600, 13, false], ['Lomito en salsa de hongos', 'Platos fuertes', 11500, 5200, 13, false],
  ['Arroz con leche', 'Postres', 2200, 600, 13, true], ['Flan de coco', 'Postres', 2500, 700, 13, true], ['Queque de chocolate', 'Postres', 2800, 900, 13, true],
  ['Helado artesanal', 'Postres', 2400, 800, 13, true], ['Cajeta de leche', 'Postres', 1500, 450, 13, true], ['Pie de limón', 'Postres', 2700, 850, 13, true],
  ['Refresco natural de cas', 'Bebidas frías', 1800, 400, 13, false], ['Limonada con hierbabuena', 'Bebidas frías', 2000, 450, 13, false], ['Agua de pipa', 'Bebidas frías', 2000, 900, 13, true],
  ['Coca-Cola 355ml', 'Bebidas frías', 1300, 600, 13, true], ['Cerveza Pilsen', 'Bebidas frías', 2200, 900, 13, true], ['Cerveza artesanal', 'Bebidas frías', 3500, 1700, 13, true],
  ['Piña colada', 'Cócteles y licores', 4900, 1500, 13, false], ['Guaro sour', 'Cócteles y licores', 3900, 1000, 13, false], ['Mojito', 'Cócteles y licores', 4500, 1300, 13, false],
  ['Margarita', 'Cócteles y licores', 4700, 1400, 13, false], ['Copa de vino tinto', 'Cócteles y licores', 4800, 1900, 13, false], ['Ron Centenario 7 años', 'Cócteles y licores', 3800, 1300, 13, false],
  ['Michelada', 'Cócteles y licores', 3200, 1100, 13, false],
  ['Bloqueador solar 50 FPS', 'Tienda', 9500, 5200, 13, true], ['Camiseta Rio Lindo', 'Tienda', 12000, 4800, 13, true], ['Gorra Rio Lindo', 'Tienda', 8500, 3200, 13, true],
  ['Salsa Lizano 280ml', 'Tienda', 1900, 1100, 1, true], ['Chocolate artesanal', 'Tienda', 3500, 1700, 13, true], ['Artesanía de madera', 'Tienda', 15000, 7000, 13, true],
  ['Repelente de insectos', 'Tienda', 6500, 3600, 13, true],
];
let created = 0;
for (const [i, [name, cat, price, cost, iva, track]] of P.entries()) {
  const exists = (await O('GET', `/products?q=${encodeURIComponent(name)}`)).find((p: any) => p.name === name);
  if (exists) continue;
  await O('POST', '/products', {
    name, category_id: catId(cat), type: 'standard', unit: 'pcs', track_stock: track, tax_ids: [tax(iva)], is_favorite: i % 9 === 0,
    variants: [{ name: '', price, cost, sku: `RL${String(2000 + i)}`, barcode: `74410${String(10000000 + i * 7919).slice(-7)}`, reorder_level: 10, stock: track ? int(25, 120) : 0 }],
  });
  created++;
}
console.log(`Products: ${created} created`);

// ---------------------------------------------------------------- 50 customers (guests and locals)
const first = ['Andrés', 'Mariana', 'Fabián', 'Valeria', 'Esteban', 'Daniela', 'Mauricio', 'Natalia', 'Gabriel', 'Camila', 'Alejandro', 'Paula', 'Ricardo', 'Melissa', 'Jorge', 'Karla', 'Luis', 'Adriana', 'Pablo', 'Fernanda', 'John', 'Emily', 'Michael', 'Sarah', 'David'];
const last = ['Rojas', 'Mora', 'Jiménez', 'Vargas', 'Solís', 'Araya', 'Chaves', 'Quesada', 'Alfaro', 'Calderón', 'Salazar', 'Ramírez', 'Smith', 'Johnson', 'Miller'];
const groups = ['Huésped', 'Local', 'Corporativo', 'Agencia de viajes'];
const strip = (x: string) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
let custCreated = 0;
for (let i = 0; i < 50; i++) {
  const fn = first[i % first.length], ln = last[(i * 7) % last.length];
  const phone = `8${String(3000000 + i * 1373).padStart(7, '0')}`;
  try {
    await O('POST', '/customers', {
      name: `${fn} ${ln}`, phone, email: `${strip(fn)}.${strip(ln)}${i}@example.com`,
      birthday: `${1970 + (i % 32)}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
      customer_group: groups[i % 4], tags: i % 4 === 0 ? `Habitación ${100 + (i % 30)}` : '',
      tax_id: i % 3 === 0 ? `${(i % 7) + 1}-${String(1000 + i * 37).slice(-4)}-${String(100 + i * 13).slice(-4)}` : null,
      address: i % 4 === 0 ? 'Huésped del hotel' : pick(['San José', 'Alajuela', 'Heredia', 'Liberia', 'Puntarenas']),
    });
    custCreated++;
  } catch { /* already exists */ }
}
console.log(`Customers: ${custCreated} created`);

// ---------------------------------------------------------------- 50 sales via the POS checkout
const dev = await O('POST', '/auth/devices', { store_id: store, name: 'Caja 2', kind: 'pos' });
const staff = [];
for (const pin of ['3333', '3333', '2222', '1111']) staff.push((await api('POST', '/auth/pin', { pin }, dev.token)).token);
const cat0 = await api('GET', '/pos/catalog', undefined, staff[0]);
const customers: any[] = await O('GET', '/customers');
const method = (name: string) => cat0.paymentMethods.find((m: any) => m.name === name);
const taxMap = new Map(cat0.taxes.map((t: any) => [t.id, t]));
const groupsById = new Map(cat0.modifierGroups.map((g: any) => [g.id, g]));
const products = cat0.products.filter((p: any) => p.unit !== 'kg');
const popular = products.filter((p: any) => /Capuchino|Café chorreado|Gallo pinto|Casado|Empanada|Batido|Imperial|Patacones|Chifrijo|Piña colada|Ceviche/.test(p.name));
const dining = ['dine_in', 'dine_in', 'dine_in', 'takeaway', 'delivery', 'pickup'];

const made: { id: string; i: number }[] = [];
for (let i = 0; i < 50; i++) {
  const lines: any[] = [];
  const n = int(1, 4);
  for (let k = 0; k < n; k++) {
    const p = rnd() < 0.55 ? pick(popular) : pick(products);
    const v = pick(p.variants) as any;
    const mods: any[] = [];
    for (const gid of p.modifier_group_ids) {
      const g: any = groupsById.get(gid);
      if (g.min_select > 0 || rnd() < 0.25) mods.push(pick(g.options));
    }
    lines.push({ p, v, mods, qty: rnd() < 0.8 ? 1 : int(2, 3) });
  }
  const discountId = rnd() < 0.15 ? cat0.discounts.find((d: any) => d.name === 'Huésped del hotel 15%')?.id : null;
  const opt = pick(dining);
  const cart = computeCart(
    lines.map((l) => ({ unit_price: Number(l.v.price) + l.mods.reduce((s: number, m: any) => s + Number(m.price), 0), qty: l.qty,
      taxes: l.p.tax_ids.map((id: string) => taxMap.get(id)).filter(Boolean).map((t: any) => ({ id: t.id, name: t.name, rate: Number(t.rate), inclusive: t.inclusive, is_gst: t.is_gst })) })),
    discountId ? { type: 'percent', value: 15 } : null, { service_charge_pct: opt === 'dine_in' ? Number(cat0.business.service_charge_pct) : 0 },
  );
  const total = cart.total;
  const r = rnd();
  const payments =
    r < 0.3 ? [{ method_id: method('Efectivo').id, amount: Math.ceil(total / 1000) * 1000 }]
    : r < 0.55 ? [{ method_id: method('Tarjeta').id, amount: total, reference: `**${int(1000, 9999)}` }]
    : r < 0.75 ? [{ method_id: method('SINPE Móvil').id, amount: total, reference: `SINPE ${int(10000000, 99999999)}` }]
    : r < 0.9 ? [{ method_id: method('Cargo a habitación').id, amount: total, reference: `Hab. ${int(101, 130)}` }]
    : [{ method_id: method('Tarjeta').id, amount: r2(total / 2), reference: `**${int(1000, 9999)}` }, { method_id: method('Efectivo').id, amount: Math.ceil(r2(total - r2(total / 2)) / 100) * 100 }];
  const sale = await api('POST', '/sales', {
    client_uuid: crypto.randomUUID(), send_to_kitchen: false, dining_option: opt, note: 'Demo sale',
    customer_id: rnd() < 0.45 ? pick(customers).id : null,
    order_discount: discountId ? { discount_id: discountId } : null,
    items: lines.map((l) => ({ variant_id: l.v.id, qty: l.qty, modifier_ids: l.mods.map((m: any) => m.id) })),
    payments,
  }, pick(staff));
  made.push({ id: sale.id, i });
}
console.log(`Sales: ${made.length} created`);

for (const [k, s] of [made[5], made[17], made[33]].entries()) {
  const sale = await api('GET', `/sales/${s.id}`, undefined, staff[2]);
  const items = k === 0 ? [] : [{ sale_item_id: sale.items[0].id, qty: 1 }];
  await api('POST', `/sales/${s.id}/refund`, { reason: pick(['Customer returned', 'Wrong item', 'Order cancelled']), items, client_uuid: crypto.randomUUID() }, staff[2]);
}
console.log('Refunds: 3 created');
writeFileSync(new URL('./.demo-sales.json', import.meta.url), JSON.stringify(made.map((m) => m.id)));
console.log('Done. Stop the server and run: npx tsx scripts/demo-backdate.ts');
