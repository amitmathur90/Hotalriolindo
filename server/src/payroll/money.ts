import { Router } from 'express';
import { db, tx } from '../db.ts';
import { requirePerm } from '../auth.ts';
import { ah, audit, bad, notify } from '../util.ts';
import { ADJUSTMENT_TYPES, PAYMENT_METHODS, roundTo } from '../../../shared/payroll.ts';
import { advanceBalances, bid, getOwned, isLocked, isoDate, lockedGuard, rateAt, recalcOpenFor, refreshPaymentStatus, who } from './common.ts';

const r = Router();
const r2 = (v: number) => roundTo(v, 2);
const amount = (v: any, what = 'Amount') => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw bad(`${what} must be greater than 0`);
  return r2(n);
};

// ================================================================ Accounts (Cuentas) — Module 7
r.get('/accounts', requirePerm('payroll.advances', 'payroll.access', 'payroll.process'), ah(async (req, res) => {
  const params: any[] = [bid(req)];
  let w = 'a.business_id=$1';
  if (req.query.period_id) w += ` AND a.period_id=$${params.push(String(req.query.period_id))}`;
  if (req.query.employee_id) w += ` AND a.employee_id=$${params.push(String(req.query.employee_id))}`;
  res.json(await db.query(
    `SELECT a.*, e.full_name, e.code, p.code AS period_code, p.name AS period_name, r.accounts_pct,
            round(a.amount * COALESCE(r.accounts_pct, 0) / 100, 2) AS employee_deduction
       FROM pr_accounts a JOIN pr_employees e ON e.id=a.employee_id JOIN pr_periods p ON p.id=a.period_id
       LEFT JOIN pr_records r ON r.period_id=a.period_id AND r.employee_id=a.employee_id
      WHERE ${w} ORDER BY a.entry_date DESC, a.created_at DESC LIMIT 2000`, params));
}));

r.post('/accounts', requirePerm('payroll.advances', 'payroll.process'), ah(async (req, res) => {
  const { employee_id, period_id, entry_date, description } = req.body || {};
  const p = await lockedGuard(db, period_id, bid(req));
  await getOwned(db, 'pr_employees', employee_id, bid(req), 'Employee');
  const amt = amount(req.body.amount);
  const u = who(req);
  const row = await db.one(
    `INSERT INTO pr_accounts (business_id, employee_id, period_id, entry_date, amount, description, created_by, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [bid(req), employee_id, p.id, entry_date || new Date().toISOString().slice(0, 10), amt, description || null, u.id, u.name],
  );
  await recalcOpenFor(db, p.id, employee_id);
  await audit(req, 'create', 'pr_accounts', row!.id, { period: p.code, employee_id, amount: amt, description });
  res.status(201).json(row);
}));

/** Grid editing: set the employee's accounts total for the period (one "grid" entry absorbs the difference). */
r.put('/accounts/total', requirePerm('payroll.advances', 'payroll.process'), ah(async (req, res) => {
  const { employee_id, period_id } = req.body || {};
  const p = await lockedGuard(db, period_id, bid(req));
  const total = Number(req.body.total) || 0;
  if (total < 0) throw bad('Accounts cannot be negative');
  const u = who(req);
  await tx(async (q) => {
    const other = await q.one(`SELECT COALESCE(sum(amount),0) AS s FROM pr_accounts WHERE period_id=$1 AND employee_id=$2 AND source<>'grid'`, [p.id, employee_id]);
    const grid = r2(total - Number(other!.s));
    if (grid < 0) throw bad(`Itemised accounts already total ${other!.s}; remove entries in Advances & Deductions → Accounts`);
    await q.query(`DELETE FROM pr_accounts WHERE period_id=$1 AND employee_id=$2 AND source='grid'`, [p.id, employee_id]);
    if (grid > 0)
      await q.query(`INSERT INTO pr_accounts (business_id, employee_id, period_id, entry_date, amount, description, source, created_by, created_by_name)
                     VALUES ($1,$2,$3,$4,$5,'Entered in payroll grid','grid',$6,$7)`, [bid(req), employee_id, p.id, p.end_date, grid, u.id, u.name]);
    await recalcOpenFor(q, p.id, employee_id);
  });
  await audit(req, 'set_total', 'pr_accounts', null, { period: p.code, employee_id, total });
  res.json(await db.one(`SELECT * FROM pr_records WHERE period_id=$1 AND employee_id=$2`, [p.id, employee_id]));
}));

r.delete('/accounts/:id', requirePerm('payroll.advances', 'payroll.process'), ah(async (req, res) => {
  const a = await getOwned(db, 'pr_accounts', req.params.id, bid(req), 'Account entry');
  await lockedGuard(db, a.period_id, bid(req));
  await db.query(`DELETE FROM pr_accounts WHERE id=$1`, [a.id]);
  await recalcOpenFor(db, a.period_id, a.employee_id);
  await audit(req, 'delete', 'pr_accounts', a.id, a);
  res.json({ ok: true });
}));

// ================================================================ Advances (Vales) — Module 8
r.get('/advances', requirePerm('payroll.advances', 'payroll.access', 'payroll.process'), ah(async (req, res) => {
  const rows = await advanceBalances(db, bid(req), req.query.employee_id ? String(req.query.employee_id) : undefined);
  const emps = new Map((await db.query(`SELECT e.id, e.full_name, e.code, d.name AS department_name FROM pr_employees e LEFT JOIN pr_departments d ON d.id=e.department_id WHERE e.business_id=$1`, [bid(req)])).map((e) => [e.id, e]));
  res.json(rows.map((a): any => ({ ...a, employee: emps.get(a.employee_id) })).filter((a: any) => !req.query.status || a.status === req.query.status).reverse());
}));

r.get('/advances/:id', requirePerm('payroll.advances', 'payroll.access', 'payroll.process'), ah(async (req, res) => {
  const a = (await advanceBalances(db, bid(req))).find((x) => x.id === req.params.id);
  if (!a) throw bad('Advance not found');
  const txns = await db.query(`SELECT t.*, p.code AS period_code FROM pr_advance_txns t LEFT JOIN pr_periods p ON p.id=t.period_id WHERE t.advance_id=$1 ORDER BY t.txn_date, t.created_at`, [a.id]);
  const emp = await db.one(`SELECT id, full_name, code FROM pr_employees WHERE id=$1`, [a.employee_id]);
  res.json({ ...a, employee: emp, txns });
}));

r.post('/advances', requirePerm('payroll.advances'), ah(async (req, res) => {
  const { employee_id, advance_date, reason, payment_method, notes, issued_by_name } = req.body || {};
  const e = await getOwned(db, 'pr_employees', employee_id, bid(req), 'Employee');
  const amt = amount(req.body.amount);
  const per = req.body.deduction_per_payroll ? amount(req.body.deduction_per_payroll, 'Deduction per payroll') : null;
  if (per && per > amt) throw bad('Deduction per payroll cannot exceed the advance');
  const u = who(req);
  // Users who can approve advances may record an already-approved advance in one step
  const autoApprove = req.body.approve === true && req.auth.permissions.has('payroll.approve');
  const row = await db.one(
    `INSERT INTO pr_advances (business_id, employee_id, advance_date, amount, reason, payment_method, deduction_per_payroll, status, requested_by, requested_by_name,
        approved_by, approved_by_name, approved_at, issued_by_name, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [bid(req), e.id, advance_date || new Date().toISOString().slice(0, 10), amt, reason || null, payment_method || 'cash', per,
     autoApprove ? 'approved' : 'requested', u.id, u.name, autoApprove ? u.id : null, autoApprove ? u.name : null, autoApprove ? new Date() : null,
     issued_by_name || u.name, notes || null],
  );
  await audit(req, 'create', 'pr_advances', row!.id, { employee: e.full_name, amount: amt, per_payroll: per, approved: autoApprove });
  if (!autoApprove) await notify(bid(req), null, 'payroll_advance_request', `Advance request ${amt} for ${e.full_name} awaits approval`, { advance_id: row!.id });
  res.status(201).json(row);
}));

r.post('/advances/:id/decision', requirePerm('payroll.approve'), ah(async (req, res) => {
  const a = await getOwned(db, 'pr_advances', req.params.id, bid(req), 'Advance');
  if (a.status !== 'requested') throw bad('Only requested advances can be approved or rejected');
  const approve = req.body?.approve === true;
  if (!approve && !String(req.body?.reason || '').trim()) throw bad('A reason is required to reject');
  const u = who(req);
  const row = await db.one(
    `UPDATE pr_advances SET status=$2, approved_by=$3, approved_by_name=$4, approved_at=now(), rejected_reason=$5 WHERE id=$1 RETURNING *`,
    [a.id, approve ? 'approved' : 'rejected', u.id, u.name, approve ? null : req.body.reason],
  );
  const e = await db.one(`SELECT full_name FROM pr_employees WHERE id=$1`, [a.employee_id]);
  await audit(req, approve ? 'approve' : 'reject', 'pr_advances', a.id, { employee: e?.full_name, amount: a.amount, reason: req.body?.reason });
  await notify(bid(req), null, approve ? 'payroll_advance_approved' : 'payroll_advance_rejected', `Advance ${a.amount} for ${e?.full_name} ${approve ? 'approved' : 'rejected'} by ${u.name}`, { advance_id: a.id });
  res.json(row);
}));

r.put('/advances/:id', requirePerm('payroll.advances'), ah(async (req, res) => {
  const a = await getOwned(db, 'pr_advances', req.params.id, bid(req), 'Advance');
  const per = req.body.deduction_per_payroll ? amount(req.body.deduction_per_payroll, 'Deduction per payroll') : null;
  const sets: any = { deduction_per_payroll: per, reason: req.body.reason ?? a.reason, notes: req.body.notes ?? a.notes };
  if (a.status === 'requested' && req.body.amount !== undefined) sets.amount = amount(req.body.amount);
  const keys = Object.keys(sets);
  const row = await db.one(`UPDATE pr_advances SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1 RETURNING *`, [a.id, ...keys.map((k) => sets[k])]);
  await audit(req, 'update', 'pr_advances', a.id, sets);
  res.json(row);
}));

/** Repayment outside payroll (cash) or write-off. Payroll recoveries are posted when a payroll is approved. */
r.post('/advances/:id/repayment', requirePerm('payroll.advances'), ah(async (req, res) => {
  const a = (await advanceBalances(db, bid(req))).find((x) => x.id === req.params.id);
  if (!a) throw bad('Advance not found');
  if (a.status !== 'approved') throw bad('Only approved advances with a balance can be repaid');
  const amt = amount(req.body.amount);
  const free = r2(Number(a.outstanding) - Number(a.planned));
  if (amt > free + 0.005) throw bad(`Amount exceeds the outstanding balance not already planned in payroll (${free})`);
  const kind = req.body.kind === 'write_off' ? 'write_off' : 'repayment_cash';
  const u = who(req);
  await tx(async (q) => {
    await q.query(`INSERT INTO pr_advance_txns (business_id, advance_id, kind, amount, txn_date, note, created_by, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [bid(req), a.id, kind, amt, req.body.txn_date || new Date().toISOString().slice(0, 10), req.body.note || null, u.id, u.name]);
    if (amt + 0.005 >= Number(a.outstanding)) await q.query(`UPDATE pr_advances SET status='repaid' WHERE id=$1`, [a.id]);
  });
  await audit(req, kind, 'pr_advances', a.id, { amount: amt, note: req.body.note });
  res.json({ ok: true });
}));

r.post('/advances/:id/cancel', requirePerm('payroll.advances'), ah(async (req, res) => {
  const a = await getOwned(db, 'pr_advances', req.params.id, bid(req), 'Advance');
  const txn = await db.one(`SELECT count(*) AS n FROM pr_advance_txns WHERE advance_id=$1`, [a.id]);
  if (Number(txn!.n)) throw bad('Repayments exist; the advance cannot be cancelled');
  const planned = (await advanceBalances(db, bid(req))).find((x) => x.id === a.id);
  if (Number(planned?.planned)) throw bad('The advance is planned for recovery in an open payroll; remove it there first');
  await db.query(`UPDATE pr_advances SET status='cancelled' WHERE id=$1`, [a.id]);
  await audit(req, 'cancel', 'pr_advances', a.id);
  res.json({ ok: true });
}));

// ================================================================ Adjustments register — Module 12
r.get('/adjustments', requirePerm('payroll.process', 'payroll.access'), ah(async (req, res) => {
  const params: any[] = [bid(req)];
  let w = 'a.business_id=$1';
  if (req.query.period_id) w += ` AND (a.period_id=$${params.push(String(req.query.period_id))} OR a.pay_in_period_id=$${params.length})`;
  if (req.query.employee_id) w += ` AND a.employee_id=$${params.push(String(req.query.employee_id))}`;
  res.json(await db.query(
    `SELECT a.*, e.full_name, e.code, p.code AS period_code, p.name AS period_name, pp.code AS pay_in_code, pp.status AS pay_in_status
       FROM pr_adjustments a JOIN pr_employees e ON e.id=a.employee_id JOIN pr_periods p ON p.id=a.period_id LEFT JOIN pr_periods pp ON pp.id=a.pay_in_period_id
      WHERE ${w} ORDER BY a.created_at DESC LIMIT 2000`, params));
}));

r.post('/adjustments', requirePerm('payroll.process'), ah(async (req, res) => {
  const { employee_id, period_id, pay_in_period_id, adj_type, reason, payment_source } = req.body || {};
  if (!ADJUSTMENT_TYPES[adj_type]) throw bad('Choose an adjustment type');
  if (!String(reason || '').trim()) throw bad('A reason is required');
  const e = await getOwned(db, 'pr_employees', employee_id, bid(req), 'Employee');
  const p = await getOwned(db, 'pr_periods', period_id, bid(req), 'Payroll period');
  const original = r2(Number(req.body.original_amount) || 0), actual = r2(Number(req.body.actual_amount) || 0);
  let diff = req.body.difference !== undefined && req.body.difference !== '' ? r2(Number(req.body.difference)) : r2(actual - original);
  if (adj_type === 'recovery' && diff > 0) diff = -diff;
  if (!diff) throw bad('The adjustment difference is zero');
  if (pay_in_period_id) {
    await lockedGuard(db, pay_in_period_id, bid(req));
    const rec = await db.one(`SELECT 1 FROM pr_records WHERE period_id=$1 AND employee_id=$2`, [pay_in_period_id, e.id]);
    if (!rec) throw bad(`${e.full_name} is not in the payroll that should pay this adjustment`);
  }
  const u = who(req);
  const autoApprove = req.auth.permissions.has('payroll.approve') && req.body.approve === true;
  const row = await db.one(
    `INSERT INTO pr_adjustments (business_id, employee_id, period_id, pay_in_period_id, adj_type, original_amount, actual_amount, difference, reason, payment_source,
        status, created_by, created_by_name, approved_by, approved_by_name, approved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [bid(req), e.id, p.id, pay_in_period_id || null, adj_type, original, actual, diff, reason, payment_source || (pay_in_period_id ? 'payroll' : null),
     autoApprove ? 'approved' : 'pending', u.id, u.name, autoApprove ? u.id : null, autoApprove ? u.name : null, autoApprove ? new Date() : null],
  );
  if (autoApprove) await recalcOpenFor(db, pay_in_period_id || null, e.id);
  await audit(req, 'payroll_adjustment_create', 'pr_adjustments', row!.id, { employee: e.full_name, period: p.code, type: adj_type, original, actual, difference: diff, reason });
  if (!autoApprove) await notify(bid(req), null, 'payroll_adjustment_pending', `Adjustment ${diff} for ${e.full_name} (${ADJUSTMENT_TYPES[adj_type]}) awaits approval`, { adjustment_id: row!.id });
  res.status(201).json(row);
}));

r.post('/adjustments/:id/decision', requirePerm('payroll.approve'), ah(async (req, res) => {
  const a = await getOwned(db, 'pr_adjustments', req.params.id, bid(req), 'Adjustment');
  if (a.status !== 'pending') throw bad('Only pending adjustments can be decided');
  if (a.pay_in_period_id) await lockedGuard(db, a.pay_in_period_id, bid(req));
  const approve = req.body?.approve === true;
  const u = who(req);
  const row = await db.one(`UPDATE pr_adjustments SET status=$2, approved_by=$3, approved_by_name=$4, approved_at=now() WHERE id=$1 RETURNING *`,
    [a.id, approve ? 'approved' : 'rejected', u.id, u.name]);
  await recalcOpenFor(db, a.pay_in_period_id, a.employee_id);
  await audit(req, approve ? 'payroll_adjustment_approve' : 'payroll_adjustment_reject', 'pr_adjustments', a.id, { difference: a.difference, reason: req.body?.reason });
  res.json(row);
}));

r.delete('/adjustments/:id', requirePerm('payroll.process'), ah(async (req, res) => {
  const a = await getOwned(db, 'pr_adjustments', req.params.id, bid(req), 'Adjustment');
  if (a.status === 'approved' && a.pay_in_period_id) {
    const p = await db.one(`SELECT status FROM pr_periods WHERE id=$1`, [a.pay_in_period_id]);
    if (isLocked(p!.status)) throw bad('This adjustment was paid in an approved payroll and is kept for history');
  } else if (a.status === 'approved') throw bad('Approved adjustments are kept for history');
  await db.query(`DELETE FROM pr_adjustments WHERE id=$1`, [a.id]);
  await recalcOpenFor(db, a.pay_in_period_id, a.employee_id);
  await audit(req, 'payroll_adjustment_delete', 'pr_adjustments', a.id, a);
  res.json({ ok: true });
}));

// ================================================================ Payments — Module 13
r.get('/payments', requirePerm('payroll.payments', 'payroll.access'), ah(async (req, res) => {
  const params: any[] = [bid(req)];
  let w = 'pay.business_id=$1';
  if (req.query.period_id) w += ` AND pay.period_id=$${params.push(String(req.query.period_id))}`;
  if (req.query.employee_id) w += ` AND pay.employee_id=$${params.push(String(req.query.employee_id))}`;
  if (req.query.from) w += ` AND pay.payment_date >= $${params.push(String(req.query.from))}`;
  if (req.query.to) w += ` AND pay.payment_date <= $${params.push(String(req.query.to))}`;
  res.json(await db.query(
    `SELECT pay.*, e.full_name, e.code AS employee_code, p.code AS period_code, p.name AS period_name
       FROM pr_payments pay JOIN pr_employees e ON e.id=pay.employee_id JOIN pr_periods p ON p.id=pay.period_id
      WHERE ${w} ORDER BY pay.payment_date DESC, pay.created_at DESC LIMIT 3000`, params));
}));

async function recordPayment(q: any, req: any, rec: any, body: any) {
  const currency = body.currency === 'USD' ? 'USD' : 'CRC';
  const method = PAYMENT_METHODS[body.method] ? body.method : rec.payment_method || 'cash';
  const date = isoDate(body.payment_date) || new Date().toISOString().slice(0, 10);
  let rate = 1;
  if (currency === 'USD') {
    rate = Number(body.exchange_rate) || Number((await rateAt(q, bid(req), date))?.usd_crc) || 0;
    if (!(rate > 0)) throw bad(`No USD exchange rate on file for ${date}; enter the rate`);
  }
  const remaining = r2(Number(rec.net_payable) - Number(rec.paid_amount));
  let amt = body.amount === undefined || body.amount === '' ? (currency === 'USD' ? r2(remaining / rate) : remaining) : amount(body.amount);
  const crc = currency === 'USD' ? r2(amt * rate) : amt;
  if (crc <= 0) throw bad(`${rec.employee_name} has nothing left to pay`);
  if (crc > remaining + (currency === 'USD' ? rate : 0.005)) throw bad(`${rec.employee_name}: payment ${crc} exceeds the remaining ${remaining}`);
  const u = who(req);
  const row = await q.one(
    `INSERT INTO pr_payments (business_id, record_id, period_id, employee_id, amount, currency, exchange_rate, amount_crc, method, bank, account_ref, payment_date,
        reference, notes, created_by, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [bid(req), rec.id, rec.period_id, rec.employee_id, amt, currency, rate, Math.min(crc, remaining), method, body.bank || rec.bank_group || null,
     body.account_ref ?? rec.bank_account ?? null, date, body.reference || null, body.notes || null, u.id, u.name],
  );
  await refreshPaymentStatus(q, rec.id);
  return row;
}

r.post('/payments', requirePerm('payroll.payments'), ah(async (req, res) => {
  const rec = await getOwned(db, 'pr_records', req.body?.record_id, bid(req), 'Payroll record');
  const p = await db.one(`SELECT * FROM pr_periods WHERE id=$1`, [rec.period_id]);
  if (!['approved', 'partially_paid'].includes(p!.status)) throw bad('Payments can only be recorded for approved payroll');
  const row = await tx((q) => recordPayment(q, req, rec, req.body));
  await audit(req, 'payroll_payment', 'pr_payments', row.id, { period: p!.code, employee: rec.employee_name, amount: row.amount, currency: row.currency, amount_crc: row.amount_crc, method: row.method });
  const after = await db.one(`SELECT status FROM pr_periods WHERE id=$1`, [p!.id]);
  if (after!.status === 'paid') await notify(bid(req), null, 'payroll_paid', `Payroll ${p!.code} is fully paid`, { period_id: p!.id });
  res.status(201).json(row);
}));

/** Pay every unpaid record of a period in full (e.g. after a bank batch), optionally filtered by method. */
r.post('/payments/bulk', requirePerm('payroll.payments'), ah(async (req, res) => {
  const p = await getOwned(db, 'pr_periods', req.body?.period_id, bid(req), 'Payroll period');
  if (!['approved', 'partially_paid'].includes(p.status)) throw bad('Payments can only be recorded for approved payroll');
  const params: any[] = [p.id];
  let w = `period_id=$1 AND payment_status <> 'paid' AND net_payable > paid_amount`;
  if (req.body.method) w += ` AND payment_method=$${params.push(req.body.method)}`;
  if (Array.isArray(req.body.record_ids) && req.body.record_ids.length) w += ` AND id = ANY($${params.push(req.body.record_ids)}::uuid[])`;
  const recs = await db.query(`SELECT * FROM pr_records WHERE ${w}`, params);
  const rows = await tx(async (q) => {
    const out: any[] = [];
    for (const rec of recs)
      out.push(await recordPayment(q, req, rec, { method: rec.payment_method === 'usd' ? 'usd' : rec.payment_method, currency: rec.payment_method === 'usd' ? 'USD' : 'CRC', payment_date: req.body.payment_date, reference: req.body.reference, exchange_rate: req.body.exchange_rate }));
    return out;
  });
  await audit(req, 'payroll_payment_bulk', 'pr_periods', p.id, { count: rows.length, total_crc: r2(rows.reduce((s, x) => s + Number(x.amount_crc), 0)), method: req.body.method || 'all' });
  const after = await db.one(`SELECT status FROM pr_periods WHERE id=$1`, [p.id]);
  if (after!.status === 'paid') await notify(bid(req), null, 'payroll_paid', `Payroll ${p.code} is fully paid`, { period_id: p.id });
  res.json({ count: rows.length });
}));

r.post('/payments/:id/void', requirePerm('payroll.payments'), ah(async (req, res) => {
  const pay = await getOwned(db, 'pr_payments', req.params.id, bid(req), 'Payment');
  if (pay.voided) throw bad('Already voided');
  if (!String(req.body?.reason || '').trim()) throw bad('A reason is required');
  const p = await db.one(`SELECT status, code FROM pr_periods WHERE id=$1`, [pay.period_id]);
  if (p!.status === 'closed') throw bad('The payroll is closed; reopen it first');
  await tx(async (q) => {
    await q.query(`UPDATE pr_payments SET voided=true, void_reason=$2, voided_by=$3, voided_at=now() WHERE id=$1`, [pay.id, req.body.reason, req.auth.userId]);
    await refreshPaymentStatus(q, pay.record_id);
  });
  await audit(req, 'payroll_payment_void', 'pr_payments', pay.id, { period: p!.code, amount_crc: pay.amount_crc, reason: req.body.reason });
  res.json({ ok: true });
}));

export default r;
