import { useState } from 'react';
import { Upload, Plus } from 'lucide-react';
import { money } from '../../lib/format';
import { parseCSV } from '../../lib/csv';
import { Badge, Empty, Field, Modal, PageHeader, Spinner, Tabs, useAsync, useToast } from '../../components/ui';
import { useSession } from '../../backoffice/BackOffice';
import { ExportButtons } from '../../backoffice/widgets';
import { MONTHS, YearSelect, errMsg, pr } from '../lib';

const S: Record<string, JSX.Element> = { matched: <Badge color="green">Matched</Badge>, difference: <Badge color="red">Difference found</Badge>, pending: <Badge color="amber">Pending</Badge>, manual: <Badge color="blue">Manually adjusted</Badge> };

export default function Reconciliation() {
  const toast = useToast();
  const { can } = useSession();
  const [year, setYear] = useState(new Date().getFullYear());
  const [tab, setTab] = useState<'lines' | 'months'>('lines');
  const { data, loading, reload } = useAsync(() => pr(`/reconciliation?year=${year}`), [year]);
  const [edit, setEdit] = useState<any>(null);
  const [manual, setManual] = useState<any>(null);
  const can_ = can('payroll.reports');
  async function save() {
    try { await pr(`/reconciliation/${edit.id}`, { method: 'PUT', body: edit }); setEdit(null); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function saveManual() {
    try { await pr('/reconciliation', { body: { ...manual, year } }); setManual(null); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function importCsv(f?: File) {
    if (!f) return;
    try { const r = await pr('/reconciliation/import', { body: { year, rows: parseCSV(await f.text()) } }); toast(`${r.updated} line(s) updated${r.errors.length ? ` · ${r.errors.length} not matched` : ''}`); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  const rows = data?.rows || [];
  return (
    <div>
      <PageHeader title="Cashbook vs QuickBooks" subtitle="Salaries in the cashbook compared to QuickBooks for every payroll. Direct QuickBooks API integration is a later phase; import CSV exports for now."
        actions={<><YearSelect value={year} onChange={setYear} />{can_ && <><label className="btn-secondary cursor-pointer"><Upload size={16} />Import CSV<input type="file" accept=".csv" className="hidden" onChange={(e) => importCsv(e.target.files?.[0])} /></label>
          <button className="btn-secondary" onClick={() => setManual({ month: new Date().getMonth() + 1, label: '15TH', payroll_amount: '', cashbook_amount: '', qbo_amount: '', notes: '' })}><Plus size={16} />Manual line</button></>}</>} />
      <p className="mb-3 text-xs text-slate-500">CSV columns: <code>period_code</code> (or <code>month</code> + <code>label</code> 15TH/30TH), <code>cashbook</code>, <code>qbo</code>. Payroll amount = net paid (net payable until payments are recorded).</p>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'lines', label: 'By payroll' }, { id: 'months', label: 'Monthly report' }]} />
      {loading || !data ? <Spinner /> : tab === 'lines' ? (
        <div>
          <div className="mb-2 flex justify-end"><ExportButtons name={`reconciliation-${year}`} rows={rows.map((r: any) => ({ ...r, month_name: MONTHS[r.month - 1] }))} cols={[{ key: 'month_name', label: 'Month' }, { key: 'label', label: 'Half' }, { key: 'period_code', label: 'Payroll' }, { key: 'payroll_amount', label: 'Payroll' }, { key: 'cashbook_amount', label: 'Cashbook' }, { key: 'qbo_amount', label: 'QuickBooks' }, { key: 'cashbook_vs_qbo', label: 'Difference' }, { key: 'status', label: 'Status' }, { key: 'notes', label: 'Notes' }]} /></div>
          <div className="card overflow-x-auto">
            {!rows.length ? <Empty>No payroll in {year}</Empty> : (
              <table className="table text-sm">
                <thead><tr><th>Month</th><th>Payroll</th><th className="text-right">Payroll paid</th><th className="text-right">Cashbook</th><th className="text-right">QuickBooks</th><th className="text-right">Cashbook − QBO</th><th className="text-right">Payroll − cashbook</th><th>Status</th><th>Notes</th><th /></tr></thead>
                <tbody>{rows.map((r: any) => (
                  <tr key={r.id}><td>{MONTHS[r.month - 1]} <span className="text-xs text-slate-400">{r.label}</span></td><td>{r.period_code || <span className="text-slate-400">manual</span>}</td>
                    <td className="text-right tabular-nums">{money(r.payroll_amount)}</td><td className="text-right tabular-nums">{r.cashbook_amount !== null ? money(r.cashbook_amount) : '—'}</td><td className="text-right tabular-nums">{r.qbo_amount !== null ? money(r.qbo_amount) : '—'}</td>
                    <td className={`text-right font-medium tabular-nums ${r.cashbook_vs_qbo ? 'text-rose-600' : ''}`}>{r.cashbook_vs_qbo !== null ? money(r.cashbook_vs_qbo) : ''}</td>
                    <td className="text-right tabular-nums">{r.payroll_vs_cashbook !== null ? money(r.payroll_vs_cashbook) : ''}</td>
                    <td>{S[r.status]}</td><td className="max-w-xs truncate text-xs" title={r.notes}>{r.notes}</td>
                    <td>{can_ && <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setEdit({ id: r.id, title: `${MONTHS[r.month - 1]} ${r.label || ''} ${r.period_code || ''}`, cashbook_amount: r.cashbook_amount ?? '', qbo_amount: r.qbo_amount ?? '', notes: r.notes || '', status: r.status === 'manual' ? 'manual' : 'auto', payroll: r.payroll_amount })}>Reconcile</button>}</td></tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table text-sm">
            <thead><tr><th>Month</th><th className="text-right">Payroll</th><th className="text-right">Cashbook</th><th className="text-right">QuickBooks</th><th className="text-right">Difference</th><th>Status</th></tr></thead>
            <tbody>{data.months.map((m: any) => <tr key={m.month}><td className="font-medium">{MONTHS[m.month - 1]}</td><td className="text-right tabular-nums">{m.payroll !== null ? money(m.payroll) : ''}</td><td className="text-right tabular-nums">{m.cashbook !== null ? money(m.cashbook) : ''}</td><td className="text-right tabular-nums">{m.qbo !== null ? money(m.qbo) : ''}</td>
              <td className={`text-right tabular-nums ${m.difference ? 'font-medium text-rose-600' : ''}`}>{m.difference !== null ? (m.difference === 0 ? 'OK' : money(m.difference)) : ''}</td><td>{m.status ? S[m.status] : ''}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={`Reconcile ${edit?.title}`} footer={<><button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button><button className="btn-primary" onClick={save}>Save</button></>}>
        {edit && <div className="grid gap-3 sm:grid-cols-2">
          <p className="text-sm text-slate-500 sm:col-span-2">Payroll paid: {money(edit.payroll)}</p>
          <Field label="Cashbook amount"><input className="input" type="number" value={edit.cashbook_amount} onChange={(e) => setEdit({ ...edit, cashbook_amount: e.target.value })} /></Field>
          <Field label="QuickBooks amount"><input className="input" type="number" value={edit.qbo_amount} onChange={(e) => setEdit({ ...edit, qbo_amount: e.target.value })} /></Field>
          <Field label="Status"><select className="input" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="auto">Automatic (matched / difference)</option><option value="manual">Manually adjusted</option></select></Field>
          <Field label="Notes" className="sm:col-span-2" hint="Required when manually adjusted"><textarea className="input" rows={2} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
        </div>}
      </Modal>
      <Modal open={!!manual} onClose={() => setManual(null)} title="Manual reconciliation line" footer={<><button className="btn-secondary" onClick={() => setManual(null)}>Cancel</button><button className="btn-primary" onClick={saveManual}>Save</button></>}>
        {manual && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Month"><select className="input" value={manual.month} onChange={(e) => setManual({ ...manual, month: Number(e.target.value) })}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></Field>
          <Field label="Label"><select className="input" value={manual.label} onChange={(e) => setManual({ ...manual, label: e.target.value })}><option>15TH</option><option>30TH</option><option value="">—</option></select></Field>
          <Field label="Payroll amount"><input className="input" type="number" value={manual.payroll_amount} onChange={(e) => setManual({ ...manual, payroll_amount: e.target.value })} /></Field>
          <Field label="Cashbook"><input className="input" type="number" value={manual.cashbook_amount} onChange={(e) => setManual({ ...manual, cashbook_amount: e.target.value })} /></Field>
          <Field label="QuickBooks"><input className="input" type="number" value={manual.qbo_amount} onChange={(e) => setManual({ ...manual, qbo_amount: e.target.value })} /></Field>
          <Field label="Notes"><input className="input" value={manual.notes} onChange={(e) => setManual({ ...manual, notes: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}
