import { Router, type Request } from 'express';
import { db, json, tx } from '../db.ts';
import { requirePerm } from '../auth.ts';
import { ah, audit, bad } from '../util.ts';
import { aguinaldoAmount, PAYMENT_METHODS, roundTo } from '../../../shared/payroll.ts';
import { bid, getOwned, isoDate, rulesAt, who } from './common.ts';
import { slipsPdf, type SlipData } from './payslips.ts';

const r = Router();
const r2 = (v: number) => roundTo(v, 2);
const reportPerm = requirePerm('payroll.reports', 'payroll.access');
const METRICS = ['payroll_expense', 'earnings', 'gross', 'net_payable', 'caja'] as const;
const metricOf = (req: Request) => (METRICS as readonly string[]).includes(String(req.query.metric)) ? String(req.query.metric) : 'payroll_expense';
const POSTED = `('approved','partially_paid','paid','closed')`;
const statusFilter = (req: Request) => (req.query.include_drafts === '1' ? '' : ` AND p.status IN ${POSTED}`);

// ---------------------------------------------------------------- Dashboard (Module 1)
r.get('/dashboard', reportPerm, ah(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const params: any[] = [bid(req), year];
  let w = `p.business_id=$1 AND EXTRACT(YEAR FROM p.end_date)=$2`;
  if (req.query.month) w += ` AND EXTRACT(MONTH FROM p.end_date)=$${params.push(Number(req.query.month))}`;
  if (req.query.period_id) w += ` AND p.id=$${params.push(String(req.query.period_id))}`;
  if (req.query.department_id) w += ` AND r.department_id=$${params.push(String(req.query.department_id))}`;
  if (req.query.employee_id) w += ` AND r.employee_id=$${params.push(String(req.query.employee_id))}`;
  if (req.query.payment_status) w += ` AND r.payment_status=$${params.push(String(req.query.payment_status))}`;
  const from = `FROM pr_records r JOIN pr_periods p ON p.id=r.period_id WHERE ${w}`;

  const [kpi, pays, latest, active, monthly, byDept, headcount, revenue, prevYear] = await Promise.all([
    db.one(`SELECT count(DISTINCT r.employee_id) AS employees, COALESCE(sum(r.gross),0) AS gross, COALESCE(sum(r.earnings),0) AS earnings,
                   COALESCE(sum(r.total_deductions),0) AS deductions, COALESCE(sum(r.net_payable),0) AS net, COALESCE(sum(r.paid_amount),0) AS paid,
                   COALESCE(sum(GREATEST(r.net_payable-r.paid_amount,0)),0) AS pending, COALESCE(sum(r.payroll_expense),0) AS payroll_expense,
                   COALESCE(sum(r.caja),0) AS caja, count(DISTINCT p.id) AS periods ${from}`, params),
    db.query(`SELECT pay.method, pay.currency, COALESCE(sum(pay.amount_crc),0) AS amount, count(*) AS n
                FROM pr_payments pay JOIN pr_records r ON r.id=pay.record_id JOIN pr_periods p ON p.id=pay.period_id WHERE ${w} AND NOT pay.voided GROUP BY 1,2`, params),
    db.one(`SELECT p.id, p.code, p.name, p.status, (SELECT count(*) FROM pr_records x WHERE x.period_id=p.id) AS employees
              FROM pr_periods p WHERE p.business_id=$1 ORDER BY p.end_date DESC LIMIT 1`, [bid(req)]),
    db.one(`SELECT count(*) AS n FROM pr_employees WHERE business_id=$1 AND status='active'`, [bid(req)]),
    db.query(`SELECT EXTRACT(MONTH FROM p.end_date)::int AS month, COALESCE(sum(r.payroll_expense),0) AS payroll_expense, COALESCE(sum(r.gross),0) AS gross,
                     COALESCE(sum(r.net_payable),0) AS net, COALESCE(sum(r.earnings),0) AS earnings
                FROM pr_records r JOIN pr_periods p ON p.id=r.period_id
               WHERE p.business_id=$1 AND EXTRACT(YEAR FROM p.end_date)=$2 ${req.query.department_id ? `AND r.department_id=$3` : ''} GROUP BY 1 ORDER BY 1`,
      req.query.department_id ? [bid(req), year, req.query.department_id] : [bid(req), year]),
    db.query(`SELECT COALESCE(r.department_name,'No department') AS department, COALESCE(sum(r.payroll_expense),0) AS payroll_expense, count(DISTINCT r.employee_id) AS employees ${from} GROUP BY 1 ORDER BY 2 DESC`, params),
    db.query(`SELECT COALESCE(d.name,'No department') AS department, count(*) AS employees FROM pr_employees e LEFT JOIN pr_departments d ON d.id=e.department_id
               WHERE e.business_id=$1 AND e.status='active' GROUP BY 1 ORDER BY 2 DESC`, [bid(req)]),
    db.query(`SELECT month, bar_revenue + food_revenue + other_revenue AS total FROM pr_revenue WHERE business_id=$1 AND year=$2`, [bid(req), year]),
    db.query(`SELECT EXTRACT(MONTH FROM p.end_date)::int AS month, COALESCE(sum(r.payroll_expense),0) AS payroll_expense
                FROM pr_records r JOIN pr_periods p ON p.id=r.period_id WHERE p.business_id=$1 AND EXTRACT(YEAR FROM p.end_date)=$2 GROUP BY 1`, [bid(req), year - 1]),
  ]);
  const cash = pays.filter((p) => p.method === 'cash').reduce((s, p) => s + Number(p.amount), 0);
  const bank = pays.filter((p) => ['transfer', 'sinpe'].includes(p.method)).reduce((s, p) => s + Number(p.amount), 0);
  const usd = pays.filter((p) => p.currency === 'USD' || p.method === 'usd').reduce((s, p) => s + Number(p.amount), 0);
  const rev = new Map(revenue.map((x) => [x.month, Number(x.total)]));
  const prev = new Map(prevYear.map((x) => [x.month, Number(x.payroll_expense)]));
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = monthly.find((x) => x.month === i + 1);
    const pe = Number(m?.payroll_expense || 0), rv = rev.get(i + 1) || 0;
    return { month: i + 1, payroll_expense: pe, gross: Number(m?.gross || 0), net: Number(m?.net || 0), revenue: rv, labor_pct: rv ? r2((pe / rv) * 100) : null, previous_year: prev.get(i + 1) || 0 };
  });
  res.json({
    year,
    kpi: { ...kpi, active_employees: Number(active!.n), current_period: latest, cash_paid: r2(cash), bank_paid: r2(bank), usd_paid: r2(usd) },
    payments_by_method: pays.map((p) => ({ ...p, label: PAYMENT_METHODS[p.method] || p.method })),
    months, by_department: byDept, headcount,
  });
}));

// ---------------------------------------------------------------- Monthly / quarterly / annual by department (Module 16 A, B)
r.get('/reports/summary', reportPerm, ah(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const metric = metricOf(req);
  const rows = await db.query(
    `SELECT COALESCE(d.name, r.department_name, 'No department') AS department, d.expense_account, d.sort, EXTRACT(YEAR FROM p.end_date)::int AS year,
            EXTRACT(MONTH FROM p.end_date)::int AS month, COALESCE(sum(r.${metric}),0) AS amount
       FROM pr_records r JOIN pr_periods p ON p.id=r.period_id LEFT JOIN pr_departments d ON d.id=r.department_id
      WHERE p.business_id=$1 AND EXTRACT(YEAR FROM p.end_date) IN ($2::int, $2::int - 1, $2::int - 2) ${statusFilter(req)}
      GROUP BY 1,2,3,4,5`, [bid(req), year]);
  const depts = await db.query(`SELECT name, expense_account, sort FROM pr_departments WHERE business_id=$1 ORDER BY sort, name`, [bid(req)]);
  const names = [...new Set([...depts.map((d) => d.name), ...rows.map((x) => x.department)])];
  const rates = await db.query(
    `SELECT EXTRACT(MONTH FROM rate_date)::int AS month, avg(usd_crc) AS rate FROM pr_exchange_rates WHERE business_id=$1 AND EXTRACT(YEAR FROM rate_date)=$2 GROUP BY 1`, [bid(req), year]);
  const revenue = await db.query(`SELECT * FROM pr_revenue WHERE business_id=$1 AND year IN ($2::int, $2::int - 1)`, [bid(req), year]);
  const get = (dep: string | null, y: number, m?: number) => rows.filter((x) => (!dep || x.department === dep) && x.year === y && (!m || x.month === m)).reduce((s, x) => s + Number(x.amount), 0);
  const lines = names.map((dep) => {
    const d = depts.find((x) => x.name === dep);
    const months = Array.from({ length: 12 }, (_, i) => r2(get(dep, year, i + 1)));
    const q = [0, 1, 2, 3].map((k) => r2(months.slice(k * 3, k * 3 + 3).reduce((s, v) => s + v, 0)));
    const total = r2(months.reduce((s, v) => s + v, 0));
    const last = r2(get(dep, year - 1)), twoAgo = r2(get(dep, year - 2));
    return { department: dep, expense_account: d?.expense_account || null, months, quarters: q, total, previous_year: last, two_years_ago: twoAgo,
      yoy_change: r2(total - last), yoy_pct: last ? r2(((total - last) / last) * 100) : null };
  }).filter((l) => l.total || l.previous_year || depts.some((d) => d.name === l.department));
  const months = Array.from({ length: 12 }, (_, i) => r2(lines.reduce((s, l) => s + l.months[i], 0)));
  const total = r2(months.reduce((s, v) => s + v, 0));
  const rate = (m: number) => Number(rates.find((x) => x.month === m)?.rate) || null;
  const rev = (y: number, m: number) => revenue.find((x) => x.year === y && x.month === m);
  const monthRev = Array.from({ length: 12 }, (_, i) => { const x = rev(year, i + 1); return x ? Number(x.bar_revenue) + Number(x.food_revenue) + Number(x.other_revenue) : 0; });
  res.json({
    year, metric, lines,
    totals: {
      months, quarters: [0, 1, 2, 3].map((k) => r2(months.slice(k * 3, k * 3 + 3).reduce((s, v) => s + v, 0))), total,
      previous_year: r2(lines.reduce((s, l) => s + l.previous_year, 0)),
      usd: months.map((v, i) => (rate(i + 1) ? r2(v / rate(i + 1)!) : null)),
      exchange_rates: months.map((_, i) => rate(i + 1)),
      revenue: monthRev,
      labor_pct: months.map((v, i) => (monthRev[i] ? r2((v / monthRev[i]) * 100) : null)),
    },
  });
}));

/** Payroll vs revenue: labour cost % overall and for bar / kitchen (Module 16 C). */
r.get('/reports/labor', reportPerm, ah(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const metric = metricOf(req);
  const pay = await db.query(
    `SELECT EXTRACT(MONTH FROM p.end_date)::int AS month, COALESCE(d.code,'') AS code, COALESCE(sum(r.${metric}),0) AS amount
       FROM pr_records r JOIN pr_periods p ON p.id=r.period_id LEFT JOIN pr_departments d ON d.id=r.department_id
      WHERE p.business_id=$1 AND EXTRACT(YEAR FROM p.end_date)=$2 ${statusFilter(req)} GROUP BY 1,2`, [bid(req), year]);
  const rev = await db.query(`SELECT * FROM pr_revenue WHERE business_id=$1 AND year=$2`, [bid(req), year]);
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const p = pay.filter((x) => x.month === m);
    const total = p.reduce((s, x) => s + Number(x.amount), 0);
    const bar = p.filter((x) => x.code === 'BAR').reduce((s, x) => s + Number(x.amount), 0);
    const kit = p.filter((x) => x.code === 'KIT').reduce((s, x) => s + Number(x.amount), 0);
    const rv = rev.find((x) => x.month === m);
    const barRev = Number(rv?.bar_revenue || 0), foodRev = Number(rv?.food_revenue || 0), totRev = barRev + foodRev + Number(rv?.other_revenue || 0);
    const pct = (a: number, b: number) => (b ? r2((a / b) * 100) : null);
    return { month: m, payroll: r2(total), bar_payroll: r2(bar), kitchen_payroll: r2(kit), bar_revenue: barRev, food_revenue: foodRev, total_revenue: totRev,
      labor_pct: pct(total, totRev), bar_labor_pct: pct(bar, barRev), kitchen_labor_pct: pct(kit, foodRev), revenue_source: rv?.source || null };
  });
  res.json({ year, metric, months });
}));

/** CAJA / insurance report by department + fixed insurance list (Module 10). */
r.get('/reports/insurance', reportPerm, ah(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const params: any[] = [bid(req), year];
  let w = `p.business_id=$1 AND EXTRACT(YEAR FROM p.end_date)=$2 ${statusFilter(req)}`;
  if (req.query.month) w += ` AND EXTRACT(MONTH FROM p.end_date)=$${params.push(Number(req.query.month))}`;
  const [byDept, byEmp] = await Promise.all([
    db.query(`SELECT COALESCE(r.department_name,'No department') AS department, count(DISTINCT r.employee_id) FILTER (WHERE r.insurance_method <> 'none') AS insured,
                     count(DISTINCT r.employee_id) FILTER (WHERE r.insurance_method = 'none') AS not_insured,
                     COALESCE(sum((r.calc->>'caja_base')::numeric),0) AS base, COALESCE(sum(r.caja),0) AS caja
                FROM pr_records r JOIN pr_periods p ON p.id=r.period_id WHERE ${w} GROUP BY 1 ORDER BY 1`, params),
    db.query(`SELECT r.employee_id, max(r.employee_name) AS employee_name, max(r.department_name) AS department_name, max(r.insurance_method) AS method,
                     COALESCE(sum((r.calc->>'caja_base')::numeric),0) AS base, COALESCE(sum(r.caja),0) AS caja, count(*) AS periods
                FROM pr_records r JOIN pr_periods p ON p.id=r.period_id WHERE ${w} GROUP BY 1 ORDER BY 2`, params),
  ]);
  const { rules } = await rulesAt(db, bid(req), `${year}-12-31`);
  const fixed = await db.query(
    `SELECT e.id, e.code, e.full_name, d.name AS department_name, e.insurance_salary, e.insurance_status, e.insurance_method
       FROM pr_employees e LEFT JOIN pr_departments d ON d.id=e.department_id
      WHERE e.business_id=$1 AND e.status='active' ORDER BY d.sort NULLS LAST, e.full_name`, [bid(req)]);
  res.json({
    year, by_department: byDept, by_employee: byEmp, rules: { caja_rate: rules.caja_rate, fixed_insurance_rate: rules.fixed_insurance_rate, quincenal_divisor: rules.quincenal_divisor },
    employees: fixed.map((e) => {
      const monthly = e.insurance_method === 'fixed' && e.insurance_status === 'insured' ? r2((Number(e.insurance_salary || 0) * rules.fixed_insurance_rate) / 100) : null;
      return { ...e, monthly_amount: monthly, quincenal_amount: monthly === null ? null : r2(monthly / rules.quincenal_divisor) };
    }),
  });
}));

// ---------------------------------------------------------------- Revenue records
r.get('/revenue', reportPerm, ah(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  res.json(await db.query(`SELECT * FROM pr_revenue WHERE business_id=$1 AND year=$2 ORDER BY month`, [bid(req), year]));
}));
r.put('/revenue', requirePerm('payroll.reports'), ah(async (req, res) => {
  const { year, month } = req.body || {};
  if (!(Number(year) > 2000) || !(Number(month) >= 1 && Number(month) <= 12)) throw bad('Valid year and month required');
  const row = await db.one(
    `INSERT INTO pr_revenue (business_id, year, month, bar_revenue, food_revenue, other_revenue, source, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (business_id, year, month) DO UPDATE SET bar_revenue=EXCLUDED.bar_revenue, food_revenue=EXCLUDED.food_revenue, other_revenue=EXCLUDED.other_revenue,
       source=EXCLUDED.source, notes=EXCLUDED.notes, updated_at=now() RETURNING *`,
    [bid(req), year, month, Number(req.body.bar_revenue) || 0, Number(req.body.food_revenue) || 0, Number(req.body.other_revenue) || 0, req.body.source || 'manual', req.body.notes || null],
  );
  await audit(req, 'save', 'pr_revenue', row!.id, req.body);
  res.json(row);
}));
/** Fill revenue from POS sales: categories routed to the Bar station = bar revenue, other kitchen stations = food. Net of tax and refunds. */
r.post('/revenue/from-pos', requirePerm('payroll.reports'), ah(async (req, res) => {
  const year = Number(req.body?.year) || new Date().getFullYear();
  const tz = (await db.one(`SELECT timezone FROM businesses WHERE id=$1`, [bid(req)]))?.timezone || 'America/Costa_Rica';
  const rows = await db.query(
    `SELECT EXTRACT(MONTH FROM s.created_at AT TIME ZONE $3)::int AS month,
            COALESCE(sum((i.total - i.tax) * CASE WHEN s.type='refund' THEN -1 ELSE 1 END) FILTER (WHERE lower(c.kitchen_station)='bar'),0) AS bar,
            COALESCE(sum((i.total - i.tax) * CASE WHEN s.type='refund' THEN -1 ELSE 1 END) FILTER (WHERE c.kitchen_station IS NOT NULL AND lower(c.kitchen_station)<>'bar'),0) AS food,
            COALESCE(sum((i.total - i.tax) * CASE WHEN s.type='refund' THEN -1 ELSE 1 END) FILTER (WHERE c.kitchen_station IS NULL),0) AS other
       FROM sales s JOIN sale_items i ON i.sale_id=s.id LEFT JOIN categories c ON c.id=i.category_id
      WHERE s.business_id=$1 AND EXTRACT(YEAR FROM s.created_at AT TIME ZONE $3)=$2 GROUP BY 1`, [bid(req), year, tz]);
  for (const x of rows)
    await db.query(
      `INSERT INTO pr_revenue (business_id, year, month, bar_revenue, food_revenue, other_revenue, source) VALUES ($1,$2,$3,$4,$5,$6,'pos')
       ON CONFLICT (business_id, year, month) DO UPDATE SET bar_revenue=EXCLUDED.bar_revenue, food_revenue=EXCLUDED.food_revenue, other_revenue=EXCLUDED.other_revenue, source='pos', updated_at=now()
       WHERE pr_revenue.source <> 'manual' OR $7`,
      [bid(req), year, x.month, r2(Number(x.bar)), r2(Number(x.food)), r2(Number(x.other)), req.body?.overwrite_manual === true]);
  await audit(req, 'revenue_from_pos', 'pr_revenue', null, { year, months: rows.length });
  res.json({ months: rows.length });
}));

// ---------------------------------------------------------------- Cashbook vs QuickBooks reconciliation (Module 17)
const TOL = 1;
function reconStatus(row: any) {
  if (row.status === 'manual') return 'manual';
  if (row.cashbook_amount === null || row.qbo_amount === null) return 'pending';
  return Math.abs(Number(row.cashbook_amount) - Number(row.qbo_amount)) <= TOL ? 'matched' : 'difference';
}
r.get('/reconciliation', reportPerm, ah(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  // One line per payroll period of the year; payroll amount = net paid in the period (what reaches the cashbook)
  const periods = await db.query(
    `SELECT p.id, p.code, p.name, p.end_date, p.status, COALESCE(sum(r.net_payable),0) AS net, COALESCE(sum(r.paid_amount),0) AS paid
       FROM pr_periods p LEFT JOIN pr_records r ON r.period_id=p.id WHERE p.business_id=$1 AND EXTRACT(YEAR FROM p.end_date)=$2 GROUP BY p.id ORDER BY p.end_date`, [bid(req), year]);
  for (const p of periods) {
    const end = new Date(isoDate(p.end_date) + 'T12:00:00Z');
    await db.query(
      `INSERT INTO pr_reconciliation (business_id, period_id, year, month, label, payroll_amount)
       SELECT $1,$2,$3,$4,$5,$6 WHERE NOT EXISTS (SELECT 1 FROM pr_reconciliation WHERE period_id=$2)`,
      [bid(req), p.id, year, end.getUTCMonth() + 1, end.getUTCDate() <= 15 ? '15TH' : '30TH', p.paid || p.net]);
    await db.query(`UPDATE pr_reconciliation SET payroll_amount=$2 WHERE period_id=$1`, [p.id, Number(p.paid) || Number(p.net)]);
  }
  const rows = await db.query(
    `SELECT x.*, p.code AS period_code, p.name AS period_name, p.status AS period_status FROM pr_reconciliation x LEFT JOIN pr_periods p ON p.id=x.period_id
      WHERE x.business_id=$1 AND x.year=$2 ORDER BY x.month, x.label, p.end_date`, [bid(req), year]);
  const out = rows.map((x): any => ({
    ...x,
    cashbook_vs_qbo: x.cashbook_amount !== null && x.qbo_amount !== null ? r2(Number(x.cashbook_amount) - Number(x.qbo_amount)) : null,
    payroll_vs_cashbook: x.cashbook_amount !== null ? r2(Number(x.payroll_amount) - Number(x.cashbook_amount)) : null,
    status: reconStatus(x),
  }));
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = out.filter((x) => x.month === i + 1);
    const sum = (k: string) => (m.some((x) => x[k] !== null) ? r2(m.reduce((s, x) => s + Number(x[k] || 0), 0)) : null);
    return { month: i + 1, payroll: sum('payroll_amount'), cashbook: sum('cashbook_amount'), qbo: sum('qbo_amount'), difference: sum('cashbook_vs_qbo'),
      status: !m.length ? null : m.every((x) => x.status === 'matched' || x.status === 'manual') ? 'matched' : m.some((x) => x.status === 'difference') ? 'difference' : 'pending' };
  });
  res.json({ year, rows: out, months });
}));
r.put('/reconciliation/:id', requirePerm('payroll.reports'), ah(async (req, res) => {
  const x = await getOwned(db, 'pr_reconciliation', req.params.id, bid(req), 'Reconciliation line');
  const val = (v: any, old: any) => (v === undefined ? old : v === '' || v === null ? null : Number(v));
  const cb = val(req.body.cashbook_amount, x.cashbook_amount), qb = val(req.body.qbo_amount, x.qbo_amount);
  let status = req.body.status === 'manual' ? 'manual' : 'auto';
  if (status === 'manual' && !String(req.body.notes ?? x.notes ?? '').trim()) throw bad('Explain a manual reconciliation in the notes');
  status = status === 'manual' ? 'manual' : reconStatus({ cashbook_amount: cb, qbo_amount: qb });
  const u = who(req);
  const row = await db.one(`UPDATE pr_reconciliation SET cashbook_amount=$2, qbo_amount=$3, status=$4, notes=$5, updated_by=$6, updated_by_name=$7, updated_at=now() WHERE id=$1 RETURNING *`,
    [x.id, cb, qb, status, req.body.notes ?? x.notes, u.id, u.name]);
  await audit(req, 'reconcile', 'pr_reconciliation', x.id, { cashbook: cb, qbo: qb, status, notes: req.body.notes });
  res.json(row);
}));
/** Manual month line (e.g. historical months before the system, or entries not tied to a payroll). */
r.post('/reconciliation', requirePerm('payroll.reports'), ah(async (req, res) => {
  const { year, month, label } = req.body || {};
  if (!(Number(month) >= 1 && Number(month) <= 12)) throw bad('Month required');
  const row = await db.one(
    `INSERT INTO pr_reconciliation (business_id, year, month, label, payroll_amount, cashbook_amount, qbo_amount, notes, updated_by, updated_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [bid(req), Number(year), Number(month), label || null, Number(req.body.payroll_amount) || 0,
     req.body.cashbook_amount === '' || req.body.cashbook_amount === undefined ? null : Number(req.body.cashbook_amount),
     req.body.qbo_amount === '' || req.body.qbo_amount === undefined ? null : Number(req.body.qbo_amount), req.body.notes || null, req.auth.userId, req.auth.userName]);
  await db.query(`UPDATE pr_reconciliation SET status=$2 WHERE id=$1`, [row!.id, reconStatus(row)]);
  res.status(201).json(row);
}));
r.delete('/reconciliation/:id', requirePerm('payroll.reports'), ah(async (req, res) => {
  const x = await getOwned(db, 'pr_reconciliation', req.params.id, bid(req), 'Reconciliation line');
  if (x.period_id) throw bad('Lines linked to a payroll period cannot be deleted');
  await db.query(`DELETE FROM pr_reconciliation WHERE id=$1`, [x.id]);
  res.json({ ok: true });
}));
/** CSV import: rows of {period_code | (month,label), cashbook, qbo}. */
r.post('/reconciliation/import', requirePerm('payroll.reports'), ah(async (req, res) => {
  const year = Number(req.body?.year) || new Date().getFullYear();
  const rows: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const lines = await db.query(`SELECT x.*, p.code FROM pr_reconciliation x LEFT JOIN pr_periods p ON p.id=x.period_id WHERE x.business_id=$1 AND x.year=$2`, [bid(req), year]);
  const n = (v: any) => (v === undefined || v === null || String(v).trim() === '' ? undefined : Number(String(v).replace(/[^\d.-]/g, '')));
  let updated = 0;
  const errors: string[] = [];
  for (const [i, raw] of rows.entries()) {
    const l = lines.find((x) => raw.period_code && x.code === raw.period_code) ||
      lines.find((x) => Number(raw.month) === x.month && String(raw.label || '').toUpperCase() === String(x.label || '').toUpperCase());
    if (!l) { errors.push(`Row ${i + 1}: no matching payroll line`); continue; }
    const cb = n(raw.cashbook) ?? l.cashbook_amount, qb = n(raw.qbo ?? raw.quickbooks) ?? l.qbo_amount;
    await db.query(`UPDATE pr_reconciliation SET cashbook_amount=$2, qbo_amount=$3, status=$4, updated_at=now() WHERE id=$1`, [l.id, cb, qb, l.status === 'manual' ? 'manual' : reconStatus({ cashbook_amount: cb, qbo_amount: qb })]);
    updated++;
  }
  await audit(req, 'reconciliation_import', 'pr_reconciliation', null, { year, updated });
  res.json({ updated, errors });
}));

// ---------------------------------------------------------------- Aguinaldo (Module 11)
r.get('/aguinaldo', requirePerm('payroll.access', 'payroll.process'), ah(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  res.json(await db.query(
    `SELECT a.*, e.full_name, e.code, e.cedula, e.payment_method AS employee_payment_method, d.name AS department_name
       FROM pr_aguinaldo a JOIN pr_employees e ON e.id=a.employee_id LEFT JOIN pr_departments d ON d.id=e.department_id
      WHERE a.business_id=$1 AND a.year=$2 ORDER BY d.sort NULLS LAST, e.full_name`, [bid(req), year]));
}));

/** Calculate proposed aguinaldo from approved payroll between 1 Dec (year − 1) and 30 Nov (year). */
r.post('/aguinaldo/calculate', requirePerm('payroll.process'), ah(async (req, res) => {
  const year = Number(req.body?.year) || new Date().getFullYear();
  const start = `${year - 1}-12-01`, end = `${year}-11-30`;
  const { rules } = await rulesAt(db, bid(req), end);
  const months = rules.aguinaldo_months || 12;
  const ids: string[] = Array.isArray(req.body?.employee_ids) ? req.body.employee_ids : [];
  const emps = await db.query(
    `SELECT * FROM pr_employees WHERE business_id=$1 AND (joining_date IS NULL OR joining_date <= $3) AND (leaving_date IS NULL OR leaving_date >= $2)
       ${ids.length ? 'AND id = ANY($4::uuid[])' : `AND status <> 'inactive'`}`, ids.length ? [bid(req), start, end, ids] : [bid(req), start, end]);
  const drafts = await db.one(`SELECT count(*) AS n FROM pr_periods WHERE business_id=$1 AND end_date BETWEEN $2 AND $3 AND status NOT IN ${POSTED}`, [bid(req), start, end]);
  let calculated = 0, skipped = 0;
  await tx(async (q) => {
    for (const e of emps) {
      const existing = await q.one(`SELECT status FROM pr_aguinaldo WHERE business_id=$1 AND year=$2 AND employee_id=$3`, [bid(req), year, e.id]);
      if (existing && existing.status !== 'draft') { skipped++; continue; }
      const recs = await q.query(
        `SELECT to_char(p.end_date,'YYYY-MM') AS month, sum(r.earnings) AS earnings, count(*) AS periods
           FROM pr_records r JOIN pr_periods p ON p.id=r.period_id
          WHERE r.employee_id=$1 AND p.end_date BETWEEN $2 AND $3 AND p.status IN ${POSTED} GROUP BY 1 ORDER BY 1`, [e.id, start, end]);
      const total = r2(recs.reduce((s, x) => s + Number(x.earnings), 0));
      const warnings: string[] = [];
      const from = e.joining_date && isoDate(e.joining_date)! > start ? isoDate(e.joining_date)! : start;
      const to = e.leaving_date && isoDate(e.leaving_date)! < end ? isoDate(e.leaving_date)! : end;
      const expected: string[] = [];
      for (let d = new Date(from.slice(0, 7) + '-01T12:00:00Z'); d.toISOString().slice(0, 7) <= to.slice(0, 7); d.setUTCMonth(d.getUTCMonth() + 1)) expected.push(d.toISOString().slice(0, 7));
      const missing = expected.filter((m) => !recs.some((x) => x.month === m));
      if (!recs.length) warnings.push('No approved payroll found in the aguinaldo period');
      else if (missing.length) warnings.push(`No approved payroll for ${missing.join(', ')} — earnings for those months are missing`);
      if (e.joining_date && isoDate(e.joining_date)! > start) warnings.push(`Partial year: joined ${isoDate(e.joining_date)}`);
      if (e.leaving_date && isoDate(e.leaving_date)! < end) warnings.push(`Left on ${isoDate(e.leaving_date)}`);
      if (Number(drafts!.n)) warnings.push(`${drafts!.n} payroll period(s) in the range are not approved yet and were not included`);
      const amount = aguinaldoAmount(total, months, 2);
      const worked = r2(recs.length);
      const detail = recs.map((x) => ({ month: x.month, earnings: r2(Number(x.earnings)), periods: Number(x.periods) }));
      await q.query(
        `INSERT INTO pr_aguinaldo (business_id, employee_id, year, period_start, period_end, months_worked, total_earnings, monthly_detail, average_monthly, calculated_amount, final_amount, warnings)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)
         ON CONFLICT (business_id, year, employee_id) DO UPDATE SET period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, months_worked=EXCLUDED.months_worked,
           total_earnings=EXCLUDED.total_earnings, monthly_detail=EXCLUDED.monthly_detail, average_monthly=EXCLUDED.average_monthly, calculated_amount=EXCLUDED.calculated_amount,
           final_amount=COALESCE(pr_aguinaldo.adjusted_amount, EXCLUDED.calculated_amount), warnings=EXCLUDED.warnings, updated_at=now()`,
        [bid(req), e.id, year, start, end, worked, total, json(detail), worked ? r2(total / worked) : 0, amount, json(warnings)]);
      calculated++;
    }
  });
  await audit(req, 'aguinaldo_calculate', 'pr_aguinaldo', null, { year, calculated, skipped });
  res.json({ calculated, skipped, period_start: start, period_end: end });
}));

r.put('/aguinaldo/:id', requirePerm('payroll.process'), ah(async (req, res) => {
  const a = await getOwned(db, 'pr_aguinaldo', req.params.id, bid(req), 'Aguinaldo');
  if (a.status !== 'draft') throw bad('Approved aguinaldo cannot be changed');
  const adj = req.body.adjusted_amount === '' || req.body.adjusted_amount === null || req.body.adjusted_amount === undefined ? null : r2(Number(req.body.adjusted_amount));
  if (adj !== null && (!Number.isFinite(adj) || adj < 0)) throw bad('Enter a valid amount');
  if (adj !== null && !String(req.body.adjustment_reason || '').trim()) throw bad('A reason is required for an adjustment');
  const row = await db.one(`UPDATE pr_aguinaldo SET adjusted_amount=$2, adjustment_reason=$3, final_amount=COALESCE($2, calculated_amount), updated_at=now() WHERE id=$1 RETURNING *`,
    [a.id, adj, adj === null ? null : req.body.adjustment_reason]);
  await audit(req, 'aguinaldo_adjust', 'pr_aguinaldo', a.id, { calculated: a.calculated_amount, adjusted: adj, reason: req.body.adjustment_reason });
  res.json(row);
}));

r.post('/aguinaldo/approve', requirePerm('payroll.approve'), ah(async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) throw bad('Select employees');
  const u = who(req);
  const rows = await db.query(`UPDATE pr_aguinaldo SET status='approved', approved_by=$3, approved_by_name=$4, approved_at=now() WHERE business_id=$1 AND id = ANY($2::uuid[]) AND status='draft' RETURNING id`,
    [bid(req), ids, u.id, u.name]);
  await audit(req, 'aguinaldo_approve', 'pr_aguinaldo', null, { ids, count: rows.length });
  res.json({ approved: rows.length });
}));

r.post('/aguinaldo/:id/pay', requirePerm('payroll.payments'), ah(async (req, res) => {
  const a = await getOwned(db, 'pr_aguinaldo', req.params.id, bid(req), 'Aguinaldo');
  if (a.status !== 'approved') throw bad('Approve the aguinaldo before recording the payment');
  const u = who(req);
  const row = await db.one(`UPDATE pr_aguinaldo SET status='paid', paid_amount=final_amount, payment_method=$2, paid_at=$3, paid_by_name=$4, payment_reference=$5, updated_at=now() WHERE id=$1 RETURNING *`,
    [a.id, req.body.payment_method || 'transfer', req.body.paid_at || new Date().toISOString().slice(0, 10), u.name, req.body.reference || null]);
  await audit(req, 'aguinaldo_pay', 'pr_aguinaldo', a.id, { amount: a.final_amount, method: req.body.payment_method });
  res.json(row);
}));

r.get('/aguinaldo/:id/payslip.pdf', requirePerm('payroll.access', 'payroll.process'), ah(async (req, res) => {
  const ids = String(req.params.id) === 'all' ? null : [req.params.id];
  const year = Number(req.query.year) || new Date().getFullYear();
  const rows = await db.query(
    `SELECT a.*, e.full_name, e.cedula, d.name AS department_name, ps.name AS position_name FROM pr_aguinaldo a JOIN pr_employees e ON e.id=a.employee_id
       LEFT JOIN pr_departments d ON d.id=e.department_id LEFT JOIN pr_positions ps ON ps.id=e.position_id
      WHERE a.business_id=$1 ${ids ? 'AND a.id = ANY($2::uuid[])' : 'AND a.year=$2'} ORDER BY e.full_name`, [bid(req), ids ?? year]);
  if (!rows.length) throw bad('Nothing to print');
  const s = await db.one(`SELECT * FROM pr_settings WHERE business_id=$1`, [bid(req)]);
  const b = await db.one(`SELECT name, logo_url, address, gstin FROM businesses WHERE id=$1`, [bid(req)]);
  const slips: SlipData[] = rows.map((a) => ({
    title: `AGUINALDO ${a.year}`,
    company: { name: s?.company_name || b?.name, id: s?.company_id || b?.gstin, address: s?.company_address || b?.address, logo: s?.logo_url || b?.logo_url, footer: s?.payslip_footer },
    info: [['Colaborador', a.full_name], ['Cédula', a.cedula || '—'], ['Departamento', a.department_name || '—'], ['Puesto', a.position_name || '—'],
      ['Periodo', `${isoDate(a.period_start)} – ${isoDate(a.period_end)}`], ['Meses', String(a.months_worked)]],
    earnings: [
      ...(a.monthly_detail || []).map((m: any) => [`Salarios ${m.month}`, `${m.periods} planilla(s)`, Number(m.earnings)] as [string, string, number]),
    ],
    deductions: [],
    gross: Number(a.total_earnings), totalDeductions: 0, net: Number(a.final_amount),
    payment: [['Total salarios', `¢${Number(a.total_earnings).toLocaleString('en-US', { minimumFractionDigits: 2 })}`], ['Cálculo', `÷ ${12}`],
      ['Estado', a.status === 'paid' ? 'Pagado' : a.status === 'approved' ? 'Aprobado' : 'Borrador'],
      ...(a.adjusted_amount !== null ? [['Ajuste', `${a.adjustment_reason}`] as [string, string]] : [])],
    notes: a.status === 'draft' ? 'BORRADOR — sujeto a aprobación.' : null,
  }));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="aguinaldo-${year}.pdf"`);
  res.send(slipsPdf(slips));
}));

// ---------------------------------------------------------------- Notifications helper for HR: pending items count
r.get('/pending', ah(async (req, res) => {
  const b = bid(req);
  const [adv, adj, vac, review, ot] = await Promise.all([
    db.one(`SELECT count(*) AS n FROM pr_advances WHERE business_id=$1 AND status='requested'`, [b]),
    db.one(`SELECT count(*) AS n FROM pr_adjustments WHERE business_id=$1 AND status='pending'`, [b]),
    db.one(`SELECT count(*) AS n FROM pr_vacation_requests WHERE business_id=$1 AND status='requested'`, [b]),
    db.one(`SELECT count(*) AS n FROM pr_periods WHERE business_id=$1 AND status='under_review'`, [b]),
    db.one(`SELECT count(*) AS n FROM pr_attendance WHERE business_id=$1 AND overtime_hours > 0 AND NOT overtime_approved AND work_date > CURRENT_DATE - 60`, [b]),
  ]);
  res.json({ advances: Number(adv!.n), adjustments: Number(adj!.n), vacation: Number(vac!.n), approvals: Number(review!.n), overtime: Number(ot!.n) });
}));

export default r;

