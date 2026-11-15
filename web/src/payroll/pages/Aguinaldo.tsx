import { useState } from 'react';
import { Calculator, CheckCircle2, FileText, AlertTriangle } from 'lucide-react';
import { money } from '../../lib/format';
import { Empty, Field, Modal, PageHeader, Spinner, Stat, useAsync, useToast } from '../../components/ui';
import { useSession } from '../../backoffice/BackOffice';
import { ExportButtons } from '../../backoffice/widgets';
import { PAYMENT_METHODS } from '../../../../shared/payroll';
import { ReqBadge, YearSelect, errMsg, num, openPdf, pr, today } from '../lib';

export default function Aguinaldo() {
  const toast = useToast();
  const { can } = useSession();
  const [year, setYear] = useState(new Date().getFullYear());
  const { data, loading, reload } = useAsync(() => pr<any[]>(`/aguinaldo?year=${year}`), [year]);
  const [sel, setSel] = useState<string[]>([]);
  const [adj, setAdj] = useState<any>(null);
  const [pay, setPay] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  async function calc() {
    try { const r = await pr('/aguinaldo/calculate', { body: { year } }); toast(`${r.calculated} calculated${r.skipped ? `, ${r.skipped} already approved (kept)` : ''}`); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function approve() {
    try { const r = await pr('/aguinaldo/approve', { body: { ids: sel } }); toast(`${r.approved} approved`); setSel([]); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function saveAdj() {
    try { await pr(`/aguinaldo/${adj.id}`, { method: 'PUT', body: adj }); setAdj(null); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function savePay() {
    try { await pr(`/aguinaldo/${pay.id}/pay`, { body: pay }); setPay(null); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  const rows = data || [];
  const drafts = rows.filter((r) => r.status === 'draft');
  return (
    <div>
      <PageHeader title={`Aguinaldo ${year}`} subtitle={`Annual bonus = total earnings from 1 Dec ${year - 1} to 30 Nov ${year} ÷ 12, from approved payroll only`}
        actions={<><YearSelect value={year} onChange={setYear} />
          {can('payroll.process') && <button className="btn-secondary" onClick={calc}><Calculator size={16} />Calculate</button>}
          {can('payroll.approve') && sel.length > 0 && <button className="btn-primary" onClick={approve}><CheckCircle2 size={16} />Approve {sel.length}</button>}
          {rows.length > 0 && <button className="btn-secondary" onClick={() => openPdf(`/aguinaldo/all/payslip.pdf?year=${year}`).catch((e) => toast(errMsg(e), 'err'))}><FileText size={16} />Payslips</button>}</>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Employees" value={rows.length} />
        <Stat label="Total aguinaldo" value={money(rows.reduce((s, r) => s + Number(r.final_amount), 0))} />
        <Stat label="Paid" value={money(rows.reduce((s, r) => s + Number(r.paid_amount), 0))} />
        <Stat label="With warnings" value={rows.filter((r) => r.warnings?.length).length} tone={rows.some((r) => r.warnings?.length) ? 'down' : undefined} />
      </div>
      <div className="mb-2 flex justify-end"><ExportButtons name={`aguinaldo-${year}`} rows={rows} cols={[{ key: 'full_name', label: 'Employee' }, { key: 'cedula', label: 'Cédula' }, { key: 'department_name', label: 'Department' }, { key: 'months_worked', label: 'Months' }, { key: 'total_earnings', label: 'Earnings' }, { key: 'average_monthly', label: 'Average' }, { key: 'calculated_amount', label: 'Calculated' }, { key: 'adjusted_amount', label: 'Adjusted' }, { key: 'final_amount', label: 'Final' }, { key: 'status', label: 'Status' }, { key: 'payment_method', label: 'Paid by' }]} /></div>
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !rows.length ? <Empty>Nothing calculated for {year} yet. Use “Calculate”.</Empty> : (
          <table className="table text-sm">
            <thead><tr>{can('payroll.approve') && <th className="w-8"><input type="checkbox" aria-label="Select drafts" onChange={(e) => setSel(e.target.checked ? drafts.map((r) => r.id) : [])} /></th>}<th>Employee</th><th className="text-right">Months</th><th className="text-right">Total earnings</th><th className="text-right">Average / month</th><th className="text-right">Calculated</th><th className="text-right">Final</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                {can('payroll.approve') && <td>{r.status === 'draft' && <input type="checkbox" aria-label={r.full_name} checked={sel.includes(r.id)} onChange={() => setSel(sel.includes(r.id) ? sel.filter((x) => x !== r.id) : [...sel, r.id])} />}</td>}
                <td><button className="font-medium hover:underline" onClick={() => setDetail(r)}>{r.full_name}</button>{r.warnings?.length > 0 && <AlertTriangle size={13} className="ml-1 inline text-amber-500" aria-label="Warnings" />}<div className="text-xs text-slate-400">{r.department_name}</div></td>
                <td className="text-right">{num(r.months_worked)}</td><td className="text-right tabular-nums">{money(r.total_earnings)}</td><td className="text-right tabular-nums">{money(r.average_monthly)}</td>
                <td className="text-right tabular-nums">{money(r.calculated_amount)}</td>
                <td className="text-right font-semibold tabular-nums">{money(r.final_amount)}{r.adjusted_amount !== null && <div className="text-[10px] font-normal text-violet-600" title={r.adjustment_reason}>adjusted</div>}</td>
                <td><ReqBadge status={r.status} />{r.paid_at && <div className="text-[10px] text-slate-400">{PAYMENT_METHODS[r.payment_method] || r.payment_method}</div>}</td>
                <td className="text-right whitespace-nowrap">
                  {r.status === 'draft' && can('payroll.process') && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setAdj({ id: r.id, name: r.full_name, calculated: r.calculated_amount, adjusted_amount: r.adjusted_amount ?? '', adjustment_reason: r.adjustment_reason || '' })}>Adjust</button>}
                  {r.status === 'approved' && can('payroll.payments') && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setPay({ id: r.id, name: r.full_name, amount: r.final_amount, payment_method: r.employee_payment_method || 'transfer', paid_at: today(), reference: '' })}>Record payment</button>}
                  <button className="btn-ghost p-1" onClick={() => openPdf(`/aguinaldo/${r.id}/payslip.pdf`).catch((e) => toast(errMsg(e), 'err'))} aria-label="Payslip"><FileText size={14} /></button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!detail} onClose={() => setDetail(null)} title={`${detail?.full_name} · aguinaldo ${year}`}>
        {detail && <div className="space-y-3 text-sm">
          {detail.warnings?.length > 0 && <ul className="rounded-lg bg-amber-50 p-3 text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">{detail.warnings.map((w: string) => <li key={w}>• {w}</li>)}</ul>}
          <table className="table text-xs"><thead><tr><th>Month</th><th className="text-right">Payrolls</th><th className="text-right">Earnings</th></tr></thead>
            <tbody>{detail.monthly_detail.map((m: any) => <tr key={m.month}><td>{m.month}</td><td className="text-right">{m.periods}</td><td className="text-right tabular-nums">{money(m.earnings)}</td></tr>)}</tbody>
            <tfoot><tr className="font-semibold"><td>Total</td><td /><td className="text-right tabular-nums">{money(detail.total_earnings)}</td></tr></tfoot></table>
          <p>Aguinaldo = {money(detail.total_earnings)} ÷ 12 = <b>{money(detail.calculated_amount)}</b>{detail.adjusted_amount !== null && <> · adjusted to <b>{money(detail.adjusted_amount)}</b> ({detail.adjustment_reason})</>}</p>
        </div>}
      </Modal>
      <Modal open={!!adj} onClose={() => setAdj(null)} size="sm" title={`Adjust · ${adj?.name}`} footer={<><button className="btn-secondary" onClick={() => setAdj(null)}>Cancel</button><button className="btn-primary" onClick={saveAdj}>Save</button></>}>
        {adj && <div className="grid gap-3"><p className="text-xs text-slate-500">Calculated {money(adj.calculated)}. Leave blank to use the calculated amount.</p>
          <Field label="Adjusted amount"><input className="input" type="number" value={adj.adjusted_amount} onChange={(e) => setAdj({ ...adj, adjusted_amount: e.target.value })} /></Field>
          <Field label="Reason"><input className="input" value={adj.adjustment_reason} onChange={(e) => setAdj({ ...adj, adjustment_reason: e.target.value })} /></Field></div>}
      </Modal>
      <Modal open={!!pay} onClose={() => setPay(null)} size="sm" title={`Aguinaldo payment · ${pay?.name}`} footer={<><button className="btn-secondary" onClick={() => setPay(null)}>Cancel</button><button className="btn-primary" onClick={savePay}>Record {pay && money(pay.amount)}</button></>}>
        {pay && <div className="grid gap-3">
          <Field label="Method"><select className="input" value={pay.payment_method} onChange={(e) => setPay({ ...pay, payment_method: e.target.value })}>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Date"><input className="input" type="date" value={pay.paid_at} onChange={(e) => setPay({ ...pay, paid_at: e.target.value })} /></Field>
          <Field label="Reference"><input className="input" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}
