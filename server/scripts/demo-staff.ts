// Adds 10 Hotel Rio Lindo employees via the API. Usage: npx tsx scripts/demo-staff.ts [baseUrl]
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

const { token, stores } = await api('POST', '/auth/login', { email: 'owner@demo.com', password: 'demo123' });
const roles: any[] = await api('GET', '/roles', undefined, token);
const role = (n: string) => roles.find((r) => r.name === n)!.id;
const existing: any[] = await api('GET', '/employees', undefined, token);
const [rest, bar] = [stores[0].id, stores[1]?.id ?? stores[0].id];

// name, role, PIN, job title, store, monthly salary ₡, hourly rate ₡, back-office email
const STAFF: [string, string, string, string, string, number, number, string?][] = [
  ['Roberto Quesada', 'Store Manager', '6101', 'Gerente de Alimentos y Bebidas', bar, 950000, 0, 'roberto.manager@demo.com'],
  ['Gabriela Araya', 'Cashier', '6102', 'Cajera principal', rest, 520000, 0],
  ['Kevin Chaves', 'Cashier', '6103', 'Salonero', rest, 0, 2300],
  ['Melany Solano', 'Cashier', '6104', 'Bartender', bar, 0, 2300],
  ['Daniel Alfaro', 'Cashier', '6105', 'Barista', rest, 480000, 0],
  ['Yorleny Monge', 'Cashier', '6106', 'Salonera', rest, 0, 2200],
  ['Óscar Brenes', 'Kitchen Staff', '6107', 'Chef principal', rest, 900000, 0],
  ['Wendy Cordero', 'Kitchen Staff', '6108', 'Cocinera de línea', bar, 0, 2400],
  ['Marco Villalobos', 'Inventory Manager', '6109', 'Encargado de bodega', '', 600000, 0, 'marco.bodega@demo.com'],
  ['Silvia Campos', 'Accountant', '6110', 'Contadora', '', 850000, 0, 'silvia.contabilidad@demo.com'],
];

let n = 0;
for (const [i, [name, roleName, pin, designation, storeId, salary, hourly, email]] of STAFF.entries()) {
  if (existing.some((e) => e.name === name)) continue;
  const joined = new Date(Date.now() - (60 + i * 37) * 86400000).toISOString().slice(0, 10);
  await api('POST', '/employees', {
    name, role_id: role(roleName), pin, designation, employee_code: `EMP${String(6 + i).padStart(3, '0')}`,
    phone: `8${String(7100000 + i * 4321).padStart(7, '0')}`, email: email ?? null, password: email ? 'demo1234' : undefined,
    store_ids: storeId ? [storeId] : [], salary, hourly_rate: hourly, joined_on: joined, active: true,
    extra_permissions: name === 'Gabriela Araya' ? ['pos.discount', 'pos.refund'] : [], denied_permissions: [],
  }, token);
  n++;
}
console.log(`Staff: ${n} created`);
