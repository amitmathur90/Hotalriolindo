import { useState } from 'react';
import { boApi } from '../../lib/api';
import { money, qty } from '../../lib/format';
import { Empty, PageHeader, Spinner, Stat, Toggle, useAsync } from '../../components/ui';
import { useSession } from '../BackOffice';
import { BarChart, ExportButtons, useRange } from '../widgets';

const REPORTS = [
  { id: 'item', label: 'Sales by item' }, { id: 'category', label: 'Sales by category' }, { id: 'employee', label: 'Sales by employee' },
  { id: 'payment', label: 'Payment methods' }, { id: 'customer', label: 'Sales by customer' }, { id: 'hour', label: 'Sales by hour' },
  { id: 'day', label: 'Sales by day' }, { id: 'store', label: 'Sales by store' }, { id: 'dining', label: 'Dining options' },
  { id: 'taxes', label: 'Taxes (GST)' }, { id: 'discounts', label: 'Discounts' }, { id: 'pnl', label: 'Profit & loss' },
  { id: 'kitchen', label: 'Kitchen performance' }, { id: 'loyalty', label: 'Loyalty' },
];

const SALES_COLS = [
  { key: 'label', label: 'Name' }, { key: 'qty', label: 'Qty' }, { key: 'orders', label: 'Orders' }, { key: 'gross_sales', label: 'Gross sales' },
  { key: 'discounts', label: 'Discounts' }, { key: 'refunds', label: 'Refunds' }, { key: 'net_sales', label: 'Net sales' }, { key: 'taxes', label: 'Tax' },
  { key: 'cogs', label: 'Cost' }, { key: 'gross_profit', label: 'Gross profit' },
];
const COLS: Record<string, { key: string; label: string; money?: boolean }[]> = {
  payment: [{ key: 'label', label: 'Method' }, { key: 'transactions', label: 'Transactions' }, { key: 'amount', label: 'Payments', money: true }, { key: 'refunds', label: 'Refunds', money: true }, { key: 'net', label: 'Net', money: true }],
  taxes: [{ key: 'name', label: 'Tax' }, { key: 'rate', label: 'Rate %' }, { key: 'gst_mode', label: 'GST mode' }, { key: 'taxable', label: 'Taxable value', money: true }, { key: 'amount', label: 'Tax amount', money: true }],
  discounts: [{ key: 'type', label: 'Type' }, { key: 'value', label: 'Value' }, { key: 'orders', label: 'Orders' }, { key: 'amount', label: 'Discount', money: true }],
  kitchen: [{ key: 'station', label: 'Station' }, { key: 'orders', label: 'Orders' }, { key: 'avg_prep_minutes', label: 'Avg prep (min)' }, { key: 'max_prep_minutes', label: 'Max prep (min)' }, { key: 'delayed', label: 'Delayed >15m' }, { key: 'cancelled', label: 'Cancelled' }],
  loyalty: [{ key: 'type', label: 'Type' }, { key: 'transactions', label: 'Transactions' }, { key: 'points', label: 'Points' }],
};
const MONEY_KEYS = new Set(['gross_sales', 'discounts', 'refunds', 'net_sales', 'taxes', 'cogs', 'gross_profit']);

export default function Reports() {
  const { storeId, stores } = useSession();
  const [rep, setRep] = useState('item');
  const [all, setAll] = useState(false);
  const range = useRange('month');
  const q = `${range.query}${all ? '&all_stores=1' : ''}`;
  const isSales = !['payment', 'taxes', 'discounts', 'pnl', 'kitchen', 'loyalty'].includes(rep);
  const { data, loading } = useAsync(() => {
    if (rep === 'payment') return boApi(`/reports/sales-by?by=payment&${q}`);
    if (isSales) return boApi(`/reports/sales-by?by=${rep}&${q}`);
    return boApi(`/reports/${rep}?${q}`);
  }, [rep, q, storeId]);
  const cols = isSales ? SALES_COLS : COLS[rep] || [];

  return (
    <div>
      <PageHeader title="Reports" actions={<>{range.ui}{stores.length > 1 && <Toggle checked={all} onChange={setAll} label="All stores" />}</>} />
      <div className="flex flex-col gap-5 lg:flex-row">
        <div className="card h-fit shrink-0 p-2 lg:w-56">
          {REPORTS.map((r) => (
            <button key={r.id} onClick={() => setRep(r.id)} className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${rep === r.id ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-900/30 dark:text-brand-300' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}>{r.label}</button>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          {loading || !data ? <div className="flex justify-center py-20"><Spinner /></div> : rep === 'pnl' ? <Pnl d={data} /> : (
            <div className="space-y-4">
              {(rep === 'hour' || rep === 'day') && (
                <div className="card p-4"><BarChart label="Net sales" data={data.map((d: any) => ({ label: rep === 'day' ? d.label.slice(5) : d.label, value: d.net_sales }))} format={(n) => money(n)} /></div>
              )}
              <div className="card overflow-x-auto">
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 dark:border-slate-800">
                  <div className="text-sm font-semibold">{REPORTS.find((r) => r.id === rep)?.label}</div>
                  <ExportButtons name={`report-${rep}`} rows={data} cols={cols} />
                </div>
                {!data.length ? <Empty>No data for this period</Empty> : (
                  <table className="table">
                    <thead><tr>{cols.map((c) => <th key={c.key} className={c.key === 'label' || c.key === 'name' ? '' : 'text-right'}>{c.label}</th>)}</tr></thead>
                    <tbody>
                      {data.map((row: any, i: number) => (
                        <tr key={i}>{cols.map((c: any) => <td key={c.key} className={c.key === 'label' || c.key === 'name' ? 'font-medium' : 'text-right tabular-nums'}>
                          {MONEY_KEYS.has(c.key) || c.money ? money(row[c.key]) : c.key === 'qty' ? qty(row[c.key]) : row[c.key]}
                        </td>)}</tr>
                      ))}
                    </tbody>
                    {isSales && (
                      <tfoot><tr className="font-semibold">{cols.map((c) => <td key={c.key} className={c.key === 'label' ? '' : 'text-right tabular-nums'}>
                        {c.key === 'label' ? 'Total' : MONEY_KEYS.has(c.key) ? money(data.reduce((s: number, r: any) => s + Number(r[c.key]), 0)) : ''}
                      </td>)}</tr></tfoot>
                    )}
                  </table>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Pnl({ d }: { d: any }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Revenue (ex-tax)" value={money(d.revenue)} sub={`incl. service charge ${money(d.service_charge)}`} />
        <Stat label="Cost of goods sold" value={money(d.cogs)} />
        <Stat label="Expenses" value={money(d.expenses)} />
        <Stat label="Net profit" value={money(d.net_profit)} tone={d.net_profit >= 0 ? 'up' : 'down'} sub={`Gross profit ${money(d.gross_profit)}`} />
      </div>
      <div className="card p-4">
        <div className="mb-2 text-sm font-semibold">Expenses by category</div>
        {!d.expenses_by_category.length ? <Empty>No expenses recorded</Empty> : (
          <table className="table"><tbody>{d.expenses_by_category.map((e: any) => <tr key={e.category}><td>{e.category}</td><td className="text-right tabular-nums">{money(e.amount)}</td></tr>)}</tbody></table>
        )}
      </div>
    </div>
  );
}
