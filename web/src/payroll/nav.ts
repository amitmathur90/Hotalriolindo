import {
  LayoutDashboard, Users, Network, CalendarClock, CalendarRange, HandCoins, Palmtree, ShieldPlus, Gift, Banknote, FileText, BarChart3, Scale, Settings, UserRound,
} from 'lucide-react';

/** Sidebar of the Payroll Management area (PRD §5). An item shows when the user has any of its permissions. */
export const PAYROLL_NAV = [
  { to: 'payroll', label: 'Dashboard', icon: LayoutDashboard, perms: ['payroll.access', 'payroll.reports'] },
  { to: 'payroll/employees', label: 'Employees', icon: Users, perms: ['payroll.employees', 'payroll.access', 'payroll.attendance'] },
  { to: 'payroll/departments', label: 'Departments & positions', icon: Network, perms: ['payroll.settings', 'payroll.employees', 'payroll.access'] },
  { to: 'payroll/attendance', label: 'Attendance & hours', icon: CalendarClock, perms: ['payroll.attendance', 'payroll.process'] },
  { to: 'payroll/periods', label: 'Payroll periods', icon: CalendarRange, perms: ['payroll.access', 'payroll.process', 'payroll.approve', 'payroll.payments'] },
  { to: 'payroll/advances', label: 'Advances & deductions', icon: HandCoins, perms: ['payroll.advances', 'payroll.process', 'payroll.access'] },
  { to: 'payroll/leave', label: 'Overtime, holidays & vacation', icon: Palmtree, perms: ['payroll.attendance', 'payroll.process', 'payroll.employees', 'payroll.access'] },
  { to: 'payroll/insurance', label: 'CAJA / insurance', icon: ShieldPlus, perms: ['payroll.reports', 'payroll.access'] },
  { to: 'payroll/aguinaldo', label: 'Aguinaldo', icon: Gift, perms: ['payroll.process', 'payroll.access'] },
  { to: 'payroll/payments', label: 'Payments', icon: Banknote, perms: ['payroll.payments', 'payroll.access'] },
  { to: 'payroll/payslips', label: 'Payslips & email', icon: FileText, perms: ['payroll.process', 'payroll.payments', 'payroll.access'] },
  { to: 'payroll/reports', label: 'Reports & analytics', icon: BarChart3, perms: ['payroll.reports', 'payroll.access'] },
  { to: 'payroll/reconciliation', label: 'Accounting reconciliation', icon: Scale, perms: ['payroll.reports', 'payroll.access'] },
  { to: 'payroll/settings', label: 'Settings & audit log', icon: Settings, perms: ['payroll.settings', 'payroll.salary', 'payroll.access'] },
  { to: 'payroll/me', label: 'My payslips', icon: UserRound, perms: ['payroll.self'] },
];
export const hasPayroll = (can: (p: string) => boolean) => PAYROLL_NAV.some((n) => n.perms.some(can));
