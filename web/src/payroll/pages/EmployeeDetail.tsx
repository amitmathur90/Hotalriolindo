import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Plus, Trash2, Download, FileText } from 'lucide-react';
import { money, dateOnly, dt } from '../../lib/format';
import { Badge, Empty, Field, Modal, Spinner, Tabs, useAsync, useToast } from '../../components/ui';
import { useSession } from '../../backoffice/BackOffice';
import { EmployeeForm, STATUS_BADGE } from './Employees';
import { PayBadge, PeriodBadge, ReqBadge, d10, errMsg, num, openPdf, pr, today } from '../lib';

export default function EmployeeDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const { data: e, loading, reload } = useAsync(() => pr(`/employees/${id}`), [id]);
  const hist = useAsync(() => (can('payroll.access') || can('payroll.process') || can('payroll.salary') ? pr(`/employees/${id}/history`) : Promise.resolve(null)), [id]);
  const [tab, setTab] = useState('overview');
  const [edit, setEdit] = useState(false);
  if (loading || !e) return <div className="flex justify-center py-20"><Spinner /></div>;
  const H = hist.data;
  const tabs = [
    { id: 'overview', label: 'Profile' },
    ...(!e.pay_hidden ? [{ id: 'salary', label: 'Salary history' }] : []),
    ...(H ? [{ id: 'payroll', label: 'Payroll history' }, { id: 'advances', label: 'Advances' }, { id: 'vacation', label: 'Vacation' }, { id: 'bonus', label: 'Aguinaldo' }, { id: 'payments', label: 'Payments' }] : []),
    { id: 'documents', label: `Documents (${e.documents.length})` },
    { id: 'changes', label: 'Change history' },
  ];
  return (
    <div>
      <Link to="/backoffice/payroll/employees" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft size={14} />Employees</Link>
      <div className="card mb-4 flex flex-wrap items-center gap-4 p-4">
        {e.photo_url ? <img src={e.photo_url} className="h-16 w-16 rounded-full object-cover" alt="" /> : <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-50 text-xl font-semibold text-brand-700 dark:bg-brand-900/30">{e.full_name[0]}</div>}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold">{e.full_name}</h1>{STATUS_BADGE[e.status]}</div>
          <div className="text-sm text-slate-500">{e.code} · Cédula {e.cedula || '—'} · {e.department_name || 'No department'}{e.position_name ? ` · ${e.position_name}` : ''}</div>
        </div>
        {!e.pay_hidden && <div className="text-right"><div className="text-xs text-slate-500">Current salary</div><div className="text-lg font-semibold tabular-nums">{e.salary_type === 'hourly' ? `${money(e.hourly_rate)} / h` : e.monthly_salary ? `${money(e.monthly_salary)} / month` : '—'}</div>{e.salary_from && <div className="text-xs text-slate-400">since {dateOnly(e.salary_from)}</div>}</div>}
        {can('payroll.employees') && <button className="btn-secondary" onClick={() => setEdit(true)}><Pencil size={15} />Edit</button>}
      </div>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'overview' && <Overview e={e} />}
      {tab === 'salary' && <Salary e={e} reload={reload} />}
      {tab === 'payroll' && H && <PayrollHistory rows={H.payroll} />}
      {tab === 'advances' && H && <SimpleTable rows={H.advances} empty="No advances" cols={[['advance_date', 'Date', d10], ['amount', 'Amount', money], ['deduction_per_payroll', 'Per payroll', (v) => (v ? money(v) : 'Full')], ['outstanding', 'Outstanding', money], ['reason', 'Reason'], ['status', 'Status', (v) => <ReqBadge status={v} />]]} />}
      {tab === 'vacation' && H && <Vacation v={H.vacation} employeeId={e.id} reload={hist.reload} />}
      {tab === 'bonus' && H && <SimpleTable rows={H.aguinaldo} empty="No aguinaldo records" cols={[['year', 'Year'], ['months_worked', 'Months'], ['total_earnings', 'Earnings', money], ['calculated_amount', 'Calculated', money], ['final_amount', 'Final', money], ['status', 'Status', (v) => <ReqBadge status={v} />]]} />}
      {tab === 'payments' && H && <SimpleTable rows={H.payments} empty="No payments" cols={[['payment_date', 'Date', d10], ['code', 'Payroll'], ['amount', 'Amount', (v, r) => `${r.currency === 'USD' ? 'US$' : ''}${num(v)}`], ['amount_crc', 'CRC', money], ['method', 'Method'], ['bank', 'Bank'], ['reference', 'Reference'], ['voided', '', (v) => (v ? <Badge color="red">Voided</Badge> : null)]]} />}
      {tab === 'documents' && <Documents e={e} reload={reload} />}
      {tab === 'changes' && <SimpleTable rows={e.changes} empty="No changes recorded" cols={[['changed_at', 'When', dt], ['field', 'Field', (v) => v.replace(/_/g, ' ')], ['old_value', 'Before'], ['new_value', 'After'], ['changed_by_name', 'By']]} />}
      {edit && <EmployeeForm employee={e} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); reload(); }} />}
    </div>
  );
}

type Col = [string, string, ((v: any, row: any) => any)?];
function SimpleTable({ rows, cols, empty }: { rows: any[]; cols: Col[]; empty: string }) {
  return (
    <div className="card overflow-x-auto">
      {!rows?.length ? <Empty>{empty}</Empty> : (
        <table className="table">
          <thead><tr>{cols.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={r.id || i}>{cols.map(([k, , f]) => <td key={k} className="tabular-nums">{f ? f(r[k], r) : r[k] ?? '—'}</td>)}</tr>)}</tbody>
        </table>
      )}
    </div>
  );
}

function Overview({ e }: { e: any }) {
  const rows: [string, any][] = [
    ['Email', e.email], ['Phone', e.phone], ['Address', e.address], ['Birth date', dateOnly(e.birth_date)],
    ['Employment type', e.employment_type], ['Joining date', dateOnly(e.joining_date)], ['Leaving date', dateOnly(e.leaving_date)],
    ['Payment method', e.payment_method], ['Bank', [e.bank_group, e.bank_name].filter(Boolean).join(' · ')], ['Bank account', e.bank_account], ['Currency', e.currency],
    ['Insurance', e.insurance_status === 'insured' ? (e.insurance_method === 'fixed' ? `Fixed (Seguro Fijo)${e.insurance_salary ? ` on ${money(e.insurance_salary)}` : ''}` : 'CAJA % of earnings') : 'Not insured'],
    ['Accounts deduction', e.accounts_deduction_pct !== null && e.accounts_deduction_pct !== undefined ? `${e.accounts_deduction_pct}% (employee override)` : 'Department / rule default'],
    ['Pay scales with hours', e.use_reference_hours ? 'Yes (hours ÷ reference hours)' : 'No (fixed quincenal)'],
    ['Linked user', e.user_name], ['Notes', e.notes],
  ];
  return <div className="card grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2">{rows.map(([k, v]) => <div key={k} className="flex gap-3"><span className="w-44 shrink-0 text-slate-500">{k}</span><span>{v || '—'}</span></div>)}</div>;
}

function Salary({ e, reload }: { e: any; reload: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [s, setS] = useState<any>(null);
  async function save(confirm = false) {
    try {
      await pr(`/employees/${e.id}/salary`, { body: { ...s, confirm_retroactive: confirm } });
      toast('Salary saved');
      setS(null);
      reload();
    } catch (err: any) {
      if (/already approved/.test(err.message) && window.confirm(`${err.message}\n\nSave anyway?`)) return save(true);
      toast(errMsg(err), 'err');
    }
  }
  async function del(sid: string) {
    if (!confirm('Delete this salary record?')) return;
    try { await pr(`/employees/${e.id}/salary/${sid}`, { method: 'DELETE' }); reload(); } catch (err) { toast(errMsg(err), 'err'); }
  }
  return (
    <div>
      <div className="mb-3 flex items-center justify-between"><p className="text-sm text-slate-500">Salaries are effective-dated. A new salary never changes payroll already calculated for earlier dates.</p>
        {can('payroll.salary') && <button className="btn-primary" onClick={() => setS({ salary_type: e.salary_type || 'monthly', monthly_salary: e.monthly_salary || '', hourly_rate: e.hourly_rate || '', effective_from: today(), currency: 'CRC', reason: '' })}><Plus size={16} />New salary</button>}</div>
      <SimpleTable rows={e.salaries} empty="No salary on file" cols={[['effective_from', 'Effective from', d10], ['salary_type', 'Type'], ['monthly_salary', 'Monthly', (v) => (v ? money(v) : '—')],
        ['hourly_rate', 'Hourly', (v) => (v ? money(v) : '—')], ['monthly_salary', 'Quincenal', (v) => (v ? money(v / 2) : '—')], ['reason', 'Reason'], ['created_by_name', 'By'],
        ['id', '', (v) => can('payroll.salary') && <button className="btn-ghost p-1 text-rose-600" onClick={() => del(v)} aria-label="Delete"><Trash2 size={14} /></button>]]} />
      <Modal open={!!s} onClose={() => setS(null)} title="New salary" footer={<><button className="btn-secondary" onClick={() => setS(null)}>Cancel</button><button className="btn-primary" onClick={() => save()}>Save</button></>}>
        {s && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Salary type"><select className="input" value={s.salary_type} onChange={(x) => setS({ ...s, salary_type: x.target.value })}><option value="monthly">Monthly</option><option value="hourly">Hourly</option></select></Field>
          {s.salary_type === 'monthly' ? <Field label="Monthly salary"><input className="input" type="number" value={s.monthly_salary} onChange={(x) => setS({ ...s, monthly_salary: x.target.value })} /></Field>
            : <Field label="Hourly rate"><input className="input" type="number" value={s.hourly_rate} onChange={(x) => setS({ ...s, hourly_rate: x.target.value })} /></Field>}
          <Field label="Effective from"><input className="input" type="date" value={s.effective_from} onChange={(x) => setS({ ...s, effective_from: x.target.value })} /></Field>
          <Field label="Currency"><select className="input" value={s.currency} onChange={(x) => setS({ ...s, currency: x.target.value })}><option>CRC</option><option>USD</option></select></Field>
          <Field label="Reason" className="sm:col-span-2"><input className="input" value={s.reason} onChange={(x) => setS({ ...s, reason: x.target.value })} placeholder="Annual raise, promotion, minimum wage update…" /></Field>
        </div>}
      </Modal>
    </div>
  );
}

function PayrollHistory({ rows }: { rows: any[] }) {
  return <SimpleTable rows={rows} empty="Not in any payroll yet" cols={[
    ['code', 'Payroll', (v, r) => <Link className="font-medium hover:underline" to={`/backoffice/payroll/periods/${r.period_id}`}>{v}</Link>], ['period_name', 'Period'], ['status', 'Status', (v) => <PeriodBadge status={v} />],
    ['hours', 'Hours', num], ['gross', 'Gross', money], ['caja', 'CAJA', money], ['payroll_expense', 'Expense', money], ['vales', 'Vales', money], ['net_payable', 'Net', money],
    ['payment_status', 'Paid', (v, r) => <span className="inline-flex items-center gap-1"><PayBadge status={v} />{r.paid_amount > 0 && r.payment_status !== 'paid' ? money(r.paid_amount) : ''}</span>],
    ['id', '', (v) => <button className="btn-ghost p-1" onClick={() => openPdf(`/records/${v}/payslip.pdf`)} aria-label="Payslip"><FileText size={14} /></button>]]} />;
}

function Vacation({ v, employeeId, reload }: { v: any; employeeId: string; reload: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [adj, setAdj] = useState<any>(null);
  async function save() {
    try { await pr(`/vacation/${employeeId}/adjust`, { body: adj }); setAdj(null); reload(); toast('Balance adjusted'); } catch (e) { toast(errMsg(e), 'err'); }
  }
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[['Months worked', v.months_worked], ['Earned', `${v.earned} d`], ['Opening + adjustments', `${num(v.opening + v.adjustments)} d`], ['Taken / paid', `${v.used} d`], ['Balance', `${v.balance} d`]].map(([k, x]) => <div key={k} className="card p-3"><div className="text-xs text-slate-500">{k}</div><div className="text-lg font-semibold">{x}</div></div>)}
      </div>
      {can('payroll.employees') && <button className="btn-secondary" onClick={() => setAdj({ days: '', note: '' })}><Plus size={15} />Adjust balance</button>}
      <SimpleTable rows={v.txns} empty="No vacation taken" cols={[['txn_date', 'Date', d10], ['kind', 'Type'], ['days', 'Days'], ['period_code', 'Payroll'], ['note', 'Note']]} />
      <Modal open={!!adj} onClose={() => setAdj(null)} title="Adjust vacation balance" footer={<><button className="btn-secondary" onClick={() => setAdj(null)}>Cancel</button><button className="btn-primary" onClick={save}>Save</button></>}>
        {adj && <div className="grid gap-3"><Field label="Days (+ add, − remove)"><input className="input" type="number" step="0.5" value={adj.days} onChange={(x) => setAdj({ ...adj, days: x.target.value })} /></Field><Field label="Note"><input className="input" value={adj.note} onChange={(x) => setAdj({ ...adj, note: x.target.value })} /></Field></div>}
      </Modal>
    </div>
  );
}

function Documents({ e, reload }: { e: any; reload: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [kind, setKind] = useState('identification');
  async function upload(f?: File) {
    if (!f) return;
    if (f.size > 4.5 * 1024 * 1024) return toast('Files must be 4 MB or smaller', 'err');
    const r = new FileReader();
    r.onload = async () => {
      try { await pr(`/employees/${e.id}/documents`, { body: { name: f.name, kind, data_url: r.result } }); toast('Uploaded'); reload(); } catch (err) { toast(errMsg(err), 'err'); }
    };
    r.readAsDataURL(f);
  }
  async function open(d: any) {
    const full = await pr(`/employees/${e.id}/documents/${d.id}`);
    const a = document.createElement('a');
    a.href = full.data_url;
    a.download = d.name;
    a.click();
  }
  async function del(d: any) {
    if (!confirm(`Delete ${d.name}?`)) return;
    await pr(`/employees/${e.id}/documents/${d.id}`, { method: 'DELETE' });
    reload();
  }
  return (
    <div>
      {can('payroll.employees') && <div className="mb-3 flex flex-wrap items-center gap-2">
        <select className="input w-auto" value={kind} onChange={(x) => setKind(x.target.value)}><option value="identification">Identification</option><option value="contract">Employment contract</option><option value="other">Other</option></select>
        <label className="btn-primary cursor-pointer"><Plus size={15} />Upload file<input type="file" className="hidden" onChange={(x) => upload(x.target.files?.[0])} /></label>
      </div>}
      <SimpleTable rows={e.documents} empty="No documents" cols={[['name', 'File'], ['kind', 'Type'], ['size', 'Size', (v) => `${Math.round(v / 1024)} KB`], ['uploaded_at', 'Uploaded', dt],
        ['id', '', (_, d) => <span className="whitespace-nowrap"><button className="btn-ghost p-1" onClick={() => open(d)} aria-label="Download"><Download size={14} /></button>{can('payroll.employees') && <button className="btn-ghost p-1 text-rose-600" onClick={() => del(d)} aria-label="Delete"><Trash2 size={14} /></button>}</span>]]} />
    </div>
  );
}
