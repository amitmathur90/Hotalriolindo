import { Router } from 'express';
import { HttpError } from '../util.ts';
import { requireUser } from '../auth.ts';
import setup, { payrollInit } from './setup.ts';
import employees from './employees.ts';
import attendance from './attendance.ts';
import periods from './periods.ts';
import money from './money.ts';
import leave from './leave.ts';
import payslips, { processEmailQueue } from './payslips.ts';
import reports from './reports.ts';

/** Payroll Management System API, mounted at /api/payroll. */
const r = Router();
r.use(requireUser, (req, _res, next) => {
  const any = [...req.auth.permissions].some((p) => p.startsWith('payroll.'));
  next(any ? undefined : new HttpError(403, 'No access to Payroll Management'));
});
r.use(payrollInit);
r.use(setup, employees, attendance, periods, money, leave, payslips, reports);

export function startPayrollWorker() {
  // Retry queued payslip e-mails after a restart, then every 2 minutes
  setTimeout(() => processEmailQueue().catch(console.error), 5000);
  setInterval(() => processEmailQueue().catch(console.error), 120000);
}

export default r;
