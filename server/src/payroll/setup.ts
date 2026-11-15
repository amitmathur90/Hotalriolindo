import { Router, type Request, type Response, type NextFunction } from 'express';
import { db, json, tx, type Q } from '../db.ts';
import { requirePerm } from '../auth.ts';
import { ah, audit, bad, pick } from '../util.ts';
import { DEFAULT_RULES, mergeRules, RULE_LABELS } from '../../../shared/payroll.ts';
import { PAYROLL_ROLES } from '../../../shared/pricing.ts';
import { bid, ensureDefaultRuleSet, getOwned, isoDate, who } from './common.ts';

const r = Router();

// ---------------------------------------------------------------- One-time initialisation per business
const DEFAULT_DEPARTMENTS: [string, string, string, string[]][] = [
  ['Bar Staff', 'BAR', '6010-BAR STAFF SALARY', ['Bartender / Coctelero', 'Cashier / Cajero', 'Especialized worker']],
  ['Kitchen Staff', 'KIT', '6020-KITCHEN STAFF SALARY', ['Cook / Cocinero', 'Pizzero', 'Kitchen helper / Ayudante de cocina']],
  ['Housekeeping', 'HKP', '6040-HOUSEKEEPING SALARY', ['Cleaner / Mucama']],
  ['Maintenance', 'MNT', '6050-MAINTENANCE STAFF SALARY', ['Building maintenance']],
  ['Security', 'SEC', '6055-SECURITY STAFF SALARY', ['Security guard']],
  ['Operations', 'OPS', '6060-OPERATIONS STAFF SALARY', ['Operations staff']],
  ['Temporary Staff', 'TMP', 'TEMPORARY STAFF SALARY', ['Temporary worker']],
];

// Costa Rica public holidays. paid=false: "feriado de pago no obligatorio". Verify each year (some move to Monday).
const CR_HOLIDAYS: [string, string, boolean][] = [
  ['01-01', 'Año Nuevo', true], ['04-11', 'Día de Juan Santamaría', true], ['05-01', 'Día del Trabajador', true],
  ['07-25', 'Anexión del Partido de Nicoya', true], ['08-02', 'Virgen de los Ángeles', false], ['08-15', 'Día de la Madre', true],
  ['08-31', 'Día de la Persona Negra y la Cultura Afrocostarricense', false], ['09-15', 'Día de la Independencia', true],
  ['12-01', 'Día de la Abolición del Ejército', false], ['12-25', 'Navidad', true],
];
const EASTER: Record<number, string> = { 2025: '04-20', 2026: '04-05', 2027: '03-28', 2028: '04-16' };

export async function seedHolidays(q: Q, businessId: string, year: number) {
  const rows: [string, string, boolean][] = CR_HOLIDAYS.map(([md, name, paid]) => [`${year}-${md}`, name, paid]);
  if (EASTER[year]) {
    const e = new Date(`${year}-${EASTER[year]}T12:00:00Z`);
    const d = (days: number) => new Date(e.getTime() + days * 86400000).toISOString().slice(0, 10);
    rows.push([d(-3), 'Jueves Santo', true], [d(-2), 'Viernes Santo', true]);
  }
  for (const [date, name, paid] of rows)
    await q.query(`INSERT INTO pr_holidays (business_id, holiday_date, name, paid) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [businessId, date, name, paid]);
  return rows.length;
}

export async function ensurePayrollSetup(q: Q, businessId: string) {
  await ensureDefaultRuleSet(q, businessId);
  await q.query(`INSERT INTO pr_settings (business_id, company_name) SELECT id, name FROM businesses WHERE id=$1 ON CONFLICT DO NOTHING`, [businessId]);
  const anyDept = await q.one(`SELECT 1 FROM pr_departments WHERE business_id=$1 LIMIT 1`, [businessId]);
  if (!anyDept)
    for (const [i, [name, code, account, positions]] of DEFAULT_DEPARTMENTS.entries()) {
      const d = await q.one(`INSERT INTO pr_departments (business_id, name, code, expense_account, sort) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [businessId, name, code, account, i]);
      for (const p of positions) await q.query(`INSERT INTO pr_positions (business_id, department_id, name) VALUES ($1,$2,$3)`, [businessId, d!.id, p]);
    }
  const anyHol = await q.one(`SELECT 1 FROM pr_holidays WHERE business_id=$1 LIMIT 1`, [businessId]);
  if (!anyHol) {
    const y = new Date().getFullYear();
    await seedHolidays(q, businessId, y);
    await seedHolidays(q, businessId, y + 1);
  }
  for (const [name, perms] of Object.entries(PAYROLL_ROLES)) {
    const exists = await q.one(`SELECT 1 FROM roles WHERE business_id=$1 AND lower(name)=lower($2)`, [businessId, name]);
    if (!exists) await q.query(`INSERT INTO roles (business_id, name, permissions) VALUES ($1,$2,$3)`, [businessId, name, json(perms)]);
  }
}

const ready = new Set<string>();
export const payrollInit = ah(async (req: Request, _res: Response, next: NextFunction) => {
  const b = req.auth?.businessId;
  if (b && !ready.has(b)) {
    await tx((q) => ensurePayrollSetup(q, b));
    ready.add(b);
  }
  next();
});

// ---------------------------------------------------------------- Departments & positions
r.get('/departments', ah(async (req, res) => {
  res.json(await db.query(
    `SELECT d.*, u.name AS manager_name,
            (SELECT count(*) FROM pr_employees e WHERE e.department_id=d.id AND e.status='active') AS active_employees
       FROM pr_departments d LEFT JOIN users u ON u.id=d.manager_user_id
      WHERE d.business_id=$1 ORDER BY d.sort, d.name`, [bid(req)]));
}));
const DEPT_FIELDS = ['name', 'code', 'expense_account', 'manager_user_id', 'accounts_deduction_pct', 'sort', 'active'];
r.post('/departments', requirePerm('payroll.settings'), ah(async (req, res) => {
  const d = pick(req.body, DEPT_FIELDS);
  if (!d.name?.trim()) throw bad('Department name is required');
  const keys = Object.keys(d);
  const row = await db.one(`INSERT INTO pr_departments (business_id, ${keys.join(',')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`,
    [bid(req), ...keys.map((k) => (d[k] === '' ? null : d[k]))]);
  await audit(req, 'create', 'pr_departments', row!.id, d);
  res.status(201).json(row);
}));
r.put('/departments/:id', requirePerm('payroll.settings'), ah(async (req, res) => {
  await getOwned(db, 'pr_departments', req.params.id, bid(req), 'Department');
  const d = pick(req.body, DEPT_FIELDS);
  const keys = Object.keys(d);
  if (!keys.length) throw bad('Nothing to update');
  const row = await db.one(`UPDATE pr_departments SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1 RETURNING *`,
    [req.params.id, ...keys.map((k) => (d[k] === '' ? null : d[k]))]);
  await audit(req, 'update', 'pr_departments', req.params.id, d);
  res.json(row);
}));
r.delete('/departments/:id', requirePerm('payroll.settings'), ah(async (req, res) => {
  await getOwned(db, 'pr_departments', req.params.id, bid(req), 'Department');
  const used = await db.one(`SELECT count(*) AS n FROM pr_employees WHERE department_id=$1`, [req.params.id]);
  if (Number(used!.n)) throw bad(`${used!.n} employee(s) are assigned to this department. Reassign them or deactivate the department.`);
  await db.query(`DELETE FROM pr_departments WHERE id=$1`, [req.params.id]);
  await audit(req, 'delete', 'pr_departments', req.params.id);
  res.json({ ok: true });
}));

r.get('/positions', ah(async (req, res) => {
  res.json(await db.query(
    `SELECT p.*, d.name AS department_name, (SELECT count(*) FROM pr_employees e WHERE e.position_id=p.id) AS employees
       FROM pr_positions p LEFT JOIN pr_departments d ON d.id=p.department_id WHERE p.business_id=$1 ORDER BY d.sort NULLS LAST, p.name`, [bid(req)]));
}));
const POS_FIELDS = ['name', 'department_id', 'minimum_salary', 'active'];
r.post('/positions', requirePerm('payroll.settings'), ah(async (req, res) => {
  const d = pick(req.body, POS_FIELDS);
  if (!d.name?.trim()) throw bad('Position name is required');
  const keys = Object.keys(d);
  const row = await db.one(`INSERT INTO pr_positions (business_id, ${keys.join(',')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`,
    [bid(req), ...keys.map((k) => (d[k] === '' ? null : d[k]))]);
  await audit(req, 'create', 'pr_positions', row!.id, d);
  res.status(201).json(row);
}));
r.put('/positions/:id', requirePerm('payroll.settings'), ah(async (req, res) => {
  await getOwned(db, 'pr_positions', req.params.id, bid(req), 'Position');
  const d = pick(req.body, POS_FIELDS);
  const keys = Object.keys(d);
  if (!keys.length) throw bad('Nothing to update');
  const row = await db.one(`UPDATE pr_positions SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1 RETURNING *`,
    [req.params.id, ...keys.map((k) => (d[k] === '' ? null : d[k]))]);
  await audit(req, 'update', 'pr_positions', req.params.id, d);
  res.json(row);
}));
r.delete('/positions/:id', requirePerm('payroll.settings'), ah(async (req, res) => {
  await getOwned(db, 'pr_positions', req.params.id, bid(req), 'Position');
  await db.query(`UPDATE pr_employees SET position_id=NULL WHERE position_id=$1`, [req.params.id]);
  await db.query(`DELETE FROM pr_positions WHERE id=$1`, [req.params.id]);
  await audit(req, 'delete', 'pr_positions', req.params.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Payroll rules (effective-dated versions)
r.get('/rules', ah(async (req, res) => {
  const sets = await db.query(`SELECT * FROM pr_rule_sets WHERE business_id=$1 ORDER BY effective_from DESC, created_at DESC`, [bid(req)]);
  res.json({ sets: sets.map((s) => ({ ...s, rules: mergeRules(s.rules) })), defaults: DEFAULT_RULES, labels: RULE_LABELS });
}));
r.post('/rules', requirePerm('payroll.salary'), ah(async (req, res) => {
  const { name, effective_from, rules, notes } = req.body || {};
  if (!effective_from) throw bad('Effective date is required');
  const merged = mergeRules(rules);
  if (merged.reference_hours <= 0) throw bad('Reference hours must be greater than 0');
  if (merged.quincenal_divisor <= 0 || merged.monthly_day_divisor <= 0) throw bad('Divisors must be greater than 0');
  const u = who(req);
  const row = await db.one(
    `INSERT INTO pr_rule_sets (business_id, name, effective_from, rules, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [bid(req), name || `Rules from ${effective_from}`, effective_from, json(merged), notes || null, u.id],
  );
  await audit(req, 'create', 'pr_rule_sets', row!.id, { effective_from, rules: merged });
  res.status(201).json(row);
}));
// Rule versions are never edited in place once a payroll uses them: create a new version instead.
r.delete('/rules/:id', requirePerm('payroll.salary'), ah(async (req, res) => {
  await getOwned(db, 'pr_rule_sets', req.params.id, bid(req), 'Rule set');
  const used = await db.one(`SELECT count(*) AS n FROM pr_periods WHERE rule_set_id=$1`, [req.params.id]);
  if (Number(used!.n)) throw bad('This rule version is used by payroll periods and is kept for history. Create a newer version instead.');
  const count = await db.one(`SELECT count(*) AS n FROM pr_rule_sets WHERE business_id=$1`, [bid(req)]);
  if (Number(count!.n) <= 1) throw bad('At least one rule version is required');
  await db.query(`DELETE FROM pr_rule_sets WHERE id=$1`, [req.params.id]);
  await audit(req, 'delete', 'pr_rule_sets', req.params.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Holidays
r.get('/holidays', ah(async (req, res) => {
  const y = Number(req.query.year) || new Date().getFullYear();
  res.json(await db.query(`SELECT * FROM pr_holidays WHERE business_id=$1 AND EXTRACT(YEAR FROM holiday_date)=$2 ORDER BY holiday_date`, [bid(req), y]));
}));
r.post('/holidays', requirePerm('payroll.settings'), ah(async (req, res) => {
  const { holiday_date, name, paid } = req.body || {};
  if (!holiday_date || !name) throw bad('Date and name are required');
  const row = await db.one(
    `INSERT INTO pr_holidays (business_id, holiday_date, name, paid) VALUES ($1,$2,$3,$4)
     ON CONFLICT (business_id, holiday_date) DO UPDATE SET name=EXCLUDED.name, paid=EXCLUDED.paid RETURNING *`,
    [bid(req), holiday_date, name, paid !== false],
  );
  await audit(req, 'save', 'pr_holidays', row!.id, req.body);
  res.status(201).json(row);
}));
r.post('/holidays/seed', requirePerm('payroll.settings'), ah(async (req, res) => {
  const y = Number(req.body?.year) || new Date().getFullYear();
  const n = await seedHolidays(db, bid(req), y);
  res.json({ ok: true, count: n });
}));
r.delete('/holidays/:id', requirePerm('payroll.settings'), ah(async (req, res) => {
  await getOwned(db, 'pr_holidays', req.params.id, bid(req), 'Holiday');
  await db.query(`DELETE FROM pr_holidays WHERE id=$1`, [req.params.id]);
  await audit(req, 'delete', 'pr_holidays', req.params.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Exchange rates (historical)
r.get('/exchange-rates', ah(async (req, res) => {
  res.json(await db.query(`SELECT * FROM pr_exchange_rates WHERE business_id=$1 ORDER BY rate_date DESC LIMIT 500`, [bid(req)]));
}));
r.post('/exchange-rates', requirePerm('payroll.payments', 'payroll.settings'), ah(async (req, res) => {
  const { rate_date, usd_crc, source } = req.body || {};
  if (!rate_date || !(Number(usd_crc) > 0)) throw bad('Date and a positive rate are required');
  const row = await db.one(
    `INSERT INTO pr_exchange_rates (business_id, rate_date, usd_crc, source) VALUES ($1,$2,$3,$4)
     ON CONFLICT (business_id, rate_date) DO UPDATE SET usd_crc=EXCLUDED.usd_crc, source=EXCLUDED.source RETURNING *`,
    [bid(req), rate_date, Number(usd_crc), source || 'manual'],
  );
  await audit(req, 'save', 'pr_exchange_rates', row!.id, req.body);
  res.status(201).json(row);
}));
r.get('/exchange-rates/at', ah(async (req, res) => {
  const d = isoDate(req.query.date) || new Date().toISOString().slice(0, 10);
  res.json(await db.one(`SELECT * FROM pr_exchange_rates WHERE business_id=$1 AND rate_date <= $2 ORDER BY rate_date DESC LIMIT 1`, [bid(req), d]) ?? null);
}));
r.delete('/exchange-rates/:id', requirePerm('payroll.settings'), ah(async (req, res) => {
  await getOwned(db, 'pr_exchange_rates', req.params.id, bid(req), 'Exchange rate');
  const used = await db.one(`SELECT 1 FROM pr_payments p JOIN pr_exchange_rates x ON x.id=$1 WHERE p.business_id=x.business_id AND p.payment_date=x.rate_date AND p.currency='USD' LIMIT 1`, [req.params.id]);
  if (used) throw bad('Payments were recorded with this rate; it is kept for history');
  await db.query(`DELETE FROM pr_exchange_rates WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Payroll settings (payslip header, email template)
r.get('/settings', ah(async (req, res) => {
  const s = await db.one(`SELECT * FROM pr_settings WHERE business_id=$1`, [bid(req)]);
  const b = await db.one(`SELECT name, logo_url, address, gstin, currency_symbol FROM businesses WHERE id=$1`, [bid(req)]);
  res.json({ ...s, business: b, smtp_configured: !!process.env.SMTP_HOST });
}));
r.put('/settings', requirePerm('payroll.settings'), ah(async (req, res) => {
  const d = pick(req.body, ['company_name', 'company_id', 'company_address', 'logo_url', 'payslip_footer', 'email_subject', 'email_body', 'employee_code_prefix']);
  const keys = Object.keys(d);
  if (!keys.length) throw bad('Nothing to update');
  const row = await db.one(`UPDATE pr_settings SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE business_id=$1 RETURNING *`,
    [bid(req), ...keys.map((k) => d[k])]);
  await audit(req, 'update', 'pr_settings', bid(req), d);
  res.json(row);
}));

// Users that can be linked to an employee or set as department manager
r.get('/users', ah(async (req, res) => {
  res.json(await db.query(`SELECT u.id, u.name, u.email, r.name AS role_name FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.business_id=$1 AND u.active ORDER BY u.name`, [bid(req)]));
}));

// Payroll audit trail
r.get('/audit', requirePerm('audit.view', 'payroll.reports'), ah(async (req, res) => {
  const params: any[] = [bid(req)];
  let w = `business_id=$1 AND (entity LIKE 'pr\\_%' OR action LIKE 'payroll%')`;
  if (req.query.entity_id) w += ` AND entity_id=$${params.push(String(req.query.entity_id))}`;
  res.json(await db.query(`SELECT * FROM audit_logs WHERE ${w} ORDER BY created_at DESC LIMIT 500`, params));
}));

export default r;
