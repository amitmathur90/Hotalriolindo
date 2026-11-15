import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { money } from '../../lib/format';
import { Empty, Field, Modal, PageHeader, Spinner, Tabs, Toggle, useAsync, useToast } from '../../components/ui';
import { useSession } from '../../backoffice/BackOffice';
import { ExportButtons } from '../../backoffice/widgets';
import { ADJUSTMENT_TYPES, PAYMENT_METHODS } from '../../../../shared/payroll';
import { ReqBadge, d10, errMsg, pr, today } from '../lib';

export default function Advances() {
  const [tab, setTab] = useState<'adv' | 'acc' | 'adj'>('adv');
  return (
    <div>
      <PageHeader title="Advances & deductions" subtitle="Vales (advances) are recovered through payroll; cuentas are partly deducted; adjustments correct earlier payroll" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'adv', label: 'Advances (vales)' }, { id: 'acc', label: 'Accounts (cuentas)' }, { id: 'adj', label: 'Adjustment register' }]} />
      {tab === 'adv' && <AdvanceList />}
      {tab === 'acc' && <Accounts />}
      {tab === 'adj' && <Adjustments />}
    </div>
  );
}

function useEmployees() { return useAsync(() => pr<any[]>('/employees'), []); }

function AdvanceList() {
  const toast = useToast();
  const { can } = useSession();
  const [status, setStatus] = useState('');
  const { data, loading, reload } = useAsync(() => pr<any[]>(`/advances${status ? `?status=${status}` : ''}`), [status]);
  const emps = useEmployees();
  const [n, setN] = useState<any>(null);
  const [ledger, setLedger] = useState<any>(null);
  const [repay, setRepay] = useState<any>(null);
  async function create() {
    try { await pr('/advances', { body: n }); toast(n.approve ? 'Advance recorded and approved' : 'Advance request created'); setN(null); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function decide(a: any, approve: boolean) {
    const reason = approve ? '' : prompt('Reason for rejecting:') || '';
    if (!approve && !reason) return;
    try { await pr(`/advances/${a.id}/decision`, { body: { approve, reason } }); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function showLedger(a: any) { setLedger(await pr(`/advances/${a.id}`)); }
  async function saveRepay() {
    try { await pr(`/advances/${repay.id}/repayment`, { body: repay }); toast('Recorded'); setRepay(null); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function cancel(a: any) {
    if (!confirm('Cancel this advance?')) return;
    try { await pr(`/advances/${a.id}/cancel`, { body: {} }); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  const totalOut = (data || []).filter((a) => a.status === 'approved').reduce((s, a) => s + Number(a.outstanding), 0);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select className="input w-auto py-1.5" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">All</option><option value="requested">Requested</option><option value="approved">Approved (open)</option><option value="repaid">Repaid</option><option value="rejected">Rejected</option></select>
        <span className="text-sm text-slate-500">Outstanding balance: <b>{money(totalOut)}</b></span>
        {can('payroll.advances') && <button className="btn-primary ml-auto" onClick={() => setN({ employee_id: '', amount: '', deduction_per_payroll: '', advance_date: today(), reason: '', payment_method: 'cash', approve: can('payroll.approve') })}><Plus size={16} />New advance</button>}
      </div>
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !data?.length ? <Empty>No advances</Empty> : (
          <table className="table text-sm">
            <thead><tr><th>Date</th><th>Employee</th><th>Reason</th><th>Paid by</th><th className="text-right">Amount</th><th className="text-right">Per payroll</th><th className="text-right">Recovered</th><th className="text-right">Outstanding</th><th className="text-right">Planned in open payroll</th><th>Status</th><th /></tr></thead>
            <tbody>{data.map((a) => (
              <tr key={a.id}>
                <td>{d10(a.advance_date)}</td><td className="font-medium">{a.employee?.full_name}<div className="text-xs text-slate-400">{a.employee?.department_name}</div></td><td className="text-xs">{a.reason}</td><td className="text-xs">{PAYMENT_METHODS[a.payment_method] || a.payment_method}<div className="text-slate-400">{a.issued_by_name}</div></td>
                <td className="text-right tabular-nums">{money(a.amount)}</td><td className="text-right tabular-nums">{a.deduction_per_payroll ? money(a.deduction_per_payroll) : 'Full'}</td>
                <td className="text-right tabular-nums">{money(a.amount - a.outstanding)}</td><td className="text-right font-medium tabular-nums">{money(a.outstanding)}</td><td className="text-right tabular-nums">{Number(a.planned) ? money(a.planned) : ''}</td>
                <td><ReqBadge status={a.status} />{a.approved_by_name && <div className="text-[10px] text-slate-400">{a.approved_by_name}</div>}</td>
                <td className="text-right whitespace-nowrap">
                  {a.status === 'requested' && can('payroll.approve') && <><button className="btn-ghost px-2 py-1 text-xs text-emerald-700" onClick={() => decide(a, true)}>Approve</button><button className="btn-ghost px-2 py-1 text-xs text-rose-600" onClick={() => decide(a, false)}>Reject</button></>}
                  {a.status === 'approved' && can('payroll.advances') && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setRepay({ id: a.id, amount: Math.round((a.outstanding - a.planned) * 100) / 100, kind: 'repayment_cash', note: '', txn_date: today() })}>Cash repayment</button>}
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => showLedger(a)}>Ledger</button>
                  {['requested', 'approved'].includes(a.status) && Number(a.amount) === Number(a.outstanding) && !Number(a.planned) && can('payroll.advances') && <button className="btn-ghost px-1 py-1 text-rose-600" onClick={() => cancel(a)} aria-label="Cancel"><Trash2 size={14} /></button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!n} onClose={() => setN(null)} title="New advance (vale)" footer={<><button className="btn-secondary" onClick={() => setN(null)}>Cancel</button><button className="btn-primary" onClick={create}>Save</button></>}>
        {n && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Employee *" className="sm:col-span-2"><select className="input" value={n.employee_id} onChange={(e) => setN({ ...n, employee_id: e.target.value })}><option value="">—</option>{emps.data?.filter((e) => e.status === 'active').map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}</select></Field>
          <Field label="Amount *"><input className="input" type="number" value={n.amount} onChange={(e) => setN({ ...n, amount: e.target.value })} /></Field>
          <Field label="Deduction per payroll" hint="Blank = recover all in the next payroll"><input className="input" type="number" value={n.deduction_per_payroll} onChange={(e) => setN({ ...n, deduction_per_payroll: e.target.value })} /></Field>
          <Field label="Date"><input className="input" type="date" value={n.advance_date} onChange={(e) => setN({ ...n, advance_date: e.target.value })} /></Field>
          <Field label="Paid by"><select className="input" value={n.payment_method} onChange={(e) => setN({ ...n, payment_method: e.target.value })}>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Reason" className="sm:col-span-2"><input className="input" value={n.reason} onChange={(e) => setN({ ...n, reason: e.target.value })} /></Field>
          {can('payroll.approve') && <div className="sm:col-span-2"><Toggle checked={n.approve} onChange={(v) => setN({ ...n, approve: v })} label="Approve now (I am authorising this advance)" /></div>}
        </div>}
      </Modal>
      <Modal open={!!repay} onClose={() => setRepay(null)} size="sm" title="Repayment outside payroll" footer={<><button className="btn-secondary" onClick={() => setRepay(null)}>Cancel</button><button className="btn-primary" onClick={saveRepay}>Save</button></>}>
        {repay && <div className="grid gap-3">
          <Field label="Type"><select className="input" value={repay.kind} onChange={(e) => setRepay({ ...repay, kind: e.target.value })}><option value="repayment_cash">Cash repayment</option><option value="write_off">Write-off</option></select></Field>
          <Field label="Amount"><input className="input" type="number" value={repay.amount} onChange={(e) => setRepay({ ...repay, amount: e.target.value })} /></Field>
          <Field label="Date"><input className="input" type="date" value={repay.txn_date} onChange={(e) => setRepay({ ...repay, txn_date: e.target.value })} /></Field>
          <Field label="Note"><input className="input" value={repay.note} onChange={(e) => setRepay({ ...repay, note: e.target.value })} /></Field>
        </div>}
      </Modal>
      <Modal open={!!ledger} onClose={() => setLedger(null)} title={`Advance ledger · ${ledger?.employee?.full_name}`}>
        {ledger && <table className="table text-sm">
          <thead><tr><th>Date</th><th>Entry</th><th className="text-right">Amount</th><th className="text-right">Balance</th></tr></thead>
          <tbody>
            <tr><td>{d10(ledger.advance_date)}</td><td>Advance issued — {ledger.reason}</td><td className="text-right tabular-nums">{money(ledger.amount)}</td><td className="text-right tabular-nums">{money(ledger.amount)}</td></tr>
            {ledger.txns.reduce((acc: any[], t: any) => { const bal = (acc.length ? acc[acc.length - 1].bal : Number(ledger.amount)) - Number(t.amount); acc.push({ ...t, bal }); return acc; }, []).map((t: any) => (
              <tr key={t.id}><td>{d10(t.txn_date)}</td><td>{t.kind === 'repayment_payroll' ? `Payroll ${t.period_code}` : t.kind === 'write_off' ? 'Write-off' : 'Cash repayment'}{t.note && t.kind !== 'repayment_payroll' ? ` — ${t.note}` : ''}</td><td className="text-right tabular-nums">−{money(t.amount)}</td><td className="text-right tabular-nums">{money(t.bal)}</td></tr>
            ))}
          </tbody>
        </table>}
      </Modal>
    </div>
  );
}

function usePeriods() { return useAsync(() => pr<any[]>('/periods'), []); }

function Accounts() {
  const toast = useToast();
  const { can } = useSession();
  const periods = usePeriods();
  const [period, setPeriod] = useState('');
  const pid = period || periods.data?.[0]?.id || '';
  const { data, loading, reload } = useAsync(() => (pid ? pr<any[]>(`/accounts?period_id=${pid}`) : Promise.resolve([])), [pid]);
  const emps = useEmployees();
  const [n, setN] = useState<any>(null);
  const per = periods.data?.find((p) => p.id === pid);
  const open = per && !['approved', 'partially_paid', 'paid', 'closed'].includes(per.status);
  async function add() {
    try { await pr('/accounts', { body: { ...n, period_id: pid } }); setN(null); reload(); toast('Saved'); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function del(a: any) {
    try { await pr(`/accounts/${a.id}`, { method: 'DELETE' }); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  const total = (data || []).reduce((s, a) => s + Number(a.amount), 0), ded = (data || []).reduce((s, a) => s + Number(a.employee_deduction), 0);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select className="input w-auto py-1.5" value={pid} onChange={(e) => setPeriod(e.target.value)} aria-label="Payroll">{periods.data?.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select>
        <span className="text-sm text-slate-500">Accounts {money(total)} · deducted from employees {money(ded)} · carried by the business {money(total - ded)}</span>
        {open && (can('payroll.advances') || can('payroll.process')) && <button className="btn-primary ml-auto" onClick={() => setN({ employee_id: '', amount: '', description: '', entry_date: today() })}><Plus size={16} />Add account entry</button>}
      </div>
      <p className="mb-2 text-xs text-slate-500">The deduction percentage comes from the employee, then the department, then the payroll rules (configurable — the workbook used 65%, 60% and 35%).</p>
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !data?.length ? <Empty>No accounts in this payroll</Empty> : (
          <table className="table text-sm">
            <thead><tr><th>Date</th><th>Employee</th><th>Description</th><th className="text-right">Amount</th><th className="text-right">Deduction %</th><th className="text-right">Employee deduction</th><th className="text-right">Business allocation</th><th>By</th><th /></tr></thead>
            <tbody>{data.map((a) => (
              <tr key={a.id}><td>{d10(a.entry_date)}</td><td className="font-medium">{a.full_name}</td><td className="text-xs">{a.description}</td><td className="text-right tabular-nums">{money(a.amount)}</td>
                <td className="text-right">{a.accounts_pct ?? '—'}%</td><td className="text-right tabular-nums">{money(a.employee_deduction)}</td><td className="text-right tabular-nums">{money(a.amount - a.employee_deduction)}</td><td className="text-xs">{a.created_by_name}</td>
                <td>{open && <button className="btn-ghost p-1 text-rose-600" onClick={() => del(a)} aria-label="Delete"><Trash2 size={14} /></button>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!n} onClose={() => setN(null)} title="Account entry" footer={<><button className="btn-secondary" onClick={() => setN(null)}>Cancel</button><button className="btn-primary" onClick={add}>Save</button></>}>
        {n && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Employee *" className="sm:col-span-2"><select className="input" value={n.employee_id} onChange={(e) => setN({ ...n, employee_id: e.target.value })}><option value="">—</option>{emps.data?.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}</select></Field>
          <Field label="Amount *"><input className="input" type="number" value={n.amount} onChange={(e) => setN({ ...n, amount: e.target.value })} /></Field>
          <Field label="Date"><input className="input" type="date" value={n.entry_date} onChange={(e) => setN({ ...n, entry_date: e.target.value })} /></Field>
          <Field label="Description" className="sm:col-span-2"><input className="input" value={n.description} onChange={(e) => setN({ ...n, description: e.target.value })} placeholder="Consumption at the bar, store purchase…" /></Field>
        </div>}
      </Modal>
    </div>
  );
}

function Adjustments() {
  const toast = useToast();
  const { can } = useSession();
  const { data, loading, reload } = useAsync(() => pr<any[]>('/adjustments'), []);
  const periods = usePeriods();
  const emps = useEmployees();
  const [n, setN] = useState<any>(null);
  const openPeriods = (periods.data || []).filter((p) => !['approved', 'partially_paid', 'paid', 'closed'].includes(p.status));
  async function create() {
    try { await pr('/adjustments', { body: { ...n, pay_in_period_id: n.pay_in_period_id || null } }); toast('Adjustment saved'); setN(null); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function decide(a: any, approve: boolean) {
    try { await pr(`/adjustments/${a.id}/decision`, { body: { approve } }); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function del(a: any) {
    if (!confirm('Delete this adjustment?')) return;
    try { await pr(`/adjustments/${a.id}`, { method: 'DELETE' }); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <ExportButtons name="payroll-adjustments" rows={data || []} cols={[{ key: 'created_at', label: 'Date' }, { key: 'full_name', label: 'Employee' }, { key: 'period_code', label: 'Payroll' }, { key: 'adj_type', label: 'Type' }, { key: 'original_amount', label: 'Original' }, { key: 'actual_amount', label: 'Actual' }, { key: 'difference', label: 'Difference' }, { key: 'reason', label: 'Reason' }, { key: 'payment_source', label: 'Payment source' }, { key: 'pay_in_code', label: 'Paid in' }, { key: 'created_by_name', label: 'Created by' }, { key: 'approved_by_name', label: 'Approved by' }, { key: 'status', label: 'Status' }]} />
        {can('payroll.process') && <button className="btn-primary" onClick={() => setN({ employee_id: '', period_id: periods.data?.[0]?.id || '', pay_in_period_id: openPeriods[0]?.id || '', adj_type: 'previous_correction', original_amount: '', actual_amount: '', reason: '', payment_source: 'payroll', approve: can('payroll.approve') })}><Plus size={16} />New adjustment</button>}
      </div>
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !data?.length ? <Empty>No adjustments</Empty> : (
          <table className="table text-sm">
            <thead><tr><th>Date</th><th>Employee</th><th>Payroll</th><th>Type</th><th className="text-right">Original</th><th className="text-right">Actual</th><th className="text-right">Difference</th><th>Reason</th><th>Paid</th><th>Created / approved</th><th>Status</th><th /></tr></thead>
            <tbody>{data.map((a) => (
              <tr key={a.id}><td>{d10(a.created_at)}</td><td className="font-medium">{a.full_name}</td><td>{a.period_code}</td><td className="text-xs">{ADJUSTMENT_TYPES[a.adj_type]}</td>
                <td className="text-right tabular-nums">{money(a.original_amount)}</td><td className="text-right tabular-nums">{money(a.actual_amount)}</td><td className={`text-right font-medium tabular-nums ${a.difference < 0 ? 'text-rose-600' : ''}`}>{money(a.difference)}</td>
                <td className="text-xs">{a.reason}</td><td className="text-xs">{a.pay_in_code ? `In ${a.pay_in_code}` : a.payment_source || '—'}</td><td className="text-xs">{a.created_by_name}{a.approved_by_name && <div className="text-slate-400">✓ {a.approved_by_name}</div>}</td>
                <td><ReqBadge status={a.status} /></td>
                <td className="text-right whitespace-nowrap">{a.status === 'pending' && can('payroll.approve') && <><button className="btn-ghost px-2 py-1 text-xs text-emerald-700" onClick={() => decide(a, true)}>Approve</button><button className="btn-ghost px-2 py-1 text-xs text-rose-600" onClick={() => decide(a, false)}>Reject</button></>}
                  {can('payroll.process') && (a.status !== 'approved' || (a.pay_in_period_id && !['approved', 'partially_paid', 'paid', 'closed'].includes(a.pay_in_status))) && <button className="btn-ghost p-1 text-rose-600" onClick={() => del(a)} aria-label="Delete"><Trash2 size={14} /></button>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!n} onClose={() => setN(null)} size="lg" title="New payroll adjustment" footer={<><button className="btn-secondary" onClick={() => setN(null)}>Cancel</button><button className="btn-primary" onClick={create}>Save</button></>}>
        {n && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Employee *"><select className="input" value={n.employee_id} onChange={(e) => setN({ ...n, employee_id: e.target.value })}><option value="">—</option>{emps.data?.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}</select></Field>
          <Field label="Adjustment type"><select className="input" value={n.adj_type} onChange={(e) => setN({ ...n, adj_type: e.target.value })}>{Object.entries(ADJUSTMENT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Payroll being corrected *"><select className="input" value={n.period_id} onChange={(e) => setN({ ...n, period_id: e.target.value })}>{periods.data?.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></Field>
          <Field label="Pay / recover in payroll" hint="Blank = paid outside payroll (e.g. bar cash)"><select className="input" value={n.pay_in_period_id} onChange={(e) => setN({ ...n, pay_in_period_id: e.target.value, payment_source: e.target.value ? 'payroll' : 'cash' })}><option value="">— outside payroll —</option>{openPeriods.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></Field>
          <Field label="Original amount"><input className="input" type="number" value={n.original_amount} onChange={(e) => setN({ ...n, original_amount: e.target.value })} /></Field>
          <Field label="Actual amount" hint="Difference = actual − original"><input className="input" type="number" value={n.actual_amount} onChange={(e) => setN({ ...n, actual_amount: e.target.value })} /></Field>
          {!n.pay_in_period_id && <Field label="Payment source"><select className="input" value={n.payment_source} onChange={(e) => setN({ ...n, payment_source: e.target.value })}><option value="cash">Cash</option><option value="bar_cash">Bar cash</option><option value="transfer">Transfer</option></select></Field>}
          <div className="flex items-end pb-2 text-sm">Difference: <b className="ml-1">{money((Number(n.actual_amount) || 0) - (Number(n.original_amount) || 0))}</b></div>
          <Field label="Reason *" className="sm:col-span-2"><input className="input" value={n.reason} onChange={(e) => setN({ ...n, reason: e.target.value })} /></Field>
          {can('payroll.approve') && <div className="sm:col-span-2"><Toggle checked={n.approve} onChange={(v) => setN({ ...n, approve: v })} label="Approve now" /></div>}
        </div>}
      </Modal>
    </div>
  );
}
