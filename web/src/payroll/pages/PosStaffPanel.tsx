import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Store, UserPlus } from 'lucide-react';
import { money, dateOnly, dt } from '../../lib/format';
import { Badge, Empty, SearchInput, Spinner, useAsync, useToast } from '../../components/ui';
import { useSession } from '../../backoffice/BackOffice';
import { ExportButtons } from '../../backoffice/widgets';
import { pr } from '../lib';
import PosStaff from './PosStaff';

/**
 * Payroll dashboard section: every POS employee with their details, live time-clock status, this month's hours and
 * POS sales, and whether they are in payroll. Data comes from the POS (users, time clock, sales).
 */
export default function PosStaffPanel() {
  const { can } = useSession();
  const { data, loading, reload } = useAsync(() => pr('/pos-staff'), []);
  const [q, setQ] = useState('');
  const [manage, setManage] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const toast = useToast();
  async function syncNow() {
    setSyncing(true);
    try {
      const r = await pr('/pos-sync', { body: {} });
      const s = r.staff;
      toast(`Synced · ${s.created.length} added, ${s.linked.length} linked, ${r.attendance.saved} attendance day(s) updated${s.errors.length ? ` · ${s.errors.length} issue(s): ${s.errors.join('; ')}` : ''}`, s.errors.length ? 'err' : 'ok');
      reload();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setSyncing(false);
    }
  }
  const staff: any[] = (data?.staff || []).filter((s: any) => !q || `${s.name} ${s.employee_code || ''} ${s.role_name || ''} ${s.designation || ''} ${s.email || ''} ${s.phone || ''}`.toLowerCase().includes(q.toLowerCase()));
  const all: any[] = data?.staff || [];
  const onShift = all.filter((s) => s.on_shift_since).length;
  const notLinked = all.filter((s) => !s.employee_id && s.active).length;
  const cols = [
    { key: 'name', label: 'Employee' }, { key: 'employee_code', label: 'Code' }, { key: 'role_name', label: 'POS role' }, { key: 'designation', label: 'Position' },
    { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' }, { key: 'joined_on', label: 'Joined' }, { key: 'month_days', label: 'Days (month)' },
    { key: 'month_hours', label: 'Hours (month)' }, { key: 'month_receipts', label: 'Receipts (month)' }, { key: 'month_sales', label: 'POS sales (month)' },
    { key: 'payroll_code', label: 'Payroll code' },
  ];

  return (
    <div className="card mb-5 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4 dark:border-slate-800">
        <div>
          <div className="flex items-center gap-2 font-semibold"><Store size={18} />POS staff</div>
          <div className="text-sm text-slate-500">
            {all.length} employees · <b className="text-emerald-600">{onShift}</b> on shift now · this month's hours and sales from the POS
            {notLinked > 0 && <> · <b className="text-amber-600">{notLinked}</b> not in payroll</>}
          </div>
          <div className="text-xs text-slate-400">Linked automatically: new POS staff join payroll, POS clock-ins become attendance and POS sales feed revenue.</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={q} onChange={setQ} placeholder="Search staff" className="w-48" />
          <ExportButtons name="pos-staff" rows={staff} cols={cols} />
          {can('payroll.employees') && <button className="btn-secondary" disabled={syncing} onClick={syncNow}><RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />Sync now</button>}
          {can('payroll.employees') && <button className="btn-secondary" onClick={() => setManage(true)}><UserPlus size={16} />Link manually</button>}
        </div>
      </div>
      <div className="overflow-x-auto">
        {loading && !data ? <div className="flex justify-center py-8"><Spinner /></div> : !staff.length ? <Empty>No POS staff</Empty> : (
          <table className="table text-sm">
            <thead>
              <tr>
                <th>Employee</th><th>POS role</th><th>Contact</th><th>Status</th>
                <th className="text-right">Days</th><th className="text-right">Hours</th><th className="text-right">POS sales</th>
                {data.can_see_pay && <th className="text-right">Rate</th>}<th>Payroll</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id} className={!s.active ? 'opacity-60' : ''}>
                  <td>
                    <div className="font-medium">{s.name}</div>
                    <div className="text-xs text-slate-400">{[s.employee_code, s.designation, s.joined_on && `since ${dateOnly(s.joined_on)}`].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="text-xs">{s.is_owner ? 'Owner' : s.role_name || '—'}</td>
                  <td className="text-xs">{s.phone || '—'}<div className="text-slate-400">{s.email}</div></td>
                  <td className="text-xs">
                    {!s.active ? <Badge>Inactive</Badge> : s.on_shift_since ? <Badge color="green">On shift</Badge> : <Badge>Off</Badge>}
                    <div className="mt-0.5 text-slate-400">{s.on_shift_since ? `since ${dt(s.on_shift_since)}` : s.last_clock_in ? `last ${dt(s.last_clock_in)}` : 'never clocked in'}</div>
                  </td>
                  <td className="text-right tabular-nums">{s.month_days}</td>
                  <td className="text-right tabular-nums">{s.month_hours}</td>
                  <td className="text-right tabular-nums">{s.month_receipts ? <>{money(s.month_sales)}<div className="text-xs text-slate-400">{s.month_receipts} receipts</div></> : <span className="text-slate-400">—</span>}</td>
                  {data.can_see_pay && <td className="text-right text-xs tabular-nums">{Number(s.hourly_rate) > 0 ? `${money(s.hourly_rate)}/h` : Number(s.salary) > 0 ? `${money(s.salary)}/mo` : <span className="text-amber-600">not set</span>}</td>}
                  <td>
                    {s.employee_id
                      ? <Link to={`/backoffice/payroll/employees/${s.employee_id}`} className="inline-flex items-center gap-1.5 whitespace-nowrap hover:underline"><Badge color="green">In payroll</Badge><span className="text-xs">{s.payroll_code}</span></Link>
                      : <span className="whitespace-nowrap"><Badge color="amber">Not in payroll</Badge></span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {manage && <PosStaff onClose={() => { setManage(false); reload(); }} />}
    </div>
  );
}
