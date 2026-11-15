import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, RefreshCw, CalendarClock, UserPlus, ShieldCheck, Send, CheckCircle2, XCircle, Lock, Unlock, Trash2, FlaskConical, FileText, Mail, Banknote, AlertTriangle, Info, X,
} from 'lucide-react';
import { money, dateOnly, dt } from '../../lib/format';
import { Badge, Empty, Field, Modal, Spinner, Stat, Tabs, useAsync, useToast } from '../../components/ui';
import { useSession } from '../../backoffice/BackOffice';
import { ExportButtons } from '../../backoffice/widgets';
import { calculatePay, OVERRIDE_KEYS, OVERRIDE_LABELS, PAYMENT_METHODS, type OverrideKey } from '../../../../shared/payroll';
import { PayBadge, PeriodBadge, ReqBadge, d10, errMsg, num, openPdf, pr, today } from '../lib';

type Tab = 'grid' | 'dept' | 'payments' | 'payslips' | 'compare' | 'history';

export default function PeriodDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useSession();
  const { data: P, loading, reload } = useAsync(() => pr(`/periods/${id}`), [id]);
  const [tab, setTab] = useState<Tab>('grid');
  const [recs, setRecs] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [validation, setValidation] = useState<any>(null);
  const [sim, setSim] = useState<Record<string, any> | null>(null);
  const [dialog, setDialog] = useState<null | { action: string; title: string; reason?: boolean }>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (P) { setRecs(P.records); setValidation(P.validation); } }, [P]);
  if (loading || !P) return <div className="flex justify-center py-20"><Spinner /></div>;
  const locked = P.locked;
  const editable = !locked && can('payroll.process');
  const upd = (r: any) => setRecs((xs) => xs.map((x) => (x.id === r.id ? { ...x, ...r } : x)));

  async function act(action: string, extra: any = {}) {
    try {
      const r = await pr(`/periods/${P.id}/action`, { body: { action, ...extra } });
      if (r.validation) setValidation(r.validation);
      const done: Record<string, string> = { submit: 'submitted for approval', approve: 'approved', reject: 'returned for correction', close: 'closed', reopen: 'reopened', request_attendance: 'waiting for attendance' };
      toast(`Payroll ${done[action] || 'updated'}`);
      setDialog(null);
      reload();
    } catch (e: any) {
      toast(errMsg(e), 'err');
      if (/must be fixed/.test(e.message)) validate();
    }
  }
  async function call(path: string, body: any = {}, msg = 'Done') {
    try { const r = await pr(path, { body }); toast(typeof msg === 'string' ? msg : msg); reload(); return r; } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function validate() {
    try { setValidation(await pr(`/periods/${P.id}/validate`, { body: {} })); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function remove() {
    if (!confirm(`Delete draft payroll ${P.code}?`)) return;
    try { await pr(`/periods/${P.id}`, { method: 'DELETE' }); nav('/backoffice/payroll/periods'); } catch (e) { toast(errMsg(e), 'err'); }
  }
  const T = P.totals;
  const st = P.status;

  return (
    <div>
      <Link to="/backoffice/payroll/periods" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft size={14} />Payroll periods</Link>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold">{P.code} · {P.name}</h1><PeriodBadge status={st} />{locked && <Lock size={15} className="text-slate-400" aria-label="Locked" />}</div>
          <div className="text-sm text-slate-500">{dateOnly(P.start_date)} – {dateOnly(P.end_date)}{P.pay_date ? ` · pay date ${dateOnly(P.pay_date)}` : ''} · created by {P.created_by_name}{P.approved_by_name ? ` · approved by ${P.approved_by_name} ${dt(P.approved_at)}` : ''}</div>
          {P.rejected_reason && <div className="mt-1 text-sm text-rose-600">Returned for correction: {P.rejected_reason}</div>}
          {P.holidays.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{P.holidays.map((h: any) => <Badge key={h.holiday_date} color="amber">Holiday {d10(h.holiday_date).slice(5)} {h.name}</Badge>)}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          {editable && <>
            <button className="btn-secondary" onClick={() => call(`/periods/${P.id}/load-attendance`, { overwrite: confirm('Overwrite hours you entered manually with attendance totals?\n\nOK = overwrite all, Cancel = only fill records still using attendance') }, 'Hours loaded from attendance')}><CalendarClock size={16} />Load hours</button>
            <button className="btn-secondary" onClick={() => call(`/periods/${P.id}/refresh`, {}, 'Salaries, departments and rules refreshed')} title="Re-read salaries, bank details and the rule version"><RefreshCw size={16} />Refresh</button>
            <button className="btn-secondary" onClick={() => setAdding(true)}><UserPlus size={16} />Add employees</button>
            {['draft', 'calculation_pending'].includes(st) && <button className="btn-secondary" onClick={() => act('request_attendance')}>Request attendance</button>}
          </>}
          {!locked && <button className={`btn-secondary ${sim ? 'ring-2 ring-violet-400' : ''}`} onClick={() => setSim(sim ? null : {})}><FlaskConical size={16} />{sim ? 'Exit simulation' : 'Simulate'}</button>}
          <button className="btn-secondary" onClick={validate}><ShieldCheck size={16} />Validate</button>
          {editable && ['draft', 'attendance_pending', 'calculation_pending'].includes(st) && <button className="btn-primary" onClick={() => act('submit')}><Send size={16} />Submit for approval</button>}
          {can('payroll.approve') && st === 'under_review' && <>
            <button className="btn-danger" onClick={() => setDialog({ action: 'reject', title: 'Return for correction', reason: true })}><XCircle size={16} />Reject</button>
            <button className="btn-primary" onClick={() => setDialog({ action: 'approve', title: `Approve payroll ${P.code}` })}><CheckCircle2 size={16} />Approve</button>
          </>}
          {can('payroll.approve') && st === 'paid' && <button className="btn-primary" onClick={() => setDialog({ action: 'close', title: `Close payroll ${P.code}` })}><Lock size={16} />Close period</button>}
          {can('payroll.approve') && locked && <button className="btn-secondary" onClick={() => setDialog({ action: 'reopen', title: `Reopen payroll ${P.code}`, reason: true })}><Unlock size={16} />Reopen</button>}
          {editable && ['draft', 'attendance_pending', 'calculation_pending'].includes(st) && <button className="btn-ghost text-rose-600" onClick={remove} aria-label="Delete payroll"><Trash2 size={16} /></button>}
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="Employees" value={T.employees} />
        <Stat label="Gross salary" value={money(T.gross)} sub={`OT ${money(T.overtime)} · hol. ${money(T.holiday)}`} />
        <Stat label="CAJA" value={money(T.caja)} />
        <Stat label="Payroll expense" value={money(T.payroll_expense)} />
        <Stat label="Net payable" value={money(T.net_payable)} sub={`Deductions ${money(T.total_deductions)}`} />
        <Stat label="Paid" value={money(T.paid)} sub={T.pending > 0 ? `${money(T.pending)} pending` : locked ? 'Fully paid' : undefined} tone={T.pending > 0 && locked ? 'down' : undefined} />
      </div>

      {validation && <ValidationPanel v={validation} onClose={() => setValidation(null)} />}
      {sim && <div className="mb-3 flex items-center gap-2 rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-sm text-violet-900 dark:border-violet-700 dark:bg-violet-900/20 dark:text-violet-200"><FlaskConical size={16} />Simulation: change hours, bonus or deductions to preview net pay. Nothing is saved. <button className="btn-ghost ml-auto px-2 py-1 text-xs" onClick={() => setSim({})}>Reset</button></div>}

      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'grid', label: 'Payroll calculation' }, { id: 'dept', label: 'By department' }, { id: 'payments', label: 'Payments' }, { id: 'payslips', label: 'Payslips' }, { id: 'compare', label: 'Compare' }, { id: 'history', label: 'History' }]} />
      {tab === 'grid' && <Grid P={P} recs={recs} editable={editable && !sim} sim={sim} setSim={setSim} upd={upd} openRec={setOpen} />}
      {tab === 'dept' && <DeptTable rows={P.by_department} />}
      {tab === 'payments' && <PaymentsTab P={P} recs={recs} reload={reload} />}
      {tab === 'payslips' && <PayslipsTab P={P} recs={recs} reload={reload} />}
      {tab === 'compare' && <Compare P={P} />}
      {tab === 'history' && <History id={P.id} />}

      {open && <RecordDrawer id={open} editable={editable} onClose={() => setOpen(null)} onChanged={(r) => { upd(r); }} />}
      {adding && <AddEmployees P={P} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {dialog && <ActionDialog d={dialog} P={P} validation={validation} onClose={() => setDialog(null)} onConfirm={(reason) => act(dialog.action, { reason, self_approve: true })} />}
    </div>
  );
}

function ValidationPanel({ v, onClose }: { v: any; onClose: () => void }) {
  const [all, setAll] = useState(false);
  const issues = v.issues || [];
  return (
    <div className={`mb-4 rounded-xl border p-3 text-sm ${v.ok ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20' : 'border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-900/20'}`}>
      <div className="flex items-center gap-2 font-medium">
        {v.ok ? <CheckCircle2 size={16} className="text-emerald-600" /> : <AlertTriangle size={16} className="text-rose-600" />}
        {v.ok ? 'Validation passed' : `${v.errors} error(s) block approval`}{v.warnings ? ` · ${v.warnings} warning(s)` : ''}
        <span className="text-xs font-normal text-slate-500">checked {dt(v.checked_at)}</span>
        <button className="btn-ghost ml-auto p-1" onClick={onClose} aria-label="Hide"><X size={14} /></button>
      </div>
      {issues.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {(all ? issues : issues.slice(0, 8)).map((i: any, k: number) => <li key={k} className="flex items-start gap-1.5">{i.level === 'error' ? <AlertTriangle size={13} className="mt-0.5 shrink-0 text-rose-600" /> : <Info size={13} className="mt-0.5 shrink-0 text-amber-600" />}{i.message}</li>)}
          {issues.length > 8 && <li><button className="text-xs text-brand-700 underline" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${issues.length}`}</button></li>}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Calculation grid
function Grid({ P, recs, editable, sim, setSim, upd, openRec }: { P: any; recs: any[]; editable: boolean; sim: Record<string, any> | null; setSim: (s: any) => void; upd: (r: any) => void; openRec: (id: string) => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const rows = useMemo(() => recs.filter((r) => !q || `${r.employee_name} ${r.department_name}`.toLowerCase().includes(q.toLowerCase())).map((r) => {
    if (!sim) return r;
    const s = sim[r.id] || {};
    const c = calculatePay({
      salary_type: r.salary_type, hourly_rate: r.hourly_rate, monthly_salary: r.monthly_salary, use_reference_hours: r.use_reference_hours, insurance_method: r.insurance_method,
      insurance_salary: r.insurance_salary, accounts_pct: r.accounts_pct, hours: s.hours ?? r.hours, overtime_hours: s.overtime_hours ?? r.overtime_hours,
      holiday_hours: s.holiday_hours ?? r.holiday_hours, holiday_days: s.holiday_days ?? r.holiday_days, vacation_days: s.vacation_days ?? r.vacation_days, bonus: s.bonus ?? r.bonus,
      accounts_amount: s.accounts_amount ?? r.accounts_amount, vales: s.vales ?? r.vales, other_deductions: s.other_deductions ?? r.other_deductions, adjustments: r.adjustments,
      overrides: Object.fromEntries(Object.entries(r.overrides || {}).map(([k, v]: any) => [k, v.value])),
    }, P.rules);
    return { ...r, ...s, ...c, _actualNet: r.net_payable };
  }), [recs, q, sim, P.rules]);

  async function save(r: any, k: string, v: string) {
    if (sim) { setSim({ ...sim, [r.id]: { ...(sim[r.id] || {}), [k]: v === '' ? 0 : Number(v) } }); return; }
    if (String(Number(r[k])) === (v === '' ? '0' : String(Number(v)))) return;
    try {
      const out = k === 'accounts_amount'
        ? await pr('/accounts/total', { method: 'PUT', body: { employee_id: r.employee_id, period_id: P.id, total: Number(v) || 0 } })
        : await pr(`/records/${r.id}`, { method: 'PUT', body: { [k]: v } });
      upd(out);
    } catch (e) { toast(errMsg(e), 'err'); }
  }
  const cell = (r: any, k: string, w = 'w-16') => (editable || sim) && k !== 'vales'
    ? <input aria-label={k} className={`${w} rounded border border-slate-200 bg-white px-1 py-0.5 text-right tabular-nums outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-900 ${sim?.[r.id]?.[k] !== undefined ? 'border-violet-400 bg-violet-50 dark:bg-violet-900/30' : ''}`}
      defaultValue={Number(r[k]) || ''} key={`${r.id}-${k}-${r.updated_at}-${!!sim}`} onBlur={(e) => save(r, k, e.target.value.trim())} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    : <span className="tabular-nums">{Number(r[k]) ? num(r[k]) : ''}</span>;
  const m = (v: any, ov?: boolean) => <span className={`tabular-nums ${ov ? 'font-semibold text-violet-700 dark:text-violet-300' : ''}`} title={ov ? 'Manually adjusted' : undefined}>{Number(v) ? money(v) : <span className="text-slate-300">—</span>}</span>;
  const cols = [{ key: 'employee_name', label: 'Employee' }, { key: 'cedula', label: 'Cédula' }, { key: 'department_name', label: 'Department' }, { key: 'salary_type', label: 'Type' },
    { key: 'monthly_salary', label: 'Monthly salary' }, { key: 'hourly_rate', label: 'Hourly rate' }, { key: 'hours', label: 'Hours' }, { key: 'overtime_hours', label: 'OT hours' },
    { key: 'gross', label: 'Gross' }, { key: 'overtime_pay', label: 'Overtime' }, { key: 'holiday_pay', label: 'Holiday' }, { key: 'vacation_pay', label: 'Vacation' }, { key: 'bonus', label: 'Bonus' },
    { key: 'caja', label: 'CAJA' }, { key: 'payroll_expense', label: 'Pay expense' }, { key: 'accounts_amount', label: 'Cuentas' }, { key: 'accounts_deduction', label: 'Con descuento' },
    { key: 'vales', label: 'Vales' }, { key: 'adjustments', label: 'Adjustments' }, { key: 'other_deductions', label: 'Other deductions' }, { key: 'net_payable', label: 'Total pagado' },
    { key: 'payment_method', label: 'Paid by' }, { key: 'bank_group', label: 'Bank' }];
  if (!recs.length) return <Empty>No employees in this payroll. Use “Add employees”.</Empty>;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input className="input w-60 py-1.5" placeholder="Filter employees…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-xs text-slate-500">{editable ? 'Edit the white cells; amounts recalculate immediately. Click a name for the full calculation, overrides and advances.' : 'Click a name for the calculation details.'}</span>
        <div className="ml-auto"><ExportButtons name={`payroll-${P.code}`} rows={rows} cols={cols} /></div>
      </div>
      <div className="card overflow-x-auto">
        <table className="table text-xs">
          <thead><tr>
            <th className="sticky left-0 z-10 bg-white dark:bg-slate-900">Employee</th><th className="text-right">Rate</th><th className="text-right">Hours</th><th className="text-right">OT h</th><th className="text-right">Holiday</th><th className="text-right">Vac. d</th>
            <th className="text-right">Gross</th><th className="text-right">Overtime</th><th className="text-right">Holiday</th><th className="text-right">Vacation</th><th className="text-right">Bonus</th><th className="text-right">CAJA</th>
            <th className="text-right">Pay expense</th><th className="text-right">Cuentas</th><th className="text-right">Acc. ded.</th><th className="text-right">Vales</th><th className="text-right">Adj.</th><th className="text-right">Other</th>
            <th className="text-right">Net payable</th><th>Status</th>
          </tr></thead>
          <tbody>{rows.map((r) => {
            const err = (r.warnings || []).some((w: any) => w.level === 'error');
            const warn = (r.warnings || []).length > 0;
            const ov = r.overrides || {};
            return (
              <tr key={r.id} className={err ? 'bg-rose-50/60 dark:bg-rose-900/10' : ''}>
                <td className="sticky left-0 z-10 bg-white whitespace-nowrap dark:bg-slate-900">
                  <button className="text-left font-medium hover:underline" onClick={() => openRec(r.id)}>{r.employee_name}</button>
                  {warn && <span title={(r.warnings || []).map((w: any) => w.message).join('\n')}>{err ? <AlertTriangle size={12} className="ml-1 inline text-rose-600" /> : <Info size={12} className="ml-1 inline text-amber-500" />}</span>}
                  <div className="text-[10px] text-slate-400">{r.department_name} · {r.salary_type}{r.insurance_method === 'none' ? ' · no CAJA' : r.insurance_method === 'fixed' ? ' · fixed ins.' : ''}</div>
                </td>
                <td className="text-right tabular-nums">{r.salary_type === 'monthly' ? <>{money(r.monthly_salary)}<div className="text-[10px] text-slate-400">{money(r.calc?.hourly_equivalent)}/h</div></> : <>{money(r.hourly_rate)}/h</>}</td>
                <td className="text-right">{cell(r, 'hours')}</td>
                <td className="text-right">{cell(r, 'overtime_hours', 'w-12')}</td>
                <td className="text-right">{(() => { const k = r.salary_type === 'monthly' ? 'holiday_days' : 'holiday_hours'; return (editable || sim || Number(r[k])) ? <span className="whitespace-nowrap">{cell(r, k, k === 'holiday_days' ? 'w-10' : 'w-12')}<span className="text-[10px] text-slate-400"> {k === 'holiday_days' ? 'd' : 'h'}</span></span> : null; })()}</td>
                <td className="text-right">{cell(r, 'vacation_days', 'w-10')}</td>
                <td className="text-right">{m(r.gross, !!ov.gross)}</td>
                <td className="text-right">{m(Number(r.overtime_pay) + Number(r.excess_premium || 0), !!ov.overtime_pay)}</td>
                <td className="text-right">{m(r.holiday_pay, !!ov.holiday_pay)}</td>
                <td className="text-right">{m(r.vacation_pay, !!ov.vacation_pay)}</td>
                <td className="text-right">{cell(r, 'bonus', 'w-20')}</td>
                <td className="text-right">{m(r.caja, !!ov.caja)}</td>
                <td className="text-right font-medium">{m(r.payroll_expense)}</td>
                <td className="text-right">{cell(r, 'accounts_amount', 'w-20')}</td>
                <td className="text-right">{m(r.accounts_deduction, !!ov.accounts_deduction)}<div className="text-[10px] text-slate-400">{Number(r.accounts_amount) ? `${num(r.accounts_pct)}%` : ''}</div></td>
                <td className="text-right">{sim ? m(r.vales) : <button className="hover:underline" onClick={() => openRec(r.id)}>{m(r.vales)}</button>}</td>
                <td className="text-right">{m(r.adjustments)}</td>
                <td className="text-right">{cell(r, 'other_deductions', 'w-16')}</td>
                <td className="text-right text-sm font-semibold">{m(r.net_payable)}{sim && Math.abs(r.net_payable - r._actualNet) > 0.004 && <div className={`text-[10px] ${r.net_payable > r._actualNet ? 'text-emerald-600' : 'text-rose-600'}`}>{r.net_payable > r._actualNet ? '+' : ''}{money(r.net_payable - r._actualNet)}</div>}</td>
                <td>{P.locked ? <PayBadge status={r.payment_status} /> : <span className="text-[10px] text-slate-400 capitalize">{r.hours_source || ''}</span>}</td>
              </tr>
            );
          })}</tbody>
          <tfoot><tr className="font-semibold">
            <td className="sticky left-0 bg-white dark:bg-slate-900">Totals ({rows.length})</td><td /><td className="text-right tabular-nums">{num(rows.reduce((s, r) => s + Number(r.hours), 0))}</td><td className="text-right tabular-nums">{num(rows.reduce((s, r) => s + Number(r.overtime_hours), 0))}</td><td /><td />
            {['gross', 'overtime_pay', 'holiday_pay', 'vacation_pay', 'bonus', 'caja', 'payroll_expense', 'accounts_amount', 'accounts_deduction', 'vales', 'adjustments', 'other_deductions', 'net_payable'].map((k) => <td key={k} className="text-right tabular-nums">{money(rows.reduce((s, r) => s + Number(r[k] || 0), 0))}</td>)}
            <td />
          </tr></tfoot>
        </table>
      </div>
    </div>
  );
}

function DeptTable({ rows }: { rows: any[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="table">
        <thead><tr><th>Department</th><th className="text-right">Employees</th><th className="text-right">Gross</th><th className="text-right">Overtime</th><th className="text-right">CAJA</th><th className="text-right">Payroll expense</th><th className="text-right">Deductions</th><th className="text-right">Net payable</th><th className="text-right">Paid</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.department}><td className="font-medium">{r.department}</td><td className="text-right">{r.employees}</td>{['gross', 'overtime', 'caja', 'payroll_expense', 'total_deductions', 'net_payable', 'paid'].map((k) => <td key={k} className="text-right tabular-nums">{money(r[k])}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- Record detail: calculation lines, overrides, vales, accounts, adjustments
function RecordDrawer({ id, editable, onClose, onChanged }: { id: string; editable: boolean; onClose: () => void; onChanged: (r: any) => void }) {
  const toast = useToast();
  const { data: r, loading, reload } = useAsync(() => pr(`/records/${id}`), [id]);
  const [ov, setOv] = useState<{ key: OverrideKey; value: string; reason: string } | null>(null);
  const [plan, setPlan] = useState<Record<string, string> | null>(null);
  useEffect(() => { if (r) setPlan(Object.fromEntries((r.vales_plan || []).map((v: any) => [v.advance_id, String(v.amount)]))); }, [r]);
  async function saveOverride(clear = false) {
    try {
      const out = await pr(`/records/${id}/override`, { body: clear ? { key: ov!.key, value: null } : ov });
      setOv(null); onChanged(out); reload(); toast(clear ? 'Manual adjustment removed' : 'Manual adjustment saved');
    } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function savePlan() {
    try {
      const vales_plan = Object.entries(plan || {}).map(([advance_id, amount]) => ({ advance_id, amount: Number(amount) || 0 }));
      const out = await pr(`/records/${id}`, { method: 'PUT', body: { vales_plan } });
      onChanged(out); reload(); toast('Advance recoveries saved');
    } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function addAccount(f: HTMLFormElement) {
    const d = Object.fromEntries(new FormData(f)) as any;
    try { await pr('/accounts', { body: { ...d, employee_id: r.employee_id, period_id: r.period_id } }); f.reset(); const out = await pr(`/records/${id}`); onChanged(out); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function delAccount(aid: string) {
    try { await pr(`/accounts/${aid}`, { method: 'DELETE' }); const out = await pr(`/records/${id}`); onChanged(out); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  return (
    <Modal open onClose={onClose} size="xl" title={r ? `${r.employee_name} · ${r.period?.code}` : 'Loading…'}
      footer={r && <><button className="btn-secondary mr-auto" onClick={() => openPdf(`/records/${id}/payslip.pdf`).catch((e) => toast(errMsg(e), 'err'))}><FileText size={15} />Payslip PDF</button><button className="btn-primary" onClick={onClose}>Close</button></>}>
      {loading || !r ? <Spinner /> : (
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <div className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Calculation</div>
            <div className="mb-2 text-xs text-slate-500">{r.salary_type === 'monthly' ? `Monthly ${money(r.monthly_salary)}` : `Hourly ${money(r.hourly_rate)}`} · {r.department_name || 'No department'} · CAJA: {r.insurance_method === 'none' ? 'not insured' : r.insurance_method === 'fixed' ? `fixed on ${money(r.insurance_salary)}` : 'percentage'} · accounts {num(r.accounts_pct)}%</div>
            <table className="table text-xs">
              <tbody>{(r.calc?.lines || []).map((l: any) => (
                <tr key={l.key} className={l.key === 'net_payable' || l.key === 'payroll_expense' ? 'font-semibold' : ''}>
                  <td>{l.label}{l.overridden && <Badge color="brand">adjusted</Badge>}</td>
                  <td className="text-slate-500">{l.formula}</td>
                  <td className="text-right tabular-nums">{money(l.value)}</td>
                  <td className="w-8">{editable && (OVERRIDE_KEYS as readonly string[]).includes(l.key) && <button className="btn-ghost px-1 py-0.5 text-[10px]" onClick={() => setOv({ key: l.key, value: String(l.value), reason: r.overrides?.[l.key]?.reason || '' })}>Adjust</button>}</td>
                </tr>
              ))}</tbody>
            </table>
            {editable && <div className="mt-2 flex flex-wrap gap-1">{OVERRIDE_KEYS.filter((k) => !(r.calc?.lines || []).some((l: any) => l.key === k)).map((k) => <button key={k} className="btn-ghost px-2 py-0.5 text-[11px]" onClick={() => setOv({ key: k, value: '', reason: '' })}>+ {OVERRIDE_LABELS[k]}</button>)}</div>}
            {Object.keys(r.overrides || {}).length > 0 && (
              <div className="mt-3 rounded-lg bg-slate-50 p-2 text-xs dark:bg-slate-800/50">
                <div className="mb-1 font-medium">Manual adjustments</div>
                {Object.entries(r.overrides).map(([k, v]: any) => <div key={k}>{OVERRIDE_LABELS[k as OverrideKey]}: calculated {money(v.original)} → <b>{money(v.value)}</b> — “{v.reason}” ({v.by_name}, {dt(v.at)})</div>)}
              </div>
            )}
            {(r.warnings || []).length > 0 && <ul className="mt-3 space-y-0.5 text-xs">{r.warnings.map((w: any, i: number) => <li key={i} className={w.level === 'error' ? 'text-rose-600' : 'text-amber-700 dark:text-amber-400'}>• {w.message}</li>)}</ul>}
          </div>
          <div className="space-y-5">
            <section>
              <div className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Vales / advance recovery</div>
              {!r.advances.length ? <p className="text-xs text-slate-400">No approved advances with a balance.</p> : (
                <table className="table text-xs">
                  <thead><tr><th>Advance</th><th className="text-right">Outstanding</th><th className="text-right">Deduct now</th></tr></thead>
                  <tbody>{r.advances.map((a: any) => (
                    <tr key={a.id}><td>{d10(a.advance_date)} · {money(a.amount)}<div className="text-[10px] text-slate-400">{a.reason} · {a.deduction_per_payroll ? `${money(a.deduction_per_payroll)}/payroll` : 'full'}</div></td>
                      <td className="text-right tabular-nums">{money(a.outstanding)}</td>
                      <td className="text-right">{editable ? <input className="input w-28 py-1 text-right" type="number" value={plan?.[a.id] ?? ''} onChange={(e) => setPlan({ ...(plan || {}), [a.id]: e.target.value })} /> : money(plan?.[a.id] || 0)}</td></tr>
                  ))}</tbody>
                </table>
              )}
              {editable && r.advances.length > 0 && <button className="btn-secondary mt-2 px-3 py-1 text-xs" onClick={savePlan}>Save recoveries</button>}
            </section>
            <section>
              <div className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Cuentas (accounts) — {num(r.accounts_pct)}% deducted</div>
              {r.accounts.map((a: any) => <div key={a.id} className="flex items-center justify-between border-b border-slate-100 py-1 text-xs dark:border-slate-800"><span>{d10(a.entry_date)} · {a.description || a.source}</span><span className="flex items-center gap-2 tabular-nums">{money(a.amount)}{editable && <button className="text-rose-600" onClick={() => delAccount(a.id)} aria-label="Remove"><X size={12} /></button>}</span></div>)}
              {editable && <form className="mt-2 flex gap-1" onSubmit={(e) => { e.preventDefault(); addAccount(e.currentTarget); }}>
                <input name="description" className="input py-1 text-xs" placeholder="Description (e.g. bar tab 12 Oct)" /><input name="amount" type="number" className="input w-28 py-1 text-xs" placeholder="Amount" required /><button className="btn-secondary px-2 py-1 text-xs">Add</button>
              </form>}
            </section>
            {r.adjustments.length > 0 && <section>
              <div className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Adjustments paid in this payroll</div>
              {r.adjustments.map((a: any) => <div key={a.id} className="flex justify-between text-xs"><span>{a.reason} <span className="text-slate-400">({a.period_code})</span> <ReqBadge status={a.status} /></span><span className="tabular-nums">{money(a.difference)}</span></div>)}
            </section>}
            {r.payments.length > 0 && <section>
              <div className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Payments</div>
              {r.payments.map((p: any) => <div key={p.id} className={`flex justify-between text-xs ${p.voided ? 'text-slate-400 line-through' : ''}`}><span>{d10(p.payment_date)} · {PAYMENT_METHODS[p.method] || p.method} {p.reference}</span><span className="tabular-nums">{p.currency === 'USD' ? `US$${num(p.amount)} = ` : ''}{money(p.amount_crc)}</span></div>)}
            </section>}
          </div>
        </div>
      )}
      <Modal open={!!ov} onClose={() => setOv(null)} size="sm" title={ov ? `Adjust ${OVERRIDE_LABELS[ov.key]}` : ''}
        footer={<>{ov && r?.overrides?.[ov.key] && <button className="btn-ghost mr-auto text-rose-600" onClick={() => saveOverride(true)}>Remove</button>}<button className="btn-secondary" onClick={() => setOv(null)}>Cancel</button><button className="btn-primary" onClick={() => saveOverride()}>Save</button></>}>
        {ov && <div className="space-y-3">
          <p className="text-xs text-slate-500">Calculated: {money(r?.calc?.calculated?.[ov.key] ?? 0)}. The original amount and your reason are kept in the audit history.</p>
          <Field label="Adjusted amount"><input className="input" type="number" value={ov.value} onChange={(e) => setOv({ ...ov, value: e.target.value })} autoFocus /></Field>
          <Field label="Reason *"><input className="input" value={ov.reason} onChange={(e) => setOv({ ...ov, reason: e.target.value })} /></Field>
        </div>}
      </Modal>
    </Modal>
  );
}

function AddEmployees({ P, onClose, onDone }: { P: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const emps = useAsync(() => pr<any[]>('/employees'), []);
  const [sel, setSel] = useState<string[]>([]);
  const inIds = new Set(P.records.map((r: any) => r.employee_id));
  const list = (emps.data || []).filter((e) => !inIds.has(e.id) && e.status !== 'inactive');
  async function add() {
    try { const r = await pr(`/periods/${P.id}/employees`, { body: { employee_ids: sel } }); toast(`${r.added} added`); onDone(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  return (
    <Modal open onClose={onClose} title="Add employees" footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!sel.length} onClick={add}>Add {sel.length || ''}</button></>}>
      {!list.length ? <Empty>Every employee is already included</Empty> : list.map((e) => <label key={e.id} className="flex items-center gap-2 py-1 text-sm"><input type="checkbox" checked={sel.includes(e.id)} onChange={() => setSel(sel.includes(e.id) ? sel.filter((x) => x !== e.id) : [...sel, e.id])} />{e.full_name}<span className="text-xs text-slate-400">{e.department_name}</span></label>)}
    </Modal>
  );
}

function ActionDialog({ d, P, validation, onClose, onConfirm }: { d: { action: string; title: string; reason?: boolean }; P: any; validation: any; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const T = P.totals;
  return (
    <Modal open onClose={onClose} title={d.title} footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className={d.action === 'reject' || d.action === 'reopen' ? 'btn-danger' : 'btn-primary'} disabled={!!d.reason && !reason.trim()} onClick={() => onConfirm(reason)}>Confirm</button></>}>
      {d.action === 'approve' && <div className="space-y-2 text-sm">
        <p>{T.employees} employees · payroll expense <b>{money(T.payroll_expense)}</b> · net payable <b>{money(T.net_payable)}</b>.</p>
        {validation?.warnings > 0 && <p className="text-amber-700 dark:text-amber-400">{validation.warnings} warning(s) — review them before approving.</p>}
        <p className="text-slate-500">After approval the payroll is locked, advance recoveries are posted to the advance ledgers and vacation days are deducted. Payments and payslips become available.</p>
      </div>}
      {d.action === 'reopen' && <p className="mb-2 text-sm text-slate-500">Reopening unlocks the payroll and reverses the posted advance recoveries and vacation days. It is recorded in the audit log.</p>}
      {d.action === 'close' && <p className="text-sm text-slate-500">A closed payroll can only be changed through an authorised reopening.</p>}
      {d.reason && <Field label="Reason *"><textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>}
    </Modal>
  );
}

// ---------------------------------------------------------------- Payments
function PaymentsTab({ P, recs, reload }: { P: any; recs: any[]; reload: () => void }) {
  const toast = useToast();
  const { can } = useSession();
  const pays = useAsync(() => pr<any[]>(`/payments?period_id=${P.id}`), [P.id, P.totals.paid]);
  const [pay, setPay] = useState<any>(null);
  const [bulk, setBulk] = useState<any>(null);
  const canPay = can('payroll.payments') && ['approved', 'partially_paid'].includes(P.status);
  async function save() {
    try { await pr('/payments', { body: pay }); toast('Payment recorded'); setPay(null); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function saveBulk() {
    try { const r = await pr('/payments/bulk', { body: { ...bulk, period_id: P.id, method: bulk.method || undefined } }); toast(`${r.count} payment(s) recorded`); setBulk(null); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function voidPay(p: any) {
    const reason = prompt(`Void payment of ${money(p.amount_crc)} to ${p.full_name}? Reason:`);
    if (!reason) return;
    try { await pr(`/payments/${p.id}/void`, { body: { reason } }); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  const byMethod = recs.reduce((m: any, r) => { const k = r.payment_method || 'other'; m[k] = (m[k] || 0) + Math.max(0, r.net_payable - r.paid_amount); return m; }, {});
  return (
    <div className="space-y-4">
      {!P.locked && <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600 dark:bg-slate-800/50 dark:text-slate-300">Payments can be recorded once the payroll is approved.</div>}
      {canPay && <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" onClick={() => setBulk({ method: '', payment_date: today(), reference: '' })}><Banknote size={16} />Pay remaining balances</button>
        {Object.entries(byMethod).filter(([, v]) => (v as number) > 0).map(([k, v]) => <Badge key={k}>{PAYMENT_METHODS[k] || k}: {money(v)}</Badge>)}
      </div>}
      <div className="card overflow-x-auto">
        <table className="table text-sm">
          <thead><tr><th>Employee</th><th>Method</th><th>Bank / account</th><th className="text-right">Net payable</th><th className="text-right">Paid</th><th className="text-right">Remaining</th><th>Status</th><th /></tr></thead>
          <tbody>{recs.map((r) => (
            <tr key={r.id}><td className="font-medium">{r.employee_name}</td><td>{PAYMENT_METHODS[r.payment_method] || r.payment_method}</td><td className="text-xs">{r.bank_group} {r.bank_account}</td>
              <td className="text-right tabular-nums">{money(r.net_payable)}</td><td className="text-right tabular-nums">{money(r.paid_amount)}</td><td className="text-right tabular-nums">{money(Math.max(0, r.net_payable - r.paid_amount))}</td>
              <td><PayBadge status={r.payment_status} /></td>
              <td>{canPay && r.payment_status !== 'paid' && <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setPay({ record_id: r.id, name: r.employee_name, remaining: Math.round((r.net_payable - r.paid_amount) * 100) / 100, amount: Math.round((r.net_payable - r.paid_amount) * 100) / 100, currency: r.payment_method === 'usd' ? 'USD' : 'CRC', method: r.payment_method, bank: r.bank_group || '', account_ref: r.bank_account || '', payment_date: today(), reference: '' })}>Record payment</button>}</td></tr>
          ))}</tbody>
        </table>
      </div>
      <div>
        <div className="mb-2 flex items-center justify-between"><div className="text-sm font-semibold">Payment transactions</div><ExportButtons name={`payments-${P.code}`} rows={pays.data || []} cols={[{ key: 'payment_date', label: 'Date' }, { key: 'full_name', label: 'Employee' }, { key: 'method', label: 'Method' }, { key: 'bank', label: 'Bank' }, { key: 'account_ref', label: 'Account' }, { key: 'currency', label: 'Currency' }, { key: 'amount', label: 'Amount' }, { key: 'exchange_rate', label: 'Rate' }, { key: 'amount_crc', label: 'CRC' }, { key: 'reference', label: 'Reference' }]} /></div>
        <div className="card overflow-x-auto">
          {!pays.data?.length ? <Empty>No payments yet</Empty> : (
            <table className="table text-sm">
              <thead><tr><th>Date</th><th>Employee</th><th>Method</th><th>Reference</th><th className="text-right">Amount</th><th className="text-right">CRC</th><th>By</th><th /></tr></thead>
              <tbody>{pays.data.map((p) => (
                <tr key={p.id} className={p.voided ? 'text-slate-400 line-through' : ''}><td>{d10(p.payment_date)}</td><td>{p.full_name}</td><td>{PAYMENT_METHODS[p.method] || p.method} {p.bank}</td><td className="text-xs">{p.reference}</td>
                  <td className="text-right tabular-nums">{p.currency === 'USD' ? `US$${num(p.amount)} @ ${num(p.exchange_rate)}` : money(p.amount)}</td><td className="text-right tabular-nums">{money(p.amount_crc)}</td><td className="text-xs">{p.created_by_name}</td>
                  <td>{!p.voided && can('payroll.payments') && P.status !== 'closed' && <button className="btn-ghost px-2 py-0.5 text-xs text-rose-600" onClick={() => voidPay(p)}>Void</button>}{p.voided && <span className="text-xs no-underline">{p.void_reason}</span>}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </div>
      <Modal open={!!pay} onClose={() => setPay(null)} title={`Payment · ${pay?.name}`} footer={<><button className="btn-secondary" onClick={() => setPay(null)}>Cancel</button><button className="btn-primary" onClick={save}>Record</button></>}>
        {pay && <div className="grid gap-3 sm:grid-cols-2">
          <p className="text-sm text-slate-500 sm:col-span-2">Remaining {money(pay.remaining)}. Partial payments are allowed; record more payments later.</p>
          <Field label="Currency"><select className="input" value={pay.currency} onChange={(e) => setPay({ ...pay, currency: e.target.value, amount: e.target.value === 'USD' ? '' : pay.remaining })}><option>CRC</option><option>USD</option></select></Field>
          <Field label={`Amount (${pay.currency})`} hint={pay.currency === 'USD' ? 'Blank = remaining at the rate' : undefined}><input className="input" type="number" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
          {pay.currency === 'USD' && <Field label="Exchange rate (₡ per US$)" hint="Blank = rate on file for the payment date"><input className="input" type="number" value={pay.exchange_rate || ''} onChange={(e) => setPay({ ...pay, exchange_rate: e.target.value })} /></Field>}
          <Field label="Method"><select className="input" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Bank"><select className="input" value={pay.bank} onChange={(e) => setPay({ ...pay, bank: e.target.value })}><option value="">—</option><option>BCR</option><option>Non-BCR</option><option>Other</option></select></Field>
          <Field label="Account"><input className="input" value={pay.account_ref} onChange={(e) => setPay({ ...pay, account_ref: e.target.value })} /></Field>
          <Field label="Payment date"><input className="input" type="date" value={pay.payment_date} onChange={(e) => setPay({ ...pay, payment_date: e.target.value })} /></Field>
          <Field label="Transaction reference"><input className="input" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>
          <Field label="Notes" className="sm:col-span-2"><input className="input" value={pay.notes || ''} onChange={(e) => setPay({ ...pay, notes: e.target.value })} /></Field>
        </div>}
      </Modal>
      <Modal open={!!bulk} onClose={() => setBulk(null)} title="Pay remaining balances" footer={<><button className="btn-secondary" onClick={() => setBulk(null)}>Cancel</button><button className="btn-primary" onClick={saveBulk}>Record payments</button></>}>
        {bulk && <div className="grid gap-3 sm:grid-cols-2">
          <p className="text-sm text-slate-500 sm:col-span-2">Records one full payment of the remaining balance for every employee, using each employee's payment method (USD employees at the rate on file).</p>
          <Field label="Only employees paid by"><select className="input" value={bulk.method} onChange={(e) => setBulk({ ...bulk, method: e.target.value })}><option value="">All methods</option>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Payment date"><input className="input" type="date" value={bulk.payment_date} onChange={(e) => setBulk({ ...bulk, payment_date: e.target.value })} /></Field>
          <Field label="Reference (e.g. bank batch)" className="sm:col-span-2"><input className="input" value={bulk.reference} onChange={(e) => setBulk({ ...bulk, reference: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------- Payslips
function PayslipsTab({ P, recs, reload }: { P: any; recs: any[]; reload: () => void }) {
  const toast = useToast();
  const { can } = useSession();
  const [sel, setSel] = useState<string[]>([]);
  const pdf = (path: string) => openPdf(path).catch((e) => toast(errMsg(e), 'err'));
  async function email(ids: string[] = [], onlyUnsent = true) {
    try {
      const r = await pr(`/periods/${P.id}/email`, { body: { record_ids: ids, only_unsent: onlyUnsent } });
      toast(`${r.queued} payslip email(s) queued${r.skipped.length ? `; no email address: ${r.skipped.join(', ')}` : ''}`);
      setTimeout(reload, 2500);
    } catch (e) { toast(errMsg(e), 'err'); }
  }
  return (
    <div>
      {!P.locked && <div className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">Payslips of a payroll that is not approved are marked as drafts. Email is available after approval.</div>}
      <div className="mb-3 flex flex-wrap gap-2">
        <button className="btn-secondary" onClick={() => pdf(`/periods/${P.id}/payslips.pdf${sel.length ? `?ids=${sel.join(',')}` : ''}`)}><FileText size={16} />{sel.length ? `PDF for ${sel.length} selected` : 'All payslips (PDF)'}</button>
        {P.locked && (can('payroll.process') || can('payroll.payments')) && <button className="btn-primary" onClick={() => email(sel, !sel.length)}><Mail size={16} />{sel.length ? `Email ${sel.length} selected` : 'Email all not yet sent'}</button>}
      </div>
      <div className="card overflow-x-auto">
        <table className="table text-sm">
          <thead><tr><th className="w-8"><input type="checkbox" aria-label="Select all" checked={sel.length === recs.length && recs.length > 0} onChange={(e) => setSel(e.target.checked ? recs.map((r) => r.id) : [])} /></th><th>Employee</th><th>Email</th><th className="text-right">Net payable</th><th>Payment</th><th>Email status</th><th /></tr></thead>
          <tbody>{recs.map((r) => (
            <tr key={r.id}>
              <td><input type="checkbox" aria-label={r.employee_name} checked={sel.includes(r.id)} onChange={() => setSel(sel.includes(r.id) ? sel.filter((x) => x !== r.id) : [...sel, r.id])} /></td>
              <td className="font-medium">{r.employee_name}</td><td className="text-xs">{r.employee_email || <span className="text-amber-600">no email</span>}</td>
              <td className="text-right tabular-nums">{money(r.net_payable)}</td><td><PayBadge status={r.payment_status} /></td>
              <td>{r.email ? <span title={r.email.error || ''}><ReqBadge status={r.email.status} />{r.email.sent_at && <span className="ml-1 text-xs text-slate-400">{dt(r.email.sent_at)}</span>}</span> : <Badge>Not sent</Badge>}</td>
              <td className="whitespace-nowrap text-right"><button className="btn-ghost p-1.5" onClick={() => pdf(`/records/${r.id}/payslip.pdf`)} aria-label="Payslip PDF"><FileText size={15} /></button>
                {P.locked && r.employee_email && <button className="btn-ghost p-1.5" onClick={() => email([r.id], false)} aria-label="Email payslip"><Mail size={15} /></button>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Compare & history
const FLAG: Record<string, string> = { new: 'New', missing: 'Not in this payroll', salary_up: 'Salary ↑', salary_down: 'Salary ↓', hours_down: 'Hours ↓', deductions_up: 'Deductions ↑', overtime_change: 'Overtime change', unusual_variance: 'Unusual variance' };
function Compare({ P }: { P: any }) {
  const periods = useAsync(() => pr<any[]>('/periods'), []);
  const [other, setOther] = useState('');
  const { data, loading } = useAsync(() => pr(`/periods/${P.id}/compare${other ? `?with=${other}` : ''}`), [other]);
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-sm">Compare with
        <select className="input w-auto py-1.5" value={other || data?.other?.id || ''} onChange={(e) => setOther(e.target.value)}>{periods.data?.filter((p) => p.id !== P.id).map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select>
      </div>
      {loading ? <Spinner /> : !data?.other ? <Empty>No earlier payroll to compare with</Empty> : (
        <div className="space-y-4">
          <div className="card overflow-x-auto"><table className="table text-sm"><thead><tr><th>Department</th><th className="text-right">{data.other.code}</th><th className="text-right">{P.code}</th><th className="text-right">Change</th></tr></thead>
            <tbody>{data.departments.map((d: any) => <tr key={d.department}><td>{d.department}</td><td className="text-right tabular-nums">{money(d.previous)}</td><td className="text-right tabular-nums">{money(d.current)}</td><td className={`text-right tabular-nums ${d.diff > 0 ? 'text-rose-600' : d.diff < 0 ? 'text-emerald-600' : ''}`}>{d.diff > 0 ? '+' : ''}{money(d.diff)}</td></tr>)}</tbody></table></div>
          <div className="card overflow-x-auto"><table className="table text-xs">
            <thead><tr><th>Employee</th><th className="text-right">Hours</th><th className="text-right">Δ hours</th><th className="text-right">Δ OT h</th><th className="text-right">Δ gross</th><th className="text-right">Δ deductions</th><th className="text-right">Net {data.other.code}</th><th className="text-right">Net {P.code}</th><th className="text-right">Δ net</th><th>Flags</th></tr></thead>
            <tbody>{data.rows.map((r: any) => (
              <tr key={r.employee_id} className={r.flags.length ? '' : 'text-slate-500'}><td className="font-medium">{r.employee_name}<div className="text-[10px] text-slate-400">{r.department_name}</div></td>
                <td className="text-right">{num(r.current?.hours)}</td><td className="text-right">{num(r.diff.hours)}</td><td className="text-right">{num(r.diff.overtime_hours)}</td><td className="text-right tabular-nums">{money(r.diff.gross)}</td><td className="text-right tabular-nums">{money(r.diff.total_deductions)}</td>
                <td className="text-right tabular-nums">{money(r.previous?.net_payable || 0)}</td><td className="text-right tabular-nums">{money(r.current?.net_payable || 0)}</td><td className="text-right font-medium tabular-nums">{money(r.diff.net_payable)}</td>
                <td>{r.flags.map((f: string) => <Badge key={f} color={f === 'unusual_variance' || f === 'deductions_up' ? 'amber' : 'slate'}>{FLAG[f]}</Badge>)}</td></tr>
            ))}</tbody></table></div>
        </div>
      )}
    </div>
  );
}

function History({ id }: { id: string }) {
  const { data, loading } = useAsync(() => pr<any[]>(`/audit?entity_id=${id}`), [id]);
  return (
    <div className="card overflow-x-auto">
      {loading ? <Spinner /> : !data?.length ? <Empty>No history</Empty> : (
        <table className="table text-sm"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>{data.map((a) => <tr key={a.id}><td className="whitespace-nowrap">{dt(a.created_at)}</td><td>{a.user_name}</td><td>{a.action.replace(/^payroll_/, '').replace(/_/g, ' ')}</td><td className="max-w-xl truncate text-xs text-slate-500" title={JSON.stringify(a.details)}>{a.details?.reason || a.details?.to ? `${a.details.from ?? ''} → ${a.details.to ?? ''} ${a.details.reason ?? ''}` : JSON.stringify(a.details)}</td></tr>)}</tbody></table>
      )}
    </div>
  );
}

