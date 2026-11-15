import type { Request } from 'express';
import { db, json, type Q } from '../db.ts';
import { HttpError, bad, notFound } from '../util.ts';
import {
  calculatePay, mergeRules, roundTo, LOCKED_STATUSES, OVERRIDE_KEYS, type PayrollRules, type PeriodStatus, type ValidationIssue,
} from '../../../shared/payroll.ts';

export const bid = (req: Request) => req.auth.businessId;
export const who = (req: Request) => ({ id: req.auth.userId ?? null, name: req.auth.userName ?? null });
export const isoDate = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
const r2 = (v: number) => roundTo(v, 2);

/** Every payroll query is scoped to the caller's business: fetch-or-404 helper. */
export async function getOwned(q: Q, table: string, id: string, businessId: string, what = 'Record') {
  const row = await q.one(`SELECT * FROM ${table} WHERE id=$1 AND business_id=$2`, [id, businessId]);
  if (!row) throw notFound(what);
  return row;
}

// ---------------------------------------------------------------- Rules
export async function rulesAt(q: Q, businessId: string, date: string) {
  const rs = await q.one(
    `SELECT * FROM pr_rule_sets WHERE business_id=$1 AND effective_from <= $2 ORDER BY effective_from DESC, created_at DESC LIMIT 1`,
    [businessId, date],
  );
  return { ruleSet: rs ?? null, rules: mergeRules(rs?.rules) };
}

export async function ensureDefaultRuleSet(q: Q, businessId: string) {
  const any = await q.one(`SELECT id FROM pr_rule_sets WHERE business_id=$1 LIMIT 1`, [businessId]);
  if (!any)
    await q.query(
      `INSERT INTO pr_rule_sets (business_id, name, effective_from, rules, notes) VALUES ($1,'Workbook defaults','2020-01-01',$2,$3)`,
      [businessId, json(mergeRules()), 'Defaults observed in 26 RL PAYROLL.xlsx (sheet 11, 23 Oct – 5 Nov). Confirm with the business owner.'],
    );
}

// ---------------------------------------------------------------- Employees
export async function salaryAt(q: Q, employeeId: string, date: string) {
  return q.one(
    `SELECT * FROM pr_salary_history WHERE employee_id=$1 AND effective_from <= $2 ORDER BY effective_from DESC, created_at DESC LIMIT 1`,
    [employeeId, date],
  );
}

export async function nextEmployeeCode(q: Q, businessId: string) {
  const s = await q.one(`SELECT employee_code_prefix FROM pr_settings WHERE business_id=$1`, [businessId]);
  const prefix = s?.employee_code_prefix || 'E';
  const last = await q.one(
    `SELECT code FROM pr_employees WHERE business_id=$1 AND code ~ $2 ORDER BY length(code) DESC, code DESC LIMIT 1`,
    [businessId, `^${prefix.replace(/[^A-Za-z0-9-]/g, '')}[0-9]+$`],
  );
  const nextN = last ? Number(String(last.code).slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(nextN).padStart(4, '0')}`;
}

export async function logChange(q: Q, req: Request, employeeId: string, field: string, oldV: any, newV: any) {
  const o = oldV === null || oldV === undefined ? null : String(oldV);
  const nv = newV === null || newV === undefined ? null : String(newV);
  if (o === nv) return;
  await q.query(
    `INSERT INTO pr_employee_changes (business_id, employee_id, field, old_value, new_value, changed_by, changed_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [bid(req), employeeId, field, o, nv, req.auth.userId ?? null, req.auth.userName ?? null],
  );
}

/** Department managers with only the attendance permission see the departments they manage. */
export async function visibleDepartments(req: Request): Promise<string[] | null> {
  const p = req.auth.permissions;
  if (p.has('payroll.access') || p.has('payroll.employees') || p.has('payroll.process')) return null; // all
  const rows = await db.query(`SELECT id FROM pr_departments WHERE business_id=$1 AND manager_user_id=$2`, [bid(req), req.auth.userId]);
  return rows.map((r) => r.id);
}

/** Salary amounts are hidden from users who may only handle attendance (department managers). */
export const canSeePay = (req: Request) =>
  ['payroll.access', 'payroll.salary', 'payroll.process', 'payroll.payments', 'payroll.reports'].some((p) => req.auth.permissions.has(p));

// ---------------------------------------------------------------- Periods & records
export const isLocked = (status: string) => LOCKED_STATUSES.includes(status as PeriodStatus);

export async function lockedGuard(q: Q, periodId: string, businessId: string) {
  const p = await getOwned(q, 'pr_periods', periodId, businessId, 'Payroll period');
  if (isLocked(p.status)) throw new HttpError(409, `Payroll ${p.code} is ${p.status.replace('_', ' ')} and locked. An authorised user must reopen it first.`);
  return p;
}

export function periodRules(period: any): PayrollRules {
  return mergeRules(period.rules);
}

/** Outstanding balance of an approved advance (amount − recoveries already posted). */
export async function advanceBalances(q: Q, businessId: string, employeeId?: string) {
  const params: any[] = [businessId];
  const where = employeeId ? `AND a.employee_id=$${params.push(employeeId)}` : '';
  return q.query(
    `SELECT a.*, a.amount - COALESCE((SELECT sum(t.amount) FROM pr_advance_txns t WHERE t.advance_id=a.id),0) AS outstanding,
            COALESCE((SELECT sum((v->>'amount')::numeric) FROM pr_records r JOIN pr_periods p ON p.id=r.period_id,
                       jsonb_array_elements(r.vales_plan) v
                      WHERE v->>'advance_id' = a.id::text AND p.status IN ('draft','attendance_pending','calculation_pending','under_review')),0) AS planned
       FROM pr_advances a WHERE a.business_id=$1 ${where} ORDER BY a.advance_date, a.created_at`,
    params,
  );
}

/** Default advance recoveries for a new record: deduction per payroll, capped at the balance not yet planned elsewhere. */
export async function defaultValesPlan(q: Q, businessId: string, employeeId: string) {
  const adv = (await advanceBalances(q, businessId, employeeId)).filter((a) => a.status === 'approved');
  const plan: { advance_id: string; amount: number }[] = [];
  for (const a of adv) {
    const free = r2(Number(a.outstanding) - Number(a.planned));
    if (free <= 0) continue;
    const want = a.deduction_per_payroll ? Math.min(Number(a.deduction_per_payroll), free) : free;
    if (want > 0) plan.push({ advance_id: a.id, amount: r2(want) });
  }
  return plan;
}

/** Hours from attendance within the period (regular, approved overtime, holiday, vacation days). */
export async function attendanceSummary(q: Q, businessId: string, start: string, end: string, employeeId?: string) {
  const params: any[] = [businessId, start, end];
  const w = employeeId ? `AND employee_id=$${params.push(employeeId)}` : '';
  return q.query(
    `SELECT employee_id,
            count(*) FILTER (WHERE status IN ('present','holiday') AND regular_hours > 0) AS working_days,
            COALESCE(sum(regular_hours),0) AS regular_hours,
            COALESCE(sum(overtime_hours) FILTER (WHERE overtime_approved),0) AS overtime_hours,
            COALESCE(sum(overtime_hours) FILTER (WHERE NOT overtime_approved),0) AS unapproved_overtime,
            COALESCE(sum(holiday_hours),0) AS holiday_hours,
            count(*) FILTER (WHERE leave_type='vacation') AS vacation_days,
            count(*) FILTER (WHERE leave_type='unpaid') AS unpaid_leave,
            count(*) FILTER (WHERE leave_type='sick') AS sick_days,
            count(*) FILTER (WHERE status='absent') AS absences,
            count(*) AS records,
            bool_and(submitted) AS all_submitted
       FROM pr_attendance WHERE business_id=$1 AND work_date BETWEEN $2 AND $3 ${w}
      GROUP BY employee_id`,
    params,
  );
}

/** Snapshot an employee into a payroll record for the period (salary effective at the period end date). */
export async function snapshotEmployee(q: Q, period: any, emp: any) {
  const end = isoDate(period.end_date)!;
  const sal = await salaryAt(q, emp.id, end);
  const dept = emp.department_id ? await q.one(`SELECT name, accounts_deduction_pct FROM pr_departments WHERE id=$1`, [emp.department_id]) : null;
  const pos = emp.position_id ? await q.one(`SELECT name FROM pr_positions WHERE id=$1`, [emp.position_id]) : null;
  const rules = periodRules(period);
  const accPct = emp.accounts_deduction_pct ?? dept?.accounts_deduction_pct ?? rules.accounts_deduction_pct;
  return {
    employee_name: emp.full_name, cedula: emp.cedula, department_id: emp.department_id, department_name: dept?.name ?? null,
    position_name: pos?.name ?? null,
    salary_type: sal?.salary_type || (emp.employment_type === 'monthly' ? 'monthly' : 'hourly'),
    currency: sal?.currency || emp.currency || 'CRC',
    hourly_rate: sal?.hourly_rate ?? null, monthly_salary: sal?.monthly_salary ?? null, salary_history_id: sal?.id ?? null,
    use_reference_hours: emp.use_reference_hours !== false,
    insurance_method: emp.insurance_status === 'not_insured' ? 'none' : emp.insurance_method || 'percent',
    insurance_salary: emp.insurance_salary ?? null,
    accounts_pct: Number(accPct),
    payment_method: emp.payment_method, bank_group: emp.bank_group, bank_account: emp.bank_account,
  };
}

const SNAP_COLS = ['employee_name', 'cedula', 'department_id', 'department_name', 'position_name', 'salary_type', 'currency', 'hourly_rate',
  'monthly_salary', 'salary_history_id', 'use_reference_hours', 'insurance_method', 'insurance_salary', 'accounts_pct', 'payment_method',
  'bank_group', 'bank_account'];

export async function addRecord(q: Q, period: any, emp: any) {
  const snap: any = await snapshotEmployee(q, period, emp);
  const plan = await defaultValesPlan(q, period.business_id, emp.id);
  const cols = ['business_id', 'period_id', 'employee_id', ...SNAP_COLS, 'vales_plan'];
  const vals = [period.business_id, period.id, emp.id, ...SNAP_COLS.map((c) => snap[c]), json(plan)];
  const row = await q.one(
    `INSERT INTO pr_records (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})
     ON CONFLICT (period_id, employee_id) DO NOTHING RETURNING id`,
    vals,
  );
  if (row) await recalcRecord(q, row.id);
  return row?.id ?? null;
}

export async function resnapshotRecord(q: Q, period: any, rec: any) {
  const emp = await q.one(`SELECT * FROM pr_employees WHERE id=$1`, [rec.employee_id]);
  const snap: any = await snapshotEmployee(q, period, emp);
  await q.query(`UPDATE pr_records SET ${SNAP_COLS.map((c, i) => `${c}=$${i + 2}`).join(', ')} WHERE id=$1`, [rec.id, ...SNAP_COLS.map((c) => snap[c])]);
}

/** Recalculate one record from its inputs, the period's rule snapshot, accounts, advances and adjustments. */
export async function recalcRecord(q: Q, recordId: string) {
  const rec = await q.one(`SELECT * FROM pr_records WHERE id=$1`, [recordId]);
  if (!rec) return null;
  const period = await q.one(`SELECT * FROM pr_periods WHERE id=$1`, [rec.period_id]);
  const rules = periodRules(period);
  const acc = await q.one(`SELECT COALESCE(sum(amount),0) AS total FROM pr_accounts WHERE period_id=$1 AND employee_id=$2`, [rec.period_id, rec.employee_id]);
  const adj = await q.one(
    `SELECT COALESCE(sum(difference),0) AS total FROM pr_adjustments WHERE pay_in_period_id=$1 AND employee_id=$2 AND status='approved'`,
    [rec.period_id, rec.employee_id],
  );
  const plan: any[] = Array.isArray(rec.vales_plan) ? rec.vales_plan : [];
  const vales = plan.reduce((s, p) => s + Number(p.amount || 0), 0);
  const overrides: Record<string, number> = {};
  for (const [k, v] of Object.entries(rec.overrides || {})) if ((OVERRIDE_KEYS as readonly string[]).includes(k)) overrides[k] = Number((v as any).value);

  const c = calculatePay({
    salary_type: rec.salary_type, hourly_rate: rec.hourly_rate, monthly_salary: rec.monthly_salary,
    use_reference_hours: rec.use_reference_hours, insurance_method: rec.insurance_method, insurance_salary: rec.insurance_salary,
    accounts_pct: rec.accounts_pct, hours: rec.hours, overtime_hours: rec.overtime_hours, holiday_hours: rec.holiday_hours,
    holiday_days: rec.holiday_days, vacation_days: rec.vacation_days, bonus: rec.bonus, accounts_amount: acc!.total,
    vales, other_deductions: rec.other_deductions, adjustments: adj!.total, overrides,
  }, rules);

  const warnings: ValidationIssue[] = [];
  const W = (level: 'error' | 'warning', code: string, message: string) => warnings.push({ level, code, message, employee_id: rec.employee_id });
  if (rec.salary_type === 'hourly' && !Number(rec.hourly_rate)) W('error', 'missing_rate', 'No hourly rate on file for this period');
  if (rec.salary_type === 'monthly' && !Number(rec.monthly_salary)) W('error', 'missing_rate', 'No monthly salary on file for this period');
  if (!Number(rec.hours) && !(rec.salary_type === 'monthly' && rec.use_reference_hours === false)) W('warning', 'no_hours', 'No working hours entered');
  if (c.net_payable < 0) W('error', 'negative_net', 'Net payable is negative');
  if (c.earnings > 0 && c.total_deductions - c.caja > c.earnings * 0.5) W('warning', 'high_deductions', 'Accounts, vales and other deductions exceed 50% of earnings');
  if (rec.insurance_method === 'fixed' && !Number(rec.insurance_salary) && !overrides.caja) W('warning', 'no_insurance_salary', 'Fixed insurance without an insurance salary');
  if (['transfer', 'sinpe'].includes(rec.payment_method) && !rec.bank_account) W('warning', 'no_bank', 'Paid by transfer but no bank account on file');
  if (c.excess_hours > 0) W('warning', 'excess_hours', `${c.excess_hours} h above the ${rules.reference_hours} h reference`);

  await q.query(
    `UPDATE pr_records SET gross=$2, overtime_pay=$3, excess_premium=$4, holiday_pay=$5, vacation_pay=$6, caja=$7, earnings=$8,
       payroll_expense=$9, accounts_amount=$10, accounts_deduction=$11, vales=$12, adjustments=$13, total_deductions=$14, net_payable=$15,
       calc=$16, warnings=$17, calculated_at=now(), updated_at=now(),
       payment_status = CASE WHEN paid_amount <= 0 THEN 'pending' WHEN paid_amount + 0.005 >= $15 THEN 'paid' ELSE 'partial' END
     WHERE id=$1`,
    [rec.id, c.gross, c.overtime_pay, c.excess_premium, c.holiday_pay, c.vacation_pay, c.caja, c.earnings, c.payroll_expense,
     c.accounts_amount, c.accounts_deduction, c.vales, c.adjustments, c.total_deductions, c.net_payable, json(c), json(warnings)],
  );
  return c;
}

export async function recalcPeriod(q: Q, periodId: string) {
  const recs = await q.query(`SELECT id FROM pr_records WHERE period_id=$1`, [periodId]);
  for (const r of recs) await recalcRecord(q, r.id);
}

/** Recalculate an employee's open records (e.g. after an accounts entry or adjustment). */
export async function recalcOpenFor(q: Q, periodId: string | null, employeeId: string) {
  if (!periodId) return;
  const rec = await q.one(
    `SELECT r.id FROM pr_records r JOIN pr_periods p ON p.id=r.period_id WHERE r.period_id=$1 AND r.employee_id=$2 AND p.status NOT IN ('approved','partially_paid','paid','closed')`,
    [periodId, employeeId],
  );
  if (rec) await recalcRecord(q, rec.id);
}

/** Pre-approval validation for a whole period (PRD §16.3). */
export async function validatePeriod(q: Q, period: any) {
  const issues: ValidationIssue[] = [];
  const recs = await q.query(`SELECT * FROM pr_records WHERE period_id=$1`, [period.id]);
  if (!recs.length) issues.push({ level: 'error', code: 'empty', message: 'The payroll has no employees' });
  for (const r of recs) for (const w of r.warnings || []) issues.push({ ...w, message: `${r.employee_name}: ${w.message}` });

  // Duplicate employees (same cédula on two records)
  const byCed = new Map<string, string[]>();
  for (const r of recs) if (r.cedula) byCed.set(r.cedula.replace(/\D/g, ''), [...(byCed.get(r.cedula.replace(/\D/g, '')) || []), r.employee_name]);
  for (const [ced, names] of byCed) if (names.length > 1) issues.push({ level: 'error', code: 'duplicate', message: `Cédula ${ced} appears on ${names.join(', ')}` });

  // Advance recoveries must not exceed the approved outstanding balance
  const bal = new Map((await advanceBalances(q, period.business_id)).map((a) => [a.id, a]));
  const totals = new Map<string, number>();
  for (const r of recs) for (const p of r.vales_plan || []) totals.set(p.advance_id, (totals.get(p.advance_id) || 0) + Number(p.amount));
  for (const [id, amt] of totals) {
    const a: any = bal.get(id);
    if (!a || a.status !== 'approved') issues.push({ level: 'error', code: 'advance_not_approved', message: `An advance recovery refers to an advance that is not approved` });
    else if (amt > Number(a.outstanding) + 0.005) issues.push({ level: 'error', code: 'advance_exceeds', message: `Advance recovery ${amt} exceeds the outstanding balance ${a.outstanding}`, employee_id: a.employee_id });
  }
  const pendingAdv = await q.one(`SELECT count(*) AS n FROM pr_advances WHERE business_id=$1 AND status='requested'`, [period.business_id]);
  if (Number(pendingAdv!.n)) issues.push({ level: 'warning', code: 'unapproved_advances', message: `${pendingAdv!.n} advance request(s) are still awaiting approval` });

  // Unapproved overtime in attendance
  const att = await attendanceSummary(q, period.business_id, isoDate(period.start_date)!, isoDate(period.end_date)!);
  const names = new Map(recs.map((r) => [r.employee_id, r.employee_name]));
  for (const a of att)
    if (Number(a.unapproved_overtime) > 0 && names.has(a.employee_id))
      issues.push({ level: 'warning', code: 'unapproved_overtime', message: `${names.get(a.employee_id)}: ${a.unapproved_overtime} h of overtime not approved (not paid)`, employee_id: a.employee_id });

  // Unexpected variations vs the previous payroll
  const prev = await q.one(
    `SELECT id FROM pr_periods WHERE business_id=$1 AND end_date < $2 AND status IN ('approved','partially_paid','paid','closed') ORDER BY end_date DESC LIMIT 1`,
    [period.business_id, period.start_date],
  );
  if (prev) {
    const prevRecs = new Map((await q.query(`SELECT employee_id, net_payable, hourly_rate, monthly_salary FROM pr_records WHERE period_id=$1`, [prev.id])).map((r) => [r.employee_id, r]));
    for (const r of recs) {
      const p: any = prevRecs.get(r.employee_id);
      if (!p) continue;
      if ((Number(p.monthly_salary) || 0) !== (Number(r.monthly_salary) || 0) || (Number(p.hourly_rate) || 0) !== (Number(r.hourly_rate) || 0))
        issues.push({ level: 'warning', code: 'salary_changed', message: `${r.employee_name}: salary rate changed since the previous payroll`, employee_id: r.employee_id });
      const pn = Number(p.net_payable);
      if (pn > 0 && Math.abs(Number(r.net_payable) - pn) / pn > 0.3)
        issues.push({ level: 'warning', code: 'variation', message: `${r.employee_name}: net pay changed ${Math.round(((Number(r.net_payable) - pn) / pn) * 100)}% vs previous payroll`, employee_id: r.employee_id });
    }
  }
  return { ok: !issues.some((i) => i.level === 'error'), errors: issues.filter((i) => i.level === 'error').length, warnings: issues.filter((i) => i.level === 'warning').length, issues, checked_at: new Date().toISOString() };
}

/** After payments change: update the record's paid total and the period status. */
export async function refreshPaymentStatus(q: Q, recordId: string) {
  const rec = await q.one(`SELECT * FROM pr_records WHERE id=$1`, [recordId]);
  if (!rec) return;
  const s = await q.one(`SELECT COALESCE(sum(amount_crc),0) AS paid FROM pr_payments WHERE record_id=$1 AND NOT voided`, [recordId]);
  const paid = r2(Number(s!.paid));
  const net = Number(rec.net_payable);
  const status = paid <= 0 ? (net <= 0 ? 'paid' : 'pending') : paid + 0.005 >= net ? 'paid' : 'partial';
  await q.query(`UPDATE pr_records SET paid_amount=$2, payment_status=$3, updated_at=now() WHERE id=$1`, [recordId, paid, status]);
  const period = await q.one(`SELECT * FROM pr_periods WHERE id=$1`, [rec.period_id]);
  if (!period || !['approved', 'partially_paid', 'paid'].includes(period.status)) return;
  const agg = await q.one(
    `SELECT count(*) FILTER (WHERE payment_status <> 'paid' AND net_payable > 0) AS open, count(*) FILTER (WHERE paid_amount > 0) AS some FROM pr_records WHERE period_id=$1`,
    [period.id],
  );
  const next = Number(agg!.open) === 0 ? 'paid' : Number(agg!.some) > 0 ? 'partially_paid' : 'approved';
  if (next !== period.status) await q.query(`UPDATE pr_periods SET status=$2 WHERE id=$1`, [period.id, next]);
}

/** Latest USD→CRC rate on or before a date. */
export async function rateAt(q: Q, businessId: string, date: string) {
  return q.one(`SELECT * FROM pr_exchange_rates WHERE business_id=$1 AND rate_date <= $2 ORDER BY rate_date DESC LIMIT 1`, [businessId, date]);
}

export function assertDateRange(start: any, end: any) {
  if (!start || !end) throw bad('Start and end dates are required');
  if (String(end) < String(start)) throw bad('End date is before the start date');
}
