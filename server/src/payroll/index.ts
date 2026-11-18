import { Router } from 'express';
import { HttpError, ah } from '../util.ts';
import { ensureFresh, startPayrollAutoSync, syncPayroll } from './autosync.ts';
import { requireUser } from '../auth.ts';
import setup, { payrollInit } from './setup.ts';
import employees from './employees.ts';
import attendance from './attendance.ts';
import periods from './periods.ts';
import money from './money.ts';
import leave from './leave.ts';
import payslips, { processEmailQueue } from './payslips.ts';
import reports from './reports.ts';
import pos from './pos.ts';

/** Payroll Management System API, mounted at /api/payroll. */
const r = Router();
r.use(requireUser, (req, _res, next) => {
  const any = [...req.auth.permissions].some((p) => p.startsWith('payroll.'));
  next(any ? undefined : new HttpError(403, 'No access to Payroll Management'));
});
r.use(payrollInit);
// Pages that show employees, attendance or revenue are refreshed from the POS first (at most once a minute)
const FRESH = /^\/(dashboard|employees|pos-staff|attendance|reports|revenue)/;
r.use(async (req, _res, next) => {
  try {
    if (req.method === 'GET' && FRESH.test(req.path)) await ensureFresh(req.auth.businessId);
  } catch (e) {
    console.error('[payroll] POS sync before request failed', e);
  }
  next();
});
r.use(setup, employees, attendance, periods, money, leave, payslips, reports, pos);

/** Manual "sync now" from the dashboard. */
r.post('/pos-sync', ah(async (req, res) => res.json(await syncPayroll(req.auth.businessId))));

export function startPayrollWorker() {
  startPayrollAutoSync();
  // Retry queued payslip e-mails after a restart, then every 2 minutes
  setTimeout(() => processEmailQueue().catch(console.error), 5000);
  setInterval(() => processEmailQueue().catch(console.error), 120000);
}

export default r;
