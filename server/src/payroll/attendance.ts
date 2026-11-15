import { Router, type Request } from 'express';
import { db, tx, type Q } from '../db.ts';
import { requirePerm } from '../auth.ts';
import { ah, audit, bad, notify } from '../util.ts';
import { assertDateRange, attendanceSummary, bid, isoDate, visibleDepartments } from './common.ts';

const r = Router();
const LEAVE = ['vacation', 'sick', 'unpaid', 'permission', 'maternity', 'other'];
const STATUS = ['present', 'absent', 'leave', 'holiday', 'off'];

function hoursBetween(a?: string | null, b?: string | null) {
  if (!a || !b) return null;
  const [h1, m1] = a.split(':').map(Number), [h2, m2] = b.split(':').map(Number);
  let mins = h2 * 60 + m2 - (h1 * 60 + m1);
  if (mins < 0) mins += 24 * 60; // overnight shift
  return Math.round((mins / 60) * 100) / 100;
}

async function assertEmployeeVisible(req: Request, q: Q, employeeId: string) {
  const e = await q.one(`SELECT id, department_id, full_name FROM pr_employees WHERE id=$1 AND business_id=$2`, [employeeId, bid(req)]);
  if (!e) throw bad('Employee not found');
  const depts = await visibleDepartments(req);
  if (depts && !depts.includes(e.department_id)) throw bad(`You do not manage ${e.full_name}'s department`);
  return e;
}

/** Locked periods freeze their attendance too. */
async function assertDateOpen(q: Q, businessId: string, employeeId: string, date: string) {
  const p = await q.one(
    `SELECT p.code FROM pr_periods p JOIN pr_records r ON r.period_id=p.id
      WHERE p.business_id=$1 AND r.employee_id=$2 AND $3 BETWEEN p.start_date AND p.end_date AND p.status IN ('approved','partially_paid','paid','closed') LIMIT 1`,
    [businessId, employeeId, date],
  );
  if (p) throw bad(`${date} belongs to approved payroll ${p.code}; reopen it to change attendance`);
}

function normalise(raw: any) {
  const work_date = isoDate(raw.work_date);
  if (!work_date || !/^\d{4}-\d{2}-\d{2}$/.test(work_date)) throw bad('A valid date is required');
  const check_in = raw.check_in || null, check_out = raw.check_out || null;
  let regular = raw.regular_hours === '' || raw.regular_hours === undefined || raw.regular_hours === null ? hoursBetween(check_in, check_out) ?? 0 : Number(raw.regular_hours);
  const overtime = Number(raw.overtime_hours) || 0;
  const holiday = Number(raw.holiday_hours) || 0;
  if (![regular, overtime, holiday].every((h) => Number.isFinite(h) && h >= 0 && h <= 24)) throw bad('Hours must be between 0 and 24');
  const leave_type = raw.leave_type && LEAVE.includes(raw.leave_type) ? raw.leave_type : null;
  let status = STATUS.includes(raw.status) ? raw.status : leave_type ? 'leave' : regular > 0 ? 'present' : 'absent';
  if (status === 'absent') regular = 0;
  return { work_date, check_in, check_out, regular_hours: regular, overtime_hours: overtime, holiday_hours: holiday, leave_type, status, remarks: raw.remarks || null };
}

async function upsert(q: Q, req: Request, employeeId: string, raw: any, source = 'manual') {
  const a = normalise(raw);
  await assertDateOpen(q, bid(req), employeeId, a.work_date);
  const approve = req.auth.permissions.has('payroll.process') || req.auth.permissions.has('payroll.approve');
  const otApproved = raw.overtime_approved === true && approve;
  return q.one(
    `INSERT INTO pr_attendance (business_id, employee_id, work_date, check_in, check_out, regular_hours, overtime_hours, overtime_approved, holiday_hours,
        leave_type, status, remarks, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET check_in=EXCLUDED.check_in, check_out=EXCLUDED.check_out, regular_hours=EXCLUDED.regular_hours,
        overtime_hours=EXCLUDED.overtime_hours,
        overtime_approved = CASE WHEN EXCLUDED.overtime_hours = pr_attendance.overtime_hours AND NOT $15 THEN pr_attendance.overtime_approved ELSE EXCLUDED.overtime_approved END,
        holiday_hours=EXCLUDED.holiday_hours, leave_type=EXCLUDED.leave_type, status=EXCLUDED.status, remarks=EXCLUDED.remarks,
        source=EXCLUDED.source, submitted=false, updated_at=now()
     RETURNING *`,
    [bid(req), employeeId, a.work_date, a.check_in, a.check_out, a.regular_hours, a.overtime_hours, otApproved, a.holiday_hours, a.leave_type, a.status,
     a.remarks, source, req.auth.userId, raw.overtime_approved !== undefined && approve],
  );
}

r.get('/attendance', ah(async (req, res) => {
  const from = isoDate(req.query.from), to = isoDate(req.query.to);
  assertDateRange(from, to);
  const params: any[] = [bid(req), from, to];
  let w = 'a.business_id=$1 AND a.work_date BETWEEN $2 AND $3';
  const depts = await visibleDepartments(req);
  if (depts) w += ` AND e.department_id = ANY($${params.push(depts)}::uuid[])`;
  if (req.query.department_id) w += ` AND e.department_id=$${params.push(String(req.query.department_id))}`;
  if (req.query.employee_id) w += ` AND a.employee_id=$${params.push(String(req.query.employee_id))}`;
  res.json(await db.query(
    `SELECT a.*, e.full_name, e.code, e.department_id, d.name AS department_name
       FROM pr_attendance a JOIN pr_employees e ON e.id=a.employee_id LEFT JOIN pr_departments d ON d.id=e.department_id
      WHERE ${w} ORDER BY a.work_date, e.full_name LIMIT 5000`, params));
}));

r.post('/attendance', requirePerm('payroll.attendance', 'payroll.process'), ah(async (req, res) => {
  const { employee_id } = req.body || {};
  await assertEmployeeVisible(req, db, employee_id);
  const row = await upsert(db, req, employee_id, req.body);
  await audit(req, 'save', 'pr_attendance', row!.id, req.body);
  res.status(201).json(row);
}));

/** Bulk entry / Excel-CSV import: rows of {employee_id | code | cedula | name, work_date, …}. */
r.post('/attendance/bulk', requirePerm('payroll.attendance', 'payroll.process'), ah(async (req, res) => {
  const rows: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) throw bad('No rows');
  if (rows.length > 5000) throw bad('At most 5,000 rows per import');
  const emps = await db.query(`SELECT id, code, cedula, full_name, short_name, department_id FROM pr_employees WHERE business_id=$1`, [bid(req)]);
  const depts = await visibleDepartments(req);
  const norm = (s: any) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const digits = (s: any) => String(s || '').replace(/\D/g, '');
  const find = (r: any) =>
    emps.find((e) => r.employee_id && e.id === r.employee_id) ||
    emps.find((e) => r.code && norm(e.code) === norm(r.code)) ||
    emps.find((e) => r.cedula && digits(e.cedula) && digits(e.cedula) === digits(r.cedula)) ||
    emps.find((e) => r.name && (norm(e.full_name) === norm(r.name) || (e.short_name && norm(e.short_name) === norm(r.name))));
  const report: any[] = [];
  let saved = 0;
  await tx(async (q) => {
    for (const [i, raw] of rows.entries()) {
      const e = find(raw);
      if (!e) { report.push({ row: i + 1, status: 'error', message: `Employee not found: ${raw.code || raw.cedula || raw.name || '?'}` }); continue; }
      if (depts && !depts.includes(e.department_id)) { report.push({ row: i + 1, status: 'error', message: `Not your department: ${e.full_name}` }); continue; }
      try {
        await upsert(q, req, e.id, raw, req.body.source === 'import' ? 'import' : 'manual');
        saved++;
      } catch (err: any) {
        report.push({ row: i + 1, status: 'error', message: `${e.full_name}: ${err.message}` });
      }
    }
  });
  await audit(req, 'bulk_save', 'pr_attendance', null, { rows: rows.length, saved });
  res.json({ saved, errors: report });
}));

r.post('/attendance/approve-overtime', requirePerm('payroll.process', 'payroll.approve'), ah(async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const approved = req.body?.approved !== false;
  if (!ids.length) throw bad('Select records');
  const rows = await db.query(`UPDATE pr_attendance SET overtime_approved=$3, updated_at=now() WHERE business_id=$1 AND id = ANY($2::uuid[]) AND overtime_hours > 0 RETURNING id`, [bid(req), ids, approved]);
  await audit(req, approved ? 'approve_overtime' : 'unapprove_overtime', 'pr_attendance', null, { ids });
  res.json({ updated: rows.length });
}));

/** Department manager submits the attendance of a date range for payroll. */
r.post('/attendance/submit', requirePerm('payroll.attendance', 'payroll.process'), ah(async (req, res) => {
  const from = isoDate(req.body?.from), to = isoDate(req.body?.to);
  assertDateRange(from, to);
  const params: any[] = [bid(req), from, to];
  let w = '';
  const depts = await visibleDepartments(req);
  if (depts) w += ` AND employee_id IN (SELECT id FROM pr_employees WHERE department_id = ANY($${params.push(depts)}::uuid[]))`;
  if (req.body?.department_id) w += ` AND employee_id IN (SELECT id FROM pr_employees WHERE department_id=$${params.push(req.body.department_id)})`;
  const rows = await db.query(`UPDATE pr_attendance SET submitted=true WHERE business_id=$1 AND work_date BETWEEN $2 AND $3 ${w} RETURNING id`, params);
  await audit(req, 'submit_attendance', 'pr_attendance', null, { from, to, count: rows.length });
  await notify(bid(req), null, 'payroll_attendance_submitted', `${req.auth.userName} submitted attendance ${from} – ${to} (${rows.length} records)`);
  res.json({ submitted: rows.length });
}));

r.delete('/attendance/:id', requirePerm('payroll.attendance', 'payroll.process'), ah(async (req, res) => {
  const a = await db.one(`SELECT * FROM pr_attendance WHERE id=$1 AND business_id=$2`, [req.params.id, bid(req)]);
  if (!a) throw bad('Record not found');
  await assertEmployeeVisible(req, db, a.employee_id);
  await assertDateOpen(db, bid(req), a.employee_id, isoDate(a.work_date)!);
  await db.query(`DELETE FROM pr_attendance WHERE id=$1`, [a.id]);
  await audit(req, 'delete', 'pr_attendance', a.id, a);
  res.json({ ok: true });
}));

/** Payroll-period summary per employee (Module 4). */
r.get('/attendance/summary', ah(async (req, res) => {
  const from = isoDate(req.query.from), to = isoDate(req.query.to);
  assertDateRange(from, to);
  const sum = await attendanceSummary(db, bid(req), from!, to!);
  const params: any[] = [bid(req)];
  let w = `e.business_id=$1 AND e.status='active'`;
  const depts = await visibleDepartments(req);
  if (depts) w += ` AND e.department_id = ANY($${params.push(depts)}::uuid[])`;
  const emps = await db.query(`SELECT e.id, e.code, e.full_name, d.name AS department_name FROM pr_employees e LEFT JOIN pr_departments d ON d.id=e.department_id WHERE ${w} ORDER BY d.sort NULLS LAST, e.full_name`, params);
  const map = new Map(sum.map((s) => [s.employee_id, s]));
  const holidays = await db.query(`SELECT holiday_date, name, paid FROM pr_holidays WHERE business_id=$1 AND holiday_date BETWEEN $2 AND $3 ORDER BY holiday_date`, [bid(req), from, to]);
  res.json({ rows: emps.map((e) => ({ ...e, ...(map.get(e.id) || { records: 0 }) })), holidays });
}));

/** Pull clock-in/out from the POS time clock for employees linked to a POS user. */
r.post('/attendance/from-timeclock', requirePerm('payroll.process', 'payroll.attendance'), ah(async (req, res) => {
  const from = isoDate(req.body?.from), to = isoDate(req.body?.to);
  assertDateRange(from, to);
  const tz = (await db.one(`SELECT timezone FROM businesses WHERE id=$1`, [bid(req)]))?.timezone || 'America/Costa_Rica';
  const rows = await db.query(
    `SELECT e.id AS employee_id, (t.clock_in AT TIME ZONE $4)::date AS work_date,
            min((t.clock_in AT TIME ZONE $4)::time) AS check_in, max((t.clock_out AT TIME ZONE $4)::time) AS check_out,
            sum(EXTRACT(EPOCH FROM (t.clock_out - t.clock_in))/3600 - t.break_minutes/60.0) AS hours
       FROM time_entries t JOIN pr_employees e ON e.user_id=t.user_id AND e.business_id=t.business_id
      WHERE t.business_id=$1 AND t.clock_out IS NOT NULL AND (t.clock_in AT TIME ZONE $4)::date BETWEEN $2 AND $3
      GROUP BY e.id, (t.clock_in AT TIME ZONE $4)::date`,
    [bid(req), from, to, tz],
  );
  let saved = 0;
  const errors: string[] = [];
  await tx(async (q) => {
    for (const x of rows) {
      const existing = await q.one(`SELECT source FROM pr_attendance WHERE employee_id=$1 AND work_date=$2`, [x.employee_id, x.work_date]);
      if (existing && existing.source !== 'timeclock') continue; // never overwrite manual entries
      try {
        await upsert(q, req, x.employee_id, {
          work_date: x.work_date, check_in: String(x.check_in).slice(0, 5), check_out: String(x.check_out).slice(0, 5),
          regular_hours: Math.round(Number(x.hours) * 100) / 100,
        }, 'timeclock');
        saved++;
      } catch (e: any) {
        errors.push(e.message);
      }
    }
  });
  res.json({ saved, found: rows.length, errors });
}));

export default r;
