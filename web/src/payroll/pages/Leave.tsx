import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { Badge, Empty, Field, Modal, PageHeader, Spinner, Tabs, Toggle, useAsync, useToast } from '../../components/ui';
import { useSession } from '../../backoffice/BackOffice';
import { ExportButtons } from '../../backoffice/widgets';
import { ReqBadge, YearSelect, d10, errMsg, num, pr, today } from '../lib';

export default function Leave() {
  const [tab, setTab] = useState<'ot' | 'hol' | 'bal' | 'req'>('ot');
  return (
    <div>
      <PageHeader title="Overtime, holidays & vacation" subtitle="Overtime is paid only after approval. Vacation balances are kept independently of payroll periods." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'ot', label: 'Overtime approval' }, { id: 'hol', label: 'Holiday calendar' }, { id: 'bal', label: 'Vacation balances' }, { id: 'req', label: 'Vacation requests' }]} />
      {tab === 'ot' && <Overtime />}
      {tab === 'hol' && <Holidays />}
      {tab === 'bal' && <Balances />}
      {tab === 'req' && <Requests />}
    </div>
  );
}

function Overtime() {
  const toast = useToast();
  const { can } = useSession();
  const t = today();
  const [r, setR] = useState({ from: new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10), to: t, pending: true });
  const { data, loading, reload } = useAsync(() => pr<any[]>(`/overtime?from=${r.from}&to=${r.to}${r.pending ? '&pending=1' : ''}`), [r]);
  const [sel, setSel] = useState<string[]>([]);
  async function approve(approved: boolean) {
    try { const x = await pr('/attendance/approve-overtime', { body: { ids: sel, approved } }); toast(`${x.updated} updated. Reload hours in open payrolls to apply.`); setSel([]); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  const canApprove = can('payroll.process') || can('payroll.approve');
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input type="date" className="input w-auto py-1.5" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} aria-label="From" />
        <input type="date" className="input w-auto py-1.5" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} aria-label="To" />
        <Toggle checked={r.pending} onChange={(v) => setR({ ...r, pending: v })} label="Pending only" />
        {canApprove && sel.length > 0 && <><button className="btn-primary" onClick={() => approve(true)}>Approve {sel.length}</button><button className="btn-secondary" onClick={() => approve(false)}>Unapprove</button></>}
      </div>
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !data?.length ? <Empty>No overtime in this range</Empty> : (
          <table className="table text-sm">
            <thead><tr>{canApprove && <th className="w-8"><input type="checkbox" aria-label="Select all" onChange={(e) => setSel(e.target.checked ? data.map((x) => x.id) : [])} /></th>}<th>Date</th><th>Employee</th><th>Department</th><th className="text-right">Regular h</th><th className="text-right">Overtime h</th><th>Remarks</th><th>Status</th></tr></thead>
            <tbody>{data.map((a) => (
              <tr key={a.id}>{canApprove && <td><input type="checkbox" aria-label={a.full_name} checked={sel.includes(a.id)} onChange={() => setSel(sel.includes(a.id) ? sel.filter((x) => x !== a.id) : [...sel, a.id])} /></td>}
                <td>{d10(a.work_date)}</td><td className="font-medium">{a.full_name}</td><td>{a.department_name}</td><td className="text-right">{num(a.regular_hours)}</td><td className="text-right font-medium">{num(a.overtime_hours)}</td><td className="text-xs">{a.remarks}</td>
                <td>{a.overtime_approved ? <Badge color="green">Approved</Badge> : <Badge color="amber">Pending</Badge>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Holidays() {
  const toast = useToast();
  const { can } = useSession();
  const [year, setYear] = useState(new Date().getFullYear());
  const { data, loading, reload } = useAsync(() => pr<any[]>(`/holidays?year=${year}`), [year]);
  const [n, setN] = useState<any>(null);
  const edit = can('payroll.settings');
  async function save() {
    try { await pr('/holidays', { body: n }); setN(null); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function del(h: any) { await pr(`/holidays/${h.id}`, { method: 'DELETE' }); reload(); }
  async function seed() {
    try { await pr('/holidays/seed', { body: { year } }); reload(); toast('Costa Rica holidays added'); } catch (e) { toast(errMsg(e), 'err'); }
  }
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <YearSelect value={year} onChange={setYear} />
        {edit && <><button className="btn-secondary" onClick={seed}>Add Costa Rica holidays for {year}</button><button className="btn-primary ml-auto" onClick={() => setN({ holiday_date: `${year}-01-01`, name: '', paid: true })}><Plus size={16} />Add holiday</button></>}
      </div>
      <p className="mb-2 text-xs text-slate-500">Verify dates each year (some holidays move to Monday). Holiday pay is entered on the payroll (hours for hourly staff, days for monthly staff) and calculated with the configured method.</p>
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !data?.length ? <Empty>No holidays for {year}</Empty> : (
          <table className="table text-sm">
            <thead><tr><th>Date</th><th>Day</th><th>Holiday</th><th>Payment</th><th /></tr></thead>
            <tbody>{data.map((h) => (
              <tr key={h.id}><td>{d10(h.holiday_date)}</td><td>{new Date(d10(h.holiday_date) + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' })}</td><td className="font-medium">{h.name}</td>
                <td>{h.paid ? <Badge color="green">Pago obligatorio</Badge> : <Badge>No obligatorio</Badge>}</td>
                <td>{edit && <button className="btn-ghost p-1 text-rose-600" onClick={() => del(h)} aria-label="Delete"><Trash2 size={14} /></button>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!n} onClose={() => setN(null)} size="sm" title="Holiday" footer={<><button className="btn-secondary" onClick={() => setN(null)}>Cancel</button><button className="btn-primary" onClick={save}>Save</button></>}>
        {n && <div className="grid gap-3">
          <Field label="Date"><input type="date" className="input" value={n.holiday_date} onChange={(e) => setN({ ...n, holiday_date: e.target.value })} /></Field>
          <Field label="Name"><input className="input" value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} /></Field>
          <Toggle checked={n.paid} onChange={(v) => setN({ ...n, paid: v })} label="Paid holiday (pago obligatorio)" />
        </div>}
      </Modal>
    </div>
  );
}

function Balances() {
  const { data, loading } = useAsync(() => pr<any[]>('/vacation/balances'), []);
  const cols = [{ key: 'full_name', label: 'Employee' }, { key: 'department_name', label: 'Department' }, { key: 'joining_date', label: 'Joined' }, { key: 'months_worked', label: 'Months' }, { key: 'opening', label: 'Opening' }, { key: 'earned', label: 'Earned' }, { key: 'adjustments', label: 'Adjustments' }, { key: 'used', label: 'Taken / paid' }, { key: 'balance', label: 'Balance' }];
  return (
    <div>
      <div className="mb-2 flex justify-end"><ExportButtons name="vacation-balances" rows={data || []} cols={cols} /></div>
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !data?.length ? <Empty /> : (
          <table className="table text-sm">
            <thead><tr>{cols.map((c) => <th key={c.key} className={['full_name', 'department_name', 'joining_date'].includes(c.key) ? '' : 'text-right'}>{c.label}</th>)}</tr></thead>
            <tbody>{data.map((b) => (
              <tr key={b.employee_id}><td><Link className="font-medium hover:underline" to={`/backoffice/payroll/employees/${b.employee_id}`}>{b.full_name}</Link></td><td>{b.department_name}</td><td>{d10(b.joining_date)}</td>
                {['months_worked', 'opening', 'earned', 'adjustments', 'used'].map((k) => <td key={k} className="text-right tabular-nums">{num(b[k])}</td>)}
                <td className={`text-right font-semibold tabular-nums ${b.balance < 0 ? 'text-rose-600' : ''}`}>{num(b.balance)} d</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500">Earned = complete months since joining × vacation days per month (payroll rules). Opening balances and corrections are set on each employee.</p>
    </div>
  );
}

function Requests() {
  const toast = useToast();
  const { can } = useSession();
  const [status, setStatus] = useState('');
  const { data, loading, reload } = useAsync(() => pr<any[]>(`/vacation-requests${status ? `?status=${status}` : ''}`), [status]);
  const emps = useAsync(() => pr<any[]>('/employees?status=active'), []);
  const [n, setN] = useState<any>(null);
  async function create() {
    try { const r = await pr('/vacation-requests', { body: n }); toast(`Request saved (balance ${r.balance} d)`); setN(null); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function decide(v: any, approve: boolean) {
    try { await pr(`/vacation-requests/${v.id}/decision`, { body: { approve } }); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function cancel(v: any) {
    if (!confirm('Cancel this request? Approved days are returned to the balance.')) return;
    await pr(`/vacation-requests/${v.id}/cancel`, { body: {} }); reload();
  }
  const canDecide = can('payroll.employees') || can('payroll.approve');
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <select className="input w-auto py-1.5" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">All</option><option value="requested">Requested</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select>
        <button className="btn-primary ml-auto" onClick={() => setN({ employee_id: '', start_date: today(), end_date: today(), days: '', notes: '' })}><Plus size={16} />New request</button>
      </div>
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !data?.length ? <Empty>No vacation requests</Empty> : (
          <table className="table text-sm">
            <thead><tr><th>Employee</th><th>From</th><th>To</th><th className="text-right">Days</th><th>Notes</th><th>Status</th><th /></tr></thead>
            <tbody>{data.map((v) => (
              <tr key={v.id}><td className="font-medium">{v.full_name}<div className="text-xs text-slate-400">{v.department_name}</div></td><td>{d10(v.start_date)}</td><td>{d10(v.end_date)}</td><td className="text-right">{num(v.days)}</td><td className="text-xs">{v.notes}</td>
                <td><ReqBadge status={v.status} />{v.approved_by_name && <div className="text-[10px] text-slate-400">{v.approved_by_name}</div>}</td>
                <td className="text-right whitespace-nowrap">{v.status === 'requested' && canDecide && <><button className="btn-ghost px-2 py-1 text-xs text-emerald-700" onClick={() => decide(v, true)}>Approve</button><button className="btn-ghost px-2 py-1 text-xs text-rose-600" onClick={() => decide(v, false)}>Reject</button></>}
                  {['requested', 'approved'].includes(v.status) && canDecide && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => cancel(v)}>Cancel</button>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!n} onClose={() => setN(null)} title="Vacation request" footer={<><button className="btn-secondary" onClick={() => setN(null)}>Cancel</button><button className="btn-primary" onClick={create}>Save</button></>}>
        {n && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Employee" className="sm:col-span-2"><select className="input" value={n.employee_id} onChange={(e) => setN({ ...n, employee_id: e.target.value })}><option value="">—</option>{emps.data?.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}</select></Field>
          <Field label="From"><input type="date" className="input" value={n.start_date} onChange={(e) => setN({ ...n, start_date: e.target.value })} /></Field>
          <Field label="To"><input type="date" className="input" value={n.end_date} onChange={(e) => setN({ ...n, end_date: e.target.value })} /></Field>
          <Field label="Working days" hint="Blank = calendar days in the range"><input type="number" step="0.5" className="input" value={n.days} onChange={(e) => setN({ ...n, days: e.target.value })} /></Field>
          <Field label="Notes"><input className="input" value={n.notes} onChange={(e) => setN({ ...n, notes: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}
