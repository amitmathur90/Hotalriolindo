import { Router } from 'express';
import { db, json, tx } from '../db.ts';
import { requirePerm } from '../auth.ts';
import { HttpError, ah, audit, bad, notify } from '../util.ts';
import { OVERRIDE_KEYS, OVERRIDE_LABELS, PERIOD_STATUS_LABELS, roundTo } from '../../../shared/payroll.ts';
import {
  addRecord, advanceBalances, assertDateRange, attendanceSummary, bid, canSeePay, getOwned, isLocked, isoDate, lockedGuard, recalcPeriod,
  recalcRecord, resnapshotRecord, rulesAt, validatePeriod, who,
} from './common.ts';

const r = Router();
const r2 = (v: number) => roundTo(v, 2);
const readPay = requirePerm('payroll.access', 'payroll.process', 'payroll.approve', 'payroll.payments');

const TOTALS = `count(*) AS employees, COALESCE(sum(gross),0) AS gross, COALESCE(sum(overtime_pay),0) AS overtime, COALESCE(sum(holiday_pay),0) AS holiday,
  COALESCE(sum(vacation_pay),0) AS vacation, COALESCE(sum(caja),0) AS caja, COALESCE(sum(earnings),0) AS earnings,
  COALESCE(sum(payroll_expense),0) AS payroll_expense, COALESCE(sum(accounts_deduction),0) AS accounts_deduction,
  COALESCE(sum(vales),0) AS vales, COALESCE(sum(adjustments),0) AS adjustments, COALESCE(sum(total_deductions),0) AS total_deductions,
  COALESCE(sum(net_payable),0) AS net_payable, COALESCE(sum(paid_amount),0) AS paid,
  COALESCE(sum(GREATEST(net_payable - paid_amount, 0)),0) AS pending,
  count(*) FILTER (WHERE jsonb_path_exists(warnings, '$[*] ? (@.level == "error")')) AS records_with_errors`;

function periodName(start: string, end: string) {
  const f = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${f(start)} – ${f(end)} ${end.slice(0, 4)}`;
}

r.get('/periods', readPay, ah(async (req, res) => {
  const params: any[] = [bid(req)];
  let w = 'p.business_id=$1';
  if (req.query.year) w += ` AND EXTRACT(YEAR FROM p.end_date)=$${params.push(Number(req.query.year))}`;
  if (req.query.status) w += ` AND p.status=$${params.push(String(req.query.status))}`;
  res.json(await db.query(
    `SELECT p.*, t.* FROM pr_periods p LEFT JOIN LATERAL (SELECT ${TOTALS} FROM pr_records r WHERE r.period_id=p.id) t ON true
      WHERE ${w} ORDER BY p.end_date DESC, p.created_at DESC LIMIT 500`, params));
}));

r.post('/periods', requirePerm('payroll.process'), ah(async (req, res) => {
  const { start_date, end_date, pay_date, notes, kind } = req.body || {};
  assertDateRange(start_date, end_date);
  const deptIds: string[] = Array.isArray(req.body.department_ids) ? req.body.department_ids : [];
  const empIds: string[] = Array.isArray(req.body.employee_ids) ? req.body.employee_ids : [];
  const overlap = await db.one(
    `SELECT code FROM pr_periods WHERE business_id=$1 AND kind='regular' AND start_date <= $3 AND end_date >= $2 LIMIT 1`, [bid(req), start_date, end_date]);
  if (overlap && kind !== 'special' && !req.body.allow_overlap) throw bad(`Dates overlap payroll ${overlap.code}. Use a special payroll or adjust the dates.`);
  const u = who(req);
  const period = await tx(async (q) => {
    const year = String(end_date).slice(0, 4);
    const n = await q.one(`SELECT count(*) AS n FROM pr_periods WHERE business_id=$1 AND code LIKE $2`, [bid(req), `PP-${year}-%`]);
    let seq = Number(n!.n) + 1, code = '';
    for (;;) {
      code = `PP-${year}-${String(seq).padStart(2, '0')}`;
      if (!(await q.one(`SELECT 1 FROM pr_periods WHERE business_id=$1 AND code=$2`, [bid(req), code]))) break;
      seq++;
    }
    const { ruleSet, rules } = await rulesAt(q, bid(req), end_date);
    const p = await q.one(
      `INSERT INTO pr_periods (business_id, code, name, start_date, end_date, pay_date, kind, department_ids, rule_set_id, rules, notes, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [bid(req), code, req.body.name?.trim() || periodName(start_date, end_date), start_date, end_date, pay_date || null, kind === 'special' ? 'special' : 'regular',
       json(deptIds), ruleSet?.id ?? null, json(rules), notes || null, u.id, u.name],
    );
    const params: any[] = [bid(req), start_date, end_date];
    let w = `business_id=$1 AND status <> 'inactive' AND (joining_date IS NULL OR joining_date <= $3) AND (leaving_date IS NULL OR leaving_date >= $2)`;
    if (empIds.length) w += ` AND id = ANY($${params.push(empIds)}::uuid[])`;
    else {
      w += ` AND status='active'`;
      if (deptIds.length) w += ` AND department_id = ANY($${params.push(deptIds)}::uuid[])`;
    }
    const emps = await q.query(`SELECT * FROM pr_employees WHERE ${w}`, params);
    for (const e of emps) await addRecord(q, p, e);
    if (req.body.load_attendance !== false) await loadAttendance(q, p, false);
    return p!;
  });
  await audit(req, 'payroll_period_create', 'pr_periods', period.id, { code: period.code, start_date, end_date, department_ids: deptIds });
  await notify(bid(req), null, 'payroll_period_created', `Payroll ${period.code} (${period.name}) created by ${u.name}`, { period_id: period.id });
  res.status(201).json(period);
}));

async function loadAttendance(q: any, period: any, overwrite: boolean) {
  const sum = await attendanceSummary(q, period.business_id, isoDate(period.start_date)!, isoDate(period.end_date)!);
  const map = new Map(sum.map((s: any) => [s.employee_id, s]));
  const recs = await q.query(`SELECT * FROM pr_records WHERE period_id=$1`, [period.id]);
  let loaded = 0;
  for (const rec of recs) {
    const s: any = map.get(rec.employee_id);
    if (!s) continue;
    if (!overwrite && rec.hours_source && rec.hours_source !== 'attendance') continue;
    await q.query(`UPDATE pr_records SET hours=$2, overtime_hours=$3, holiday_hours=$4, vacation_days=$5, hours_source='attendance' WHERE id=$1`,
      [rec.id, s.regular_hours, s.overtime_hours, s.holiday_hours, s.vacation_days]);
    await recalcRecord(q, rec.id);
    loaded++;
  }
  return loaded;
}

r.get('/periods/:id', readPay, ah(async (req, res) => {
  const p = await getOwned(db, 'pr_periods', req.params.id, bid(req), 'Payroll period');
  const [records, totals, holidays, byDept, emails] = await Promise.all([
    db.query(`SELECT r.*, e.code AS employee_code, e.email AS employee_email FROM pr_records r JOIN pr_employees e ON e.id=r.employee_id
               WHERE r.period_id=$1 ORDER BY (SELECT sort FROM pr_departments d WHERE d.id=r.department_id) NULLS LAST, r.department_name, r.employee_name`, [p.id]),
    db.one(`SELECT ${TOTALS} FROM pr_records WHERE period_id=$1`, [p.id]),
    db.query(`SELECT holiday_date, name, paid FROM pr_holidays WHERE business_id=$1 AND holiday_date BETWEEN $2 AND $3 ORDER BY holiday_date`, [bid(req), p.start_date, p.end_date]),
    db.query(`SELECT COALESCE(department_name,'No department') AS department, ${TOTALS} FROM pr_records WHERE period_id=$1 GROUP BY 1 ORDER BY 1`, [p.id]),
    db.query(`SELECT DISTINCT ON (record_id) record_id, status, sent_at, error FROM pr_email_log WHERE period_id=$1 ORDER BY record_id, created_at DESC`, [p.id]),
  ]);
  const em = new Map(emails.map((e) => [e.record_id, e]));
  res.json({ ...p, status_label: PERIOD_STATUS_LABELS[p.status as keyof typeof PERIOD_STATUS_LABELS], locked: isLocked(p.status), records: records.map((x) => ({ ...x, email: em.get(x.id) ?? null })), totals, holidays, by_department: byDept });
}));

r.put('/periods/:id', requirePerm('payroll.process'), ah(async (req, res) => {
  const p = await lockedGuard(db, req.params.id, bid(req));
  const { name, start_date, end_date, pay_date, notes } = req.body || {};
  const s = start_date || isoDate(p.start_date), e = end_date || isoDate(p.end_date);
  assertDateRange(s, e);
  const datesChanged = s !== isoDate(p.start_date) || e !== isoDate(p.end_date);
  const row = await tx(async (q) => {
    const upd = await q.one(`UPDATE pr_periods SET name=COALESCE($2,name), start_date=$3, end_date=$4, pay_date=$5, notes=$6 WHERE id=$1 RETURNING *`,
      [p.id, name?.trim() || null, s, e, pay_date === undefined ? p.pay_date : pay_date || null, notes === undefined ? p.notes : notes]);
    if (datesChanged) {
      const recs = await q.query(`SELECT * FROM pr_records WHERE period_id=$1`, [p.id]);
      for (const rec of recs) await resnapshotRecord(q, upd, rec);
      await recalcPeriod(q, p.id);
    }
    return upd;
  });
  await audit(req, 'update', 'pr_periods', p.id, req.body);
  res.json(row);
}));

r.delete('/periods/:id', requirePerm('payroll.process'), ah(async (req, res) => {
  const p = await getOwned(db, 'pr_periods', req.params.id, bid(req), 'Payroll period');
  if (!['draft', 'attendance_pending', 'calculation_pending'].includes(p.status)) throw bad('Only payroll that has not been submitted for approval can be deleted');
  const used = await db.one(`SELECT (SELECT count(*) FROM pr_payments WHERE period_id=$1) + (SELECT count(*) FROM pr_adjustments WHERE period_id=$1 OR pay_in_period_id=$1) AS n`, [p.id]);
  if (Number(used!.n)) throw bad('Payments or adjustments refer to this payroll; it cannot be deleted');
  await db.query(`DELETE FROM pr_periods WHERE id=$1`, [p.id]);
  await audit(req, 'payroll_period_delete', 'pr_periods', p.id, { code: p.code });
  res.json({ ok: true });
}));

r.post('/periods/:id/employees', requirePerm('payroll.process'), ah(async (req, res) => {
  const p = await lockedGuard(db, req.params.id, bid(req));
  const ids: string[] = Array.isArray(req.body?.employee_ids) ? req.body.employee_ids : [];
  if (!ids.length) throw bad('Select employees');
  let added = 0;
  await tx(async (q) => {
    const emps = await q.query(`SELECT * FROM pr_employees WHERE business_id=$1 AND id = ANY($2::uuid[])`, [bid(req), ids]);
    for (const e of emps) if (await addRecord(q, p, e)) added++;
  });
  await audit(req, 'payroll_add_employees', 'pr_periods', p.id, { employee_ids: ids });
  res.json({ added });
}));

r.delete('/periods/:id/records/:rid', requirePerm('payroll.process'), ah(async (req, res) => {
  const p = await lockedGuard(db, req.params.id, bid(req));
  const rec = await db.one(`SELECT * FROM pr_records WHERE id=$1 AND period_id=$2`, [req.params.rid, p.id]);
  if (!rec) throw bad('Record not found');
  const pay = await db.one(`SELECT 1 FROM pr_payments WHERE record_id=$1 LIMIT 1`, [rec.id]);
  if (pay) throw bad('Payments exist for this record');
  await db.query(`DELETE FROM pr_records WHERE id=$1`, [rec.id]);
  await audit(req, 'payroll_remove_employee', 'pr_periods', p.id, { employee: rec.employee_name });
  res.json({ ok: true });
}));

r.post('/periods/:id/load-attendance', requirePerm('payroll.process'), ah(async (req, res) => {
  const p = await lockedGuard(db, req.params.id, bid(req));
  const loaded = await tx(async (q) => {
    const n = await loadAttendance(q, p, !!req.body?.overwrite);
    if (['draft', 'attendance_pending'].includes(p.status)) await q.query(`UPDATE pr_periods SET status='calculation_pending' WHERE id=$1`, [p.id]);
    return n;
  });
  await audit(req, 'payroll_load_attendance', 'pr_periods', p.id, { loaded, overwrite: !!req.body?.overwrite });
  res.json({ loaded });
}));

/** Refresh employee snapshots (salary, department, bank) and reload the rule version effective at the period end. */
r.post('/periods/:id/refresh', requirePerm('payroll.process'), ah(async (req, res) => {
  const p = await lockedGuard(db, req.params.id, bid(req));
  await tx(async (q) => {
    const { ruleSet, rules } = await rulesAt(q, bid(req), isoDate(p.end_date)!);
    const upd = await q.one(`UPDATE pr_periods SET rule_set_id=$2, rules=$3 WHERE id=$1 RETURNING *`, [p.id, ruleSet?.id ?? null, json(rules)]);
    const recs = await q.query(`SELECT * FROM pr_records WHERE period_id=$1`, [p.id]);
    for (const rec of recs) await resnapshotRecord(q, upd, rec);
    await recalcPeriod(q, p.id);
  });
  await audit(req, 'payroll_refresh', 'pr_periods', p.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Records
r.get('/records/:id', readPay, ah(async (req, res) => {
  const rec = await getOwned(db, 'pr_records', req.params.id, bid(req), 'Payroll record');
  const [period, payments, accounts, adjustments, advances] = await Promise.all([
    db.one(`SELECT id, code, name, start_date, end_date, pay_date, status FROM pr_periods WHERE id=$1`, [rec.period_id]),
    db.query(`SELECT * FROM pr_payments WHERE record_id=$1 ORDER BY payment_date, created_at`, [rec.id]),
    db.query(`SELECT * FROM pr_accounts WHERE period_id=$1 AND employee_id=$2 ORDER BY entry_date, created_at`, [rec.period_id, rec.employee_id]),
    db.query(`SELECT a.*, p.code AS period_code FROM pr_adjustments a JOIN pr_periods p ON p.id=a.period_id WHERE a.pay_in_period_id=$1 AND a.employee_id=$2 ORDER BY a.created_at`, [rec.period_id, rec.employee_id]),
    advanceBalances(db, bid(req), rec.employee_id),
  ]);
  res.json({ ...rec, period, payments, accounts, adjustments, advances: advances.filter((a) => a.status === 'approved' || (rec.vales_plan || []).some((v: any) => v.advance_id === a.id)) });
}));

const INPUTS = ['hours', 'overtime_hours', 'holiday_hours', 'holiday_days', 'vacation_days', 'bonus', 'other_deductions'];
r.put('/records/:id', requirePerm('payroll.process'), ah(async (req, res) => {
  const rec = await getOwned(db, 'pr_records', req.params.id, bid(req), 'Payroll record');
  const p = await lockedGuard(db, rec.period_id, bid(req));
  const sets: string[] = [];
  const vals: any[] = [rec.id];
  const changes: any = {};
  for (const k of INPUTS)
    if (req.body[k] !== undefined) {
      const v = req.body[k] === '' || req.body[k] === null ? 0 : Number(req.body[k]);
      if (!Number.isFinite(v) || v < 0) throw bad(`${k.replace(/_/g, ' ')} must be a positive number`);
      if (/hours/.test(k) && v > 400) throw bad(`${k.replace(/_/g, ' ')} looks too high (${v})`);
      if (Number(rec[k]) !== v) { sets.push(`${k}=$${vals.push(v)}`); changes[k] = { from: Number(rec[k]), to: v }; }
    }
  if (req.body.notes !== undefined) sets.push(`notes=$${vals.push(req.body.notes || null)}`);
  if (changes.hours || changes.overtime_hours || changes.holiday_hours || changes.vacation_days) sets.push(`hours_source='manual'`);
  if (req.body.vales_plan !== undefined) {
    if (!req.auth.permissions.has('payroll.advances') && !req.auth.permissions.has('payroll.process')) throw bad('No permission to change advance recoveries');
    const plan = (Array.isArray(req.body.vales_plan) ? req.body.vales_plan : []).map((v: any) => ({ advance_id: v.advance_id, amount: r2(Number(v.amount) || 0) })).filter((v: any) => v.amount > 0);
    const bal = new Map((await advanceBalances(db, bid(req), rec.employee_id)).map((a) => [a.id, a]));
    for (const v of plan) {
      const a: any = bal.get(v.advance_id);
      if (!a) throw bad('Unknown advance');
      if (a.status !== 'approved') throw bad('Only approved advances can be recovered through payroll');
      const plannedElsewhere = Number(a.planned) - (rec.vales_plan || []).filter((x: any) => x.advance_id === v.advance_id).reduce((s: number, x: any) => s + Number(x.amount), 0);
      if (v.amount > r2(Number(a.outstanding) - plannedElsewhere) + 0.005)
        throw bad(`Recovery ${v.amount} exceeds the outstanding balance ${r2(Number(a.outstanding) - plannedElsewhere)} of the advance`);
    }
    sets.push(`vales_plan=$${vals.push(json(plan))}`);
    changes.vales_plan = { from: rec.vales_plan, to: plan };
  }
  if (sets.length) await db.query(`UPDATE pr_records SET ${sets.join(', ')} WHERE id=$1`, vals);
  const calc = await recalcRecord(db, rec.id);
  if (Object.keys(changes).length) await audit(req, 'payroll_record_update', 'pr_records', rec.id, { period: p.code, employee: rec.employee_name, changes });
  if (p.status === 'under_review' && Object.keys(changes).length) await db.query(`UPDATE pr_periods SET status='calculation_pending' WHERE id=$1`, [p.id]);
  res.json({ ...(await db.one(`SELECT * FROM pr_records WHERE id=$1`, [rec.id])), calc });
}));

/** Authorised manual adjustment of a calculated component; keeps the original value and the reason. */
r.post('/records/:id/override', requirePerm('payroll.process'), ah(async (req, res) => {
  const rec = await getOwned(db, 'pr_records', req.params.id, bid(req), 'Payroll record');
  const p = await lockedGuard(db, rec.period_id, bid(req));
  const { key, value, reason } = req.body || {};
  if (!(OVERRIDE_KEYS as readonly string[]).includes(key)) throw bad('This amount cannot be adjusted manually');
  const ov = { ...(rec.overrides || {}) };
  const original = rec.calc?.calculated?.[key];
  if (value === null || value === undefined || value === '') delete ov[key];
  else {
    if (!String(reason || '').trim()) throw bad('A reason is required for a manual adjustment');
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) throw bad('Enter a valid amount');
    const u = who(req);
    ov[key] = { value: r2(v), original, reason: String(reason).trim(), by: u.id, by_name: u.name, at: new Date().toISOString() };
  }
  await db.query(`UPDATE pr_records SET overrides=$2 WHERE id=$1`, [rec.id, json(ov)]);
  await recalcRecord(db, rec.id);
  await audit(req, 'payroll_manual_adjustment', 'pr_records', rec.id, {
    period: p.code, employee: rec.employee_name, component: OVERRIDE_LABELS[key as keyof typeof OVERRIDE_LABELS], original, adjusted: ov[key]?.value ?? null, reason,
  });
  if (p.status === 'under_review') await db.query(`UPDATE pr_periods SET status='calculation_pending' WHERE id=$1`, [p.id]);
  res.json(await db.one(`SELECT * FROM pr_records WHERE id=$1`, [rec.id]));
}));

// ---------------------------------------------------------------- Validation & workflow
r.post('/periods/:id/validate', readPay, ah(async (req, res) => {
  const p = await getOwned(db, 'pr_periods', req.params.id, bid(req), 'Payroll period');
  if (!isLocked(p.status)) await recalcPeriod(db, p.id);
  const v = await validatePeriod(db, p);
  await db.query(`UPDATE pr_periods SET validation=$2 WHERE id=$1`, [p.id, json(v)]);
  res.json(v);
}));

const TRANSITIONS: Record<string, { from: string[]; to: string; perm: string }> = {
  request_attendance: { from: ['draft', 'calculation_pending'], to: 'attendance_pending', perm: 'payroll.process' },
  calculation: { from: ['draft', 'attendance_pending'], to: 'calculation_pending', perm: 'payroll.process' },
  submit: { from: ['draft', 'attendance_pending', 'calculation_pending'], to: 'under_review', perm: 'payroll.process' },
  reject: { from: ['under_review'], to: 'calculation_pending', perm: 'payroll.approve' },
  approve: { from: ['under_review'], to: 'approved', perm: 'payroll.approve' },
  close: { from: ['paid'], to: 'closed', perm: 'payroll.approve' },
  reopen: { from: ['approved', 'partially_paid', 'paid', 'closed'], to: 'calculation_pending', perm: 'payroll.approve' },
};

r.post('/periods/:id/action', ah(async (req, res) => {
  const action = String(req.body?.action || '');
  const t = TRANSITIONS[action];
  if (!t) throw bad('Unknown action');
  if (!req.auth.permissions.has(t.perm)) throw new HttpError(403, 'You are not allowed to do this');
  const p = await getOwned(db, 'pr_periods', req.params.id, bid(req), 'Payroll period');
  if (!t.from.includes(p.status)) throw bad(`Cannot ${action.replace('_', ' ')} a payroll that is ${PERIOD_STATUS_LABELS[p.status as keyof typeof PERIOD_STATUS_LABELS]}`);
  const reason = String(req.body?.reason || '').trim();
  const u = who(req);

  if (action === 'close') {
    const open = await db.one(`SELECT count(*) AS n FROM pr_records WHERE period_id=$1 AND payment_status <> 'paid' AND net_payable > 0`, [p.id]);
    if (Number(open!.n)) throw bad(`${open!.n} employee(s) are not fully paid`);
  }
  if ((action === 'reject' || action === 'reopen') && !reason) throw bad('A reason is required');
  let validation: any = null;
  if (action === 'submit' || action === 'approve') {
    await recalcPeriod(db, p.id);
    validation = await validatePeriod(db, p);
    await db.query(`UPDATE pr_periods SET validation=$2 WHERE id=$1`, [p.id, json(validation)]);
    if (!validation.ok) return res.status(422).json({ error: `${validation.errors} error(s) must be fixed first`, validation });
  }
  if (action === 'approve' && p.submitted_by && p.submitted_by === u.id && !req.auth.isOwner && req.body?.self_approve !== true)
    throw bad('The person who submitted the payroll should not approve it. The owner can approve, or confirm self-approval.');

  if (action === 'reopen') {
    const paid = await db.one(`SELECT count(*) AS n FROM pr_payments WHERE period_id=$1 AND NOT voided`, [p.id]);
    if (Number(paid!.n)) throw bad(`${paid!.n} payment(s) are recorded. Void them before reopening, or record the correction as an adjustment in the next payroll.`);
  }

  await tx(async (q) => {
    if (action === 'approve') {
      const recs = await q.query(`SELECT * FROM pr_records WHERE period_id=$1`, [p.id]);
      for (const rec of recs) {
        for (const v of rec.vales_plan || [])
          await q.query(
            `INSERT INTO pr_advance_txns (business_id, advance_id, kind, amount, period_id, record_id, txn_date, note, created_by, created_by_name)
             VALUES ($1,$2,'repayment_payroll',$3,$4,$5,$6,$7,$8,$9)`,
            [bid(req), v.advance_id, v.amount, p.id, rec.id, p.pay_date || p.end_date, `Payroll ${p.code}`, u.id, u.name],
          );
        if (Number(rec.vacation_days) > 0) {
          // Days already deducted from the balance by approved vacation requests in this period are not deducted twice
          const taken = await q.one(
            `SELECT COALESCE(sum(t.days),0) AS d FROM pr_vacation_txns t JOIN pr_vacation_requests v ON v.id=t.request_id
              WHERE t.employee_id=$1 AND t.kind='taken' AND v.start_date BETWEEN $2 AND $3`, [rec.employee_id, p.start_date, p.end_date]);
          const extra = r2(Number(rec.vacation_days) - Number(taken!.d));
          if (extra > 0)
            await q.query(`INSERT INTO pr_vacation_txns (business_id, employee_id, txn_date, kind, days, period_id, note, created_by) VALUES ($1,$2,$3,'paid',$4,$5,$6,$7)`,
              [bid(req), rec.employee_id, p.end_date, extra, p.id, `Paid in payroll ${p.code}`, u.id]);
        }
        if (Number(rec.net_payable) <= 0) await q.query(`UPDATE pr_records SET payment_status='paid' WHERE id=$1`, [rec.id]);
      }
      await q.query(
        `UPDATE pr_advances a SET status='repaid' WHERE a.business_id=$1 AND a.status='approved'
           AND a.amount - COALESCE((SELECT sum(amount) FROM pr_advance_txns t WHERE t.advance_id=a.id),0) <= 0.005`, [bid(req)]);
      await q.query(`UPDATE pr_periods SET status='approved', approved_by=$2, approved_by_name=$3, approved_at=now(), rejected_reason=NULL WHERE id=$1`, [p.id, u.id, u.name]);
    } else if (action === 'reopen') {
      const advIds = (await q.query(`SELECT DISTINCT advance_id FROM pr_advance_txns WHERE period_id=$1`, [p.id])).map((x) => x.advance_id);
      await q.query(`DELETE FROM pr_advance_txns WHERE period_id=$1`, [p.id]);
      if (advIds.length) await q.query(`UPDATE pr_advances SET status='approved' WHERE id = ANY($1::uuid[]) AND status='repaid'`, [advIds]);
      await q.query(`DELETE FROM pr_vacation_txns WHERE period_id=$1 AND kind='paid'`, [p.id]);
      await q.query(`UPDATE pr_periods SET status='calculation_pending', approved_by=NULL, approved_by_name=NULL, approved_at=NULL, closed_at=NULL, closed_by=NULL WHERE id=$1`, [p.id]);
    } else if (action === 'submit') {
      await q.query(`UPDATE pr_periods SET status='under_review', submitted_by=$2, submitted_at=now(), rejected_reason=NULL WHERE id=$1`, [p.id, u.id]);
    } else if (action === 'reject') {
      await q.query(`UPDATE pr_periods SET status='calculation_pending', rejected_reason=$2 WHERE id=$1`, [p.id, reason]);
    } else if (action === 'close') {
      await q.query(`UPDATE pr_periods SET status='closed', closed_by=$2, closed_at=now() WHERE id=$1`, [p.id, u.id]);
    } else {
      await q.query(`UPDATE pr_periods SET status=$2 WHERE id=$1`, [p.id, t.to]);
    }
  });
  await audit(req, `payroll_${action}`, 'pr_periods', p.id, { code: p.code, from: p.status, to: t.to, reason: reason || undefined, validation: validation ? { errors: validation.errors, warnings: validation.warnings } : undefined });
  const msg: Record<string, string> = {
    request_attendance: `Attendance requested for payroll ${p.code} (${p.name})`,
    submit: `Payroll ${p.code} is waiting for approval (submitted by ${u.name})`,
    approve: `Payroll ${p.code} approved by ${u.name}`,
    reject: `Payroll ${p.code} returned for correction: ${reason}`,
    close: `Payroll ${p.code} closed`,
    reopen: `Payroll ${p.code} reopened by ${u.name}: ${reason}`,
  };
  if (msg[action]) await notify(bid(req), null, `payroll_${action}`, msg[action], { period_id: p.id });
  res.json({ ok: true, status: t.to, validation });
}));

/** Side-by-side comparison of two payroll periods (PRD §16.2). */
r.get('/periods/:id/compare', readPay, ah(async (req, res) => {
  const a = await getOwned(db, 'pr_periods', req.params.id, bid(req), 'Payroll period');
  let otherId = String(req.query.with || '');
  if (!otherId) {
    const prev = await db.one(`SELECT id FROM pr_periods WHERE business_id=$1 AND end_date < $2 AND id<>$3 ORDER BY end_date DESC LIMIT 1`, [bid(req), a.start_date, a.id]);
    if (!prev) return res.json({ base: a, other: null, rows: [], departments: [] });
    otherId = prev.id;
  }
  const b = await getOwned(db, 'pr_periods', otherId, bid(req), 'Payroll period');
  const cols = 'employee_id, employee_name, department_name, hours, overtime_hours, gross, overtime_pay, caja, total_deductions, payroll_expense, net_payable, hourly_rate, monthly_salary';
  const [ra, rb] = await Promise.all([
    db.query(`SELECT ${cols} FROM pr_records WHERE period_id=$1`, [a.id]),
    db.query(`SELECT ${cols} FROM pr_records WHERE period_id=$1`, [b.id]),
  ]);
  const mb = new Map(rb.map((x) => [x.employee_id, x]));
  const ids = new Set([...ra.map((x) => x.employee_id), ...rb.map((x) => x.employee_id)]);
  const rows = [...ids].map((id) => {
    const x: any = ra.find((r) => r.employee_id === id) || null, y: any = mb.get(id) || null;
    const d = (k: string) => r2(Number(x?.[k] || 0) - Number(y?.[k] || 0));
    const flags: string[] = [];
    if (!y) flags.push('new');
    if (!x) flags.push('missing');
    if (x && y) {
      if ((Number(x.monthly_salary) || Number(x.hourly_rate)) > (Number(y.monthly_salary) || Number(y.hourly_rate))) flags.push('salary_up');
      if ((Number(x.monthly_salary) || Number(x.hourly_rate)) < (Number(y.monthly_salary) || Number(y.hourly_rate))) flags.push('salary_down');
      if (Number(x.hours) < Number(y.hours) * 0.8) flags.push('hours_down');
      if (Number(x.total_deductions) > Number(y.total_deductions) * 1.25 + 1000) flags.push('deductions_up');
      if (Math.abs(Number(x.overtime_hours) - Number(y.overtime_hours)) >= 4) flags.push('overtime_change');
      if (Number(y.net_payable) > 0 && Math.abs(d('net_payable')) / Number(y.net_payable) > 0.3) flags.push('unusual_variance');
    }
    return { employee_id: id, employee_name: x?.employee_name || y?.employee_name, department_name: x?.department_name || y?.department_name, current: x, previous: y,
      diff: { hours: d('hours'), overtime_hours: d('overtime_hours'), gross: d('gross'), total_deductions: d('total_deductions'), payroll_expense: d('payroll_expense'), net_payable: d('net_payable') }, flags };
  }).sort((p, q) => String(p.department_name).localeCompare(String(q.department_name)) || String(p.employee_name).localeCompare(String(q.employee_name)));
  const dept = new Map<string, { department: string; current: number; previous: number }>();
  for (const x of rows) {
    const k = x.department_name || 'No department';
    const e = dept.get(k) || { department: k, current: 0, previous: 0 };
    e.current += Number(x.current?.payroll_expense || 0);
    e.previous += Number(x.previous?.payroll_expense || 0);
    dept.set(k, e);
  }
  res.json({ base: a, other: b, rows, departments: [...dept.values()].map((d) => ({ ...d, current: r2(d.current), previous: r2(d.previous), diff: r2(d.current - d.previous) })) });
}));

export default r;
