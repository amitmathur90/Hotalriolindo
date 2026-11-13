import { useState } from 'react';
import { boApi } from '../../lib/api';
import { dt, money } from '../../lib/format';
import { Badge, Empty, Modal, PageHeader, Tabs, useAsync } from '../../components/ui';
import { useSession } from '../BackOffice';
import { CrudPage, ExportButtons, useRange } from '../widgets';

export default function Cash() {
  const [tab, setTab] = useState<'shifts' | 'movements' | 'expenses'>('shifts');
  return (
    <div>
      <PageHeader title="Shifts & Cash" subtitle="Shift reports, cash drawer movements and expenses" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'shifts', label: 'Shifts' }, { id: 'movements', label: 'Cash movements' }, { id: 'expenses', label: 'Expenses' }]} />
      {tab === 'shifts' && <Shifts />}
      {tab === 'movements' && <Movements />}
      {tab === 'expenses' && <Expenses />}
    </div>
  );
}

export function ShiftReport({ s }: { s: any }) {
  return (
    <div className="space-y-4 text-sm">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <div className="text-slate-500">Opened</div><div>{dt(s.opened_at)} by {s.opened_by_name}</div>
        {s.closed_at && <><div className="text-slate-500">Closed</div><div>{dt(s.closed_at)} by {s.closed_by_name}</div></>}
      </div>
      <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
        <div className="mb-1 font-semibold">Cash drawer</div>
        {[['Opening cash', s.cash.opening], ['Cash payments', s.cash.cash_sales], ['Cash refunds', -s.cash.cash_refunds], ['Paid in', s.cash.pay_in], ['Paid out', -s.cash.pay_out]].map(([l, v]) => (
          <div key={l as string} className="flex justify-between"><span>{l}</span><span className="tabular-nums">{money(v)}</span></div>
        ))}
        <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-semibold dark:border-slate-700"><span>Expected cash</span><span>{money(s.cash.expected)}</span></div>
        {s.actual_cash != null && <>
          <div className="flex justify-between"><span>Actual cash</span><span>{money(s.actual_cash)}</span></div>
          <div className={`flex justify-between font-semibold ${Number(s.difference) < 0 ? 'text-rose-600' : Number(s.difference) > 0 ? 'text-amber-600' : 'text-emerald-600'}`}><span>Difference</span><span>{money(s.difference)}</span></div>
        </>}
      </div>
      <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
        <div className="mb-1 font-semibold">Sales summary</div>
        <div className="flex justify-between"><span>Receipts</span><span>{s.totals.receipts}</span></div>
        <div className="flex justify-between"><span>Gross sales</span><span>{money(s.totals.gross_sales)}</span></div>
        <div className="flex justify-between"><span>Refunds</span><span>{money(s.totals.refunds)}</span></div>
        <div className="flex justify-between"><span>Discounts</span><span>{money(s.totals.discounts)}</span></div>
        <div className="flex justify-between"><span>Taxes</span><span>{money(s.totals.taxes)}</span></div>
        <div className="mt-2 font-medium">By payment type</div>
        {s.payments.map((p: any, i: number) => <div key={i} className="flex justify-between"><span>{p.method_name} {p.type === 'refund' ? '(refunds)' : ''}</span><span>{money(p.amount)}</span></div>)}
      </div>
      {s.movements.length > 0 && (
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <div className="mb-1 font-semibold">Cash movements</div>
          {s.movements.map((m: any) => <div key={m.id} className="flex justify-between"><span>{dt(m.created_at)} · {m.type.replace('_', ' ')} · {m.reason} ({m.user_name})</span><span>{money(m.amount)}</span></div>)}
        </div>
      )}
    </div>
  );
}

function Shifts() {
  const { storeId } = useSession();
  const range = useRange('week');
  const { data } = useAsync(() => boApi<any[]>(`/shifts?${range.query}`), [range.query, storeId]);
  const [open, setOpen] = useState<any>(null);
  const cols = ['store_name', 'opened_by_name', 'opened_at', 'closed_at', 'opening_cash', 'expected_cash', 'actual_cash', 'difference', 'sales_total'].map((k) => ({ key: k, label: k }));
  return (
    <div>
      <div className="mb-3 flex flex-wrap justify-between gap-2">{range.ui}<ExportButtons name="shifts" rows={data || []} cols={cols} /></div>
      <div className="card overflow-x-auto">
        {!data?.length ? <Empty>No shifts in this period</Empty> : (
          <table className="table">
            <thead><tr><th>Opened</th><th>Employee</th><th>Status</th><th className="text-right">Sales</th><th className="text-right">Expected cash</th><th className="text-right">Actual</th><th className="text-right">Difference</th></tr></thead>
            <tbody>{data.map((s) => (
              <tr key={s.id} className="cursor-pointer" onClick={async () => setOpen(await boApi(`/shifts/${s.id}`))}>
                <td>{dt(s.opened_at)}<div className="text-xs text-slate-400">{s.store_name}</div></td><td>{s.opened_by_name}</td>
                <td>{s.status === 'open' ? <Badge color="green">Open</Badge> : <Badge>Closed {dt(s.closed_at)}</Badge>}</td>
                <td className="text-right tabular-nums">{money(s.sales_total)}</td><td className="text-right tabular-nums">{s.expected_cash != null ? money(s.expected_cash) : '—'}</td>
                <td className="text-right tabular-nums">{s.actual_cash != null ? money(s.actual_cash) : '—'}</td>
                <td className={`text-right font-medium tabular-nums ${Number(s.difference) < 0 ? 'text-rose-600' : ''}`}>{s.difference != null ? money(s.difference) : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!open} onClose={() => setOpen(null)} title="Shift report">{open && <ShiftReport s={open} />}</Modal>
    </div>
  );
}

function Movements() {
  const { storeId } = useSession();
  const range = useRange('week');
  const { data } = useAsync(() => boApi<any[]>(`/cash-movements?${range.query}`), [range.query, storeId]);
  const cols = ['created_at', 'store_name', 'type', 'amount', 'reason', 'user_name'].map((k) => ({ key: k, label: k }));
  return (
    <div>
      <div className="mb-3 flex flex-wrap justify-between gap-2">{range.ui}<ExportButtons name="cash-movements" rows={data || []} cols={cols} /></div>
      <div className="card overflow-x-auto">
        {!data?.length ? <Empty>No pay-ins or pay-outs. Record them from the POS shift screen.</Empty> : (
          <table className="table">
            <thead><tr><th>Time</th><th>Type</th><th>Reason</th><th>Employee</th><th className="text-right">Amount</th></tr></thead>
            <tbody>{data.map((m) => (
              <tr key={m.id}><td>{dt(m.created_at)}</td><td className="capitalize">{m.type.replace('_', ' ')}</td><td>{m.reason}</td><td>{m.user_name}</td>
                <td className={`text-right tabular-nums ${['pay_in', 'deposit'].includes(m.type) ? 'text-emerald-600' : 'text-rose-600'}`}>{['pay_in', 'deposit'].includes(m.type) ? '+' : '-'}{money(m.amount)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Expenses() {
  const { stores } = useSession();
  return (
    <CrudPage header={false} title="Expenses" path="/expenses" perm="reports.view" defaults={{ spent_on: new Date().toISOString().slice(0, 10), category: 'Utilities' }}
      subtitle="Expenses feed the Profit & loss report."
      columns={[{ key: 'spent_on', label: 'Date', render: (r) => String(r.spent_on).slice(0, 10) }, { key: 'category', label: 'Category' }, { key: 'note', label: 'Note' },
        { key: 'store_id', label: 'Store', render: (r) => stores.find((s) => s.id === r.store_id)?.name || 'All' }, { key: 'amount', label: 'Amount', render: (r) => money(r.amount) }]}
      fields={[{ key: 'spent_on', label: 'Date', type: 'date', required: true }, { key: 'category', label: 'Category', type: 'select', options: ['Rent', 'Salaries', 'Utilities', 'Marketing', 'Maintenance', 'Petty cash', 'Other'].map((c) => ({ value: c, label: c })) },
        { key: 'amount', label: 'Amount', type: 'number', required: true }, { key: 'store_id', label: 'Store', type: 'select', options: stores.map((s) => ({ value: s.id, label: s.name })) }, { key: 'note', label: 'Note', type: 'textarea' }]} />
  );
}
