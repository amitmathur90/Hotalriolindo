import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PAYROLL_NAV } from './nav';
import { useSession } from '../backoffice/BackOffice';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Employees = lazy(() => import('./pages/Employees'));
const EmployeeDetail = lazy(() => import('./pages/EmployeeDetail'));
const Departments = lazy(() => import('./pages/Departments'));
const Attendance = lazy(() => import('./pages/Attendance'));
const Periods = lazy(() => import('./pages/Periods'));
const PeriodDetail = lazy(() => import('./pages/PeriodDetail'));
const Advances = lazy(() => import('./pages/Advances'));
const Leave = lazy(() => import('./pages/Leave'));
const Insurance = lazy(() => import('./pages/Insurance'));
const Aguinaldo = lazy(() => import('./pages/Aguinaldo'));
const Payments = lazy(() => import('./pages/Payments'));
const Payslips = lazy(() => import('./pages/Payslips'));
const Reports = lazy(() => import('./pages/Reports'));
const Reconciliation = lazy(() => import('./pages/Reconciliation'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const MyPayslips = lazy(() => import('./pages/MyPayslips'));

export default function Payroll() {
  const { can } = useSession();
  const items = PAYROLL_NAV.filter((n) => n.perms.some(can));
  const home = items[0]?.to.replace(/^payroll\/?/, '') || 'me';
  const ok = (to: string, el: JSX.Element) => (PAYROLL_NAV.find((n) => n.to === to)!.perms.some(can) ? el : <Navigate to={`/backoffice/payroll/${home}`} replace />);
  return (
    <Routes>
      <Route index element={ok('payroll', <Dashboard />)} />
      <Route path="employees" element={ok('payroll/employees', <Employees />)} />
      <Route path="employees/:id" element={ok('payroll/employees', <EmployeeDetail />)} />
      <Route path="departments" element={ok('payroll/departments', <Departments />)} />
      <Route path="attendance" element={ok('payroll/attendance', <Attendance />)} />
      <Route path="periods" element={ok('payroll/periods', <Periods />)} />
      <Route path="periods/:id" element={ok('payroll/periods', <PeriodDetail />)} />
      <Route path="advances" element={ok('payroll/advances', <Advances />)} />
      <Route path="leave" element={ok('payroll/leave', <Leave />)} />
      <Route path="insurance" element={ok('payroll/insurance', <Insurance />)} />
      <Route path="aguinaldo" element={ok('payroll/aguinaldo', <Aguinaldo />)} />
      <Route path="payments" element={ok('payroll/payments', <Payments />)} />
      <Route path="payslips" element={ok('payroll/payslips', <Payslips />)} />
      <Route path="reports" element={ok('payroll/reports', <Reports />)} />
      <Route path="reconciliation" element={ok('payroll/reconciliation', <Reconciliation />)} />
      <Route path="settings" element={ok('payroll/settings', <SettingsPage />)} />
      <Route path="me" element={ok('payroll/me', <MyPayslips />)} />
      <Route path="*" element={<Navigate to={`/backoffice/payroll/${home}`} replace />} />
    </Routes>
  );
}
