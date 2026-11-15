import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { dt } from '../../lib/format';
import { Badge, Empty, Field, Modal, PageHeader, Spinner, Tabs, Toggle, useAsync, useToast } from '../../components/ui';
import { useSession } from '../../backoffice/BackOffice';
import { DEFAULT_RULES, RULE_LABELS, type PayrollRules } from '../../../../shared/payroll';
import { d10, errMsg, pr, today } from '../lib';

export default function Settings() {
  const { can } = useSession();
  const [tab, setTab] = useState<'rules' | 'company' | 'audit'>('rules');
  return (
    <div>
      <PageHeader title="Payroll settings & audit log" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'rules', label: 'Payroll rules' }, { id: 'company', label: 'Payslip & email' }, ...(can('audit.view') || can('payroll.reports') ? [{ id: 'audit' as const, label: 'Audit log' }] : [])]} />
      {tab === 'rules' && <Rules />}
      {tab === 'company' && <Company />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

const GROUPS: [string, (keyof PayrollRules)[]][] = [
  ['Salary structure', ['reference_hours', 'quincenal_divisor', 'monthly_day_divisor', 'hours_per_day', 'rounding_decimals']],
  ['CAJA / insurance', ['caja_rate', 'caja_include_holiday', 'caja_include_overtime', 'caja_include_vacation', 'caja_include_bonus', 'fixed_insurance_rate']],
  ['Overtime & holidays', ['overtime_multiplier', 'excess_hours_premium', 'holiday_multiplier', 'holiday_monthly_method']],
  ['Deductions, vacation & bonus', ['accounts_deduction_pct', 'vacation_days_per_month', 'aguinaldo_months']],
];
const HINTS: Partial<Record<keyof PayrollRules, string>> = {
  reference_hours: 'Workbook: 96 h per ~14-day period',
  caja_rate: 'Workbook: 10.83% in newer sheets',
  fixed_insurance_rate: 'Workbook Seguro Fijo: 10.67%',
  overtime_multiplier: 'Workbook sheet 11: OT hours × hourly × 1.5',
  excess_hours_premium: 'Some sheets: (hours − 96) × hourly × 0.5. 0 = above-reference hours paid at 1× only',
  accounts_deduction_pct: 'Workbook: 65%, 60% (newest) or 35%',
  holiday_monthly_method: 'Proportional: days × (monthly ÷ 30) × hours ÷ reference (sheet 8)',
  caja_include_overtime: 'The workbook formula did not include overtime pay',
};

function Rules() {
  const toast = useToast();
  const { can } = useSession();
  const { data, loading, reload } = useAsync(() => pr('/rules'), []);
  const [n, setN] = useState<any>(null);
  async function save() {
    try { await pr('/rules', { body: n }); toast('New rule version saved'); setN(null); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function del(s: any) {
    if (!confirm(`Delete rule version "${s.name}"?`)) return;
    try { await pr(`/rules/${s.id}`, { method: 'DELETE' }); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  if (loading || !data) return <Spinner />;
  const current = data.sets.find((s: any) => d10(s.effective_from) <= today()) || data.sets[0];
  const val = (r: any, k: keyof PayrollRules) => (typeof DEFAULT_RULES[k] === 'boolean' ? (r[k] ? 'Yes' : 'No') : String(r[k]));
  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">These values come from the Excel workbook and are <b>not confirmed legal payroll rules</b>. Confirm rates, the contribution basis and overtime rules with the business owner and CCSS / Ministerio de Trabajo before production. Changes take effect through a new dated version; payroll already created keeps the rules it was calculated with.</div>
      <div className="flex justify-end">{can('payroll.salary') && <button className="btn-primary" onClick={() => setN({ name: '', effective_from: today(), notes: '', rules: { ...current.rules } })}><Plus size={16} />New rule version</button>}</div>
      <div className="card overflow-x-auto">
        <table className="table text-sm">
          <thead><tr><th>Setting</th>{data.sets.map((s: any) => <th key={s.id} className="text-right">{s.name}<div className="font-normal normal-case">from {d10(s.effective_from)} {s.id === current.id && <Badge color="green">current</Badge>}</div>
            {can('payroll.salary') && data.sets.length > 1 && <button className="btn-ghost p-0.5 text-rose-600" onClick={() => del(s)} aria-label="Delete version"><Trash2 size={12} /></button>}</th>)}</tr></thead>
          <tbody>{GROUPS.map(([g, keys]) => [
            <tr key={g}><td colSpan={data.sets.length + 1} className="bg-slate-50 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:bg-slate-800/50">{g}</td></tr>,
            ...keys.map((k) => <tr key={k}><td>{RULE_LABELS[k]}{HINTS[k] && <div className="text-[11px] text-slate-400">{HINTS[k]}</div>}</td>{data.sets.map((s: any) => <td key={s.id} className="text-right tabular-nums">{val(s.rules, k)}</td>)}</tr>),
          ])}</tbody>
        </table>
      </div>
      <Modal open={!!n} onClose={() => setN(null)} size="xl" title="New payroll rule version" footer={<><button className="btn-secondary" onClick={() => setN(null)}>Cancel</button><button className="btn-primary" onClick={save}>Save version</button></>}>
        {n && <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name"><input className="input" value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} placeholder="2027 rates" /></Field>
            <Field label="Effective from" hint="Payroll ending on or after this date uses it"><input className="input" type="date" value={n.effective_from} onChange={(e) => setN({ ...n, effective_from: e.target.value })} /></Field>
            <Field label="Notes"><input className="input" value={n.notes} onChange={(e) => setN({ ...n, notes: e.target.value })} /></Field>
          </div>
          {GROUPS.map(([g, keys]) => (
            <div key={g}>
              <div className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">{g}</div>
              <div className="grid gap-3 sm:grid-cols-3">{keys.map((k) => {
                const v = n.rules[k];
                const set = (x: any) => setN({ ...n, rules: { ...n.rules, [k]: x } });
                if (typeof DEFAULT_RULES[k] === 'boolean') return <div key={k} className="flex items-end pb-2"><Toggle checked={!!v} onChange={set} label={RULE_LABELS[k]} /></div>;
                if (k === 'holiday_monthly_method') return <Field key={k} label={RULE_LABELS[k]} hint={HINTS[k]}><select className="input" value={v} onChange={(e) => set(e.target.value)}><option value="proportional">Proportional to hours</option><option value="daily">Daily salary × days</option></select></Field>;
                return <Field key={k} label={RULE_LABELS[k]} hint={HINTS[k]}><input className="input" type="number" step="any" value={v} onChange={(e) => set(e.target.value)} /></Field>;
              })}</div>
            </div>
          ))}
        </div>}
      </Modal>
    </div>
  );
}

function Company() {
  const toast = useToast();
  const { can } = useSession();
  const { data, loading, reload } = useAsync(() => pr('/settings'), []);
  const [s, setS] = useState<any>(null);
  if (loading || !data) return <Spinner />;
  const v = s || data;
  const set = (k: string, x: any) => setS({ ...v, [k]: x });
  async function save() {
    try { await pr('/settings', { method: 'PUT', body: v }); toast('Saved'); setS(null); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  function logo(f?: File) {
    if (!f) return;
    if (f.size > 400_000) return toast('Logo must be smaller than 400 KB (PNG or JPEG)', 'err');
    const r = new FileReader();
    r.onload = () => set('logo_url', r.result);
    r.readAsDataURL(f);
  }
  const edit = can('payroll.settings');
  return (
    <div className="card max-w-3xl space-y-4 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Company name on payslips"><input className="input" disabled={!edit} value={v.company_name || ''} onChange={(e) => set('company_name', e.target.value)} /></Field>
        <Field label="Cédula jurídica"><input className="input" disabled={!edit} value={v.company_id || ''} onChange={(e) => set('company_id', e.target.value)} placeholder={data.business?.gstin} /></Field>
        <Field label="Address" className="sm:col-span-2"><input className="input" disabled={!edit} value={v.company_address || ''} onChange={(e) => set('company_address', e.target.value)} placeholder={data.business?.address} /></Field>
        <Field label="Logo (PNG / JPEG)"><div className="flex items-center gap-3">{(v.logo_url || data.business?.logo_url) && <img src={v.logo_url || data.business?.logo_url} alt="" className="h-12 w-12 object-contain" />}{edit && <input type="file" accept="image/png,image/jpeg" onChange={(e) => logo(e.target.files?.[0])} />}</div></Field>
        <Field label="Employee ID prefix"><input className="input" disabled={!edit} value={v.employee_code_prefix || 'E'} onChange={(e) => set('employee_code_prefix', e.target.value)} /></Field>
        <Field label="Payslip footer" className="sm:col-span-2"><input className="input" disabled={!edit} value={v.payslip_footer || ''} onChange={(e) => set('payslip_footer', e.target.value)} /></Field>
      </div>
      <div>
        <div className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Payslip email template</div>
        {!data.smtp_configured && <p className="mb-2 text-xs text-amber-700">SMTP is not configured on the server; emails cannot be sent yet.</p>}
        <div className="grid gap-3">
          <Field label="Subject"><input className="input" disabled={!edit} value={v.email_subject || ''} onChange={(e) => set('email_subject', e.target.value)} /></Field>
          <Field label="Body" hint="Placeholders: {name} {period} {code} {net} {company}. The PDF payslip is attached."><textarea className="input" rows={6} disabled={!edit} value={(v.email_body || '').replace(/\\n/g, '\n')} onChange={(e) => set('email_body', e.target.value)} /></Field>
        </div>
      </div>
      {edit && <div className="flex justify-end"><button className="btn-primary" disabled={!s} onClick={save}>Save</button></div>}
    </div>
  );
}

function Audit() {
  const { data, loading } = useAsync(() => pr<any[]>('/audit'), []);
  const [q, setQ] = useState('');
  const rows = (data || []).filter((a) => !q || JSON.stringify(a).toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <input className="input mb-3 w-72" placeholder="Search user, action, employee…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !rows.length ? <Empty /> : (
          <table className="table text-sm"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Record</th><th>Details</th></tr></thead>
            <tbody>{rows.map((a) => <tr key={a.id}><td className="whitespace-nowrap">{dt(a.created_at)}</td><td>{a.user_name}</td><td>{a.action.replace(/^payroll_/, '').replace(/_/g, ' ')}</td><td className="text-xs">{(a.entity || '').replace(/^pr_/, '')}</td>
              <td className="max-w-xl truncate font-mono text-[11px] text-slate-500" title={JSON.stringify(a.details, null, 2)}>{JSON.stringify(a.details)}</td></tr>)}</tbody></table>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500">Audit records cannot be edited or deleted from the application.</p>
    </div>
  );
}
