import { useState } from 'react';
import { Download } from 'lucide-react';
import { money } from '../../lib/format';
import { Empty, PageHeader, Spinner, Tabs, Toggle, useAsync, useToast } from '../../components/ui';
import { useSession } from '../../backoffice/BackOffice';
import { ExportButtons } from '../../backoffice/widgets';
import { Bars, ChartCard, MONTHS, YearSelect, errMsg, num, pr, short } from '../lib';

const METRICS: Record<string, string> = { payroll_expense: 'Payroll expense (earnings − CAJA)', earnings: 'Total earnings', gross: 'Gross salary', net_payable: 'Net paid to employees', caja: 'CAJA' };
const pct = (v: any) => (v === null || v === undefined ? '—' : `${num(v, 1)}%`);

export default function Reports() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [metric, setMetric] = useState('payroll_expense');
  const [drafts, setDrafts] = useState(false);
  const [tab, setTab] = useState<'month' | 'quarter' | 'yoy' | 'labor'>('month');
  const q = `year=${year}&metric=${metric}${drafts ? '&include_drafts=1' : ''}`;
  return (
    <div>
      <PageHeader title="Payroll reports & analytics" subtitle="Payroll is assigned to the month of its end date"
        actions={<><YearSelect value={year} onChange={setYear} /><select className="input w-auto py-1.5" value={metric} onChange={(e) => setMetric(e.target.value)} aria-label="Measure">{Object.entries(METRICS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><Toggle checked={drafts} onChange={setDrafts} label="Include unapproved" /></>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'month', label: 'Monthly by department' }, { id: 'quarter', label: 'Quarterly & annual' }, { id: 'yoy', label: 'Year over year' }, { id: 'labor', label: 'Payroll vs revenue' }]} />
      {tab === 'labor' ? <Labor q={q} year={year} /> : <Summary q={q} tab={tab} year={year} />}
    </div>
  );
}

function Summary({ q, tab, year }: { q: string; tab: string; year: number }) {
  const { data, loading } = useAsync(() => pr(`/reports/summary?${q}`), [q]);
  if (loading || !data) return <Spinner />;
  const L = data.lines, T = data.totals;
  if (tab === 'month') {
    const rows = [...L.map((l: any) => ({ dep: l.department, acc: l.expense_account, ...Object.fromEntries(l.months.map((v: number, i: number) => [MONTHS[i], v])), total: l.total })),
      { dep: 'TOTAL PERSONNEL EXPENSES (CRC)', ...Object.fromEntries(T.months.map((v: number, i: number) => [MONTHS[i], v])), total: T.total }];
    const cols = [{ key: 'acc', label: 'Account' }, { key: 'dep', label: 'Category' }, ...MONTHS.map((m) => ({ key: m, label: m })), { key: 'total', label: 'Total' }];
    return (
      <div className="space-y-4">
        <div className="flex justify-end"><ExportButtons name={`payroll-monthly-${year}`} rows={rows} cols={cols} /></div>
        <div className="card overflow-x-auto">
          <table className="table text-xs">
            <thead><tr><th>Category</th>{MONTHS.map((m) => <th key={m} className="text-right">{m}</th>)}<th className="text-right">Total</th></tr></thead>
            <tbody>
              {L.map((l: any) => <tr key={l.department}><td className="whitespace-nowrap"><div className="font-medium">{l.department}</div><div className="text-[10px] text-slate-400">{l.expense_account}</div></td>{l.months.map((v: number, i: number) => <td key={i} className="text-right tabular-nums">{v ? money(v) : ''}<div className="text-[10px] text-slate-400">{v && T.months[i] ? `${Math.round((v / T.months[i]) * 100)}%` : ''}</div></td>)}<td className="text-right font-medium tabular-nums">{money(l.total)}</td></tr>)}
              <tr className="font-semibold"><td>Total personnel expenses (CRC)</td>{T.months.map((v: number, i: number) => <td key={i} className="text-right tabular-nums">{v ? money(v) : ''}</td>)}<td className="text-right tabular-nums">{money(T.total)}</td></tr>
              <tr className="text-slate-500"><td>Total personnel expenses (USD)</td>{T.usd.map((v: any, i: number) => <td key={i} className="text-right tabular-nums">{v ? `US$${num(v, 0)}` : ''}</td>)}<td /></tr>
              <tr className="text-slate-500"><td>USD → CRC exchange rate</td>{T.exchange_rates.map((v: any, i: number) => <td key={i} className="text-right tabular-nums">{v ? num(v) : ''}</td>)}<td /></tr>
              <tr className="text-slate-500"><td>Labour % vs revenue</td>{T.labor_pct.map((v: any, i: number) => <td key={i} className="text-right">{v !== null ? pct(v) : ''}</td>)}<td /></tr>
            </tbody>
          </table>
        </div>
        <ChartCard title={`Personnel expenses by month ${year}`} rows={T.months.map((v: number, i: number) => ({ label: MONTHS[i], v }))} cols={[{ key: 'label', label: 'Month' }, { key: 'v', label: 'Amount', num: true }]}>
          <Bars data={T.months.map((v: number, i: number) => ({ label: MONTHS[i], v }))} series={[{ key: 'v', label: 'Personnel expenses' }]} format={short} />
        </ChartCard>
      </div>
    );
  }
  if (tab === 'quarter') {
    const rows = L.map((l: any) => ({ dep: l.department, q1: l.quarters[0], q2: l.quarters[1], q3: l.quarters[2], q4: l.quarters[3], total: l.total, share: T.total ? Math.round((l.total / T.total) * 1000) / 10 : 0 }));
    return (
      <div>
        <div className="mb-2 flex justify-end"><ExportButtons name={`payroll-quarterly-${year}`} rows={rows} cols={[{ key: 'dep', label: 'Department' }, { key: 'q1', label: 'Q1' }, { key: 'q2', label: 'Q2' }, { key: 'q3', label: 'Q3' }, { key: 'q4', label: 'Q4' }, { key: 'total', label: 'Annual' }, { key: 'share', label: '%' }]} /></div>
        <div className="card overflow-x-auto"><table className="table text-sm">
          <thead><tr><th>Department</th>{['Q1', 'Q2', 'Q3', 'Q4'].map((x) => <th key={x} className="text-right">{x}</th>)}<th className="text-right">Annual {year}</th><th className="text-right">%</th></tr></thead>
          <tbody>{rows.map((r: any) => <tr key={r.dep}><td className="font-medium">{r.dep}</td>{['q1', 'q2', 'q3', 'q4', 'total'].map((k) => <td key={k} className="text-right tabular-nums">{money(r[k])}</td>)}<td className="text-right">{r.share}%</td></tr>)}
            <tr className="font-semibold"><td>Total</td>{T.quarters.map((v: number, i: number) => <td key={i} className="text-right tabular-nums">{money(v)}</td>)}<td className="text-right tabular-nums">{money(T.total)}</td><td /></tr></tbody></table></div>
      </div>
    );
  }
  const rows = L.map((l: any) => ({ dep: l.department, y2: l.two_years_ago, y1: l.previous_year, y0: l.total, d1: l.yoy_change, p1: l.yoy_pct, d2: l.total - l.two_years_ago, p2: l.two_years_ago ? Math.round(((l.total - l.two_years_ago) / l.two_years_ago) * 1000) / 10 : null }));
  return (
    <div>
      <p className="mb-2 text-xs text-slate-500">Earlier years appear when their payroll is in the system (import historical payroll, or enter the totals as approved special payroll periods).</p>
      <div className="mb-2 flex justify-end"><ExportButtons name={`payroll-yoy-${year}`} rows={rows} cols={[{ key: 'dep', label: 'Department' }, { key: 'y2', label: String(year - 2) }, { key: 'y1', label: String(year - 1) }, { key: 'y0', label: String(year) }, { key: 'd1', label: `${year} v ${year - 1}` }, { key: 'p1', label: '%' }, { key: 'd2', label: `${year} v ${year - 2}` }, { key: 'p2', label: '%' }]} /></div>
      <div className="card overflow-x-auto"><table className="table text-sm">
        <thead><tr><th>Department</th><th className="text-right">{year - 2}</th><th className="text-right">{year - 1}</th><th className="text-right">{year}</th><th className="text-right">{year} v {year - 1}</th><th className="text-right">%</th><th className="text-right">{year} v {year - 2}</th><th className="text-right">%</th></tr></thead>
        <tbody>{rows.map((r: any) => <tr key={r.dep}><td className="font-medium">{r.dep}</td><td className="text-right tabular-nums">{money(r.y2)}</td><td className="text-right tabular-nums">{money(r.y1)}</td><td className="text-right tabular-nums">{money(r.y0)}</td>
          <td className="text-right tabular-nums">{money(r.d1)}</td><td className="text-right">{pct(r.p1)}</td><td className="text-right tabular-nums">{money(r.d2)}</td><td className="text-right">{pct(r.p2)}</td></tr>)}</tbody></table></div>
    </div>
  );
}

function Labor({ q, year }: { q: string; year: number }) {
  const toast = useToast();
  const { can } = useSession();
  const { data, loading, reload } = useAsync(() => pr(`/reports/labor?${q}`), [q]);
  const edit = can('payroll.reports');
  async function save(m: any, k: string, v: string) {
    if (Number(m[k]) === Number(v)) return;
    try { await pr('/revenue', { method: 'PUT', body: { year, month: m.month, bar_revenue: m.bar_revenue, food_revenue: m.food_revenue, [k]: Number(v) || 0, source: 'manual' } }); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function fromPos() {
    if (!confirm(`Fill ${year} revenue from POS sales (net of tax and refunds)? Bar = categories routed to the Bar station; food = other kitchen stations. Months entered manually are kept.`)) return;
    try { const r = await pr('/revenue/from-pos', { body: { year } }); toast(`${r.months} month(s) imported`); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  if (loading || !data) return <Spinner />;
  const M = data.months.map((m: any) => ({ ...m, label: MONTHS[m.month - 1] }));
  const inp = (m: any, k: string) => edit
    ? <input className="w-28 rounded border border-slate-200 px-1 py-0.5 text-right tabular-nums dark:border-slate-700 dark:bg-slate-900" defaultValue={m[k] || ''} key={`${m.month}-${k}-${m[k]}`} onBlur={(e) => save(m, k, e.target.value)} aria-label={`${k} ${m.label}`} />
    : money(m[k]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">Labour cost % = payroll ÷ revenue × 100. Bar and kitchen percentages use departments coded BAR and KIT. Enter revenue below or import it from the POS.</p>
        <div className="flex gap-2">{edit && <button className="btn-secondary" onClick={fromPos}><Download size={15} />Revenue from POS sales</button>}<ExportButtons name={`labor-${year}`} rows={M} cols={[{ key: 'label', label: 'Month' }, { key: 'bar_revenue', label: 'Bar revenue' }, { key: 'food_revenue', label: 'Food revenue' }, { key: 'total_revenue', label: 'Total revenue' }, { key: 'payroll', label: 'Personnel expense' }, { key: 'labor_pct', label: 'Labour %' }, { key: 'bar_labor_pct', label: 'Bar labour %' }, { key: 'kitchen_labor_pct', label: 'Kitchen labour %' }]} /></div>
      </div>
      <div className="card overflow-x-auto"><table className="table text-sm">
        <thead><tr><th>Month</th><th className="text-right">Bar revenue</th><th className="text-right">Food revenue</th><th className="text-right">Total revenue</th><th className="text-right">Personnel expense</th><th className="text-right">Labour %</th><th className="text-right">Bar staff</th><th className="text-right">Bar %</th><th className="text-right">Kitchen staff</th><th className="text-right">Kitchen %</th></tr></thead>
        <tbody>{M.map((m: any) => <tr key={m.month}><td className="font-medium">{m.label}{m.revenue_source === 'pos' && <span className="ml-1 text-[10px] text-slate-400">POS</span>}</td><td className="text-right">{inp(m, 'bar_revenue')}</td><td className="text-right">{inp(m, 'food_revenue')}</td>
          <td className="text-right tabular-nums">{money(m.total_revenue)}</td><td className="text-right tabular-nums">{money(m.payroll)}</td><td className="text-right font-medium">{pct(m.labor_pct)}</td>
          <td className="text-right tabular-nums">{money(m.bar_payroll)}</td><td className="text-right">{pct(m.bar_labor_pct)}</td><td className="text-right tabular-nums">{money(m.kitchen_payroll)}</td><td className="text-right">{pct(m.kitchen_labor_pct)}</td></tr>)}</tbody></table></div>
      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Personnel expense vs revenue" rows={M} cols={[{ key: 'label', label: 'Month' }, { key: 'payroll', label: 'Payroll', num: true }, { key: 'total_revenue', label: 'Revenue', num: true }]}>
          <Bars data={M} series={[{ key: 'payroll', label: 'Personnel expense' }, { key: 'total_revenue', label: 'Revenue' }]} format={short} />
        </ChartCard>
        <ChartCard title="Labour cost %" rows={M} cols={[{ key: 'label', label: 'Month' }, { key: 'labor_pct', label: 'Labour %', num: true }]} fmt={(n) => `${n}%`}>
          {M.some((m: any) => m.labor_pct) ? <Bars data={M.map((m: any) => ({ ...m, labor_pct: m.labor_pct ?? 0 }))} series={[{ key: 'labor_pct', label: 'Labour %' }]} format={(n) => `${Math.round(n * 10) / 10}%`} /> : <Empty>Enter revenue to see the labour %</Empty>}
        </ChartCard>
      </div>
    </div>
  );
}
