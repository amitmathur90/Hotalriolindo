import { useState, type ReactNode } from 'react';
import { Plus, Pencil, Trash2, Download, FileSpreadsheet, Printer } from 'lucide-react';
import { boApi } from '../lib/api';
import { RANGE_LABELS, rangeOf, type RangeKey } from '../lib/format';
import { download, downloadExcel, toCSV, type Col } from '../lib/csv';
import { Badge, Empty, Field, Modal, PageHeader, Spinner, Toggle, useAsync, useToast } from '../components/ui';
import { useSession } from './BackOffice';

// ---------------------------------------------------------------- Date range filter (Today / Yesterday / … / Custom)
export function useRange(initial: RangeKey = 'today') {
  const [key, setKey] = useState<RangeKey>(initial);
  const [custom, setCustom] = useState({ from: new Date().toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) });
  const r = rangeOf(key, custom);
  const query = `from=${encodeURIComponent(r.from.toISOString())}&to=${encodeURIComponent(r.to.toISOString())}`;
  const ui = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700">
        {(Object.keys(RANGE_LABELS) as RangeKey[]).map((k) => (
          <button key={k} onClick={() => setKey(k)}
            className={`px-3 py-1.5 text-xs font-medium ${key === k ? 'bg-brand-600 text-white' : 'bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800'}`}>
            {RANGE_LABELS[k]}
          </button>
        ))}
      </div>
      {key === 'custom' && (
        <>
          <input type="date" className="input w-auto py-1.5" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="From" />
          <input type="date" className="input w-auto py-1.5" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="To" />
        </>
      )}
    </div>
  );
  return { key, query, ui, from: r.from, to: r.to };
}

// ---------------------------------------------------------------- Export (CSV / Excel / Print)
export function ExportButtons({ name, rows, cols }: { name: string; rows: any[]; cols: Col[] }) {
  const file = `${name}-${new Date().toISOString().slice(0, 10)}`;
  return (
    <div className="flex gap-1">
      <button className="btn-secondary px-2.5 py-1.5 text-xs" onClick={() => download(`${file}.csv`, toCSV(rows, cols))}><Download size={14} />CSV</button>
      <button className="btn-secondary px-2.5 py-1.5 text-xs" onClick={() => downloadExcel(`${file}.xls`, rows, cols)}><FileSpreadsheet size={14} />Excel</button>
      <button className="btn-secondary px-2.5 py-1.5 text-xs" onClick={() => printTable(name, rows, cols)}><Printer size={14} />PDF</button>
    </div>
  );
}
/** Opens a printable report; the browser's "Save as PDF" produces the PDF. */
export function printTable(title: string, rows: any[], cols: Col[]) {
  const w = window.open('', '_blank');
  if (!w) return;
  const esc = (v: any) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  w.document.write(`<html><head><title>${esc(title)}</title><style>body{font:12px system-ui;padding:16px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left}th{background:#f1f5f9}</style></head><body>
    <h2>${esc(title)}</h2><p>Generated ${new Date().toLocaleString()}</p><table><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr>
    ${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c.key])}</td>`).join('')}</tr>`).join('')}</table></body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

// ---------------------------------------------------------------- Single-series bar chart with hover tooltip
export function BarChart({ data, format = (n) => String(n), height = 220, label = 'Value' }: { data: { label: string; value: number }[]; format?: (n: number) => string; height?: number; label?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return <Empty>No data for this period</Empty>;
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  const W = 640, H = height, padL = 8, padB = 22, padT = 10;
  const bw = (W - padL) / data.length;
  const barW = Math.max(2, Math.min(40, bw - 2)); // 2px surface gap between bars
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0.5, 1].map((f) => max * f);
  const labelEvery = Math.ceil(data.length / 12);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${label} bar chart`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W} y1={y(t)} y2={y(t)} className="stroke-slate-200 dark:stroke-slate-800" strokeWidth={1} />
            <text x={W} y={y(t) - 3} textAnchor="end" className="fill-slate-400 text-[10px]">{format(t)}</text>
          </g>
        ))}
        <line x1={padL} x2={W} y1={H - padB} y2={H - padB} className="stroke-slate-300 dark:stroke-slate-700" />
        {data.map((d, i) => {
          const x = padL + i * bw + (bw - barW) / 2;
          const top = y(Math.max(0, d.value));
          const h = H - padB - top;
          const r = Math.min(4, barW / 2, h);
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={padL + i * bw} y={padT} width={bw} height={H - padT - padB} fill="transparent" />
              {h > 0 && (
                <path d={`M${x},${H - padB} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${H - padB} Z`}
                  fill="#0d9488" opacity={hover === null || hover === i ? 1 : 0.55} />
              )}
              {i % labelEvery === 0 && <text x={padL + i * bw + bw / 2} y={H - 6} textAnchor="middle" className="fill-slate-500 text-[10px]">{d.label}</text>}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-0 rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs text-white shadow-lg"
          style={{ left: `${((hover + 0.5) / data.length) * 100}%`, transform: 'translateX(-50%)' }}>
          <div className="text-slate-300">{data[hover].label}</div>
          <div className="font-semibold tabular-nums">{format(data[hover].value)}</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Generic CRUD page
export type FieldDef = {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'select' | 'toggle' | 'textarea' | 'color' | 'date' | 'email';
  options?: { value: any; label: string }[];
  required?: boolean;
  hint?: string;
};
export type ColDef = { key: string; label: string; render?: (row: any) => ReactNode; className?: string };

export function CrudPage({ title, subtitle, path, columns, fields, defaults = {}, perm, header = true, extraActions }: {
  title: string; subtitle?: string; path: string; columns: ColDef[]; fields: FieldDef[]; defaults?: any; perm: string; header?: boolean;
  extraActions?: (row: any, reload: () => void) => ReactNode;
}) {
  const { can, storeId } = useSession();
  const toast = useToast();
  const { data, loading, reload } = useAsync(() => boApi<any[]>(path), [path, storeId]);
  const [edit, setEdit] = useState<any>(null);
  const editable = can(perm);

  async function save() {
    try {
      const body = { ...edit };
      for (const f of fields) if (f.type === 'number' && body[f.key] !== undefined && body[f.key] !== '') body[f.key] = Number(body[f.key]);
      if (edit.id) await boApi(`${path}/${edit.id}`, { method: 'PUT', body });
      else await boApi(path, { body });
      toast('Saved');
      setEdit(null);
      reload();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  }
  async function remove(row: any) {
    if (!confirm(`Delete "${row.name ?? 'this record'}"?`)) return;
    try {
      await boApi(`${path}/${row.id}`, { method: 'DELETE' });
      toast('Deleted');
      reload();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  }

  const addBtn = editable && <button className="btn-primary" onClick={() => setEdit({ ...defaults })}><Plus size={16} />Add</button>;
  return (
    <div>
      {header ? <PageHeader title={title} subtitle={subtitle} actions={addBtn} /> : <div className="mb-3 flex items-center justify-between"><div className="text-sm text-slate-500">{subtitle}</div>{addBtn}</div>}
      <div className="card overflow-x-auto">
        {loading ? <div className="flex justify-center py-10"><Spinner /></div> : !data?.length ? <Empty /> : (
          <table className="table">
            <thead><tr>{columns.map((c) => <th key={c.key} className={c.className}>{c.label}</th>)}<th className="w-24" /></tr></thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.id}>
                  {columns.map((c) => <td key={c.key} className={c.className}>{c.render ? c.render(row) : typeof row[c.key] === 'boolean' ? (row[c.key] ? <Badge color="green">Yes</Badge> : <Badge>No</Badge>) : row[c.key]}</td>)}
                  <td className="text-right whitespace-nowrap">
                    {extraActions?.(row, reload)}
                    {editable && <button className="btn-ghost p-1.5" onClick={() => setEdit(row)} aria-label="Edit"><Pencil size={15} /></button>}
                    {editable && <button className="btn-ghost p-1.5 text-rose-600" onClick={() => remove(row)} aria-label="Delete"><Trash2 size={15} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${title.replace(/s$/, '').toLowerCase()}` : `New ${title.replace(/s$/, '').toLowerCase()}`}
        footer={<><button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button><button className="btn-primary" onClick={save}>Save</button></>}>
        {edit && (
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((f) => <FormField key={f.key} f={f} value={edit[f.key]} onChange={(v) => setEdit({ ...edit, [f.key]: v })} />)}
          </div>
        )}
      </Modal>
    </div>
  );
}

export function FormField({ f, value, onChange }: { f: FieldDef; value: any; onChange: (v: any) => void }) {
  const wide = f.type === 'textarea' ? 'sm:col-span-2' : '';
  if (f.type === 'toggle') return <div className="flex items-end pb-2"><Toggle checked={!!value} onChange={onChange} label={f.label} /></div>;
  return (
    <Field label={f.label + (f.required ? ' *' : '')} hint={f.hint} className={wide}>
      {f.type === 'select' ? (
        <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {f.options?.map((o) => <option key={String(o.value)} value={o.value}>{o.label}</option>)}
        </select>
      ) : f.type === 'textarea' ? (
        <textarea className="input" rows={3} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className={`input ${f.type === 'color' ? 'h-10 p-1' : ''}`} type={f.type || 'text'} step={f.type === 'number' ? 'any' : undefined}
          value={f.type === 'date' && value ? String(value).slice(0, 10) : value ?? ''} onChange={(e) => onChange(e.target.value)} required={f.required} />
      )}
    </Field>
  );
}
