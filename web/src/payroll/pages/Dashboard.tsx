import { useState } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../../lib/format';
import { PageHeader, Spinner, Stat, useAsync } from '../../components/ui';
import { Bars, ChartCard, HBars, MONTHS, PeriodBadge, YearSelect, pr, short } from '../lib';
import PosStaffPanel from './PosStaffPanel';

export default function Dashboard() {
  const [f, setF] = useState({ year: new Date().getFullYear(), month: '', period_id: '', department_id: '', employee_id: '', payment_status: '' });
  const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '').map(([k, v]) => [k, String(v)])).toString();
  const { data, loading } = useAsync(() => pr(`/dashboard?${q}`), [q]);
  const lookups = useAsync(async () => {
    const [periods, depts, emps, pending] = await Promise.all([pr<any[]>(`/periods?year=${f.year}`), pr<any[]>('/departments'), pr<any[]>('/employees?status=active'), pr('/pending')]);
    return { periods, depts, emps, pending };
  }, [f.year]);
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const L = lookups.data;
  const k = data?.kpi;
  const months = (data?.months || []).map((m: any) => ({ ...m, label: MONTHS[m.month - 1] }));

  return (
    <div>
      <PageHeader title="Payroll dashboard" subtitle={k?.current_period ? <>Latest payroll <Link className="text-brand-700 hover:underline dark:text-brand-400" to={`/backoffice/payroll/periods/${k.current_period.id}`}>{k.current_period.code} · {k.current_period.name}</Link> <PeriodBadge status={k.current_period.status} /></> : 'No payroll yet'} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <YearSelect value={f.year} onChange={(v) => setF({ ...f, year: v, period_id: '' })} />
        <select className="input w-auto py-1.5" value={f.month} onChange={(e) => set('month', e.target.value)} aria-label="Month"><option value="">All months</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
        <select className="input w-auto py-1.5" value={f.period_id} onChange={(e) => set('period_id', e.target.value)} aria-label="Payroll period"><option value="">All periods</option>{L?.periods.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select>
        <select className="input w-auto py-1.5" value={f.department_id} onChange={(e) => set('department_id', e.target.value)} aria-label="Department"><option value="">All departments</option>{L?.depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <select className="input w-auto py-1.5" value={f.employee_id} onChange={(e) => set('employee_id', e.target.value)} aria-label="Employee"><option value="">All employees</option>{L?.emps.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}</select>
        <select className="input w-auto py-1.5" value={f.payment_status} onChange={(e) => set('payment_status', e.target.value)} aria-label="Payment status"><option value="">Any payment status</option><option value="pending">Pending</option><option value="partial">Partial</option><option value="paid">Paid</option></select>
      </div>
      {L?.pending && Object.values(L.pending).some((n: any) => n > 0) && (
        <div className="mb-4 flex flex-wrap gap-2 text-sm">
          {L.pending.approvals > 0 && <Link to="/backoffice/payroll/periods" className="rounded-lg bg-sky-50 px-3 py-1.5 text-sky-800 dark:bg-sky-900/30 dark:text-sky-200">{L.pending.approvals} payroll(s) awaiting approval</Link>}
          {L.pending.advances > 0 && <Link to="/backoffice/payroll/advances" className="rounded-lg bg-amber-50 px-3 py-1.5 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">{L.pending.advances} advance request(s)</Link>}
          {L.pending.adjustments > 0 && <Link to="/backoffice/payroll/advances" className="rounded-lg bg-amber-50 px-3 py-1.5 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">{L.pending.adjustments} adjustment(s) to approve</Link>}
          {L.pending.overtime > 0 && <Link to="/backoffice/payroll/leave" className="rounded-lg bg-amber-50 px-3 py-1.5 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">{L.pending.overtime} overtime entr(ies) to approve</Link>}
          {L.pending.vacation > 0 && <Link to="/backoffice/payroll/leave" className="rounded-lg bg-amber-50 px-3 py-1.5 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">{L.pending.vacation} vacation request(s)</Link>}
        </div>
      )}
      <PosStaffPanel />
      {loading || !data ? <div className="flex justify-center py-20"><Spinner /></div> : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Active employees" value={k.active_employees} />
            <Stat label="Employees in payroll" value={k.employees} sub={`${k.periods} period(s)`} />
            <Stat label="Gross salary" value={money(k.gross)} />
            <Stat label="Total deductions" value={money(k.deductions)} sub={`CAJA ${money(k.caja)}`} />
            <Stat label="Net payable" value={money(k.net)} />
            <Stat label="Paid" value={money(k.paid)} />
            <Stat label="Pending payments" value={money(k.pending)} tone={k.pending > 0 ? 'down' : undefined} />
            <Stat label="Cash payments" value={money(k.cash_paid)} />
            <Stat label="Bank transfers" value={money(k.bank_paid)} sub={k.usd_paid ? `USD paid ${money(k.usd_paid)}` : undefined} />
            <Stat label="Payroll expense" value={money(k.payroll_expense)} sub="Earnings − CAJA" />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <ChartCard title={`Monthly payroll expense ${f.year}`} rows={months} cols={[{ key: 'label', label: 'Month' }, { key: 'payroll_expense', label: 'Payroll expense', num: true }]}>
              <Bars data={months} series={[{ key: 'payroll_expense', label: 'Payroll expense' }]} format={short} />
            </ChartCard>
            <ChartCard title="Gross vs net salary" rows={months} cols={[{ key: 'label', label: 'Month' }, { key: 'gross', label: 'Gross', num: true }, { key: 'net', label: 'Net', num: true }]}>
              <Bars data={months} series={[{ key: 'gross', label: 'Gross salary' }, { key: 'net', label: 'Net payable' }]} format={short} />
            </ChartCard>
            <ChartCard title="Payroll expense vs restaurant revenue" rows={months} cols={[{ key: 'label', label: 'Month' }, { key: 'payroll_expense', label: 'Payroll', num: true }, { key: 'revenue', label: 'Revenue', num: true }]}>
              <Bars data={months} series={[{ key: 'payroll_expense', label: 'Payroll expense' }, { key: 'revenue', label: 'Revenue' }]} format={short} />
            </ChartCard>
            <ChartCard title="Payroll expense as % of revenue" rows={months} cols={[{ key: 'label', label: 'Month' }, { key: 'labor_pct', label: 'Labour %', num: true }]} fmt={(n) => `${n}%`}>
              <Bars data={months.map((m: any) => ({ ...m, labor_pct: m.labor_pct ?? 0 }))} series={[{ key: 'labor_pct', label: 'Labour cost %' }]} format={(n) => `${Math.round(n * 10) / 10}%`} />
              {!months.some((m: any) => m.revenue) && <p className="mt-1 text-xs text-slate-400">Enter monthly revenue in Reports → Payroll vs revenue (or import it from POS sales).</p>}
            </ChartCard>
            <ChartCard title={`Monthly comparison ${f.year} vs ${f.year - 1}`} rows={months} cols={[{ key: 'label', label: 'Month' }, { key: 'payroll_expense', label: String(f.year), num: true }, { key: 'previous_year', label: String(f.year - 1), num: true }]}>
              <Bars data={months} series={[{ key: 'payroll_expense', label: String(f.year) }, { key: 'previous_year', label: String(f.year - 1) }]} format={short} />
            </ChartCard>
            <ChartCard title="Cash vs bank transfer payments" rows={data.payments_by_method} cols={[{ key: 'label', label: 'Method' }, { key: 'currency', label: 'Currency' }, { key: 'amount', label: 'Amount (CRC)', num: true }]}>
              <HBars data={data.payments_by_method.map((p: any) => ({ label: `${p.label}${p.currency === 'USD' ? ' (USD)' : ''}`, value: Number(p.amount), sub: `${p.n} payments` }))} />
            </ChartCard>
            <ChartCard title="Payroll expense by department" rows={data.by_department} cols={[{ key: 'department', label: 'Department' }, { key: 'employees', label: 'Employees' }, { key: 'payroll_expense', label: 'Payroll expense', num: true }]}>
              <HBars data={data.by_department.map((d: any) => ({ label: d.department, value: Number(d.payroll_expense), sub: `${d.employees} emp.` }))} />
            </ChartCard>
            <ChartCard title="Active employees by department" rows={data.headcount} cols={[{ key: 'department', label: 'Department' }, { key: 'employees', label: 'Employees' }]} fmt={String}>
              <HBars data={data.headcount.map((d: any) => ({ label: d.department, value: Number(d.employees) }))} format={(n) => String(n)} />
            </ChartCard>
          </div>
        </div>
      )}
    </div>
  );
}
