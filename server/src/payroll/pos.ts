/**
 * POS ↔ Payroll integration.
 * POS staff (users) are the people who log into the POS and clock in/out. Payroll employees (pr_employees) carry the
 * HR, salary and banking details. A payroll employee is linked to at most one POS user through pr_employees.user_id;
 * once linked, the POS time clock feeds payroll attendance and the employee sees their payslips with their POS login.
 */
import { Router } from 'express';
import { db, tx, type Q } from '../db.ts';
import { requirePerm } from '../auth.ts';
import { ah, audit, bad } from '../util.ts';
import { bid, canSeePay, logChange, nextEmployeeCode, who } from './common.ts';

const r = Router();
const today = () => new Date().toISOString().slice(0, 10);
const norm = (s: any) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Throws when the POS user is missing, belongs to another business, or is already linked to another payroll employee. */
export async function assertLinkable(q: Q, businessId: string, userId: string, exceptEmployeeId?: string) {
  const u = await q.one(`SELECT id, name FROM users WHERE id=$1 AND business_id=$2`, [userId, businessId]);
  if (!u) throw bad('POS user not found');
  const other = await q.one(
    `SELECT code, full_name FROM pr_employees WHERE business_id=$1 AND user_id=$2 AND ($3::uuid IS NULL OR id<>$3::uuid)`,
    [businessId, userId, exceptEmployeeId ?? null],
  );
  if (other) throw bad(`POS user ${u.name} is already linked to ${other.full_name} (${other.code})`);
  return u;
}

/** POS staff with their payroll link status, plus payroll employees not yet linked (with suggested matches). */
r.get('/pos-staff', requirePerm('payroll.employees', 'payroll.access', 'payroll.reports'), ah(async (req, res) => {
  const showPay = canSeePay(req);
  // "This month" is the calendar month in the business time zone (Costa Rica), not the server's.
  const staff = await db.query(
    `WITH bz AS (SELECT timezone AS tz FROM businesses WHERE id=$1),
          m AS (SELECT (date_trunc('month', now() AT TIME ZONE bz.tz) AT TIME ZONE bz.tz) AS start FROM bz)
     SELECT u.id, u.name, u.email, u.phone, u.employee_code, u.designation, u.joined_on, u.salary, u.hourly_rate, u.active, u.is_owner,
            r.name AS role_name, e.id AS employee_id, e.code AS payroll_code, e.full_name AS payroll_name, e.status AS payroll_status,
            (SELECT max(t.clock_in) FROM time_entries t WHERE t.user_id=u.id AND t.business_id=u.business_id) AS last_clock_in,
            (SELECT t.clock_in FROM time_entries t WHERE t.user_id=u.id AND t.business_id=u.business_id AND t.clock_out IS NULL
              ORDER BY t.clock_in DESC LIMIT 1) AS on_shift_since,
            (SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (t.clock_out - t.clock_in)) / 3600 - t.break_minutes / 60.0)), 0)
               FROM time_entries t, m WHERE t.user_id=u.id AND t.business_id=u.business_id AND t.clock_out IS NOT NULL AND t.clock_in >= m.start) AS month_hours,
            (SELECT COUNT(DISTINCT (t.clock_in AT TIME ZONE bz.tz)::date)
               FROM time_entries t, m, bz WHERE t.user_id=u.id AND t.business_id=u.business_id AND t.clock_in >= m.start) AS month_days,
            (SELECT COUNT(*) FROM sales s, m WHERE s.user_id=u.id AND s.business_id=u.business_id AND s.type='sale' AND s.created_at >= m.start) AS month_receipts,
            (SELECT COALESCE(SUM(CASE WHEN s.type='sale' THEN s.total ELSE -s.total END), 0)
               FROM sales s, m WHERE s.user_id=u.id AND s.business_id=u.business_id AND s.created_at >= m.start) AS month_sales
       FROM users u
       LEFT JOIN roles r ON r.id=u.role_id
       LEFT JOIN pr_employees e ON e.user_id=u.id AND e.business_id=u.business_id
      WHERE u.business_id=$1 AND NOT u.is_super_admin
      ORDER BY u.active DESC, u.name`,
    [bid(req)],
  );
  for (const s of staff) {
    s.month_hours = Math.round(Number(s.month_hours) * 100) / 100;
    s.month_days = Number(s.month_days);
    s.month_receipts = Number(s.month_receipts);
    s.month_sales = Math.round(Number(s.month_sales) * 100) / 100;
  }
  const unlinked = await db.query(
    `SELECT id, code, full_name, short_name, email, status FROM pr_employees WHERE business_id=$1 AND user_id IS NULL ORDER BY full_name`,
    [bid(req)],
  );
  // Suggest the payroll employee that most likely is the same person: same e-mail, same code, or same name.
  for (const s of staff) {
    if (!showPay) { s.salary = null; s.hourly_rate = null; }
    if (s.employee_id) continue;
    const m =
      (s.email && unlinked.find((e: any) => e.email && norm(e.email) === norm(s.email))) ||
      (s.employee_code && unlinked.find((e: any) => norm(e.code) === norm(s.employee_code))) ||
      unlinked.find((e: any) => norm(e.full_name) === norm(s.name) || (e.short_name && norm(e.short_name) === norm(s.name)));
    s.suggested_employee_id = m?.id ?? null;
  }
  res.json({ staff, unlinked_employees: unlinked, can_see_pay: showPay });
}));

/**
 * Creates a payroll employee from a POS user (name, e-mail, phone, code, joining date, position, salary) and links them.
 * Used by the manual import and by the automatic POS ↔ payroll sync.
 */
export async function createFromPosUser(q: Q, businessId: string, it: { user_id: string; department_id?: string | null; payment_method?: string },
  actor: { id: string | null; name: string | null }, setSalary: boolean) {
  const p = await q.one(`SELECT * FROM users WHERE id=$1 AND business_id=$2 AND NOT is_super_admin`, [it.user_id, businessId]);
  if (!p) throw bad('POS user not found');
  await assertLinkable(q, businessId, p.id);
  if (it.department_id && !(await q.one(`SELECT 1 FROM pr_departments WHERE id=$1 AND business_id=$2`, [it.department_id, businessId])))
    throw bad('Department not found');
  const wanted = String(p.employee_code || '').trim();
  const taken = wanted && (await q.one(`SELECT 1 FROM pr_employees WHERE business_id=$1 AND code=$2`, [businessId, wanted]));
  const code = wanted && !taken ? wanted : await nextEmployeeCode(q, businessId);
  const position = p.designation
    ? await q.one(`SELECT id FROM pr_positions WHERE business_id=$1 AND lower(name)=lower($2) AND active`, [businessId, String(p.designation).trim()])
    : null;
  const hourly = Number(p.hourly_rate) > 0;
  const joining = p.joined_on ? String(p.joined_on instanceof Date ? p.joined_on.toISOString() : p.joined_on).slice(0, 10) : today();
  const payment = it.payment_method && ['cash', 'transfer', 'usd', 'sinpe', 'other'].includes(it.payment_method) ? it.payment_method : 'transfer';
  const e = await q.one(
    `INSERT INTO pr_employees (business_id, code, full_name, email, phone, department_id, position_id, employment_type, joining_date,
                               status, payment_method, photo_url, user_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [businessId, code, p.name, p.email, p.phone, it.department_id || null, position?.id ?? null, hourly ? 'hourly' : 'monthly', joining,
     p.active ? 'active' : 'inactive', payment, p.photo_url, p.id, 'Imported from POS staff'],
  );
  const amount = hourly ? Number(p.hourly_rate) : Number(p.salary);
  if (setSalary && amount > 0)
    await q.query(
      `INSERT INTO pr_salary_history (business_id, employee_id, effective_from, salary_type, hourly_rate, monthly_salary, currency, reason, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,'CRC','Imported from POS staff',$7,$8)`,
      [businessId, e!.id, joining, hourly ? 'hourly' : 'monthly', hourly ? amount : null, hourly ? null : amount, actor.id, actor.name],
    );
  return { ...e!, salary_set: setSalary && amount > 0 };
}

/**
 * Create payroll employees from POS staff. Body: { items: [{ user_id, department_id?, payment_method? }] }.
 * Name, e-mail, phone, employee code, joining date, position (designation) and salary are taken from the POS record.
 */
r.post('/pos-staff/import', requirePerm('payroll.employees'), ah(async (req, res) => {
  const items: any[] = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) throw bad('Select at least one POS employee');
  const setSalary = req.auth.permissions.has('payroll.salary');
  const u = who(req);
  const created: any[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const it of items) {
    try {
      const row = await tx((q) => createFromPosUser(q, bid(req), it, u, setSalary));
      created.push(row);
    } catch (err: any) {
      const name = (await db.one(`SELECT name FROM users WHERE id=$1 AND business_id=$2`, [it.user_id, bid(req)]).catch(() => null))?.name || String(it.user_id);
      if (err?.status && err.status < 500) skipped.push({ name, reason: err.message });
      else throw err;
    }
  }
  if (created.length)
    await audit(req, 'payroll_import_pos_staff', 'pr_employees', null, { created: created.map((e) => ({ id: e.id, code: e.code, name: e.full_name })) });
  res.status(created.length ? 201 : 200).json({ created, skipped, without_salary: created.filter((e) => !e.salary_set).map((e) => e.full_name) });
}));

/** Link (or unlink with user_id null) an existing payroll employee and a POS user. */
r.post('/pos-staff/link', requirePerm('payroll.employees'), ah(async (req, res) => {
  const { employee_id, user_id } = req.body || {};
  const row = await tx(async (q) => {
    const e = await q.one(`SELECT * FROM pr_employees WHERE id=$1 AND business_id=$2`, [employee_id, bid(req)]);
    if (!e) throw bad('Payroll employee not found');
    let newName: string | null = null;
    if (user_id) newName = (await assertLinkable(q, bid(req), user_id, e.id)).name;
    const oldName = e.user_id ? (await q.one(`SELECT name FROM users WHERE id=$1`, [e.user_id]))?.name ?? null : null;
    const n = await q.one(`UPDATE pr_employees SET user_id=$2, updated_at=now() WHERE id=$1 RETURNING *`, [e.id, user_id || null]);
    await logChange(q, req, e.id, 'pos_user', oldName, newName);
    return n!;
  });
  await audit(req, user_id ? 'payroll_link_pos_user' : 'payroll_unlink_pos_user', 'pr_employees', row.id, { user_id: user_id || null });
  res.json(row);
}));

export default r;
