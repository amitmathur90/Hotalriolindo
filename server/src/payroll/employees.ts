import { Router } from 'express';
import { db, tx } from '../db.ts';
import { requirePerm } from '../auth.ts';
import { ah, audit, bad, notify, pick } from '../util.ts';
import { advanceBalances, bid, canSeePay, getOwned, isoDate, logChange, nextEmployeeCode, salaryAt, visibleDepartments, who } from './common.ts';
import { mergeRules } from '../../../shared/payroll.ts';
import { assertLinkable } from './pos.ts';

const r = Router();

const FIELDS = ['full_name', 'short_name', 'cedula', 'email', 'phone', 'address', 'birth_date', 'department_id', 'position_id', 'employment_type',
  'joining_date', 'leaving_date', 'status', 'currency', 'bank_name', 'bank_account', 'bank_group', 'payment_method', 'insurance_status',
  'insurance_method', 'insurance_salary', 'accounts_deduction_pct', 'use_reference_hours', 'vacation_opening_days', 'photo_url', 'user_id', 'notes'];
const PAY_FIELDS = ['insurance_salary', 'accounts_deduction_pct'];
const ENUMS: Record<string, string[]> = {
  employment_type: ['hourly', 'monthly', 'temporary'],
  status: ['active', 'inactive', 'suspended'],
  currency: ['CRC', 'USD'],
  payment_method: ['cash', 'transfer', 'usd', 'sinpe', 'other'],
  insurance_status: ['insured', 'not_insured'],
  insurance_method: ['percent', 'fixed'],
};

function clean(body: any) {
  const d = pick(body, FIELDS);
  for (const [k, vals] of Object.entries(ENUMS)) if (d[k] !== undefined && d[k] !== null && !vals.includes(d[k])) throw bad(`Invalid ${k.replace('_', ' ')}: ${d[k]}`);
  for (const k of Object.keys(d)) if (d[k] === '') d[k] = null;
  if (d.cedula) d.cedula = String(d.cedula).trim();
  if (d.full_name !== undefined && !String(d.full_name || '').trim()) throw bad('Full name is required');
  if (d.leaving_date && d.joining_date && d.leaving_date < d.joining_date) throw bad('Leaving date is before the joining date');
  return d;
}

function salaryInput(body: any) {
  const s = body?.salary;
  if (!s) return null;
  const type = s.salary_type === 'hourly' ? 'hourly' : 'monthly';
  const hourly = s.hourly_rate === '' || s.hourly_rate === undefined ? null : Number(s.hourly_rate);
  const monthly = s.monthly_salary === '' || s.monthly_salary === undefined ? null : Number(s.monthly_salary);
  if (type === 'hourly' && !(hourly! > 0)) throw bad('Hourly rate must be greater than 0');
  if (type === 'monthly' && !(monthly! > 0)) throw bad('Monthly salary must be greater than 0');
  return { salary_type: type, hourly_rate: type === 'hourly' ? hourly : null, monthly_salary: type === 'monthly' ? monthly : null,
    currency: s.currency === 'USD' ? 'USD' : 'CRC', effective_from: s.effective_from || new Date().toISOString().slice(0, 10), reason: s.reason || null };
}

const LIST_SQL = `
  SELECT e.*, d.name AS department_name, p.name AS position_name, u.name AS user_name,
         s.salary_type, s.hourly_rate, s.monthly_salary, s.effective_from AS salary_from,
         (SELECT count(*) FROM pr_documents x WHERE x.employee_id=e.id) AS documents
    FROM pr_employees e
    LEFT JOIN pr_departments d ON d.id=e.department_id
    LEFT JOIN pr_positions p ON p.id=e.position_id
    LEFT JOIN users u ON u.id=e.user_id
    LEFT JOIN LATERAL (SELECT * FROM pr_salary_history h WHERE h.employee_id=e.id AND h.effective_from <= CURRENT_DATE
                       ORDER BY h.effective_from DESC, h.created_at DESC LIMIT 1) s ON true`;

const hidePay = (row: any) => ({ ...row, hourly_rate: null, monthly_salary: null, insurance_salary: null, pay_hidden: true });

r.get('/employees', ah(async (req, res) => {
  const params: any[] = [bid(req)];
  let w = 'e.business_id=$1';
  const depts = await visibleDepartments(req);
  if (depts) w += ` AND e.department_id = ANY($${params.push(depts)}::uuid[])`;
  if (req.query.status) w += ` AND e.status=$${params.push(String(req.query.status))}`;
  if (req.query.department_id) w += ` AND e.department_id=$${params.push(String(req.query.department_id))}`;
  if (req.query.q) {
    const i = params.push(`%${req.query.q}%`);
    w += ` AND (e.full_name ILIKE $${i} OR e.short_name ILIKE $${i} OR e.cedula ILIKE $${i} OR e.code ILIKE $${i} OR e.email ILIKE $${i})`;
  }
  const rows = await db.query(`${LIST_SQL} WHERE ${w} ORDER BY d.sort NULLS LAST, e.full_name`, params);
  res.json(canSeePay(req) ? rows : rows.map(hidePay));
}));

r.get('/employees/:id', ah(async (req, res) => {
  const row = await db.one(`${LIST_SQL} WHERE e.id=$1 AND e.business_id=$2`, [req.params.id, bid(req)]);
  if (!row) throw bad('Employee not found');
  const depts = await visibleDepartments(req);
  if (depts && !depts.includes(row.department_id)) throw bad('Employee not found');
  const pay = canSeePay(req);
  const [salaries, changes, documents] = await Promise.all([
    pay ? db.query(`SELECT * FROM pr_salary_history WHERE employee_id=$1 ORDER BY effective_from DESC, created_at DESC`, [row.id]) : [],
    db.query(`SELECT * FROM pr_employee_changes WHERE employee_id=$1 ORDER BY changed_at DESC LIMIT 200`, [row.id]),
    db.query(`SELECT id, kind, name, mime, size, uploaded_at FROM pr_documents WHERE employee_id=$1 ORDER BY uploaded_at DESC`, [row.id]),
  ]);
  res.json({ ...(pay ? row : hidePay(row)), salaries, changes: pay ? changes : changes.filter((c) => !PAY_FIELDS.includes(c.field)), documents });
}));

/** Payroll, advances, vacation and bonus history for the employee detail page. */
r.get('/employees/:id/history', requirePerm('payroll.access', 'payroll.process', 'payroll.salary'), ah(async (req, res) => {
  const e = await getOwned(db, 'pr_employees', req.params.id, bid(req), 'Employee');
  const [payroll, advances, vacation, aguinaldo, payments] = await Promise.all([
    db.query(`SELECT r.id, r.period_id, p.code, p.name AS period_name, p.start_date, p.end_date, p.status, r.hours, r.gross, r.overtime_pay, r.holiday_pay,
                     r.vacation_pay, r.caja, r.payroll_expense, r.accounts_deduction, r.vales, r.adjustments, r.net_payable, r.paid_amount, r.payment_status,
                     r.department_name, r.hourly_rate, r.monthly_salary, r.salary_type
                FROM pr_records r JOIN pr_periods p ON p.id=r.period_id WHERE r.employee_id=$1 ORDER BY p.end_date DESC`, [e.id]),
    advanceBalances(db, bid(req), e.id),
    vacationBalance(e),
    db.query(`SELECT * FROM pr_aguinaldo WHERE employee_id=$1 ORDER BY year DESC`, [e.id]),
    db.query(`SELECT pay.*, p.code FROM pr_payments pay JOIN pr_periods p ON p.id=pay.period_id WHERE pay.employee_id=$1 ORDER BY pay.payment_date DESC LIMIT 200`, [e.id]),
  ]);
  res.json({ payroll, advances, vacation, aguinaldo, payments });
}));

export async function vacationBalance(e: any) {
  const rs = await db.one(`SELECT rules FROM pr_rule_sets WHERE business_id=$1 AND effective_from <= CURRENT_DATE ORDER BY effective_from DESC LIMIT 1`, [e.business_id]);
  const perMonth = mergeRules(rs?.rules).vacation_days_per_month;
  const start = e.joining_date ? new Date(e.joining_date) : null;
  const end = e.leaving_date ? new Date(e.leaving_date) : new Date();
  const months = start ? Math.max(0, (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) - (end.getDate() < start.getDate() ? 1 : 0)) : 0;
  const txns = await db.query(`SELECT t.*, p.code AS period_code FROM pr_vacation_txns t LEFT JOIN pr_periods p ON p.id=t.period_id WHERE t.employee_id=$1 ORDER BY t.txn_date DESC, t.created_at DESC`, [e.id]);
  const used = txns.filter((t) => t.kind !== 'adjustment').reduce((s, t) => s + Number(t.days), 0);
  const adj = txns.filter((t) => t.kind === 'adjustment').reduce((s, t) => s + Number(t.days), 0);
  const earned = Math.round(months * perMonth * 100) / 100;
  const opening = Number(e.vacation_opening_days || 0);
  return { months_worked: months, per_month: perMonth, earned, opening, adjustments: adj, used, balance: Math.round((opening + earned + adj - used) * 100) / 100, txns };
}

r.post('/employees', requirePerm('payroll.employees'), ah(async (req, res) => {
  const d = clean(req.body);
  if (!d.full_name) throw bad('Full name is required');
  const sal = salaryInput(req.body);
  if (sal && !req.auth.permissions.has('payroll.salary')) throw bad('You may not set salaries (permission: Change salaries)');
  if (!req.auth.permissions.has('payroll.salary')) for (const f of PAY_FIELDS) delete d[f];
  const u = who(req);
  const row = await tx(async (q) => {
    if (d.user_id) await assertLinkable(q, bid(req), d.user_id);
    if (d.cedula) {
      const dup = await q.one(`SELECT full_name FROM pr_employees WHERE business_id=$1 AND regexp_replace(cedula,'\\D','','g')=regexp_replace($2,'\\D','','g')`, [bid(req), d.cedula]);
      if (dup) throw bad(`Cédula ${d.cedula} already belongs to ${dup.full_name}`);
    }
    const code = req.body.code?.trim() || (await nextEmployeeCode(q, bid(req)));
    const keys = Object.keys(d);
    const e = await q.one(
      `INSERT INTO pr_employees (business_id, code, ${keys.join(',')}) VALUES ($1,$2,${keys.map((_, i) => `$${i + 3}`).join(',')}) RETURNING *`,
      [bid(req), code, ...keys.map((k) => d[k])],
    );
    if (sal)
      await q.query(
        `INSERT INTO pr_salary_history (business_id, employee_id, effective_from, salary_type, hourly_rate, monthly_salary, currency, reason, created_by, created_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [bid(req), e!.id, d.joining_date && d.joining_date < sal.effective_from ? d.joining_date : sal.effective_from, sal.salary_type, sal.hourly_rate,
         sal.monthly_salary, sal.currency, sal.reason || 'Initial salary', u.id, u.name],
      );
    return e!;
  });
  await audit(req, 'create', 'pr_employees', row.id, { ...d, salary: sal });
  res.status(201).json(row);
}));

r.put('/employees/:id', requirePerm('payroll.employees'), ah(async (req, res) => {
  const old = await getOwned(db, 'pr_employees', req.params.id, bid(req), 'Employee');
  const d = clean(req.body);
  if (!req.auth.permissions.has('payroll.salary')) for (const f of PAY_FIELDS) delete d[f];
  const keys = Object.keys(d).filter((k) => String(old[k] ?? '') !== String(d[k] ?? '') && !(isoDate(old[k]) && isoDate(old[k]) === isoDate(d[k])));
  if (!keys.length) return res.json(old);
  if (d.cedula && d.cedula !== old.cedula) {
    const dup = await db.one(`SELECT full_name FROM pr_employees WHERE business_id=$1 AND id<>$2 AND regexp_replace(cedula,'\\D','','g')=regexp_replace($3,'\\D','','g')`, [bid(req), old.id, d.cedula]);
    if (dup) throw bad(`Cédula ${d.cedula} already belongs to ${dup.full_name}`);
  }
  const row = await tx(async (q) => {
    if (keys.includes('user_id') && d.user_id) await assertLinkable(q, bid(req), d.user_id, old.id);
    const e = await q.one(`UPDATE pr_employees SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`,
      [old.id, ...keys.map((k) => d[k])]);
    for (const k of keys) {
      if (k === 'photo_url') continue;
      let ov = old[k], nv = d[k];
      if (k === 'department_id') {
        ov = ov && (await q.one(`SELECT name FROM pr_departments WHERE id=$1`, [ov]))?.name;
        nv = nv && (await q.one(`SELECT name FROM pr_departments WHERE id=$1`, [nv]))?.name;
      }
      if (k === 'position_id') {
        ov = ov && (await q.one(`SELECT name FROM pr_positions WHERE id=$1`, [ov]))?.name;
        nv = nv && (await q.one(`SELECT name FROM pr_positions WHERE id=$1`, [nv]))?.name;
      }
      await logChange(q, req, old.id, k, isoDate(ov) && /date/.test(k) ? isoDate(ov) : ov, nv);
    }
    return e;
  });
  await audit(req, 'update', 'pr_employees', old.id, Object.fromEntries(keys.map((k) => [k, { from: k === 'photo_url' ? '…' : old[k], to: k === 'photo_url' ? '…' : d[k] }])));
  res.json(row);
}));

/** New effective-dated salary. Payroll already calculated keeps its own snapshot of the old rate. */
r.post('/employees/:id/salary', requirePerm('payroll.salary'), ah(async (req, res) => {
  const e = await getOwned(db, 'pr_employees', req.params.id, bid(req), 'Employee');
  const sal = salaryInput({ salary: req.body });
  if (!sal) throw bad('Salary details are required');
  const prev = await salaryAt(db, e.id, sal.effective_from);
  const locked = await db.one(
    `SELECT p.code FROM pr_records r JOIN pr_periods p ON p.id=r.period_id
      WHERE r.employee_id=$1 AND p.status IN ('approved','partially_paid','paid','closed') AND p.end_date >= $2 LIMIT 1`,
    [e.id, sal.effective_from],
  );
  if (locked && !req.body.confirm_retroactive)
    throw bad(`Payroll ${locked.code} (already approved) falls on or after ${sal.effective_from}. Approved payroll keeps the old rate; use an adjustment for retroactive pay, or confirm.`);
  const u = who(req);
  const row = await db.one(
    `INSERT INTO pr_salary_history (business_id, employee_id, effective_from, salary_type, hourly_rate, monthly_salary, currency, reason, created_by, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [bid(req), e.id, sal.effective_from, sal.salary_type, sal.hourly_rate, sal.monthly_salary, sal.currency, sal.reason, u.id, u.name],
  );
  await audit(req, 'payroll_salary_change', 'pr_employees', e.id, {
    employee: e.full_name, effective_from: sal.effective_from,
    previous: prev ? { salary_type: prev.salary_type, hourly_rate: prev.hourly_rate, monthly_salary: prev.monthly_salary } : null,
    new: { salary_type: sal.salary_type, hourly_rate: sal.hourly_rate, monthly_salary: sal.monthly_salary }, reason: sal.reason,
  });
  await notify(bid(req), null, 'payroll_salary_change', `Salary changed for ${e.full_name} from ${sal.effective_from} by ${u.name}`, { employee_id: e.id });
  res.status(201).json(row);
}));

r.delete('/employees/:id/salary/:sid', requirePerm('payroll.salary'), ah(async (req, res) => {
  const e = await getOwned(db, 'pr_employees', req.params.id, bid(req), 'Employee');
  const used = await db.one(`SELECT 1 FROM pr_records WHERE salary_history_id=$1 LIMIT 1`, [req.params.sid]);
  if (used) throw bad('This salary was used in payroll and is kept for history. Add a new salary instead.');
  const row = await db.one(`DELETE FROM pr_salary_history WHERE id=$1 AND employee_id=$2 RETURNING *`, [req.params.sid, e.id]);
  await audit(req, 'payroll_salary_delete', 'pr_employees', e.id, row);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Documents (ID, contract) — stored as data URLs
r.post('/employees/:id/documents', requirePerm('payroll.employees'), ah(async (req, res) => {
  const e = await getOwned(db, 'pr_employees', req.params.id, bid(req), 'Employee');
  const { name, kind, data_url } = req.body || {};
  if (!name || !String(data_url || '').startsWith('data:')) throw bad('A file is required');
  const size = Math.round((String(data_url).length * 3) / 4);
  if (size > 4.5 * 1024 * 1024) throw bad('Files must be 4 MB or smaller');
  const mime = String(data_url).slice(5, String(data_url).indexOf(';'));
  const row = await db.one(
    `INSERT INTO pr_documents (business_id, employee_id, kind, name, mime, size, data_url, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, kind, name, mime, size, uploaded_at`,
    [bid(req), e.id, ['identification', 'contract'].includes(kind) ? kind : 'other', name, mime, size, data_url, req.auth.userId],
  );
  await audit(req, 'upload_document', 'pr_employees', e.id, { name, kind });
  res.status(201).json(row);
}));
r.get('/employees/:id/documents/:did', requirePerm('payroll.employees', 'payroll.access'), ah(async (req, res) => {
  const d = await db.one(`SELECT * FROM pr_documents WHERE id=$1 AND employee_id=$2 AND business_id=$3`, [req.params.did, req.params.id, bid(req)]);
  if (!d) throw bad('Document not found');
  res.json(d);
}));
r.delete('/employees/:id/documents/:did', requirePerm('payroll.employees'), ah(async (req, res) => {
  const d = await db.one(`DELETE FROM pr_documents WHERE id=$1 AND employee_id=$2 AND business_id=$3 RETURNING name`, [req.params.did, req.params.id, bid(req)]);
  if (!d) throw bad('Document not found');
  await audit(req, 'delete_document', 'pr_employees', req.params.id, { name: d.name });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Bulk import (CSV rows already parsed by the browser)
r.post('/employees/import', requirePerm('payroll.employees'), ah(async (req, res) => {
  const rows: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const dryRun = !!req.body?.dry_run;
  if (!rows.length) throw bad('No rows to import');
  const depts = await db.query(`SELECT id, name, code FROM pr_departments WHERE business_id=$1`, [bid(req)]);
  const positions = await db.query(`SELECT id, name FROM pr_positions WHERE business_id=$1`, [bid(req)]);
  const existing = await db.query(`SELECT id, full_name, cedula FROM pr_employees WHERE business_id=$1`, [bid(req)]);
  const norm = (s: any) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const digits = (s: any) => String(s || '').replace(/\D/g, '');
  const report: any[] = [];
  const canSal = req.auth.permissions.has('payroll.salary');
  for (const [i, raw] of rows.entries()) {
    const issues: string[] = [];
    const name = String(raw.full_name || raw.name || '').trim();
    if (!name) { report.push({ row: i + 1, status: 'error', issues: ['Missing name'] }); continue; }
    const ced = String(raw.cedula || '').trim();
    const byCed = ced && existing.find((e) => digits(e.cedula) && digits(e.cedula) === digits(ced));
    const byName = existing.find((e) => norm(e.full_name) === norm(name));
    const similar = !byCed && !byName ? existing.find((e) => norm(e.full_name).split(' ')[0] === norm(name).split(' ')[0] && (norm(e.full_name).includes(norm(name)) || norm(name).includes(norm(e.full_name)))) : null;
    if (byCed || byName) { report.push({ row: i + 1, name, status: 'duplicate', issues: [`Already exists as ${(byCed || byName)!.full_name}`] }); continue; }
    if (similar) issues.push(`Similar to existing employee "${similar.full_name}" — verify before merging`);
    if (!ced) issues.push('Missing cédula');
    const dept = raw.department && depts.find((d) => norm(d.name) === norm(raw.department) || norm(d.code) === norm(raw.department) || norm(d.name).startsWith(norm(raw.department).split(' ')[0]));
    if (raw.department && !dept) issues.push(`Unknown department "${raw.department}"`);
    const pos = raw.position && positions.find((p) => norm(p.name).includes(norm(raw.position)));
    const monthly = Number(raw.monthly_salary) || 0, hourly = Number(raw.hourly_rate) || 0;
    if (!monthly && !hourly) issues.push('No salary or hourly rate');
    const e: any = {
      full_name: name, short_name: raw.short_name || null, cedula: ced || null, email: raw.email || null, phone: raw.phone || null,
      department_id: dept?.id ?? null, position_id: pos?.id ?? null, employment_type: monthly ? 'monthly' : 'hourly',
      joining_date: raw.joining_date || null, payment_method: /cash|efectivo/i.test(raw.payment_method) ? 'cash' : /usd/i.test(raw.payment_method) ? 'usd' : 'transfer',
      bank_group: /non/i.test(raw.bank || '') ? 'Non-BCR' : /bcr/i.test(raw.bank || '') ? 'BCR' : null, bank_account: raw.bank_account || null,
      insurance_status: /no/i.test(raw.insured || '') ? 'not_insured' : 'insured',
    };
    if (!dryRun) {
      await tx(async (q) => {
        const code = await nextEmployeeCode(q, bid(req));
        const keys = Object.keys(e);
        const row = await q.one(`INSERT INTO pr_employees (business_id, code, ${keys.join(',')}) VALUES ($1,$2,${keys.map((_, j) => `$${j + 3}`).join(',')}) RETURNING id`,
          [bid(req), code, ...keys.map((k) => e[k])]);
        if (canSal && (monthly || hourly))
          await q.query(`INSERT INTO pr_salary_history (business_id, employee_id, effective_from, salary_type, hourly_rate, monthly_salary, reason, created_by, created_by_name)
                         VALUES ($1,$2,$3,$4,$5,$6,'Imported',$7,$8)`,
            [bid(req), row!.id, raw.salary_from || raw.joining_date || '2020-01-01', monthly ? 'monthly' : 'hourly', monthly ? null : hourly, monthly || null, req.auth.userId, req.auth.userName]);
        existing.push({ id: row!.id, full_name: name, cedula: ced });
      });
    }
    report.push({ row: i + 1, name, status: dryRun ? 'ready' : 'imported', issues });
  }
  if (!dryRun) await audit(req, 'import', 'pr_employees', null, { rows: rows.length, imported: report.filter((x) => x.status === 'imported').length });
  res.json({ report, imported: report.filter((x) => x.status === 'imported').length });
}));

export default r;
