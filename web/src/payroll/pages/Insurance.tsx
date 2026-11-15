import { useState } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../../lib/format';
import { Badge, Empty, PageHeader, Spinner, Stat, Tabs, useAsync } from '../../components/ui';
import { ExportButtons } from '../../backoffice/widgets';
import { MONTHS, YearSelect, pr } from '../lib';

export default function Insurance() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState('');
  const [tab, setTab] = useState<'dept' | 'emp' | 'fixed'>('dept');
  const { data, loading } = useAsync(() => pr(`/reports/insurance?year=${year}${month ? `&month=${month}` : ''}`), [year, month]);
  const total = data?.by_department.reduce((s: number, d: any) => s + Number(d.caja), 0) || 0;
  const fixed = (data?.employees || []).filter((e: any) => e.monthly_amount !== null);
  return (
    <div>
      <PageHeader title="CAJA / insurance" subtitle={data ? `Payroll-period CAJA ${data.rules.caja_rate}% · fixed insurance (Seguro Fijo) ${data.rules.fixed_insurance_rate}% per month. Verify rates and contribution basis with CCSS before production.` : ''}
        actions={<><YearSelect value={year} onChange={setYear} /><select className="input w-auto py-1.5" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month"><option value="">Whole year</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></>} />
      {loading || !data ? <Spinner /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="CAJA withheld (approved payroll)" value={money(total)} />
            <Stat label="Insured employees" value={(data.employees as any[]).filter((e) => e.insurance_status === 'insured').length} />
            <Stat label="Not insured" value={(data.employees as any[]).filter((e) => e.insurance_status !== 'insured').length} />
            <Stat label="Fixed insurance per month" value={money(fixed.reduce((s: number, e: any) => s + e.monthly_amount, 0))} sub={`${fixed.length} employee(s)`} />
          </div>
          <Tabs value={tab} onChange={setTab} tabs={[{ id: 'dept', label: 'By department' }, { id: 'emp', label: 'Contribution summary' }, { id: 'fixed', label: 'Employee insurance (Seguro Fijo)' }]} />
          {tab === 'dept' && <Table rows={data.by_department} name="caja-by-department" cols={[['department', 'Department'], ['insured', 'Insured', 'n'], ['not_insured', 'Not insured', 'n'], ['base', 'Contribution base', 'm'], ['caja', 'CAJA', 'm']]} />}
          {tab === 'emp' && <Table rows={data.by_employee} name="caja-by-employee" cols={[['employee_name', 'Employee'], ['department_name', 'Department'], ['method', 'Method'], ['periods', 'Payrolls', 'n'], ['base', 'Contribution base', 'm'], ['caja', 'CAJA', 'm']]} />}
          {tab === 'fixed' && (
            <div className="card overflow-x-auto">
              <table className="table text-sm">
                <thead><tr><th>Employee</th><th>Department</th><th>Status</th><th>Method</th><th className="text-right">Insurance salary</th><th className="text-right">Monthly ({data.rules.fixed_insurance_rate}%)</th><th className="text-right">Quincenal</th></tr></thead>
                <tbody>{data.employees.map((e: any) => (
                  <tr key={e.id}><td><Link className="font-medium hover:underline" to={`/backoffice/payroll/employees/${e.id}`}>{e.full_name}</Link></td><td>{e.department_name}</td>
                    <td>{e.insurance_status === 'insured' ? <Badge color="green">Insured</Badge> : <Badge>Not insured</Badge>}</td><td>{e.insurance_status === 'insured' ? (e.insurance_method === 'fixed' ? 'Fixed salary' : `${data.rules.caja_rate}% of earnings`) : '—'}</td>
                    <td className="text-right tabular-nums">{e.insurance_salary ? money(e.insurance_salary) : '—'}</td><td className="text-right tabular-nums">{e.monthly_amount !== null ? money(e.monthly_amount) : '—'}</td><td className="text-right tabular-nums">{e.quincenal_amount !== null ? money(e.quincenal_amount) : '—'}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Table({ rows, cols, name }: { rows: any[]; cols: [string, string, ('m' | 'n')?][]; name: string }) {
  if (!rows.length) return <Empty>No approved payroll in this range</Empty>;
  return (
    <div>
      <div className="mb-2 flex justify-end"><ExportButtons name={name} rows={rows} cols={cols.map(([key, label]) => ({ key, label }))} /></div>
      <div className="card overflow-x-auto"><table className="table text-sm"><thead><tr>{cols.map(([k, l, t]) => <th key={k} className={t ? 'text-right' : ''}>{l}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{cols.map(([k, , t]) => <td key={k} className={t ? 'text-right tabular-nums' : ''}>{t === 'm' ? money(r[k]) : r[k]}</td>)}</tr>)}</tbody></table></div>
    </div>
  );
}
