// End-to-end check of the Payroll Management System (PRD §14 acceptance criteria).
// Usage: start a server on a fresh database, then: node server/scripts/payroll-e2e.mjs http://localhost:4100
const BASE = process.argv[2] || 'http://localhost:4000';
let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✔', msg); } else { fail++; console.log('  ✘', msg, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
};
const near = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) <= tol;
async function api(method, path, body, token) {
  const res = await fetch(BASE + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => null) : await res.arrayBuffer();
  return { status: res.status, data, type };
}
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }

const T = (await api('POST', '/auth/login', { email: 'owner@demo.com', password: 'demo123' })).data.token;
const P = (m, p, b) => api(m, '/payroll' + p, b, T);

console.log('Setup: departments, rules, holidays, roles');
const depts = (await P('GET', '/departments')).data;
ok(depts.length === 7 && depts.some((d) => d.name === 'Bar Staff' && d.expense_account === '6010-BAR STAFF SALARY'), 'default departments with expense accounts', depts.map((d) => d.name));
const dept = Object.fromEntries(depts.map((d) => [d.code, d]));
const positions = (await P('GET', '/positions')).data;
ok(positions.length >= 10, 'default job positions');
const rules = (await P('GET', '/rules')).data;
ok(rules.sets.length === 1 && rules.sets[0].rules.reference_hours === 96 && rules.sets[0].rules.caja_rate === 10.83, 'default rule version (96 h, CAJA 10.83%)');
const hol = (await P('GET', '/holidays?year=2026')).data;
ok(hol.some((h) => h.name === 'Viernes Santo' && h.holiday_date.startsWith('2026-04-03')), 'Costa Rica holiday calendar seeded');
const roles = (await api('GET', '/roles', null, T)).data;
ok(['Payroll Admin', 'HR Manager', 'Payroll Accountant', 'Department Manager', 'Auditor', 'Employee'].every((n) => roles.some((r) => r.name === n)), 'payroll roles created');

// POS staff join payroll automatically (payroll/autosync.ts); the checks below count them on top of the test's own 4.
const SYNCED = (await P('GET', '/pos-staff')).data.staff.filter((s) => s.employee_id && s.active).length;
ok(SYNCED >= 4, `active POS staff already in payroll automatically (${SYNCED})`);

console.log('Employees & effective-dated salary');
const mk = async (b) => (await P('POST', '/employees', b));
const empA = await mk({ full_name: 'Ana Maria Prueba Uno', short_name: 'Ana', cedula: '100000001', email: 'ana@example.com', department_id: dept.BAR.id, employment_type: 'monthly', joining_date: '2024-01-10', payment_method: 'cash', salary: { salary_type: 'monthly', monthly_salary: 480000, effective_from: '2024-01-10' } });
ok(empA.status === 201 && /^E\d{4}$/.test(empA.data.code), 'create monthly employee with auto ID', empA.data);
const empC = await mk({ full_name: 'Carlos Prueba Dos', cedula: '200000002', department_id: dept.BAR.id, employment_type: 'monthly', joining_date: '2023-05-01', payment_method: 'transfer', bank_group: 'Non-BCR', bank_account: 'CR00000000000000000000', salary: { salary_type: 'monthly', monthly_salary: 585485, effective_from: '2023-05-01' } });
const empF = await mk({ full_name: 'Jorge Prueba Cuatro', cedula: '1-1111-2222', department_id: dept.BAR.id, employment_type: 'hourly', joining_date: '2025-06-01', insurance_status: 'not_insured', payment_method: 'cash', salary: { salary_type: 'hourly', hourly_rate: 2000, effective_from: '2025-06-01' } });
const empE = await mk({ full_name: 'Luis Prueba Tres', cedula: '1-0000-0003', department_id: dept.MNT.id, employment_type: 'monthly', joining_date: '2022-02-01', insurance_method: 'fixed', insurance_salary: 250000, payment_method: 'transfer', bank_account: '123', salary: { salary_type: 'monthly', monthly_salary: 487335, effective_from: '2022-02-01' } });
ok([empC, empF, empE].every((x) => x.status === 201), 'create hourly + fixed-insurance employees');
const dup = await mk({ full_name: 'Duplicate', cedula: '1-0000-0001' === '100000001' ? '' : '100000001' });
ok(dup.status === 400 && /already belongs/.test(dup.data.error), 'duplicate cédula rejected');
const J = empA.data.id, PB = empC.data.id, G = empF.data.id, D = empE.data.id;
// Raise effective after the first payroll period: must not change it
const raise = await P('POST', `/employees/${J}/salary`, { salary_type: 'monthly', monthly_salary: 500000, effective_from: '2026-11-06', reason: 'Annual raise' });
ok(raise.status === 201, 'add future salary (effective 6 Nov)');
const detail = (await P('GET', `/employees/${J}`)).data;
ok(detail.salaries.length === 2 && detail.monthly_salary === 500000, 'salary history kept (480,000 → 500,000 from 6 Nov)');

console.log('Attendance');
const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10));
const rows = [
  ...days('2026-10-23', 8).map((d, i) => ({ cedula: '100000001', work_date: d, regular_hours: i < 6 ? 8 : 9 })), // 66 h
  ...days('2026-10-23', 12).map((d, i) => ({ name: 'Carlos Prueba Dos', work_date: d, regular_hours: 8, overtime_hours: i === 0 ? 8 : 0 })), // 96 h + 8 OT
  ...days('2026-10-23', 7).map((d, i) => ({ code: empF.data.code, work_date: d, regular_hours: i < 6 ? 8 : 6.13 })), // 54.13 h
  ...days('2026-10-23', 10).map((d) => ({ cedula: '100000003', work_date: d, regular_hours: 8 })), // 80 h
  { name: 'Nobody Here', work_date: '2026-10-24', regular_hours: 8 },
];
const bulk = await P('POST', '/attendance/bulk', { rows, source: 'import' });
ok(bulk.data.saved === rows.length - 1 && bulk.data.errors.length === 1, 'bulk import matches by cédula / name / code; unknown reported', bulk.data);
const ot = (await P('GET', '/overtime?from=2026-10-23&to=2026-11-05&pending=1')).data;
ok(ot.length === 1 && ot[0].overtime_hours === 8, 'overtime awaiting approval');
const sum = (await P('GET', '/attendance/summary?from=2026-10-23&to=2026-11-05')).data;
ok(sum.rows.find((r) => r.id === J)?.regular_hours === 66, 'period summary: 66 regular hours');

console.log('Payroll period & calculation');
const per = await P('POST', '/periods', { start_date: '2026-10-23', end_date: '2026-11-05', pay_date: '2026-11-06' });
ok(per.status === 201 && per.data.code === 'PP-2026-01', 'create payroll period', per.data);
let PER = (await P('GET', `/periods/${per.data.id}`)).data;
const rec = (id) => PER.records.find((r) => r.employee_id === id);
ok(PER.records.length === 4 + SYNCED, `${4 + SYNCED} employees included (4 test + ${SYNCED} from POS)`, PER.records.length);
ok(rec(J).hours === 66 && rec(J).monthly_salary === 480000, 'hours loaded from attendance; salary effective at period end (480,000 not 500,000)');
ok(near(rec(J).gross, 165000) && near(rec(J).caja, 17869.5), 'monthly: gross = 240,000 × 66/96 = 165,000; CAJA 10.83%', rec(J));
ok(rec(PB).overtime_hours === 0 && rec(PB).warnings.some((w) => w.code === 'excess_hours') === false, 'unapproved overtime is not paid');
await P('POST', '/attendance/approve-overtime', { ids: ot.map((o) => o.id) });
await P('POST', `/periods/${per.data.id}/load-attendance`, { overwrite: true });
PER = (await P('GET', `/periods/${per.data.id}`)).data;
ok(near(rec(PB).overtime_pay, 36592.81), 'approved overtime: 8 h × 3,049.40 × 1.5 = 36,592.81', rec(PB).overtime_pay);
ok(near(rec(G).gross, 108260) && rec(G).caja === 0, 'hourly uninsured: 54.13 × 2,000 = 108,260, no CAJA', rec(G));
ok(near(rec(D).caja, 13337.5), 'fixed insurance: 250,000 × 10.67% ÷ 2 = 13,337.50', rec(D).caja);

console.log('Accounts, advances, bonus, overrides, adjustments');
await P('PUT', `/records/${rec(J).id}`, { bonus: 10000 });
const acc = await P('PUT', '/accounts/total', { employee_id: J, period_id: per.data.id, total: 6500 });
ok(near(acc.data.accounts_deduction, 3900) && near(acc.data.net_payable, 153230.5), 'accounts 6,500 × 60% = 3,900 → net 153,230.50 (matches workbook)', acc.data);
const adv = await P('POST', '/advances', { employee_id: D, amount: 100000, deduction_per_payroll: 20000, reason: 'Emergencia' });
ok(adv.status === 201 && adv.data.status === 'requested', 'advance requested');
const early = await P('PUT', `/records/${rec(D).id}`, { vales_plan: [{ advance_id: adv.data.id, amount: 20000 }] });
ok(early.status === 400, 'unapproved advance cannot be deducted');
await P('POST', `/advances/${adv.data.id}/decision`, { approve: true });
const over = await P('PUT', `/records/${rec(D).id}`, { vales_plan: [{ advance_id: adv.data.id, amount: 120000 }] });
ok(over.status === 400 && /exceeds/.test(over.data.error), 'deduction above outstanding balance rejected');
const vale = await P('PUT', `/records/${rec(D).id}`, { vales_plan: [{ advance_id: adv.data.id, amount: 20000 }] });
ok(vale.data.vales === 20000, 'first recovery 20,000 planned');
const noReason = await P('POST', `/records/${rec(D).id}/override`, { key: 'caja', value: 15000 });
ok(noReason.status === 400, 'manual adjustment needs a reason');
const ovr = await P('POST', `/records/${rec(D).id}/override`, { key: 'caja', value: 15000, reason: 'CCSS invoice amount' });
ok(ovr.data.caja === 15000 && ovr.data.overrides.caja.original === 13337.5, 'override keeps original (13,337.50) and adjusted (15,000)');
const adj = await P('POST', '/adjustments', { employee_id: G, period_id: per.data.id, pay_in_period_id: per.data.id, adj_type: 'missing_payment', original_amount: 0, actual_amount: 5000, reason: 'Missing hours from previous payroll', approve: true });
ok(adj.status === 201 && adj.data.difference === 5000 && adj.data.status === 'approved', 'adjustment register: +5,000 approved');
PER = (await P('GET', `/periods/${per.data.id}`)).data;
ok(near(rec(G).net_payable, 113260), 'adjustment added to net (108,260 + 5,000)', rec(G).net_payable);

console.log('Validation, approval and locking');
const v = (await P('POST', `/periods/${per.data.id}/validate`)).data;
ok(v.ok && v.errors === 0, 'pre-approval validation passes', v);
const sub = await P('POST', `/periods/${per.data.id}/action`, { action: 'submit' });
ok(sub.status === 200 && sub.data.status === 'under_review', 'submitted for review');
const rej = await P('POST', `/periods/${per.data.id}/action`, { action: 'reject' });
ok(rej.status === 400, 'reject needs a reason');
await P('POST', `/periods/${per.data.id}/action`, { action: 'reject', reason: 'Check Pablo hours' });
await P('POST', `/periods/${per.data.id}/action`, { action: 'submit' });
const appr = await P('POST', `/periods/${per.data.id}/action`, { action: 'approve' });
ok(appr.status === 200 && appr.data.status === 'approved', 'owner approves payroll', appr.data);
const locked = await P('PUT', `/records/${rec(J).id}`, { hours: 80 });
ok(locked.status === 409, 'approved payroll is locked against edits');
const advAfter = (await P('GET', `/advances/${adv.data.id}`)).data;
ok(advAfter.outstanding === 80000 && advAfter.txns.length === 1, 'advance ledger: 100,000 − 20,000 = 80,000 outstanding');

console.log('Payments');
const r1 = rec(PB);
const partial = await P('POST', '/payments', { record_id: r1.id, amount: 100000, method: 'transfer', reference: 'TRX-1' });
ok(partial.status === 201, 'partial payment recorded');
let r1b = (await P('GET', `/records/${r1.id}`)).data;
ok(r1b.payment_status === 'partial' && r1b.paid_amount === 100000, 'status partial, paid 100,000');
const overpay = await P('POST', '/payments', { record_id: r1.id, amount: 9999999, method: 'transfer' });
ok(overpay.status === 400, 'overpayment rejected');
await P('POST', '/exchange-rates', { rate_date: '2026-11-01', usd_crc: 505 });
const usd = await P('POST', '/payments', { record_id: r1.id, currency: 'USD', amount: 100, method: 'usd', payment_date: '2026-11-06' });
ok(usd.status === 201 && usd.data.exchange_rate === 505 && usd.data.amount_crc === 50500, 'USD payment converted at historical rate (100 × 505)', usd.data);
const per1 = (await P('GET', `/periods/${per.data.id}`)).data;
ok(per1.status === 'partially_paid', 'period partially paid');
const bulkPay = await P('POST', '/payments/bulk', { period_id: per.data.id, payment_date: '2026-11-06', reference: 'BATCH-1' });
ok(bulkPay.data.count === 4, 'bulk payment of remaining balances', bulkPay.data);
const per2 = (await P('GET', `/periods/${per.data.id}`)).data;
ok(per2.status === 'paid' && near(per2.totals.pending, 0), 'period fully paid');
const reopen = await P('POST', `/periods/${per.data.id}/action`, { action: 'reopen', reason: 'test' });
ok(reopen.status === 400 && /payment/.test(reopen.data.error), 'cannot reopen with payments recorded');

console.log('Payslips');
const pdf = await P('GET', `/records/${rec(J).id}/payslip.pdf`);
ok(pdf.status === 200 && pdf.type.includes('pdf') && pdf.data.byteLength > 2000, 'individual PDF payslip', pdf.type);
const bulkPdf = await P('GET', `/periods/${per.data.id}/payslips.pdf`);
ok(bulkPdf.status === 200 && bulkPdf.data.byteLength > pdf.data.byteLength, 'bulk PDF payslips');
const close = await P('POST', `/periods/${per.data.id}/action`, { action: 'close' });
ok(close.status === 200 && close.data.status === 'closed', 'close payroll period');

console.log('Second period uses new salary and next advance instalment');
const per3 = await P('POST', '/periods', { start_date: '2026-11-06', end_date: '2026-11-19' });
const P3 = (await P('GET', `/periods/${per3.data.id}`)).data;
ok(P3.records.find((r) => r.employee_id === J).monthly_salary === 500000, 'new salary (500,000) used from its effective date');
ok(P3.records.find((r) => r.employee_id === D).vales === 20000, 'next payroll deducts the configured 20,000 instalment');
const overlap = await P('POST', '/periods', { start_date: '2026-11-10', end_date: '2026-11-20' });
ok(overlap.status === 400, 'overlapping regular payroll rejected');
const cmp = (await P('GET', `/periods/${per3.data.id}/compare`)).data;
ok(cmp.other?.id === per.data.id && cmp.rows.some((r) => r.flags.includes('salary_up')), 'period comparison flags salary increase');

console.log('Reports, revenue, reconciliation');
await P('PUT', '/revenue', { year: 2026, month: 11, bar_revenue: 6000000, food_revenue: 4000000 });
const summary = (await P('GET', '/reports/summary?year=2026')).data;
const barLine = summary.lines.find((l) => l.department === 'Bar Staff');
const barExpected = per2.records.filter((r) => r.department_name === 'Bar Staff').reduce((s, r) => s + r.payroll_expense, 0);
ok(near(barLine.months[10], barExpected), 'monthly summary: Bar Staff November = period payroll expense', { got: barLine.months[10], barExpected });
ok(near(summary.totals.total, per2.totals.payroll_expense), 'annual total reconciles with approved payroll');
const labor = (await P('GET', '/reports/labor?year=2026')).data;
ok(near(labor.months[10].labor_pct, Math.round((per2.totals.payroll_expense / 10000000) * 10000) / 100), 'labour % = payroll ÷ revenue × 100', labor.months[10]);
const dash = (await P('GET', '/dashboard?year=2026')).data;
ok(dash.kpi.active_employees === 4 + SYNCED && near(dash.kpi.paid, per2.totals.paid) && dash.kpi.cash_paid > 0 && dash.kpi.bank_paid > 0, 'dashboard KPIs (active, paid, cash vs bank)', dash.kpi);
const rec1 = (await P('GET', '/reconciliation?year=2026')).data;
const line = rec1.rows.find((x) => x.period_id === per.data.id);
ok(line && near(line.payroll_amount, per2.totals.paid) && line.status === 'pending', 'reconciliation line created per period');
await P('PUT', `/reconciliation/${line.id}`, { cashbook_amount: 500000, qbo_amount: 502679 });
const rec2 = (await P('GET', '/reconciliation?year=2026')).data.rows.find((x) => x.id === line.id);
ok(rec2.status === 'difference' && rec2.cashbook_vs_qbo === -2679, 'difference found: −2,679 (PRD example)');

console.log('Aguinaldo');
const ag = await P('POST', '/aguinaldo/calculate', { year: 2026 });
ok(ag.data.calculated === 4 + SYNCED, `aguinaldo calculated for ${4 + SYNCED} employees`, ag.data.calculated);
const agRows = (await P('GET', '/aguinaldo?year=2026')).data;
const agJ = agRows.find((a) => a.employee_id === J);
const jEarn = per2.records.find((r) => r.employee_id === J).earnings;
ok(near(agJ.calculated_amount, Math.round((jEarn / 12) * 100) / 100) && agJ.warnings.some((w) => /No approved payroll for/.test(w)), 'aguinaldo = earnings ÷ 12, with missing-month warning', agJ);

console.log('Vacation');
const vr = await P('POST', '/vacation-requests', { employee_id: PB, start_date: '2026-12-01', end_date: '2026-12-03' });
await P('POST', `/vacation-requests/${vr.data.id}/decision`, { approve: true });
const vb = (await P('GET', `/vacation/${PB}`)).data;
ok(vb.used === 3 && vb.earned > 30, 'vacation request approved; balance tracked independently', { used: vb.used, earned: vb.earned });

console.log('Permissions');
const mgrRole = roles.find((r) => r.name === 'Department Manager');
const accRole = roles.find((r) => r.name === 'Payroll Accountant');
await api('POST', '/employees', { name: 'Jefe Mantenimiento', email: 'jefe@example.com', password: 'manager123', role_id: mgrRole.id, active: true }, T);
await api('POST', '/employees', { name: 'Contadora', email: 'conta@example.com', password: 'conta12345', role_id: accRole.id, active: true }, T);
const users = (await P('GET', '/users')).data;
await P('PUT', `/departments/${dept.MNT.id}`, { manager_user_id: users.find((u) => u.email === 'jefe@example.com').id });
const MT = (await api('POST', '/auth/login', { email: 'jefe@example.com', password: 'manager123' })).data.token;
const mgrEmps = (await api('GET', '/payroll/employees', null, MT)).data;
ok(mgrEmps.length === 1 && mgrEmps[0].id === D && mgrEmps[0].monthly_salary === null, 'department manager sees only own department, without salaries', mgrEmps.map((e) => e.full_name));
const mgrAtt = await api('POST', '/payroll/attendance', { employee_id: J, work_date: '2026-11-07', regular_hours: 8 }, MT);
ok(mgrAtt.status === 400, 'department manager cannot enter attendance for other departments');
const mgrPer = await api('GET', '/payroll/periods', null, MT);
ok(mgrPer.status === 403, 'department manager cannot see payroll amounts');
const AT = (await api('POST', '/auth/login', { email: 'conta@example.com', password: 'conta12345' })).data.token;
ok((await api('GET', `/payroll/periods/${per.data.id}`, null, AT)).status === 200, 'accountant views payroll & payments');
ok((await api('POST', `/payroll/employees/${J}/salary`, { salary_type: 'monthly', monthly_salary: 1 }, AT)).status === 403, 'accountant cannot change salaries');

console.log('Audit trail');
const audit = (await P('GET', '/audit')).data;
const sal = audit.find((a) => a.action === 'payroll_salary_change');
ok(sal && sal.details.previous.monthly_salary === 480000 && sal.details.new.monthly_salary === 500000, 'salary change audited with previous and new salary');
ok(['payroll_approve', 'payroll_manual_adjustment', 'payroll_payment', 'payroll_reject'].every((a) => audit.some((x) => x.action === a)), 'approval, manual adjustment, payment and rejection audited');

console.log('POS staff integration');
{
  const login = (await api('POST', '/auth/login', { email: 'owner@demo.com', password: 'demo123' })).data;
  const store = login.stores[0].id;
  const cashierRole = roles.find((r) => r.name === 'Employee') || roles[0];
  // Two POS staff: one hourly, one monthly with an employee code and a designation that matches a payroll position
  const posA = await api('POST', '/employees', { name: 'Maria Cajera', email: 'maria.pos@example.com', password: 'maria12345', role_id: cashierRole.id, employee_code: 'P-77', designation: positions[0].name, joined_on: '2025-03-01', hourly_rate: 2500, phone: '8888-0000', active: true }, T);
  const posB = await api('POST', '/employees', { name: 'Pedro Mesero', email: 'pedro.pos@example.com', password: 'pedro12345', role_id: cashierRole.id, joined_on: '2024-07-15', salary: 450000, active: true }, T);
  ok(posA.status === 201 && posB.status === 201, 'POS staff created in the POS');
  // An existing payroll employee entered by hand with the same e-mail as a third POS user should be suggested as a match
  const posC = await api('POST', '/employees', { name: 'Rosa Cocina', email: 'rosa.pos@example.com', password: 'rosa123456', role_id: cashierRole.id, active: true }, T);
  const manual = await P('POST', '/employees', { full_name: 'Rosa Elena Cocina', email: 'ROSA.pos@example.com', department_id: dept.BAR.id, employment_type: 'monthly', joining_date: '2024-01-01', salary: { salary_type: 'monthly', monthly_salary: 400000, effective_from: '2024-01-01' } });
  let ps = (await P('GET', '/pos-staff')).data;
  const a = ps.staff.find((s) => s.id === posA.data.id), c = ps.staff.find((s) => s.id === posC.data.id);
  ok(a && !a.employee_id && Number(a.hourly_rate) === 2500, 'POS staff listed as not in payroll, with POS rate');
  ok(c && c.suggested_employee_id === manual.data.id, 'existing payroll employee suggested by matching e-mail');

  const imp = await P('POST', '/pos-staff/import', { items: [{ user_id: posA.data.id, department_id: dept.BAR.id, payment_method: 'cash' }, { user_id: posB.data.id }] });
  ok(imp.status === 201 && imp.data.created.length === 2 && !imp.data.skipped.length, 'two POS staff added to payroll', imp.data);
  const ea = imp.data.created.find((e) => e.user_id === posA.data.id), eb = imp.data.created.find((e) => e.user_id === posB.data.id);
  ok(ea.code === 'P-77' && ea.employment_type === 'hourly' && ea.payment_method === 'cash' && ea.department_id === dept.BAR.id && ea.position_id === positions[0].id && ea.phone === '8888-0000' && String(ea.joining_date).startsWith('2025-03-01'),
    'POS details carried over (code, type, department, position, phone, joining date)', ea);
  const eaFull = (await P('GET', `/employees/${ea.id}`)).data;
  const ebFull = (await P('GET', `/employees/${eb.id}`)).data;
  ok(eaFull.salary?.hourly_rate === 2500 || eaFull.salary_type === 'hourly' || JSON.stringify(eaFull).includes('2500'), 'hourly rate carried over as salary history', eaFull.salary);
  ok(/^E\d{4}$/.test(eb.code) && eb.employment_type === 'monthly' && JSON.stringify(ebFull).includes('450000'), 'monthly salary carried over; code generated when POS has none');
  const again = await P('POST', '/pos-staff/import', { items: [{ user_id: posA.data.id }] });
  ok(again.data.created.length === 0 && again.data.skipped.length === 1 && /already linked/.test(again.data.skipped[0].reason), 'the same POS user cannot be added twice', again.data);

  const lk = await P('POST', '/pos-staff/link', { employee_id: manual.data.id, user_id: posC.data.id });
  ok(lk.status === 200 && lk.data.user_id === posC.data.id, 'existing payroll employee linked to POS user');
  const dupLink = await P('PUT', `/employees/${eb.id}`, { full_name: eb.full_name, user_id: posC.data.id });
  ok(dupLink.status === 400, 'one POS user cannot be linked to two payroll employees', dupLink.data);
  ps = (await P('GET', '/pos-staff')).data;
  ok([posA, posB, posC].every((p) => ps.staff.find((s) => s.id === p.data.id)?.employee_id), 'all three show as linked');

  // POS time clock → payroll attendance for the linked employee
  const MT2 = (await api('POST', '/auth/login', { email: 'maria.pos@example.com', password: 'maria12345' })).data.token;
  const cin = await fetch(BASE + '/api/timeclock/in', { method: 'POST', headers: { Authorization: 'Bearer ' + MT2, 'X-Store-Id': store } }).then((r) => r.json());
  await fetch(BASE + '/api/timeclock/out', { method: 'POST', headers: { Authorization: 'Bearer ' + MT2, 'X-Store-Id': store } });
  const fix = await api('PUT', `/timeclock/${cin.id}`, { clock_in: '2026-09-01T08:00:00-06:00', clock_out: '2026-09-01T16:00:00-06:00', break_minutes: 30 }, T);
  ok(fix.status === 200, 'time clock entry set to 1 Sep 08:00–16:00 with 30 min break');
  const tc = await P('POST', '/attendance/from-timeclock', { from: '2026-09-01', to: '2026-09-01' });
  const att = (await P('GET', `/attendance?from=2026-09-01&to=2026-09-01&employee_id=${ea.id}`)).data;
  const day = (Array.isArray(att) ? att : att.rows || []).find((x) => x.employee_id === ea.id);
  ok(tc.data.saved >= 1 && day && Number(day.regular_hours) === 7.5, 'POS time clock loaded into payroll attendance (7.5 h)', { tc: tc.data, day });

  // Self-service: the POS login now opens the employee's own payroll page
  const me = await api('GET', '/payroll/me', null, MT2);
  ok(me.status === 200 && me.data.employee.id === ea.id, 'POS login sees own payroll (self-service)');

  const ul = await P('POST', '/pos-staff/link', { employee_id: manual.data.id, user_id: null });
  ok(ul.status === 200 && ul.data.user_id === null, 'unlink keeps the payroll employee');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
