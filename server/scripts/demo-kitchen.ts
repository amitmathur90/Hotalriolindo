// Puts live orders on the Kitchen Display: table tickets sent from the POS (Cocina + Bar stations),
// some already in preparation / ready. Usage: npx tsx scripts/demo-kitchen.ts [baseUrl]
const BASE = process.argv[2] || 'http://localhost:4000';
async function api(method: string, path: string, body?: any, token?: string) {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${data?.error || res.status}`);
  return data;
}

const login = await api('POST', '/auth/login', { email: 'owner@demo.com', password: 'demo123' });
const dev = await api('POST', '/auth/devices', { store_id: login.stores[0].id, name: 'Caja Salón', kind: 'pos' }, login.token);
const waiter = (await api('POST', '/auth/pin', { pin: '3333' }, dev.token)).token;
const cat = await api('GET', '/pos/catalog', undefined, waiter);
const prod = (name: string) => cat.products.find((p: any) => p.name === name);
const opt = (group: string, option: string) => cat.modifierGroups.find((g: any) => g.name === group)?.options.find((o: any) => o.name === option)?.id;
const table = (name: string) => cat.tables.find((t: any) => t.name === name);
const line = (name: string, qty: number, mods: (string | undefined)[] = [], note?: string, variant = 0) => {
  const p = prod(name);
  if (!p) return null;
  return { line_id: crypto.randomUUID(), variant_id: p.variants[Math.min(variant, p.variants.length - 1)].id, qty, modifier_ids: mods.filter(Boolean), note };
};

const ORDERS: { table: string; dining: string; items: any[]; status?: string; rush?: boolean }[] = [
  { table: 'Mesa 1', dining: 'dine_in', items: [line('Casado con pollo', 2, [], 'Sin cebolla'), line('Batido natural', 2, [], 'De fresa'), line('Capuchino', 1, [opt('Azúcar', 'Poca azúcar')], undefined, 1)] },
  { table: 'Mesa 3', dining: 'dine_in', items: [line('Gallo pinto tradicional', 3, [opt('Huevos', 'Huevos fritos')]), line('Café chorreado', 3, [opt('Azúcar', 'Con azúcar')])], status: 'preparing' },
  { table: 'Mesa 5', dining: 'dine_in', items: [line('Chifrijo', 1), line('Ceviche de pescado', 2, [], 'Extra limón'), line('Piña colada', 2), line('Cerveza Imperial', 2)], rush: true },
  { table: 'Terraza 1', dining: 'dine_in', items: [line('Arroz con camarones', 1), line('Patacones con frijolitos', 1, [], undefined, 1), line('Limonada con hierbabuena', 2)], status: 'ready' },
  { table: 'Mesa 2', dining: 'dine_in', items: [line('Desayuno americano', 2, [opt('Huevos', 'Huevos revueltos')], 'Tocineta bien dorada'), line('Café latte', 2, [opt('Azúcar', 'Sin azúcar'), opt('Leche', 'Leche deslactosada')])] },
  { table: '', dining: 'takeaway', items: [line('Hamburguesa Rio Lindo', 1, [], 'Término medio'), line('Yuca frita', 1), line('Mojito', 1)] },
];

let n = 0;
for (const o of ORDERS) {
  const items = o.items.filter(Boolean);
  if (!items.length) continue;
  const t = table(o.table);
  const ticket = await api('POST', '/tickets', {
    name: t?.name || 'Para llevar · Mostrador', table_id: t?.id ?? null, dining_option: o.dining, send_to_kitchen: true, priority: o.rush ? 'rush' : 'normal',
    cart: { items },
  }, waiter);
  n++;
  if (o.status) {
    const ko: any[] = await api('GET', '/kitchen/orders', undefined, waiter);
    for (const k of ko.filter((x) => x.ticket_id === ticket.id)) {
      if (o.status === 'ready') await api('PUT', `/kitchen/orders/${k.id}`, { status: 'preparing' }, waiter);
      await api('PUT', `/kitchen/orders/${k.id}`, { status: o.status }, waiter);
    }
  }
}
const all: any[] = await api('GET', '/kitchen/orders', undefined, waiter);
console.log(`Kitchen: ${n} open orders sent → ${all.length} kitchen tickets on the KDS (Cocina + Bar)`);
