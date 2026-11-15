import { Router } from 'express';
import { db } from '../db.ts';
import { requirePerm } from '../auth.ts';
import { ah, audit, bad, notify } from '../util.ts';
import { assertDateRange, bid, getOwned, isoDate, visibleDepartments, who } from './common.ts';
import { vacationBalance } from './employees.ts';

const r = Router();

/** Vacation balances for all active employees (maintained independently of payroll periods). */
r.get('/vacation/balances', ah(async (req, res) => {
  const params: any[] = [bid(req)];
  let w = `e.business_id=$1 AND e.status <> 'inactive'`;
  const depts = await visibleDepartments(req);
  if (depts) w += ` AND e.department_id = ANY($${params.push(depts)}::uuid[])`;
  const emps = await db.query(`SELECT e.*, d.name AS department_name FROM pr_employees e LEFT JOIN pr_departments d ON d.id=e.department_id WHERE ${w} ORDER BY d.sort NULLS LAST, e.full_name`, params);
  const out: any[] = [];
  for (const e of emps) {
    const b = await vacationBalance(e);
    out.push({ employee_id: e.id, code: e.code, full_name: e.full_name, department_name: e.department_name, joining_date: e.joining_date, ...b, txns: undefined });
  }
  res.json(out);
}));

r.get('/vacation/:employeeId', ah(async (req, res) => {
  const e = await getOwned(db, 'pr_employees', req.params.employeeId, bid(req), 'Employee');
  const requests = await db.query(`SELECT * FROM pr_vacation_requests WHERE employee_id=$1 ORDER BY start_date DESC`, [e.id]);
  res.json({ ...(await vacationBalance(e)), requests });
}));

r.get('/vacation-requests', ah(async (req, res) => {
  const params: any[] = [bid(req)];
  let w = 'v.business_id=$1';
  const depts = await visibleDepartments(req);
  if (depts) w += ` AND e.department_id = ANY($${params.push(depts)}::uuid[])`;
  if (req.query.status) w += ` AND v.status=$${params.push(String(req.query.status))}`;
  res.json(await db.query(
    `SELECT v.*, e.full_name, e.code, d.name AS department_name FROM pr_vacation_requests v JOIN pr_employees e ON e.id=v.employee_id
       LEFT JOIN pr_departments d ON d.id=e.department_id WHERE ${w} ORDER BY v.start_date DESC LIMIT 1000`, params));
}));

r.post('/vacation-requests', requirePerm('payroll.attendance', 'payroll.employees', 'payroll.process'), ah(async (req, res) => {
  const { employee_id, start_date, end_date, notes } = req.body || {};
  assertDateRange(start_date, end_date);
  const e = await getOwned(db, 'pr_employees', employee_id, bid(req), 'Employee');
  const depts = await visibleDepartments(req);
  if (depts && !depts.includes(e.department_id)) throw bad('Not your department');
  const days = Number(req.body.days) || Math.round((new Date(end_date).getTime() - new Date(start_date).getTime()) / 86400000) + 1;
  if (!(days > 0)) throw bad('Days must be greater than 0');
  const overlap = await db.one(`SELECT 1 FROM pr_vacation_requests WHERE employee_id=$1 AND status IN ('requested','approved') AND start_date <= $3 AND end_date >= $2`, [e.id, start_date, end_date]);
  if (overlap) throw bad('Overlaps another vacation request');
  const bal = await vacationBalance(e);
  const row = await db.one(
    `INSERT INTO pr_vacation_requests (business_id, employee_id, start_date, end_date, days, notes, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [bid(req), e.id, start_date, end_date, days, notes || null, req.auth.userId]);
  await audit(req, 'create', 'pr_vacation_requests', row!.id, { employee: e.full_name, start_date, end_date, days });
  await notify(bid(req), null, 'payroll_vacation_request', `Vacation request: ${e.full_name}, ${days} day(s) from ${start_date}${days > bal.balance ? ` (balance only ${bal.balance})` : ''}`, { request_id: row!.id });
  res.status(201).json({ ...row, balance: bal.balance });
}));

r.post('/vacation-requests/:id/decision', requirePerm('payroll.employees', 'payroll.approve'), ah(async (req, res) => {
  const v = await getOwned(db, 'pr_vacation_requests', req.params.id, bid(req), 'Request');
  if (v.status !== 'requested') throw bad('Already decided');
  const approve = req.body?.approve === true;
  const u = who(req);
  const row = await db.one(`UPDATE pr_vacation_requests SET status=$2, approved_by=$3, approved_by_name=$4, decided_at=now(), notes=COALESCE($5, notes) WHERE id=$1 RETURNING *`,
    [v.id, approve ? 'approved' : 'rejected', u.id, u.name, req.body?.notes || null]);
  if (approve)
    await db.query(`INSERT INTO pr_vacation_txns (business_id, employee_id, txn_date, kind, days, request_id, note, created_by) VALUES ($1,$2,$3,'taken',$4,$5,$6,$7)`,
      [bid(req), v.employee_id, v.start_date, v.days, v.id, `Vacation ${isoDate(v.start_date)} – ${isoDate(v.end_date)}`, u.id]);
  const e = await db.one(`SELECT full_name FROM pr_employees WHERE id=$1`, [v.employee_id]);
  await audit(req, approve ? 'approve' : 'reject', 'pr_vacation_requests', v.id, { employee: e?.full_name, days: v.days });
  await notify(bid(req), null, approve ? 'payroll_vacation_approved' : 'payroll_vacation_rejected', `Vacation for ${e?.full_name} (${v.days} d) ${approve ? 'approved' : 'rejected'} by ${u.name}`, { request_id: v.id });
  res.json(row);
}));

r.post('/vacation-requests/:id/cancel', requirePerm('payroll.employees', 'payroll.approve'), ah(async (req, res) => {
  const v = await getOwned(db, 'pr_vacation_requests', req.params.id, bid(req), 'Request');
  await db.query(`UPDATE pr_vacation_requests SET status='cancelled' WHERE id=$1`, [v.id]);
  await db.query(`DELETE FROM pr_vacation_txns WHERE request_id=$1`, [v.id]);
  await audit(req, 'cancel', 'pr_vacation_requests', v.id);
  res.json({ ok: true });
}));

/** Manual balance correction (opening balance migration, compensation …). */
r.post('/vacation/:employeeId/adjust', requirePerm('payroll.employees'), ah(async (req, res) => {
  const e = await getOwned(db, 'pr_employees', req.params.employeeId, bid(req), 'Employee');
  const days = Number(req.body?.days);
  if (!Number.isFinite(days) || !days) throw bad('Enter the days to add (+) or remove (−)');
  if (!String(req.body?.note || '').trim()) throw bad('A note is required');
  await db.query(`INSERT INTO pr_vacation_txns (business_id, employee_id, txn_date, kind, days, note, created_by) VALUES ($1,$2,$3,'adjustment',$4,$5,$6)`,
    [bid(req), e.id, req.body.txn_date || new Date().toISOString().slice(0, 10), days, req.body.note, req.auth.userId]);
  await audit(req, 'vacation_adjust', 'pr_employees', e.id, { days, note: req.body.note });
  res.json(await vacationBalance(e));
}));

/** Overtime register: attendance rows with overtime, for manager approval. */
r.get('/overtime', ah(async (req, res) => {
  const from = isoDate(req.query.from), to = isoDate(req.query.to);
  assertDateRange(from, to);
  const params: any[] = [bid(req), from, to];
  let w = 'a.business_id=$1 AND a.work_date BETWEEN $2 AND $3 AND a.overtime_hours > 0';
  const depts = await visibleDepartments(req);
  if (depts) w += ` AND e.department_id = ANY($${params.push(depts)}::uuid[])`;
  if (req.query.pending === '1') w += ' AND NOT a.overtime_approved';
  res.json(await db.query(
    `SELECT a.*, e.full_name, e.code, d.name AS department_name FROM pr_attendance a JOIN pr_employees e ON e.id=a.employee_id
       LEFT JOIN pr_departments d ON d.id=e.department_id WHERE ${w} ORDER BY a.work_date DESC, e.full_name`, params));
}));

export default r;
