import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Store, Upload } from 'lucide-react';
import { money, dateOnly } from '../../lib/format';
import { parseCSV } from '../../lib/csv';
import { Badge, Empty, Field, Modal, PageHeader, SearchInput, Spinner, Toggle, useAsync, useToast } from '../../components/ui';
import { useSession } from '../../backoffice/BackOffice';
import { ExportButtons } from '../../backoffice/widgets';
import { errMsg, pr, today } from '../lib';
import PosStaff from './PosStaff';

export const STATUS_BADGE: Record<string, JSX.Element> = { active: <Badge color="green">Active</Badge>, inactive: <Badge>Inactive</Badge>, suspended: <Badge color="red">Suspended</Badge> };

export default function Employees() {
  const { can } = useSession();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [dept, setDept] = useState('');
  const { data, loading, reload } = useAsync(() => pr<any[]>(`/employees?status=${status}&department_id=${dept}`), [status, dept]);
  const depts = useAsync(() => pr<any[]>('/departments'), []);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [posStaff, setPosStaff] = useState(false);
  const rows = (data || []).filter((e) => !q || `${e.full_name} ${e.short_name || ''} ${e.cedula || ''} ${e.code} ${e.email || ''}`.toLowerCase().includes(q.toLowerCase()));
  const pay = rows.some((r) => !r.pay_hidden);

  return (
    <div>
      <PageHeader title="Employees" subtitle={`${rows.length} employee(s)`} actions={can('payroll.employees') && <>
        <button className="btn-secondary" onClick={() => setPosStaff(true)}><Store size={16} />POS staff</button>
        <button className="btn-secondary" onClick={() => setImporting(true)}><Upload size={16} />Import</button>
        <button className="btn-primary" onClick={() => setCreating(true)}><Plus size={16} />Add employee</button>
      </>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Name, cédula, ID, email…" className="w-72" />
        <select className="input w-auto py-1.5" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="suspended">Suspended</option></select>
        <select className="input w-auto py-1.5" value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department"><option value="">All departments</option>{depts.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <div className="ml-auto"><ExportButtons name="employees" rows={rows.map((r) => ({ ...r, salary: r.salary_type === 'hourly' ? r.hourly_rate : r.monthly_salary }))} cols={[
          { key: 'code', label: 'ID' }, { key: 'full_name', label: 'Name' }, { key: 'cedula', label: 'Cédula' }, { key: 'department_name', label: 'Department' }, { key: 'position_name', label: 'Position' },
          { key: 'employment_type', label: 'Type' }, ...(pay ? [{ key: 'salary_type', label: 'Salary type' }, { key: 'salary', label: 'Salary / rate' }] : []), { key: 'payment_method', label: 'Payment' },
          { key: 'bank_group', label: 'Bank' }, { key: 'bank_account', label: 'Account' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' }, { key: 'status', label: 'Status' }]} /></div>
      </div>
      <div className="card overflow-x-auto">
        {loading ? <div className="flex justify-center py-10"><Spinner /></div> : !rows.length ? <Empty>No employees</Empty> : (
          <table className="table">
            <thead><tr><th>Employee</th><th>Cédula</th><th>Department / position</th><th>Type</th>{pay && <th className="text-right">Salary / rate</th>}<th>Payment</th><th>Insurance</th><th>Joined</th><th>Status</th></tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e.id} className="cursor-pointer" onClick={() => nav(`/backoffice/payroll/employees/${e.id}`)}>
                <td><Link to={`/backoffice/payroll/employees/${e.id}`} className="font-medium hover:underline">{e.full_name}</Link><div className="text-xs text-slate-400">{e.code}{e.short_name ? ` · "${e.short_name}"` : ''}{e.user_id && <span className="ml-1.5 rounded bg-brand-50 px-1 text-[10px] font-semibold text-brand-700 dark:bg-brand-900/30 dark:text-brand-300" title={`Linked to POS user ${e.user_name || ''}`}>POS</span>}</div></td>
                <td className="font-mono text-xs">{e.cedula || <span className="text-amber-600">missing</span>}</td>
                <td>{e.department_name || '—'}<div className="text-xs text-slate-400">{e.position_name}</div></td>
                <td className="capitalize">{e.employment_type}</td>
                {pay && <td className="text-right tabular-nums">{e.salary_type === 'hourly' ? <>{money(e.hourly_rate)}<span className="text-xs text-slate-400"> /h</span></> : e.monthly_salary ? <>{money(e.monthly_salary)}<span className="text-xs text-slate-400"> /mo</span></> : <span className="text-amber-600">not set</span>}</td>}
                <td className="text-xs capitalize">{e.payment_method}{e.bank_group ? ` · ${e.bank_group}` : ''}</td>
                <td className="text-xs">{e.insurance_status === 'insured' ? (e.insurance_method === 'fixed' ? 'Fixed' : 'CAJA %') : <span className="text-slate-400">Not insured</span>}</td>
                <td className="text-xs">{dateOnly(e.joining_date)}</td>
                <td>{STATUS_BADGE[e.status]}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {creating && <EmployeeForm onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); nav(`/backoffice/payroll/employees/${id}`); }} />}
      {importing && <ImportEmployees onClose={() => { setImporting(false); reload(); }} />}
      {posStaff && <PosStaff onClose={() => { setPosStaff(false); reload(); }} />}
    </div>
  );
}

export function EmployeeForm({ employee, onClose, onSaved }: { employee?: any; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const { can } = useSession();
  const lookups = useAsync(async () => {
    const [d, p, u] = await Promise.all([pr<any[]>('/departments'), pr<any[]>('/positions'), pr<any[]>('/users')]);
    return { d, p, u };
  }, []);
  const [e, setE] = useState<any>(employee ? { ...employee } : {
    full_name: '', employment_type: 'monthly', status: 'active', currency: 'CRC', payment_method: 'transfer', insurance_status: 'insured', insurance_method: 'percent',
    use_reference_hours: true, joining_date: today(), salary: { salary_type: 'monthly', monthly_salary: '', hourly_rate: '', effective_from: today() },
  });
  const set = (k: string, v: any) => setE((x: any) => ({ ...x, [k]: v }));
  const setSal = (k: string, v: any) => setE((x: any) => ({ ...x, salary: { ...x.salary, [k]: v } }));
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      const body = { ...e };
      if (!employee && !can('payroll.salary')) delete body.salary;
      if (!employee && body.salary) body.salary.effective_from = body.joining_date || body.salary.effective_from;
      const row = employee ? await pr(`/employees/${employee.id}`, { method: 'PUT', body }) : await pr('/employees', { body });
      toast('Employee saved');
      onSaved(row.id);
    } catch (err) {
      toast(errMsg(err), 'err');
    } finally { setSaving(false); }
  }
  async function photo(file?: File) {
    if (!file) return;
    if (file.size > 600_000) return toast('Photo must be smaller than 600 KB', 'err');
    const r = new FileReader();
    r.onload = () => set('photo_url', r.result);
    r.readAsDataURL(file);
  }
  const L = lookups.data;
  const positions = L?.p.filter((p) => !e.department_id || !p.department_id || p.department_id === e.department_id) || [];
  const txt = (k: string, label: string, props: any = {}) => <Field label={label}><input className="input" value={e[k] ?? ''} onChange={(x) => set(k, x.target.value)} {...props} /></Field>;
  return (
    <Modal open onClose={onClose} size="xl" title={employee ? `Edit ${employee.full_name}` : 'New employee'}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={saving} onClick={save}>Save</button></>}>
      <div className="space-y-5">
        <section>
          <div className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Profile</div>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="row-span-2 flex flex-col items-center gap-2">
              {e.photo_url ? <img src={e.photo_url} alt="" className="h-20 w-20 rounded-full object-cover" /> : <div className="flex h-20 w-20 items-center justify-center rounded-full bg-slate-100 text-2xl text-slate-400 dark:bg-slate-800">{(e.full_name || '?')[0]}</div>}
              <label className="btn-ghost cursor-pointer px-2 py-1 text-xs">Photo<input type="file" accept="image/*" className="hidden" onChange={(x) => photo(x.target.files?.[0])} /></label>
            </div>
            {txt('full_name', 'Full name *')}
            {txt('short_name', 'Short name / alias', { placeholder: 'e.g. Jazz' })}
            {txt('cedula', 'Cédula / identification', { placeholder: '1-0000-0000' })}
            {txt('email', 'Email', { type: 'email' })}
            {txt('phone', 'Phone')}
            <Field label="Birth date"><input className="input" type="date" value={e.birth_date?.slice?.(0, 10) || ''} onChange={(x) => set('birth_date', x.target.value)} /></Field>
            <Field label="Address" className="sm:col-span-3"><input className="input" value={e.address || ''} onChange={(x) => set('address', x.target.value)} /></Field>
          </div>
        </section>
        <section>
          <div className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Employment</div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Department"><select className="input" value={e.department_id || ''} onChange={(x) => set('department_id', x.target.value)}><option value="">—</option>{L?.d.filter((d) => d.active || d.id === e.department_id).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
            <Field label="Job position"><select className="input" value={e.position_id || ''} onChange={(x) => set('position_id', x.target.value)}><option value="">—</option>{positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
            <Field label="Employment type"><select className="input" value={e.employment_type} onChange={(x) => set('employment_type', x.target.value)}><option value="monthly">Monthly</option><option value="hourly">Hourly</option><option value="temporary">Temporary</option></select></Field>
            <Field label="Status"><select className="input" value={e.status} onChange={(x) => set('status', x.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option><option value="suspended">Suspended</option></select></Field>
            <Field label="Joining date"><input className="input" type="date" value={e.joining_date?.slice?.(0, 10) || ''} onChange={(x) => set('joining_date', x.target.value)} /></Field>
            <Field label="Leaving date"><input className="input" type="date" value={e.leaving_date?.slice?.(0, 10) || ''} onChange={(x) => set('leaving_date', x.target.value)} /></Field>
            <Field label="Linked user (login)" hint="Self-service payslips / POS time clock"><select className="input" value={e.user_id || ''} onChange={(x) => set('user_id', x.target.value)}><option value="">—</option>{L?.u.map((u) => <option key={u.id} value={u.id}>{u.name}{u.email ? ` (${u.email})` : ''}</option>)}</select></Field>
            <Field label="Opening vacation balance (days)"><input className="input" type="number" step="0.5" value={e.vacation_opening_days ?? 0} onChange={(x) => set('vacation_opening_days', x.target.value)} /></Field>
          </div>
        </section>
        {!employee && can('payroll.salary') && (
          <section>
            <div className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Salary (effective from the joining date)</div>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Salary type"><select className="input" value={e.salary.salary_type} onChange={(x) => setSal('salary_type', x.target.value)}><option value="monthly">Monthly salary</option><option value="hourly">Hourly rate</option></select></Field>
              {e.salary.salary_type === 'monthly'
                ? <Field label="Monthly salary *" hint="Quincenal = ÷ 2"><input className="input" type="number" value={e.salary.monthly_salary} onChange={(x) => setSal('monthly_salary', x.target.value)} /></Field>
                : <Field label="Hourly rate *"><input className="input" type="number" value={e.salary.hourly_rate} onChange={(x) => setSal('hourly_rate', x.target.value)} /></Field>}
              <Field label="Currency"><select className="input" value={e.salary.currency || 'CRC'} onChange={(x) => setSal('currency', x.target.value)}><option>CRC</option><option>USD</option></select></Field>
            </div>
          </section>
        )}
        <section>
          <div className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Payment & insurance</div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Payment method"><select className="input" value={e.payment_method} onChange={(x) => set('payment_method', x.target.value)}><option value="transfer">Bank transfer</option><option value="cash">Cash</option><option value="usd">USD</option><option value="sinpe">SINPE Móvil</option><option value="other">Other</option></select></Field>
            <Field label="Bank"><select className="input" value={e.bank_group || ''} onChange={(x) => set('bank_group', x.target.value)}><option value="">—</option><option>BCR</option><option>Non-BCR</option><option>Other</option></select></Field>
            {txt('bank_name', 'Bank name')}
            {txt('bank_account', 'Bank account / IBAN / SINPE')}
            <Field label="Currency"><select className="input" value={e.currency} onChange={(x) => set('currency', x.target.value)}><option>CRC</option><option>USD</option></select></Field>
            <Field label="Insurance (CAJA)"><select className="input" value={e.insurance_status} onChange={(x) => set('insurance_status', x.target.value)}><option value="insured">Insured</option><option value="not_insured">Not insured</option></select></Field>
            {e.insurance_status === 'insured' && <Field label="Insurance method"><select className="input" value={e.insurance_method} onChange={(x) => set('insurance_method', x.target.value)}><option value="percent">CAJA % of earnings</option><option value="fixed">Fixed insurance salary (Seguro Fijo)</option></select></Field>}
            {e.insurance_status === 'insured' && e.insurance_method === 'fixed' && can('payroll.salary') && <Field label="Insurance salary"><input className="input" type="number" value={e.insurance_salary ?? ''} onChange={(x) => set('insurance_salary', x.target.value)} /></Field>}
            {can('payroll.salary') && <Field label="Accounts deduction %" hint="Blank = department / rule default"><input className="input" type="number" value={e.accounts_deduction_pct ?? ''} onChange={(x) => set('accounts_deduction_pct', x.target.value)} /></Field>}
            <div className="flex items-end pb-2 sm:col-span-2"><Toggle checked={e.use_reference_hours !== false} onChange={(v) => set('use_reference_hours', v)} label="Monthly pay scales with hours ÷ reference hours (96)" /></div>
          </div>
        </section>
        <Field label="Notes"><textarea className="input" rows={2} value={e.notes || ''} onChange={(x) => set('notes', x.target.value)} /></Field>
      </div>
    </Modal>
  );
}

const IMPORT_COLS = 'full_name, short_name, cedula, email, phone, department, position, joining_date, monthly_salary, hourly_rate, payment_method, bank, bank_account, insured';
function ImportEmployees({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<any[]>([]);
  const [report, setReport] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  async function file(f?: File) {
    if (!f) return;
    const r = parseCSV(await f.text());
    setRows(r);
    run(r, true);
  }
  async function run(r = rows, dry = false) {
    setBusy(true);
    try {
      const out = await pr('/employees/import', { body: { rows: r, dry_run: dry } });
      setReport(out.report);
      if (!dry) { toast(`${out.imported} employee(s) imported`); }
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  }
  const done = report?.some((x) => x.status === 'imported');
  return (
    <Modal open onClose={onClose} size="lg" title="Import employees (CSV)"
      footer={<><button className="btn-secondary" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>{!done && <button className="btn-primary" disabled={!rows.length || busy} onClick={() => run(rows, false)}>Import {report?.filter((x) => x.status === 'ready').length || ''} employee(s)</button>}</>}>
      <p className="mb-2 text-sm text-slate-500">Save the sheet from Excel as CSV with these column headers (any order): <code className="text-xs">{IMPORT_COLS}</code>. Duplicates are detected by cédula and name; similar names are flagged for verification.</p>
      <input type="file" accept=".csv,text/csv" className="input" onChange={(e) => file(e.target.files?.[0])} />
      {report && (
        <table className="table mt-3 text-xs">
          <thead><tr><th>Row</th><th>Name</th><th>Status</th><th>Notes</th></tr></thead>
          <tbody>{report.map((x) => <tr key={x.row}><td>{x.row}</td><td>{x.name}</td><td><Badge color={x.status === 'error' ? 'red' : x.status === 'duplicate' ? 'amber' : 'green'}>{x.status}</Badge></td><td>{x.issues?.join('; ')}</td></tr>)}</tbody>
        </table>
      )}
    </Modal>
  );
}
