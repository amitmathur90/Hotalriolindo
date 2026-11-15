import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { money } from '../../lib/format';
import { Badge, Empty, Field, Modal, PageHeader, Spinner, Stat, Tabs, useAsync, useToast } from '../../components/ui';
import { useSession } from '../../backoffice/BackOffice';
import { ExportButtons } from '../../backoffice/widgets';
import { PAYMENT_METHODS } from '../../../../shared/payroll';
import { d10, errMsg, num, pr, today } from '../lib';

export default function Payments() {
  const [tab, setTab] = useState<'reg' | 'fx'>('reg');
  return (
    <div>
      <PageHeader title="Payroll payments" subtitle="Record payments from each approved payroll (Payroll periods → Payments). Partial payments and USD are supported." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'reg', label: 'Payment register' }, { id: 'fx', label: 'Exchange rates (USD)' }]} />
      {tab === 'reg' ? <Register /> : <Rates />}
    </div>
  );
}

function Register() {
  const m = new Date();
  const [r, setR] = useState({ from: new Date(m.getFullYear(), m.getMonth() - 1, 1).toISOString().slice(0, 10), to: today(), method: '' });
  const { data, loading } = useAsync(() => pr<any[]>(`/payments?from=${r.from}&to=${r.to}`), [r.from, r.to]);
  const rows = (data || []).filter((p) => !r.method || p.method === r.method);
  const live = rows.filter((p) => !p.voided);
  const sum = (f: (p: any) => boolean) => live.filter(f).reduce((s, p) => s + Number(p.amount_crc), 0);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input type="date" className="input w-auto py-1.5" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} aria-label="From" />
        <input type="date" className="input w-auto py-1.5" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} aria-label="To" />
        <select className="input w-auto py-1.5" value={r.method} onChange={(e) => setR({ ...r, method: e.target.value })} aria-label="Method"><option value="">All methods</option>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <div className="ml-auto"><ExportButtons name="payroll-payments" rows={rows} cols={[{ key: 'payment_date', label: 'Date' }, { key: 'period_code', label: 'Payroll' }, { key: 'employee_code', label: 'ID' }, { key: 'full_name', label: 'Employee' }, { key: 'method', label: 'Method' }, { key: 'bank', label: 'Bank' }, { key: 'account_ref', label: 'Account' }, { key: 'currency', label: 'Currency' }, { key: 'amount', label: 'Amount' }, { key: 'exchange_rate', label: 'Rate' }, { key: 'amount_crc', label: 'CRC' }, { key: 'reference', label: 'Reference' }, { key: 'voided', label: 'Voided' }, { key: 'created_by_name', label: 'Recorded by' }]} /></div>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Total paid" value={money(sum(() => true))} sub={`${live.length} payments`} />
        <Stat label="Cash" value={money(sum((p) => p.method === 'cash'))} />
        <Stat label="Bank transfer / SINPE" value={money(sum((p) => ['transfer', 'sinpe'].includes(p.method)))} />
        <Stat label="BCR" value={money(sum((p) => p.bank === 'BCR'))} sub={`Non-BCR ${money(sum((p) => p.bank === 'Non-BCR'))}`} />
        <Stat label="USD" value={`US$${num(live.filter((p) => p.currency === 'USD').reduce((s, p) => s + Number(p.amount), 0))}`} sub={money(sum((p) => p.currency === 'USD'))} />
      </div>
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !rows.length ? <Empty>No payments in this range</Empty> : (
          <table className="table text-sm">
            <thead><tr><th>Date</th><th>Payroll</th><th>Employee</th><th>Method</th><th>Bank / account</th><th>Reference</th><th className="text-right">Amount</th><th className="text-right">CRC</th><th>By</th></tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id} className={p.voided ? 'text-slate-400 line-through' : ''}><td>{d10(p.payment_date)}</td><td><Link className="hover:underline" to={`/backoffice/payroll/periods/${p.period_id}`}>{p.period_code}</Link></td><td className="font-medium">{p.full_name}</td>
                <td>{PAYMENT_METHODS[p.method] || p.method}</td><td className="text-xs">{p.bank} {p.account_ref}</td><td className="text-xs">{p.reference}</td>
                <td className="text-right tabular-nums">{p.currency === 'USD' ? `US$${num(p.amount)} @ ${num(p.exchange_rate)}` : money(p.amount)}</td><td className="text-right tabular-nums">{money(p.amount_crc)}</td>
                <td className="text-xs">{p.created_by_name}{p.voided && <Badge color="red">Voided</Badge>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Rates() {
  const toast = useToast();
  const { can } = useSession();
  const { data, loading, reload } = useAsync(() => pr<any[]>('/exchange-rates'), []);
  const [n, setN] = useState<any>(null);
  async function save() {
    try { await pr('/exchange-rates', { body: n }); setN(null); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function del(r: any) {
    try { await pr(`/exchange-rates/${r.id}`, { method: 'DELETE' }); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  return (
    <div className="max-w-2xl">
      <div className="mb-3 flex items-center justify-between"><p className="text-sm text-slate-500">USD payments use the latest rate on or before their payment date; the rate is stored on each payment so history never changes.</p>
        {(can('payroll.payments') || can('payroll.settings')) && <button className="btn-primary" onClick={() => setN({ rate_date: today(), usd_crc: data?.[0]?.usd_crc || '', source: 'BCCR' })}><Plus size={16} />Add rate</button>}</div>
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !data?.length ? <Empty>No exchange rates</Empty> : (
          <table className="table text-sm"><thead><tr><th>Date</th><th className="text-right">₡ per US$</th><th>Source</th><th /></tr></thead>
            <tbody>{data.map((r) => <tr key={r.id}><td>{d10(r.rate_date)}</td><td className="text-right tabular-nums">{num(r.usd_crc, 4)}</td><td>{r.source}</td><td>{can('payroll.settings') && <button className="btn-ghost px-2 py-0.5 text-xs text-rose-600" onClick={() => del(r)}>Delete</button>}</td></tr>)}</tbody></table>
        )}
      </div>
      <Modal open={!!n} onClose={() => setN(null)} size="sm" title="Exchange rate" footer={<><button className="btn-secondary" onClick={() => setN(null)}>Cancel</button><button className="btn-primary" onClick={save}>Save</button></>}>
        {n && <div className="grid gap-3">
          <Field label="Date"><input type="date" className="input" value={n.rate_date} onChange={(e) => setN({ ...n, rate_date: e.target.value })} /></Field>
          <Field label="Colones per US dollar"><input type="number" step="0.01" className="input" value={n.usd_crc} onChange={(e) => setN({ ...n, usd_crc: e.target.value })} /></Field>
          <Field label="Source"><input className="input" value={n.source} onChange={(e) => setN({ ...n, source: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}
