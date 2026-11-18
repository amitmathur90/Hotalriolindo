import { useMemo, useState } from 'react';
import { Link2, Unlink, UserPlus } from 'lucide-react';
import { money, dateOnly } from '../../lib/format';
import { Badge, Empty, Field, Modal, Spinner, useAsync, useToast } from '../../components/ui';
import { errMsg, pr } from '../lib';

/**
 * Bring POS staff into payroll: create payroll employees from POS users, or link an existing payroll employee to its POS user.
 * Linked employees get attendance from the POS time clock and see their payslips with their POS login.
 */
export default function PosStaff({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { data, loading, reload } = useAsync(() => pr('/pos-staff'), []);
  const depts = useAsync(() => pr<any[]>('/departments'), []);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [deptFor, setDeptFor] = useState<Record<string, string>>({});
  const [linkTo, setLinkTo] = useState<Record<string, string>>({});
  const [defDept, setDefDept] = useState('');
  const [payment, setPayment] = useState('transfer');
  const [busy, setBusy] = useState(false);

  const staff: any[] = data?.staff || [];
  const unlinked: any[] = data?.unlinked_employees || [];
  const open = useMemo(() => staff.filter((s) => !s.employee_id), [staff]);
  const chosen = open.filter((s) => sel[s.id]);
  const linkedCount = staff.length - open.length;

  async function importSelected() {
    if (!chosen.length) return;
    setBusy(true);
    try {
      const r = await pr('/pos-staff/import', { body: { items: chosen.map((s) => ({ user_id: s.id, department_id: deptFor[s.id] ?? defDept ?? null, payment_method: payment })) } });
      const parts = [`${r.created.length} employee(s) added to payroll`];
      if (r.skipped.length) parts.push(`${r.skipped.length} skipped: ${r.skipped.map((x: any) => `${x.name} (${x.reason})`).join('; ')}`);
      if (r.without_salary.length) parts.push(`set the salary for: ${r.without_salary.join(', ')}`);
      toast(parts.join(' · '), r.skipped.length ? 'err' : 'ok');
      setSel({}); reload();
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  async function link(userId: string, employeeId: string | null) {
    try {
      if (employeeId) await pr('/pos-staff/link', { body: { employee_id: employeeId, user_id: userId } });
      toast('Linked'); reload();
    } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function unlink(s: any) {
    if (!confirm(`Unlink ${s.payroll_name} from POS user ${s.name}? Payroll data is kept; only the POS time clock and self-service login stop.`)) return;
    try { await pr('/pos-staff/link', { body: { employee_id: s.employee_id, user_id: null } }); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  const close = onClose;

  return (
    <Modal open onClose={close} size="xl" title="POS staff → Payroll"
      footer={<>
        <button className="btn-secondary" onClick={close}>Close</button>
        <button className="btn-primary" disabled={!chosen.length || busy} onClick={importSelected}><UserPlus size={16} />Add {chosen.length || ''} to payroll</button>
      </>}>
      {loading || !data ? <div className="flex justify-center py-10"><Spinner /></div> : !staff.length ? <Empty>No POS staff found. Add staff under Back Office → Employees first.</Empty> : (
        <div className="space-y-3">
          <p className="text-sm text-slate-500">
            {staff.length} POS staff · <b>{linkedCount}</b> linked to payroll · <b>{open.length}</b> not in payroll.
            Adding takes name, e-mail, phone, employee ID, joining date, position and salary from the POS record. A linked employee's attendance can be loaded from the POS time clock, and they see their payslips with their POS login.
          </p>
          {!!open.length && (
            <div className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-3 dark:bg-slate-800/50">
              <Field label="Department for new employees"><select className="input" value={defDept} onChange={(e) => setDefDept(e.target.value)}><option value="">— choose later —</option>{depts.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
              <Field label="Payment method"><select className="input" value={payment} onChange={(e) => setPayment(e.target.value)}><option value="transfer">Bank transfer</option><option value="cash">Cash</option><option value="sinpe">SINPE Móvil</option><option value="usd">USD</option></select></Field>
              <div className="flex items-end gap-2 pb-1">
                <button className="btn-ghost text-xs" onClick={() => setSel(Object.fromEntries(open.filter((s) => s.active && !s.suggested_employee_id).map((s) => [s.id, true])))}>Select all active</button>
                <button className="btn-ghost text-xs" onClick={() => setSel({})}>Clear</button>
              </div>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="table text-sm">
              <thead><tr><th /><th>POS staff</th><th>Role</th>{data.can_see_pay && <th className="text-right">POS salary</th>}<th>Joined</th><th>Payroll</th></tr></thead>
              <tbody>{staff.map((s) => (
                <tr key={s.id} className={!s.active ? 'opacity-60' : ''}>
                  <td>{!s.employee_id && <input type="checkbox" aria-label={`Add ${s.name}`} checked={!!sel[s.id]} onChange={(e) => setSel({ ...sel, [s.id]: e.target.checked })} />}</td>
                  <td><div className="font-medium">{s.name} {!s.active && <Badge>Inactive in POS</Badge>}</div><div className="text-xs text-slate-400">{[s.employee_code, s.designation, s.email].filter(Boolean).join(' · ')}</div></td>
                  <td className="text-xs">{s.is_owner ? 'Owner' : s.role_name || '—'}</td>
                  {data.can_see_pay && <td className="text-right tabular-nums">{Number(s.hourly_rate) > 0 ? <>{money(s.hourly_rate)}<span className="text-xs text-slate-400"> /h</span></> : Number(s.salary) > 0 ? <>{money(s.salary)}<span className="text-xs text-slate-400"> /mo</span></> : <span className="text-xs text-amber-600">not set</span>}</td>}
                  <td className="text-xs">{s.joined_on ? dateOnly(s.joined_on) : '—'}</td>
                  <td>
                    {s.employee_id ? (
                      <div className="flex items-center gap-2"><Badge color="green">Linked</Badge><span className="text-xs">{s.payroll_name} · {s.payroll_code}</span>
                        <button className="btn-ghost p-1 text-slate-400" onClick={() => unlink(s)} aria-label="Unlink" title="Unlink"><Unlink size={13} /></button></div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        {sel[s.id] && <select className="input w-auto py-1 text-xs" value={deptFor[s.id] ?? defDept} onChange={(e) => setDeptFor({ ...deptFor, [s.id]: e.target.value })} aria-label="Department"><option value="">No department</option>{depts.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>}
                        {!sel[s.id] && !!unlinked.length && <>
                          <select className="input w-auto py-1 text-xs" value={linkTo[s.id] ?? s.suggested_employee_id ?? ''} onChange={(e) => setLinkTo({ ...linkTo, [s.id]: e.target.value })} aria-label="Existing payroll employee">
                            <option value="">Link to existing…</option>{unlinked.map((e) => <option key={e.id} value={e.id}>{e.full_name} ({e.code})</option>)}
                          </select>
                          {(linkTo[s.id] ?? s.suggested_employee_id) && <button className="btn-secondary px-2 py-1 text-xs" onClick={() => link(s.id, linkTo[s.id] ?? s.suggested_employee_id)}><Link2 size={13} />Link</button>}
                          {s.suggested_employee_id && linkTo[s.id] === undefined && <Badge color="blue">Likely match</Badge>}
                        </>}
                        {!sel[s.id] && !unlinked.length && <Badge color="amber">Not in payroll</Badge>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
