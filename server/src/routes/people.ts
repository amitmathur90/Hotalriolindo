import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, json, tx } from '../db.ts';
import { ALL_PERMISSIONS, hashPin, requirePerm, requireStore, requireUser } from '../auth.ts';
import { crud } from '../crud.ts';
import { HttpError, ah, audit, bad, notFound, notify, num, range } from '../util.ts';
import { r2 } from '../../../shared/pricing.ts';

const r = Router();

// ================================================================ Customers & loyalty
r.get('/customers', ah(async (req, res) => {
  const params: any[] = [req.auth.businessId];
  let where = '';
  if (req.query.q) {
    const i = params.push(`%${req.query.q}%`);
    where += ` AND (name ILIKE $${i} OR phone ILIKE $${i} OR email ILIKE $${i} OR code ILIKE $${i})`;
  }
  // Segments: new (<30d), regular (3+ visits), vip (top spenders), inactive (no visit 60d), birthday (this month)
  const seg = req.query.segment;
  if (seg === 'new') where += ` AND created_at > now() - interval '30 days'`;
  if (seg === 'regular') where += ` AND visits >= 3`;
  if (seg === 'vip') where += ` AND total_spent >= 10000`;
  if (seg === 'inactive') where += ` AND (last_visit_at IS NULL OR last_visit_at < now() - interval '60 days')`;
  if (seg === 'birthday') where += ` AND EXTRACT(MONTH FROM birthday) = EXTRACT(MONTH FROM now())`;
  res.json(await db.query(`SELECT * FROM customers WHERE business_id=$1 ${where} ORDER BY name LIMIT ${req.query.q ? 50 : 2000}`, params));
}));

const CUST_FIELDS = ['name', 'phone', 'email', 'address', 'birthday', 'code', 'notes', 'tags', 'customer_group', 'tax_id', 'id_type', 'activity_code'];
r.post('/customers', requireUser, ah(async (req, res) => {
  if (!req.auth.permissions.has('customers.manage') && !req.auth.permissions.has('pos.sell')) throw new HttpError(403, 'Not allowed');
  const b = req.body || {};
  if (!b.name) throw bad('Name is required');
  if (b.phone && (await db.one(`SELECT 1 FROM customers WHERE business_id=$1 AND phone=$2`, [req.auth.businessId, b.phone]))) throw bad('A customer with this phone exists');
  const vals = CUST_FIELDS.map((f) => (b[f] === '' ? null : b[f] ?? null));
  vals[5] = vals[5] || `C${Date.now().toString().slice(-8)}`; // code
  const c = await db.one(`INSERT INTO customers (business_id, ${CUST_FIELDS.join(',')}) VALUES ($1,${CUST_FIELDS.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`, [req.auth.businessId, ...vals]);
  await audit(req, 'create', 'customers', c!.id, { name: b.name });
  res.status(201).json(c);
}));

r.put('/customers/:id', requirePerm('customers.manage'), ah(async (req, res) => {
  const b = req.body || {};
  const sets = CUST_FIELDS.filter((f) => b[f] !== undefined);
  if (!sets.length) throw bad('Nothing to update');
  const c = await db.one(`UPDATE customers SET ${sets.map((f, i) => `${f}=$${i + 3}`).join(',')} WHERE id=$1 AND business_id=$2 RETURNING *`, [
    req.params.id, req.auth.businessId, ...sets.map((f) => (b[f] === '' ? null : b[f])),
  ]);
  if (!c) throw notFound('Customer');
  await audit(req, 'update', 'customers', c.id, b);
  res.json(c);
}));

r.delete('/customers/:id', requirePerm('customers.manage'), ah(async (req, res) => {
  await db.query(`DELETE FROM customers WHERE id=$1 AND business_id=$2`, [req.params.id, req.auth.businessId]);
  await audit(req, 'delete', 'customers', req.params.id);
  res.json({ ok: true });
}));

r.get('/customers/:id', ah(async (req, res) => {
  const c = await db.one(`SELECT * FROM customers WHERE id=$1 AND business_id=$2`, [req.params.id, req.auth.businessId]);
  if (!c) throw notFound('Customer');
  const [sales, loyalty] = await Promise.all([
    db.query(`SELECT id, receipt_no, type, total, created_at, store_id FROM sales WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`, [c.id]),
    db.query(`SELECT * FROM loyalty_transactions WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`, [c.id]),
  ]);
  res.json({ ...c, sales, loyalty });
}));

r.post('/customers/:id/points', requirePerm('customers.manage'), ah(async (req, res) => {
  const pts = num(req.body?.points);
  if (!pts) throw bad('Enter points (+/-)');
  const c = await tx(async (q) => {
    const c = await q.one(`UPDATE customers SET points = GREATEST(0, points + $3) WHERE id=$1 AND business_id=$2 RETURNING *`, [req.params.id, req.auth.businessId, pts]);
    if (!c) throw notFound('Customer');
    await q.query(`INSERT INTO loyalty_transactions (business_id, customer_id, points, type, note, user_id) VALUES ($1,$2,$3,'adjust',$4,$5)`, [
      req.auth.businessId, c.id, pts, req.body?.note || 'Manual adjustment', req.auth.userId,
    ]);
    return c;
  });
  await audit(req, 'adjust_points', 'customers', c.id, { points: pts, note: req.body?.note });
  res.json(c);
}));

// Points expiry job: expire points of customers inactive longer than points_expiry_days
export async function expirePoints() {
  const rows = await db.query(
    `SELECT c.id, c.business_id, c.points FROM customers c JOIN businesses b ON b.id=c.business_id
      WHERE c.points > 0 AND b.points_expiry_days > 0 AND COALESCE(c.last_visit_at, c.created_at) < now() - (b.points_expiry_days || ' days')::interval`,
  );
  for (const c of rows) {
    await db.query(`UPDATE customers SET points=0 WHERE id=$1`, [c.id]);
    await db.query(`INSERT INTO loyalty_transactions (business_id, customer_id, points, type, note) VALUES ($1,$2,$3,'adjust','Points expired')`, [c.business_id, c.id, -c.points]);
  }
  return rows.length;
}

// ================================================================ Gift cards
r.get('/gift-cards', requirePerm('customers.manage'), ah(async (req, res) => {
  res.json(await db.query(`SELECT g.*, c.name AS customer_name FROM gift_cards g LEFT JOIN customers c ON c.id=g.customer_id WHERE g.business_id=$1 ORDER BY g.created_at DESC`, [req.auth.businessId]));
}));
r.get('/gift-cards/lookup/:code', ah(async (req, res) => {
  const g = await db.one(`SELECT id, code, balance, expires_on, active FROM gift_cards WHERE business_id=$1 AND upper(code)=upper($2)`, [req.auth.businessId, req.params.code]);
  if (!g) throw notFound('Gift card');
  res.json(g);
}));
r.get('/gift-cards/:id/transactions', requirePerm('customers.manage'), ah(async (req, res) => {
  res.json(await db.query(`SELECT t.* FROM gift_card_transactions t JOIN gift_cards g ON g.id=t.gift_card_id WHERE g.id=$1 AND g.business_id=$2 ORDER BY t.created_at DESC`, [req.params.id, req.auth.businessId]));
}));
r.post('/gift-cards', requirePerm('customers.manage'), ah(async (req, res) => {
  const value = num(req.body?.value);
  if (value <= 0) throw bad('Enter card value');
  const code = (req.body?.code || `GC-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Date.now().toString().slice(-4)}`).toUpperCase();
  const g = await tx(async (q) => {
    const g = await q.one(`INSERT INTO gift_cards (business_id, code, balance, initial_value, customer_id, expires_on) VALUES ($1,$2,$3,$3,$4,$5) RETURNING *`, [
      req.auth.businessId, code, value, req.body?.customer_id || null, req.body?.expires_on || null,
    ]);
    await q.query(`INSERT INTO gift_card_transactions (gift_card_id, amount, type, user_id) VALUES ($1,$2,'issue',$3)`, [g!.id, value, req.auth.userId]);
    return g;
  });
  await audit(req, 'issue_gift_card', 'gift_cards', g!.id, { code, value });
  res.status(201).json(g);
}));
r.post('/gift-cards/:id/topup', requirePerm('customers.manage'), ah(async (req, res) => {
  const amt = num(req.body?.amount);
  if (amt <= 0) throw bad('Enter amount');
  const g = await db.one(`UPDATE gift_cards SET balance=balance+$3 WHERE id=$1 AND business_id=$2 RETURNING *`, [req.params.id, req.auth.businessId, amt]);
  if (!g) throw notFound('Gift card');
  await db.query(`INSERT INTO gift_card_transactions (gift_card_id, amount, type, user_id) VALUES ($1,$2,'topup',$3)`, [g.id, amt, req.auth.userId]);
  await audit(req, 'topup_gift_card', 'gift_cards', g.id, { amount: amt });
  res.json(g);
}));

// ================================================================ Roles & employees
r.use('/roles', crud({ table: 'roles', fields: ['name', 'permissions'], jsonFields: ['permissions'], required: ['name'], perm: 'employees.manage', readPerm: 'employees.manage' }));

r.get('/employees', requirePerm('employees.manage', 'reports.view'), ah(async (req, res) => {
  res.json(await db.query(
    `SELECT u.id, u.name, u.email, u.phone, u.employee_code, u.designation, u.role_id, r.name AS role_name, u.store_ids, u.extra_permissions,
            u.denied_permissions, u.joined_on, u.salary, u.hourly_rate, u.active, u.is_owner, u.photo_url, u.last_login_at, (u.pin_hash IS NOT NULL) AS has_pin
       FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.business_id=$1 ORDER BY u.is_owner DESC, u.name`, [req.auth.businessId]));
}));

async function saveEmployee(req: any, id: string | null) {
  const b = req.body || {};
  const bid = req.auth.businessId;
  if (!b.name) throw bad('Name is required');
  if (b.role_id && !(await db.one(`SELECT 1 FROM roles WHERE id=$1 AND business_id=$2`, [b.role_id, bid]))) throw bad('Invalid role');
  const target = id ? await db.one(`SELECT * FROM users WHERE id=$1 AND business_id=$2`, [id, bid]) : null;
  if (id && !target) throw notFound('Employee');
  if (target?.is_owner && !req.auth.isOwner) throw new HttpError(403, 'Only the owner can edit the owner');
  let pinHash: string | undefined;
  if (b.pin) {
    if (!/^\d{4,6}$/.test(String(b.pin))) throw bad('PIN must be 4-6 digits');
    pinHash = hashPin(bid, String(b.pin));
    const clash = await db.one(`SELECT id FROM users WHERE business_id=$1 AND pin_hash=$2 AND id <> COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000')`, [bid, pinHash, id]);
    if (clash) throw bad('This PIN is already used by another employee');
  }
  if (b.email) {
    const clash = await db.one(`SELECT id FROM users WHERE lower(email)=lower($1) AND id <> COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000')`, [b.email, id]);
    if (clash) throw bad('Email already in use');
  }
  const perms = (x: any) => json((Array.isArray(x) ? x : []).filter((p: string) => ALL_PERMISSIONS.includes(p)));
  const vals = [b.name, b.email || null, b.phone || null, b.employee_code || null, b.designation || null, b.role_id || null, json(b.store_ids || []),
    perms(b.extra_permissions), perms(b.denied_permissions), b.joined_on || null, num(b.salary), num(b.hourly_rate), b.active !== false, b.photo_url || null];
  let uid = id;
  if (id) {
    await db.query(`UPDATE users SET name=$3, email=$4, phone=$5, employee_code=$6, designation=$7, role_id=$8, store_ids=$9, extra_permissions=$10,
      denied_permissions=$11, joined_on=$12, salary=$13, hourly_rate=$14, active=$15, photo_url=$16 WHERE id=$1 AND business_id=$2`, [id, bid, ...vals]);
  } else {
    const row = await db.one(`INSERT INTO users (business_id, name, email, phone, employee_code, designation, role_id, store_ids, extra_permissions,
      denied_permissions, joined_on, salary, hourly_rate, active, photo_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, [bid, ...vals]);
    uid = row!.id;
  }
  if (pinHash) await db.query(`UPDATE users SET pin_hash=$2 WHERE id=$1`, [uid, pinHash]);
  if (b.password) {
    if (String(b.password).length < 8) throw bad('Password must be at least 8 characters');
    await db.query(`UPDATE users SET password_hash=$2 WHERE id=$1`, [uid, await bcrypt.hash(b.password, 10)]);
  }
  await audit(req, id ? 'update' : 'create', 'employees', uid, { name: b.name, role_id: b.role_id, pin_changed: !!pinHash, password_changed: !!b.password });
  return uid;
}
r.post('/employees', requirePerm('employees.manage'), ah(async (req, res) => res.status(201).json({ id: await saveEmployee(req, null) })));
r.put('/employees/:id', requirePerm('employees.manage'), ah(async (req, res) => res.json({ id: await saveEmployee(req, req.params.id) })));

// ================================================================ Time clock & attendance
r.get('/timeclock/status', requireUser, ah(async (req, res) => {
  res.json(await db.one(`SELECT * FROM time_entries WHERE user_id=$1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`, [req.auth.userId]) ?? null);
}));

r.post('/timeclock/:action(in|out|break_start|break_end)', requireUser, requireStore, ah(async (req, res) => {
  const open = await db.one(`SELECT * FROM time_entries WHERE user_id=$1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`, [req.auth.userId]);
  const a = req.params.action;
  let row;
  if (a === 'in') {
    if (open) throw bad('Already clocked in');
    row = await db.one(`INSERT INTO time_entries (business_id, store_id, user_id) VALUES ($1,$2,$3) RETURNING *`, [req.auth.businessId, req.storeId, req.auth.userId]);
  } else {
    if (!open) throw bad('Not clocked in');
    if (a === 'break_start') {
      if (open.break_started_at) throw bad('Break already started');
      row = await db.one(`UPDATE time_entries SET break_started_at=now() WHERE id=$1 RETURNING *`, [open.id]);
    } else {
      const brk = `break_minutes + CASE WHEN break_started_at IS NOT NULL THEN CEIL(EXTRACT(EPOCH FROM now()-break_started_at)/60) ELSE 0 END`;
      row = await db.one(`UPDATE time_entries SET break_minutes=${brk}, break_started_at=NULL ${a === 'out' ? ', clock_out=now()' : ''} WHERE id=$1 RETURNING *`, [open.id]);
    }
  }
  await audit(req, `timeclock_${a}`, 'time_entries', row!.id);
  res.json(row);
}));

r.get('/timeclock', requirePerm('employees.manage', 'timeclock.manage', 'reports.view'), ah(async (req, res) => {
  const { from, to } = range(req);
  const params: any[] = [req.auth.businessId, from, to];
  let where = '';
  if (req.query.user_id) where += ` AND t.user_id=$${params.push(req.query.user_id)}`;
  if (req.query.store_id) where += ` AND t.store_id=$${params.push(req.query.store_id)}`;
  res.json(await db.query(
    `SELECT t.*, u.name AS user_name, s.name AS store_name,
            ROUND((EXTRACT(EPOCH FROM (COALESCE(t.clock_out, now()) - t.clock_in))/3600 - t.break_minutes/60.0)::numeric, 2) AS hours
       FROM time_entries t JOIN users u ON u.id=t.user_id JOIN stores s ON s.id=t.store_id
      WHERE t.business_id=$1 AND t.clock_in >= $2 AND t.clock_in < $3 ${where} ORDER BY t.clock_in DESC`, params));
}));

// Manager-approved correction of an attendance record
r.put('/timeclock/:id', requirePerm('timeclock.manage'), ah(async (req, res) => {
  const { clock_in, clock_out, break_minutes, note } = req.body || {};
  const row = await db.one(
    `UPDATE time_entries SET clock_in=COALESCE($3::timestamptz, clock_in), clock_out=$4::timestamptz, break_minutes=COALESCE($5, break_minutes), note=$6, edited_by=$7
      WHERE id=$1 AND business_id=$2 RETURNING *`,
    [req.params.id, req.auth.businessId, clock_in || null, clock_out || null, break_minutes ?? null, note || null, req.auth.userId],
  );
  if (!row) throw notFound('Time entry');
  await audit(req, 'correct_timeclock', 'time_entries', row.id, req.body);
  res.json(row);
}));

// Payroll preparation: hours, overtime (>8h/day), late arrivals vs. shift start, gross pay
r.get('/payroll', requirePerm('employees.manage', 'reports.view'), ah(async (req, res) => {
  const { from, to } = range(req);
  const shiftStart = String(req.query.shift_start || '09:30');
  const dailyHours = num(req.query.daily_hours, 8);
  const rows = await db.query(
    `SELECT u.id, u.name, u.employee_code, u.salary, u.hourly_rate, t.clock_in, t.clock_out, t.break_minutes
       FROM users u LEFT JOIN time_entries t ON t.user_id=u.id AND t.clock_in >= $2 AND t.clock_in < $3 AND t.clock_out IS NOT NULL
      WHERE u.business_id=$1 AND u.active ORDER BY u.name`, [req.auth.businessId, from, to]);
  const map = new Map<string, any>();
  for (const x of rows) {
    if (!map.has(x.id)) map.set(x.id, { id: x.id, name: x.name, employee_code: x.employee_code, salary: Number(x.salary), hourly_rate: Number(x.hourly_rate), days: new Set(), hours: 0, overtime: 0, late: 0 });
    const e = map.get(x.id);
    if (!x.clock_in) continue;
    const h = Math.max(0, (new Date(x.clock_out).getTime() - new Date(x.clock_in).getTime()) / 3600000 - x.break_minutes / 60);
    e.hours += h;
    e.overtime += Math.max(0, h - dailyHours);
    const ci = new Date(x.clock_in);
    e.days.add(ci.toDateString());
    const [hh, mm] = shiftStart.split(':').map(Number);
    if (ci.getHours() * 60 + ci.getMinutes() > hh * 60 + mm + 5) e.late++;
  }
  res.json([...map.values()].map((e) => {
    const regular = e.hours - e.overtime;
    const gross = e.hourly_rate > 0 ? regular * e.hourly_rate + e.overtime * e.hourly_rate * 1.5 : e.salary;
    return { ...e, days: e.days.size, hours: r2(e.hours), overtime: r2(e.overtime), gross_pay: r2(gross) };
  }));
}));

// ================================================================ Shifts & cash management
async function shiftSummary(shiftId: string) {
  const s = await db.one(`SELECT sh.*, u.name AS opened_by_name, c.name AS closed_by_name FROM shifts sh JOIN users u ON u.id=sh.opened_by LEFT JOIN users c ON c.id=sh.closed_by WHERE sh.id=$1`, [shiftId]);
  if (!s) throw notFound('Shift');
  const pays = await db.query(
    `SELECT p.method_name, p.method_type, s.type, SUM(p.amount) AS amount, COUNT(DISTINCT s.id) AS count
       FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE s.shift_id=$1 GROUP BY 1,2,3`, [shiftId]);
  const totals = await db.one(
    `SELECT COALESCE(SUM(CASE WHEN type='sale' THEN total END),0) AS gross_sales, COALESCE(SUM(CASE WHEN type='refund' THEN total END),0) AS refunds,
            COALESCE(SUM(CASE WHEN type='sale' THEN discount_total END),0) AS discounts, COALESCE(SUM(CASE WHEN type='sale' THEN tax_total ELSE -tax_total END),0) AS taxes,
            COUNT(*) FILTER (WHERE type='sale') AS receipts
       FROM sales WHERE shift_id=$1`, [shiftId]);
  const moves = await db.query(`SELECT m.*, u.name AS user_name FROM cash_movements m JOIN users u ON u.id=m.user_id WHERE m.shift_id=$1 ORDER BY m.created_at`, [shiftId]);
  const cashSales = pays.filter((p) => p.method_type === 'cash' && p.type === 'sale').reduce((a, p) => a + Number(p.amount), 0);
  const cashRefunds = pays.filter((p) => p.method_type === 'cash' && p.type === 'refund').reduce((a, p) => a + Number(p.amount), 0);
  const payIn = moves.filter((m) => m.type === 'pay_in' || m.type === 'deposit').reduce((a, m) => a + Number(m.amount), 0);
  const payOut = moves.filter((m) => !(m.type === 'pay_in' || m.type === 'deposit')).reduce((a, m) => a + Number(m.amount), 0);
  const expected = r2(Number(s.opening_cash) + cashSales - cashRefunds + payIn - payOut);
  return { ...s, payments: pays, totals, movements: moves, cash: { opening: Number(s.opening_cash), cash_sales: r2(cashSales), cash_refunds: r2(cashRefunds), pay_in: r2(payIn), pay_out: r2(payOut), expected } };
}

r.get('/shifts/current', requireStore, ah(async (req, res) => {
  const s = await db.one(`SELECT id FROM shifts WHERE store_id=$1 AND status='open' ORDER BY (device_id IS NOT DISTINCT FROM $2) DESC, opened_at DESC LIMIT 1`, [req.storeId, req.auth.deviceId ?? null]);
  res.json(s ? await shiftSummary(s.id) : null);
}));

r.get('/shifts', requirePerm('reports.view', 'shift.manage'), ah(async (req, res) => {
  const { from, to } = range(req);
  const params: any[] = [req.auth.businessId, from, to];
  let where = '';
  if (req.storeId) where = ` AND sh.store_id=$${params.push(req.storeId)}`;
  res.json(await db.query(
    `SELECT sh.*, u.name AS opened_by_name, c.name AS closed_by_name, st.name AS store_name,
            (SELECT COALESCE(SUM(total),0) FROM sales WHERE shift_id=sh.id AND type='sale') AS sales_total
       FROM shifts sh JOIN users u ON u.id=sh.opened_by LEFT JOIN users c ON c.id=sh.closed_by JOIN stores st ON st.id=sh.store_id
      WHERE sh.business_id=$1 AND sh.opened_at >= $2 AND sh.opened_at < $3 ${where} ORDER BY sh.opened_at DESC`, params));
}));
r.get('/shifts/:id', requirePerm('reports.view', 'shift.manage'), ah(async (req, res) => {
  const s = await db.one(`SELECT id FROM shifts WHERE id=$1 AND business_id=$2`, [req.params.id, req.auth.businessId]);
  if (!s) throw notFound('Shift');
  res.json(await shiftSummary(s.id));
}));

r.post('/shifts/open', requireUser, requirePerm('shift.manage'), requireStore, ah(async (req, res) => {
  const open = await db.one(`SELECT id FROM shifts WHERE store_id=$1 AND status='open' AND device_id IS NOT DISTINCT FROM $2`, [req.storeId, req.auth.deviceId ?? null]);
  if (open) throw bad('A shift is already open on this terminal');
  const s = await db.one(`INSERT INTO shifts (business_id, store_id, device_id, opened_by, opening_cash) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
    req.auth.businessId, req.storeId, req.auth.deviceId ?? null, req.auth.userId, num(req.body?.opening_cash),
  ]);
  await audit(req, 'open_shift', 'shifts', s!.id, { opening_cash: num(req.body?.opening_cash) });
  res.status(201).json(await shiftSummary(s!.id));
}));

r.post('/shifts/:id/close', requireUser, requirePerm('shift.manage'), ah(async (req, res) => {
  const s = await db.one(`SELECT * FROM shifts WHERE id=$1 AND business_id=$2 AND status='open'`, [req.params.id, req.auth.businessId]);
  if (!s) throw notFound('Open shift');
  const sum = await shiftSummary(s.id);
  const actual = num(req.body?.actual_cash);
  const diff = r2(actual - sum.cash.expected);
  await db.query(`UPDATE shifts SET status='closed', closed_at=now(), closed_by=$2, expected_cash=$3, actual_cash=$4, difference=$5, close_note=$6 WHERE id=$1`, [
    s.id, req.auth.userId, sum.cash.expected, actual, diff, req.body?.note || null,
  ]);
  await audit(req, 'close_shift', 'shifts', s.id, { expected: sum.cash.expected, actual, difference: diff });
  if (Math.abs(diff) >= 1) {
    await notify(req.auth.businessId, s.store_id, 'cash_discrepancy', `Shift closed with cash ${diff > 0 ? 'surplus' : 'shortage'} of ${Math.abs(diff)}`, { shift_id: s.id, diff });
  }
  res.json(await shiftSummary(s.id));
}));

const CASH_TYPES = ['pay_in', 'pay_out', 'expense', 'deposit', 'withdrawal', 'supplier_payment'];
r.post('/cash-movements', requireUser, requirePerm('cash.manage'), requireStore, ah(async (req, res) => {
  const { type, amount, reason } = req.body || {};
  if (!CASH_TYPES.includes(type)) throw bad('Invalid type');
  if (num(amount) <= 0) throw bad('Enter an amount');
  if (!reason) throw bad('A reason is required for every cash movement');
  const shift = await db.one(`SELECT id FROM shifts WHERE store_id=$1 AND status='open' ORDER BY (device_id IS NOT DISTINCT FROM $2) DESC, opened_at DESC LIMIT 1`, [req.storeId, req.auth.deviceId ?? null]);
  if (!shift) throw bad('Open a shift first');
  const m = await db.one(`INSERT INTO cash_movements (business_id, store_id, shift_id, user_id, type, amount, reason) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [
    req.auth.businessId, req.storeId, shift.id, req.auth.userId, type, num(amount), reason,
  ]);
  if (type === 'expense') await db.query(`INSERT INTO expenses (business_id, store_id, category, amount, note, user_id) VALUES ($1,$2,'Petty cash',$3,$4,$5)`, [req.auth.businessId, req.storeId, num(amount), reason, req.auth.userId]);
  await audit(req, 'cash_movement', 'cash_movements', m!.id, { type, amount, reason });
  res.status(201).json(m);
}));

r.get('/cash-movements', requirePerm('reports.view', 'cash.manage'), ah(async (req, res) => {
  const { from, to } = range(req);
  const params: any[] = [req.auth.businessId, from, to];
  let where = '';
  if (req.storeId) where = ` AND m.store_id=$${params.push(req.storeId)}`;
  res.json(await db.query(`SELECT m.*, u.name AS user_name, s.name AS store_name FROM cash_movements m JOIN users u ON u.id=m.user_id JOIN stores s ON s.id=m.store_id
     WHERE m.business_id=$1 AND m.created_at >= $2 AND m.created_at < $3 ${where} ORDER BY m.created_at DESC`, params));
}));

// Expenses (back office)
r.use('/expenses', crud({ table: 'expenses', fields: ['store_id', 'category', 'amount', 'note', 'spent_on'], required: ['category', 'amount'], perm: 'reports.view', readPerm: 'reports.view', orderBy: 'spent_on DESC' }));

export default r;
