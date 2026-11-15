import { useState, type ReactNode } from 'react';
import { Table2, BarChart3 } from 'lucide-react';
import { bo, boApi } from '../lib/api';
import { money } from '../lib/format';
import { Badge, Empty } from '../components/ui';
import { PERIOD_STATUS_LABELS, type PeriodStatus } from '../../../shared/payroll';

/** Payroll API client (prefix /payroll). */
export const pr = <T = any,>(path: string, opts?: { method?: string; body?: any }) => boApi<T>(`/payroll${path}`, opts);

/** Fetch an authenticated PDF and open it in a new tab (print / save from the browser viewer). */
export async function openPdf(path: string, download?: string) {
  const w = download ? null : window.open('', '_blank');
  const res = await fetch(`/api/payroll${path}`, { headers: { Authorization: `Bearer ${bo.token}` } });
  if (!res.ok) {
    w?.close();
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.error || 'Could not create the PDF');
  }
  const url = URL.createObjectURL(await res.blob());
  if (download) {
    const a = document.createElement('a');
    a.href = url;
    a.download = download;
    a.click();
  } else if (w) w.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const num = (v: any, d = 2) => (Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: d });
export const d10 = (d: any) => (d ? String(d).slice(0, 10) : '');
export const today = () => new Date().toISOString().slice(0, 10);
export const errMsg = (e: any) => e?.message || String(e);

const STATUS_COLOR: Record<string, 'slate' | 'amber' | 'blue' | 'green' | 'brand' | 'red'> = {
  draft: 'slate', attendance_pending: 'amber', calculation_pending: 'amber', under_review: 'blue', approved: 'brand', partially_paid: 'amber', paid: 'green', closed: 'slate',
};
export const PeriodBadge = ({ status }: { status: string }) => <Badge color={STATUS_COLOR[status] || 'slate'}>{PERIOD_STATUS_LABELS[status as PeriodStatus] || status}</Badge>;
export const PayBadge = ({ status }: { status: string }) =>
  status === 'paid' ? <Badge color="green">Paid</Badge> : status === 'partial' ? <Badge color="amber">Partial</Badge> : <Badge>Pending</Badge>;
export const ReqBadge = ({ status }: { status: string }) => {
  const c = ({ requested: 'amber', pending: 'amber', approved: 'green', repaid: 'slate', rejected: 'red', cancelled: 'slate', paid: 'green', draft: 'slate', queued: 'blue', sent: 'green', failed: 'red' } as const)[status as 'requested'] || 'slate';
  return <Badge color={c}>{status.replace('_', ' ')}</Badge>;
};

export function YearSelect({ value, onChange }: { value: number; onChange: (y: number) => void }) {
  const y = new Date().getFullYear();
  return (
    <select className="input w-auto py-1.5" value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label="Year">
      {[y + 1, y, y - 1, y - 2, y - 3].map((x) => <option key={x} value={x}>{x}</option>)}
    </select>
  );
}

// ---------------------------------------------------------------- Charts (validated palette: blue / orange, light + dark)
const SERIES = ['var(--pr-s1)', 'var(--pr-s2)'];
export const chartVars = '[--pr-s1:#2a78d6] [--pr-s2:#eb6834] dark:[--pr-s1:#3987e5] dark:[--pr-s2:#d95926]';

export type Series = { key: string; label: string };
/** Card with a chart / table toggle so every chart has a table view. */
export function ChartCard({ title, children, rows, cols, fmt = (n) => money(n) }: {
  title: string; children: ReactNode; rows: any[]; cols: { key: string; label: string; num?: boolean }[]; fmt?: (n: number) => string;
}) {
  const [table, setTable] = useState(false);
  return (
    <div className={`card p-4 ${chartVars}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-semibold">{title}</div>
        <button className="btn-ghost p-1.5 text-slate-500" onClick={() => setTable(!table)} aria-label={table ? 'Show chart' : 'Show table'} title={table ? 'Chart' : 'Table'}>
          {table ? <BarChart3 size={15} /> : <Table2 size={15} />}
        </button>
      </div>
      {table ? (
        <div className="max-h-72 overflow-auto">
          <table className="table text-xs">
            <thead><tr>{cols.map((c) => <th key={c.key} className={c.num ? 'text-right' : ''}>{c.label}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c.key} className={c.num ? 'text-right tabular-nums' : ''}>{c.num ? (r[c.key] === null || r[c.key] === undefined ? '—' : fmt(r[c.key])) : r[c.key]}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : children}
    </div>
  );
}

/** Vertical bars, 1–2 series, shared single axis, hover tooltip, legend for 2 series. */
export function Bars({ data, series, format = (n) => money(n), height = 220 }: {
  data: Record<string, any>[]; series: Series[]; format?: (n: number) => string; height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length || data.every((d) => series.every((s) => !Number(d[s.key])))) return <Empty>No data for this selection</Empty>;
  const max = Math.max(...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0)), 0) || 1;
  const W = 640, H = height, padL = 4, padB = 22, padT = 12;
  const bw = (W - padL) / data.length;
  const inner = Math.min(bw - 6, series.length * 26);
  const barW = Math.max(2, (inner - (series.length - 1) * 2) / series.length);
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const bar = (x: number, v: number, fill: string, dim: boolean, k: string) => {
    const top = y(Math.max(0, v)), h = H - padB - top, r = Math.min(4, barW / 2, h);
    if (h <= 0) return null;
    return <path key={k} d={`M${x},${H - padB} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${H - padB} Z`} fill={fill} opacity={dim ? 0.45 : 1} />;
  };
  return (
    <div className="relative">
      {series.length > 1 && (
        <div className="mb-1 flex flex-wrap gap-3 text-xs text-slate-600 dark:text-slate-300">
          {series.map((s, i) => <span key={s.key} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES[i] }} />{s.label}</span>)}
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={series.map((s) => s.label).join(' and ')} onMouseLeave={() => setHover(null)}>
        {[0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={W} y1={y(max * f)} y2={y(max * f)} className="stroke-slate-200 dark:stroke-slate-800" />
            <text x={W} y={y(max * f) - 3} textAnchor="end" className="fill-slate-400 text-[10px]">{format(max * f)}</text>
          </g>
        ))}
        <line x1={padL} x2={W} y1={H - padB} y2={H - padB} className="stroke-slate-300 dark:stroke-slate-700" />
        {data.map((d, i) => {
          const x0 = padL + i * bw + (bw - inner) / 2;
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={padL + i * bw} y={0} width={bw} height={H} fill="transparent" />
              {series.map((s, j) => bar(x0 + j * (barW + 2), Number(d[s.key]) || 0, SERIES[j], hover !== null && hover !== i, s.key))}
              <text x={padL + i * bw + bw / 2} y={H - 6} textAnchor="middle" className="fill-slate-500 text-[10px]">{d.label}</text>
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-6 z-10 rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs whitespace-nowrap text-white shadow-lg"
          style={{ left: `${((hover + 0.5) / data.length) * 100}%`, transform: `translateX(${hover > data.length / 2 ? '-100%' : '0'})` }}>
          <div className="text-slate-300">{data[hover].label}</div>
          {series.map((s, j) => (
            <div key={s.key} className="flex items-center gap-1.5 tabular-nums"><span className="h-2 w-2 rounded-sm" style={{ background: SERIES[j] }} />{series.length > 1 ? `${s.label}: ` : ''}<b>{format(Number(data[hover][s.key]) || 0)}</b></div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Horizontal ranked bars (one series) with direct value labels. */
export function HBars({ data, format = (n) => money(n) }: { data: { label: string; value: number; sub?: string }[]; format?: (n: number) => string }) {
  if (!data.length) return <Empty>No data</Empty>;
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  return (
    <ul className="space-y-2">
      {data.map((d) => (
        <li key={d.label} className="text-sm" title={`${d.label}: ${format(d.value)}`}>
          <div className="mb-0.5 flex justify-between gap-2"><span className="truncate">{d.label}{d.sub && <span className="ml-1 text-xs text-slate-400">{d.sub}</span>}</span><span className="font-medium tabular-nums">{format(d.value)}</span></div>
          <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-2 rounded-full" style={{ width: `${Math.max(1, (d.value / max) * 100)}%`, background: 'var(--pr-s1)' }} /></div>
        </li>
      ))}
    </ul>
  );
}

/** Compact money formatter for axis ticks (₡1.2M). */
export const short = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : a >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));
  return money(0).replace(/[\d.,\s-]+/g, '') + s;
};
