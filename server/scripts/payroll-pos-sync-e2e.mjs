// Automatic POS ↔ Payroll link. Usage: fresh database, then: node scripts/payroll-pos-sync-e2e.mjs http://localhost:4100
const BASE = process.argv[2] || 'http://localhost:4100';
let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ✔', m); } else { fail++; console.log('  ✘', m, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body, token) {
  const res = await fetch(BASE + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(1000); }
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Costa_Rica' });

const login = (await api('POST', '/auth/login', { email: 'owner@demo.com', password: 'demo123' })).data;
const O = login.token;
const store = login.stores[0];

console.log('Staff');
const staff = (await api('GET', '/payroll/pos-staff', null, O)).data.staff;
const nonOwnerActive = staff.filter((s) => !s.is_owner && s.active);
ok(nonOwnerActive.length >= 4 && nonOwnerActive.every((s) => s.employee_id), `all ${nonOwnerActive.length} active POS staff are in payroll without any manual step`, staff.map((s) => [s.name, s.employee_id]));
ok(staff.filter((s) => s.is_owner).every((s) => !s.employee_id), 'the shared owner login is not added as an employee');
const emps = (await api('GET', '/payroll/employees', null, O)).data;
const jose = emps.find((e) => e.full_name === 'José Rodríguez');
ok(!!jose && jose.user_id, 'payroll employee created from the POS record and linked', jose);
const carlos = emps.find((e) => e.full_name === 'Carlos Jiménez');
ok(carlos?.department_name === 'Kitchen Staff', `kitchen POS role placed in Kitchen Staff (${carlos?.department_name})`);

const roles = (await api('GET', '/roles', null, O)).data;
const cashierRole = roles.find((r) => /cashier/i.test(r.name));
const created2 = await api('POST', '/employees', { name: 'Luis Mora Prueba', email: 'luis.prueba@demo.com', pin: '7788', role_id: cashierRole.id }, O);
ok(created2.status === 201, 'new POS employee saved', created2.data);
await sleep(4500);
let luis = (await api('GET', '/payroll/employees', null, O)).data.find((e) => e.full_name === 'Luis Mora Prueba');
ok(!!luis && luis.status === 'active', 'new POS employee appears in payroll automatically', luis);

console.log('Attendance');
const dev = (await api('POST', '/auth/devices', { store_id: store.id, name: 'Sync test' }, O)).data;
const C = (await api('POST', '/auth/pin', { pin: '3333' }, dev.token)).data.token;
await api('POST', '/timeclock/in', {}, C);
await sleep(1200);
const out = await api('POST', '/timeclock/out', {}, C);
ok(out.status === 200 && out.data.clock_out, 'José clocks in and out on the POS');
await sleep(4500);
const att = (await api('GET', `/payroll/attendance?from=${today}&to=${today}`, null, O)).data;
const rows = att.rows || att;
const joseAtt = (Array.isArray(rows) ? rows : []).find((r) => r.employee_id === jose.id || r.full_name === 'José Rodríguez');
ok(!!joseAtt && (joseAtt.records > 0 || joseAtt.work_date), 'POS clock-in/out appears in payroll attendance automatically', joseAtt);

console.log('Deactivation');
await api('PUT', `/employees/${created2.data.id}`, { name: 'Luis Mora Prueba', active: false }, O);
await sleep(4500);
luis = (await api('GET', '/payroll/employees', null, O)).data.find((e) => e.full_name === 'Luis Mora Prueba');
ok(luis?.status === 'inactive', 'deactivating in the POS deactivates in payroll', luis?.status);

console.log('Revenue');
const cat = (await api('GET', '/pos/catalog', null, C)).data;
const casado = cat.products.find((p) => p.name === 'Casado con pollo');
const cash = cat.paymentMethods.find((m) => m.type === 'cash');
await api('POST', '/shifts/open', { opening_cash: 0 }, C);
const sale = await api('POST', '/sales', { client_uuid: crypto.randomUUID(), items: [{ variant_id: casado.variants[0].id, qty: 2 }], payments: [{ method_id: cash.id, amount: 20000 }] }, C);
ok(sale.status === 201, 'POS sale');
const sync = await api('POST', '/payroll/pos-sync', {}, O);
ok(sync.status === 200, 'manual "Sync now" works', sync.data);
const dash = (await api('GET', `/payroll/dashboard?year=${today.slice(0, 4)}`, null, O)).data;
const month = dash.months.find((m) => m.month === Number(today.slice(5, 7)));
ok(month?.revenue > 0, `this month's POS sales feed payroll revenue (₡${month?.revenue})`, month);
ok(dash.kpi.active_employees >= 4, `dashboard counts active employees (${dash.kpi.active_employees})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
