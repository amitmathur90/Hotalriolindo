import { useState } from 'react';
import { boApi } from '../../lib/api';
import { money } from '../../lib/format';
import { Empty, PageHeader, Spinner, Stat, Toggle, useAsync } from '../../components/ui';
import { useSession } from '../BackOffice';
import { BarChart, useRange } from '../widgets';

export default function Dashboard() {
  const { storeId, stores } = useSession();
  const range = useRange('today');
  const [all, setAll] = useState(false);
  const q = `${range.query}${all ? '&all_stores=1' : ''}`;
  const multiDay = range.to.getTime() - range.from.getTime() > 86400000 * 1.5;
  const { data, loading } = useAsync(async () => {
    const [sum, trend, items, emps, pays, byStore] = await Promise.all([
      boApi(`/reports/summary?${q}`),
      boApi(`/reports/sales-by?by=${multiDay ? 'day' : 'hour'}&${q}`),
      boApi(`/reports/sales-by?by=item&${q}`),
      boApi(`/reports/sales-by?by=employee&${q}`),
      boApi(`/reports/sales-by?by=payment&${q}`),
      boApi(`/reports/sales-by?by=store&${range.query}&all_stores=1`),
    ]);
    return { sum, trend, items, emps, pays, byStore };
  }, [q, storeId]);

  return (
    <div>
      <PageHeader title="Dashboard" subtitle={all ? 'All stores' : stores.find((s) => s.id === storeId)?.name}
        actions={<>{range.ui}{stores.length > 1 && <Toggle checked={all} onChange={setAll} label="All stores" />}</>} />
      {loading || !data ? <div className="flex justify-center py-20"><Spinner /></div> : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Gross sales" value={money(data.sum.gross_sales)} sub={`${data.sum.orders} orders`} />
            <Stat label="Net sales (ex-tax)" value={money(data.sum.net_sales)} sub={`Avg order ${money(data.sum.avg_order)}`} />
            <Stat label="Gross profit" value={money(data.sum.gross_profit)} sub={`${data.sum.margin_pct}% margin`} tone={data.sum.gross_profit >= 0 ? 'up' : 'down'} />
            <Stat label="Collected" value={money(data.sum.collected)} sub={`${data.sum.customers} customers`} />
            <Stat label="Discounts" value={money(data.sum.discounts)} />
            <Stat label="Refunds" value={money(data.sum.refunds)} sub={`${data.sum.refund_count} refunds`} tone={data.sum.refunds > 0 ? 'down' : undefined} />
            <Stat label="Taxes" value={money(data.sum.taxes)} />
            <Stat label="Cost of goods" value={money(data.sum.cogs)} sub={data.sum.offline_orders ? `${data.sum.offline_orders} offline orders synced` : undefined} />
          </div>
          <div className="card p-4">
            <div className="mb-2 text-sm font-semibold">Net sales by {multiDay ? 'day' : 'hour'}</div>
            <BarChart label="Net sales" data={multiDay ? data.trend.map((t: any) => ({ label: t.label.slice(5), value: t.net_sales })) : Array.from({ length: 24 }, (_, h) => ({ label: `${String(h).padStart(2, '0')}:00`, value: data.trend.find((t: any) => Number(t.key) === h)?.net_sales ?? 0 }))} format={(n) => money(n)} />
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            <List title="Best-selling items" rows={data.items.slice(0, 8)} value={(r) => money(r.net_sales)} sub={(r) => `${r.qty} sold`} />
            <List title="Sales by employee" rows={data.emps} value={(r) => money(r.net_sales)} sub={(r) => `${r.orders} orders`} />
            <List title="Payment methods" rows={data.pays} value={(r) => money(r.net)} sub={(r) => `${r.transactions} transactions`} />
          </div>
          {stores.length > 1 && <List title="Store comparison" rows={data.byStore} value={(r) => money(r.net_sales)} sub={(r) => `${r.orders} orders · profit ${money(r.gross_profit)}`} />}
        </div>
      )}
    </div>
  );
}

function List({ title, rows, value, sub }: { title: string; rows: any[]; value: (r: any) => string; sub: (r: any) => string }) {
  return (
    <div className="card p-4">
      <div className="mb-2 text-sm font-semibold">{title}</div>
      {!rows.length ? <Empty>No sales yet</Empty> : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((r, i) => (
            <li key={i} className="flex items-center justify-between py-2 text-sm">
              <div className="min-w-0"><div className="truncate font-medium">{r.label}</div><div className="text-xs text-slate-400">{sub(r)}</div></div>
              <div className="font-semibold tabular-nums">{value(r)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
