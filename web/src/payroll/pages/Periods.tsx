import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { money, dateOnly } from '../../lib/format';
import { Empty, Field, Modal, PageHeader, Spinner, Toggle, useAsync, useToast } from '../../components/ui';
import { useSession } from '../../backoffice/BackOffice';
import { PeriodBadge, YearSelect, d10, errMsg, pr } from '../lib';

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

export default function Periods() {
  const { can } = useSession();
  const nav = useNavigate();
  const [year, setYear] = useState(new Date().getFullYear());
  const { data, loading } = useAsync(() => pr<any[]>(`/periods?year=${year}`), [year]);
  const [creating, setCreating] = useState(false);
  return (
    <div>
      <PageHeader title="Payroll periods" subtitle="Flexible periods (e.g. 23 Oct – 5 Nov). Approved periods are locked."
        actions={<><YearSelect value={year} onChange={setYear} />{can('payroll.process') && <button className="btn-primary" onClick={() => setCreating(true)}><Plus size={16} />New payroll</button>}</>} />
      <div className="card overflow-x-auto">
        {loading ? <div className="flex justify-center py-10"><Spinner /></div> : !data?.length ? <Empty>No payroll periods in {year}</Empty> : (
          <table className="table">
            <thead><tr><th>Payroll</th><th>Dates</th><th>Status</th><th className="text-right">Employees</th><th className="text-right">Gross</th><th className="text-right">Deductions</th><th className="text-right">Payroll expense</th><th className="text-right">Net payable</th><th className="text-right">Paid</th></tr></thead>
            <tbody>{data.map((p) => (
              <tr key={p.id} className="cursor-pointer" onClick={() => nav(`/backoffice/payroll/periods/${p.id}`)}>
                <td><Link to={`/backoffice/payroll/periods/${p.id}`} className="font-medium hover:underline">{p.code}</Link><div className="text-xs text-slate-400">{p.name}{p.kind === 'special' ? ' · special' : ''}</div></td>
                <td className="text-xs">{dateOnly(p.start_date)} – {dateOnly(p.end_date)}{p.pay_date && <div className="text-slate-400">Pay {dateOnly(p.pay_date)}</div>}</td>
                <td><PeriodBadge status={p.status} />{p.records_with_errors > 0 && <div className="mt-0.5 text-xs text-rose-600">{p.records_with_errors} with errors</div>}</td>
                <td className="text-right">{p.employees}</td>
                <td className="text-right tabular-nums">{money(p.gross)}</td>
                <td className="text-right tabular-nums">{money(p.total_deductions)}</td>
                <td className="text-right tabular-nums">{money(p.payroll_expense)}</td>
                <td className="text-right font-medium tabular-nums">{money(p.net_payable)}</td>
                <td className="text-right tabular-nums">{money(p.paid)}{p.pending > 0 && ['approved', 'partially_paid'].includes(p.status) && <div className="text-xs text-amber-600">{money(p.pending)} pending</div>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {creating && <CreatePeriod last={data?.[0]} onClose={() => setCreating(false)} onCreated={(id) => nav(`/backoffice/payroll/periods/${id}`)} />}
    </div>
  );
}

function CreatePeriod({ last, onClose, onCreated }: { last?: any; onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const start = last ? addDays(d10(last.end_date), 1) : addDays(new Date().toISOString().slice(0, 10), -13);
  const [p, setP] = useState<any>({ start_date: start, end_date: addDays(start, 13), pay_date: addDays(start, 14), name: '', department_ids: [], employee_ids: [], load_attendance: true, kind: 'regular', mode: 'departments' });
  const depts = useAsync(() => pr<any[]>('/departments'), []);
  const emps = useAsync(() => pr<any[]>('/employees?status=active'), []);
  const [busy, setBusy] = useState(false);
  const toggle = (k: 'department_ids' | 'employee_ids', id: string) => setP({ ...p, [k]: p[k].includes(id) ? p[k].filter((x: string) => x !== id) : [...p[k], id] });
  async function create() {
    setBusy(true);
    try {
      const body = { ...p, department_ids: p.mode === 'departments' ? p.department_ids : [], employee_ids: p.mode === 'employees' ? p.employee_ids : [] };
      const r = await pr('/periods', { body });
      toast(`Payroll ${r.code} created`);
      onCreated(r.id);
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  const quincena = (half: 1 | 2) => {
    const d = new Date(p.start_date + 'T12:00:00Z');
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    const s = half === 1 ? new Date(Date.UTC(y, m, 1)) : new Date(Date.UTC(y, m, 16));
    const e = half === 1 ? new Date(Date.UTC(y, m, 15)) : new Date(Date.UTC(y, m + 1, 0));
    setP({ ...p, start_date: s.toISOString().slice(0, 10), end_date: e.toISOString().slice(0, 10), pay_date: e.toISOString().slice(0, 10) });
  };
  return (
    <Modal open onClose={onClose} size="lg" title="New payroll period" footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy} onClick={create}>Create draft payroll</button></>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Start date"><input type="date" className="input" value={p.start_date} onChange={(e) => setP({ ...p, start_date: e.target.value })} /></Field>
          <Field label="End date"><input type="date" className="input" value={p.end_date} onChange={(e) => setP({ ...p, end_date: e.target.value })} /></Field>
          <Field label="Pay date"><input type="date" className="input" value={p.pay_date} onChange={(e) => setP({ ...p, pay_date: e.target.value })} /></Field>
          <Field label="Type"><select className="input" value={p.kind} onChange={(e) => setP({ ...p, kind: e.target.value })}><option value="regular">Regular</option><option value="special">Special / off-cycle</option></select></Field>
          <Field label="Name" className="sm:col-span-2" hint="Blank = dates, e.g. 23 Oct – 5 Nov 2026"><input className="input" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
          <div className="flex items-end gap-1 pb-0.5 sm:col-span-2">
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setP({ ...p, end_date: addDays(p.start_date, 13), pay_date: addDays(p.start_date, 14) })}>14 days</button>
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => quincena(1)}>1st–15th</button>
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => quincena(2)}>16th–end</button>
          </div>
        </div>
        <div>
          <div className="mb-2 flex gap-4 text-sm">
            {[['departments', 'By department'], ['employees', 'Select employees']].map(([k, l]) => <label key={k} className="flex items-center gap-1.5"><input type="radio" checked={p.mode === k} onChange={() => setP({ ...p, mode: k })} />{l}</label>)}
          </div>
          {p.mode === 'departments' ? (
            <div className="flex flex-wrap gap-2">
              {depts.data?.filter((d) => d.active).map((d) => <button key={d.id} type="button" onClick={() => toggle('department_ids', d.id)} className={`rounded-full border px-3 py-1 text-sm ${p.department_ids.includes(d.id) ? 'border-brand-600 bg-brand-50 text-brand-800 dark:bg-brand-900/30 dark:text-brand-200' : 'border-slate-300 dark:border-slate-700'}`}>{d.name} <span className="text-xs text-slate-400">{d.active_employees}</span></button>)}
              <p className="w-full text-xs text-slate-400">{p.department_ids.length ? `${p.department_ids.length} department(s)` : 'No selection = all active employees'}</p>
            </div>
          ) : (
            <div className="max-h-60 overflow-y-auto rounded-lg border border-slate-200 p-2 dark:border-slate-700">
              {emps.data?.map((e) => <label key={e.id} className="flex items-center gap-2 py-0.5 text-sm"><input type="checkbox" checked={p.employee_ids.includes(e.id)} onChange={() => toggle('employee_ids', e.id)} />{e.full_name}<span className="text-xs text-slate-400">{e.department_name}</span></label>)}
            </div>
          )}
        </div>
        <Toggle checked={p.load_attendance} onChange={(v) => setP({ ...p, load_attendance: v })} label="Load working hours from attendance" />
        <p className="text-xs text-slate-500">Salaries are taken from each employee's salary history effective on the end date, and the payroll rules version effective on that date is stored with the payroll.</p>
      </div>
    </Modal>
  );
}
