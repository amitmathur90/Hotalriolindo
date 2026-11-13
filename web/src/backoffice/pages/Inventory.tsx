import { useMemo, useState } from 'react';
import { Plus, Trash2, Check, X } from 'lucide-react';
import { boApi } from '../../lib/api';
import { dt, money, qty } from '../../lib/format';
import { Badge, Empty, Field, Modal, PageHeader, SearchInput, Spinner, Stat, Tabs, Toggle, useAsync, useToast } from '../../components/ui';
import { useSession } from '../BackOffice';
import { ExportButtons, useRange } from '../widgets';

type Tab = 'stock' | 'adjustments' | 'count' | 'transfers' | 'production' | 'history';

/** Product variant picker backed by the item list of the current store. */
export function useVariants() {
  const { storeId } = useSession();
  const { data } = useAsync(() => boApi<any[]>('/products'), [storeId]);
  return useMemo(() => (data || []).flatMap((p) => p.variants.map((v: any) => ({
    id: v.id, name: `${p.name}${v.name ? ` (${v.name})` : ''}`, sku: v.sku, barcode: v.barcode, cost: v.cost, stock: v.stock, track: p.track_stock, unit: p.unit, components: v.components,
  }))), [data]);
}
export function VariantSelect({ variants, value, onChange, filter }: { variants: any[]; value: string; onChange: (v: any) => void; filter?: (v: any) => boolean }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(variants.find((v) => v.id === e.target.value))}>
      <option value="">Choose item…</option>
      {variants.filter(filter || (() => true)).map((v) => <option key={v.id} value={v.id}>{v.name}{v.sku ? ` · ${v.sku}` : ''}</option>)}
    </select>
  );
}

export default function Inventory() {
  const [tab, setTab] = useState<Tab>('stock');
  return (
    <div>
      <PageHeader title="Inventory" subtitle="Stock levels, adjustments, counts, transfers and production" />
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'stock', label: 'Stock levels' }, { id: 'adjustments', label: 'Adjustments' }, { id: 'count', label: 'Inventory count' },
        { id: 'transfers', label: 'Transfers' }, { id: 'production', label: 'Production' }, { id: 'history', label: 'Stock history' },
      ]} />
      {tab === 'stock' && <Stock />}
      {tab === 'adjustments' && <Adjustments />}
      {tab === 'count' && <Count />}
      {tab === 'transfers' && <Transfers />}
      {tab === 'production' && <Production />}
      {tab === 'history' && <History />}
    </div>
  );
}

function Stock() {
  const { storeId } = useSession();
  const [q, setQ] = useState('');
  const [low, setLow] = useState(false);
  const { data, loading } = useAsync(() => boApi<any[]>(`/stock?q=${encodeURIComponent(q)}${low ? '&low=1' : ''}`), [q, low, storeId]);
  const rows = data || [];
  const value = rows.reduce((s, r) => s + Number(r.stock_value), 0);
  const profit = rows.reduce((s, r) => s + Number(r.potential_profit), 0);
  const out = rows.filter((r) => Number(r.qty) <= 0).length;
  const cols = ['product_name', 'variant_name', 'sku', 'category_name', 'qty', 'reorder_level', 'cost', 'price', 'stock_value', 'potential_profit'].map((k) => ({ key: k, label: k }));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Inventory value (cost)" value={money(value)} />
        <Stat label="Potential profit" value={money(profit)} />
        <Stat label="Items tracked" value={rows.length} />
        <Stat label="Out of stock" value={out} tone={out ? 'down' : undefined} sub={`${rows.filter((r) => Number(r.qty) <= Number(r.reorder_level)).length} at or below reorder level`} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={q} onChange={setQ} className="w-64" />
        <Toggle checked={low} onChange={setLow} label="Low stock only" />
        <div className="ml-auto"><ExportButtons name="stock" rows={rows} cols={cols} /></div>
      </div>
      <div className="card overflow-x-auto">
        {loading ? <div className="flex justify-center py-10"><Spinner /></div> : !rows.length ? <Empty /> : (
          <table className="table">
            <thead><tr><th>Item</th><th>Category</th><th className="text-right">In stock</th><th className="text-right">Reorder at</th><th className="text-right">Sold (30d)</th><th className="text-right">Cost</th><th className="text-right">Value</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.variant_id}>
                <td><div className="font-medium">{r.product_name}{r.variant_name ? ` (${r.variant_name})` : ''}</div><div className="text-xs text-slate-400">{r.sku}</div></td>
                <td>{r.category_name}</td>
                <td className="text-right tabular-nums">{Number(r.qty) <= 0 ? <Badge color="red">{qty(r.qty)} {r.unit}</Badge> : Number(r.qty) <= Number(r.reorder_level) ? <Badge color="amber">{qty(r.qty)} {r.unit}</Badge> : `${qty(r.qty)} ${r.unit}`}</td>
                <td className="text-right tabular-nums">{qty(r.reorder_level)}</td>
                <td className="text-right tabular-nums">{qty(-r.sold_30d)}</td>
                <td className="text-right tabular-nums">{money(r.cost)}</td>
                <td className="text-right tabular-nums">{money(r.stock_value)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const REASONS = [
  { id: 'receive', label: 'Receive items (+)' }, { id: 'damage', label: 'Damaged (−)' }, { id: 'loss', label: 'Loss (−)' }, { id: 'theft', label: 'Theft (−)' },
  { id: 'expiry', label: 'Expired (−)' }, { id: 'wastage', label: 'Wastage (−)' }, { id: 'internal_use', label: 'Internal use (−)' }, { id: 'correction', label: 'Correction (±)' },
];

function Adjustments() {
  const { can, storeId } = useSession();
  const toast = useToast();
  const variants = useVariants();
  const { data, reload } = useAsync(() => boApi<any[]>('/adjustments'), [storeId]);
  const [form, setForm] = useState<any>(null);
  async function save() {
    try {
      const sign = form.reason === 'receive' || form.reason === 'correction' ? 1 : -1;
      const items = form.items.filter((i: any) => i.variant_id).map((i: any) => ({ ...i, qty_change: form.reason === 'correction' ? Number(i.qty) : sign * Math.abs(Number(i.qty)) }));
      const r = await boApi('/adjustments', { body: { reason: form.reason, note: form.note, items } });
      toast(r.status === 'approved' ? 'Stock updated' : 'Submitted for manager approval');
      setForm(null);
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  }
  const decide = async (id: string, d: string) => { try { await boApi(`/adjustments/${id}/${d}`, { body: {} }); reload(); } catch (e: any) { toast(e.message, 'err'); } };
  return (
    <div>
      <div className="mb-3 flex justify-end"><button className="btn-primary" onClick={() => setForm({ reason: 'receive', note: '', items: [{ variant_id: '', qty: 1 }] })}><Plus size={16} />New adjustment</button></div>
      <div className="card overflow-x-auto">
        {!data?.length ? <Empty /> : (
          <table className="table">
            <thead><tr><th>Date</th><th>Reason</th><th>Items</th><th>By</th><th>Status</th><th /></tr></thead>
            <tbody>{data.map((a) => (
              <tr key={a.id}>
                <td>{dt(a.created_at)}</td><td className="capitalize">{a.reason.replace('_', ' ')}{a.note ? <div className="text-xs text-slate-400">{a.note}</div> : null}</td>
                <td className="text-xs">{a.items.map((i: any) => `${i.name || variants.find((v) => v.id === i.variant_id)?.name || 'Item'} ${i.qty_change > 0 ? '+' : ''}${i.qty_change}`).join(', ')}</td>
                <td>{a.created_by_name}{a.approved_by_name && a.status !== 'pending' ? <div className="text-xs text-slate-400">{a.status} by {a.approved_by_name}</div> : null}</td>
                <td>{a.status === 'approved' ? <Badge color="green">Approved</Badge> : a.status === 'pending' ? <Badge color="amber">Pending</Badge> : <Badge color="red">Rejected</Badge>}</td>
                <td className="text-right">{a.status === 'pending' && can('inventory.approve') && <>
                  <button className="btn-ghost p-1.5 text-emerald-600" onClick={() => decide(a.id, 'approve')} aria-label="Approve"><Check size={16} /></button>
                  <button className="btn-ghost p-1.5 text-rose-600" onClick={() => decide(a.id, 'reject')} aria-label="Reject"><X size={16} /></button></>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!form} onClose={() => setForm(null)} title="Stock adjustment" size="lg" footer={<><button className="btn-secondary" onClick={() => setForm(null)}>Cancel</button><button className="btn-primary" onClick={save}>Save</button></>}>
        {form && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Reason"><select className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>{REASONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></Field>
              <Field label="Note"><input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
            </div>
            {form.items.map((it: any, i: number) => (
              <div key={i} className="flex gap-2">
                <VariantSelect variants={variants} filter={(v) => v.track} value={it.variant_id} onChange={(v) => setForm({ ...form, items: form.items.map((x: any, j: number) => (i === j ? { ...x, variant_id: v?.id || '', name: v?.name } : x)) })} />
                <input className="input w-28" type="number" step="any" value={it.qty} onChange={(e) => setForm({ ...form, items: form.items.map((x: any, j: number) => (i === j ? { ...x, qty: e.target.value } : x)) })} aria-label="Quantity" />
                <button className="btn-ghost p-2 text-rose-600" onClick={() => setForm({ ...form, items: form.items.filter((_: any, j: number) => j !== i) })} aria-label="Remove"><Trash2 size={15} /></button>
              </div>
            ))}
            <button className="btn-ghost py-1 text-sm" onClick={() => setForm({ ...form, items: [...form.items, { variant_id: '', qty: 1 }] })}><Plus size={14} />Add item</button>
            {form.reason === 'correction' && <p className="text-xs text-slate-500">Use negative quantities to decrease stock.</p>}
            {!can('inventory.approve') && form.reason !== 'receive' && <p className="text-xs text-amber-600">Decreases require manager approval before stock changes.</p>}
          </div>
        )}
      </Modal>
    </div>
  );
}

function Count() {
  const { storeId, can } = useSession();
  const toast = useToast();
  const { data, loading, reload } = useAsync(() => boApi<any[]>('/stock'), [storeId]);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [scan, setScan] = useState('');
  const [result, setResult] = useState<any[] | null>(null);
  // Barcode-assisted counting: scanning an item adds 1 to its count
  const onScan = (e: React.FormEvent) => {
    e.preventDefault();
    const r = data?.find((x) => x.barcode === scan || x.sku === scan);
    if (!r) toast('Barcode not found', 'err');
    else setCounts({ ...counts, [r.variant_id]: String(Number(counts[r.variant_id] || 0) + 1) });
    setScan('');
  };
  async function submit(apply: boolean) {
    const items = Object.entries(counts).filter(([, v]) => v !== '').map(([variant_id, c]) => ({ variant_id, counted: Number(c) }));
    try {
      const r = await boApi('/counts', { body: { items, apply } });
      setResult(r.variances);
      toast(apply ? 'Count applied to stock' : 'Variance recorded for approval');
      setCounts({});
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={onScan}><input className="input w-64" placeholder="Scan barcode to count +1" value={scan} onChange={(e) => setScan(e.target.value)} /></form>
        <div className="ml-auto flex gap-2">
          <button className="btn-secondary" onClick={() => submit(false)} disabled={!Object.keys(counts).length}>Save for approval</button>
          {can('inventory.approve') && <button className="btn-primary" onClick={() => submit(true)} disabled={!Object.keys(counts).length}>Apply count</button>}
        </div>
      </div>
      {result && (
        <div className="card p-4">
          <div className="mb-2 text-sm font-semibold">Variance report</div>
          {!result.length ? <div className="text-sm text-emerald-600">No variances — expected matches actual.</div> : (
            <table className="table"><thead><tr><th>Item</th><th className="text-right">Expected</th><th className="text-right">Counted</th><th className="text-right">Variance</th></tr></thead>
              <tbody>{result.map((r) => <tr key={r.variant_id}><td>{data?.find((x) => x.variant_id === r.variant_id)?.product_name || r.variant_id}</td><td className="text-right">{r.expected}</td><td className="text-right">{r.counted}</td><td className={`text-right font-medium ${r.qty_change < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{r.qty_change > 0 ? '+' : ''}{r.qty_change}</td></tr>)}</tbody></table>
          )}
        </div>
      )}
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>Item</th><th>SKU / barcode</th><th className="text-right">Expected</th><th className="w-36">Counted</th><th className="text-right">Difference</th></tr></thead>
            <tbody>{data?.map((r) => {
              const c = counts[r.variant_id];
              const diff = c !== undefined && c !== '' ? Number(c) - Number(r.qty) : null;
              return (
                <tr key={r.variant_id}>
                  <td className="font-medium">{r.product_name}{r.variant_name ? ` (${r.variant_name})` : ''}</td>
                  <td className="text-xs text-slate-400">{r.sku} {r.barcode}</td>
                  <td className="text-right tabular-nums">{qty(r.qty)}</td>
                  <td><input className="input py-1" type="number" step="any" value={c ?? ''} onChange={(e) => setCounts({ ...counts, [r.variant_id]: e.target.value })} aria-label={`Counted ${r.product_name}`} /></td>
                  <td className={`text-right tabular-nums ${diff ? (diff < 0 ? 'text-rose-600' : 'text-emerald-600') : ''}`}>{diff === null ? '' : diff > 0 ? `+${qty(diff)}` : qty(diff)}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Transfers() {
  const { stores, storeId } = useSession();
  const toast = useToast();
  const variants = useVariants();
  const { data, reload } = useAsync(() => boApi<any[]>('/transfers'), []);
  const [form, setForm] = useState<any>(null);
  const [receiving, setReceiving] = useState<any>(null);
  const act = async (t: any, a: string, body: any = {}) => { try { await boApi(`/transfers/${t.id}/${a}`, { body }); toast(`Transfer ${a}d`); setReceiving(null); reload(); } catch (e: any) { toast(e.message, 'err'); } };
  async function create() {
    try {
      await boApi('/transfers', { body: { ...form, items: form.items.filter((i: any) => i.variant_id).map((i: any) => ({ ...i, qty: Number(i.qty) })) } });
      setForm(null);
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  }
  const color: Record<string, any> = { requested: 'amber', approved: 'blue', dispatched: 'brand', received: 'green', rejected: 'red' };
  return (
    <div>
      <div className="mb-3 flex justify-end"><button className="btn-primary" disabled={stores.length < 2} onClick={() => setForm({ from_store_id: storeId, to_store_id: stores.find((s) => s.id !== storeId)?.id, note: '', items: [{ variant_id: '', qty: 1 }] })}><Plus size={16} />Request transfer</button></div>
      {stores.length < 2 && <p className="mb-3 text-sm text-slate-500">Add a second store in Settings to transfer stock.</p>}
      <div className="card overflow-x-auto">
        {!data?.length ? <Empty /> : (
          <table className="table">
            <thead><tr><th>Date</th><th>From → To</th><th>Items</th><th>Status</th><th /></tr></thead>
            <tbody>{data.map((t) => (
              <tr key={t.id}>
                <td>{dt(t.created_at)}</td><td>{t.from_name} → {t.to_name}</td>
                <td className="text-xs">{t.items.map((i: any) => `${i.name} ×${i.qty}${t.status === 'received' && i.received_qty !== i.qty ? ` (recv ${i.received_qty})` : ''}`).join(', ')}</td>
                <td><Badge color={color[t.status]}>{t.status}</Badge></td>
                <td className="text-right whitespace-nowrap">
                  {t.status === 'requested' && <><button className="btn-secondary py-1 text-xs" onClick={() => act(t, 'approve')}>Approve</button> <button className="btn-ghost py-1 text-xs text-rose-600" onClick={() => act(t, 'reject')}>Reject</button></>}
                  {t.status === 'approved' && <button className="btn-secondary py-1 text-xs" onClick={() => act(t, 'dispatch')}>Dispatch</button>}
                  {t.status === 'dispatched' && <button className="btn-primary py-1 text-xs" onClick={() => setReceiving({ ...t, items: t.items.map((i: any) => ({ ...i, received_qty: i.qty })) })}>Receive</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!form} onClose={() => setForm(null)} title="Request stock transfer" size="lg" footer={<><button className="btn-secondary" onClick={() => setForm(null)}>Cancel</button><button className="btn-primary" onClick={create}>Create</button></>}>
        {form && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="From store"><select className="input" value={form.from_store_id} onChange={(e) => setForm({ ...form, from_store_id: e.target.value })}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
              <Field label="To store"><select className="input" value={form.to_store_id} onChange={(e) => setForm({ ...form, to_store_id: e.target.value })}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            </div>
            {form.items.map((it: any, i: number) => (
              <div key={i} className="flex gap-2">
                <VariantSelect variants={variants} filter={(v) => v.track} value={it.variant_id} onChange={(v) => setForm({ ...form, items: form.items.map((x: any, j: number) => (i === j ? { ...x, variant_id: v?.id || '', name: v?.name } : x)) })} />
                <input className="input w-28" type="number" step="any" min={0} value={it.qty} onChange={(e) => setForm({ ...form, items: form.items.map((x: any, j: number) => (i === j ? { ...x, qty: e.target.value } : x)) })} aria-label="Quantity" />
              </div>
            ))}
            <button className="btn-ghost py-1 text-sm" onClick={() => setForm({ ...form, items: [...form.items, { variant_id: '', qty: 1 }] })}><Plus size={14} />Add item</button>
            <Field label="Note"><input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
      <Modal open={!!receiving} onClose={() => setReceiving(null)} title="Receive transfer" footer={<button className="btn-primary" onClick={() => act(receiving, 'receive', { items: receiving.items })}>Confirm receipt</button>}>
        {receiving && receiving.items.map((it: any, i: number) => (
          <div key={i} className="mb-2 flex items-center gap-3 text-sm">
            <div className="flex-1">{it.name} <span className="text-slate-400">(sent {it.qty})</span></div>
            <input className="input w-28" type="number" step="any" value={it.received_qty} onChange={(e) => setReceiving({ ...receiving, items: receiving.items.map((x: any, j: number) => (i === j ? { ...x, received_qty: Number(e.target.value) } : x)) })} aria-label="Received quantity" />
          </div>
        ))}
        <p className="text-xs text-slate-500">Short quantities are recorded as a transfer discrepancy.</p>
      </Modal>
    </div>
  );
}

function Production() {
  const toast = useToast();
  const variants = useVariants();
  const [v, setV] = useState<any>(null);
  const [q, setQ] = useState('10');
  const [note, setNote] = useState('');
  const recipes = variants.filter((x) => x.components?.length);
  async function produce() {
    try {
      const r = await boApi('/production', { body: { variant_id: v.id, qty: Number(q), note } });
      toast(`Produced ${q} · batch cost ${money(r.batch_cost)} (${money(r.unit_cost)}/unit)`);
    } catch (e: any) { toast(e.message, 'err'); }
  }
  return (
    <div className="card max-w-xl space-y-3 p-5">
      <p className="text-sm text-slate-500">Make finished goods from a recipe: ingredients are deducted, finished stock is added and unit cost updated from the batch.</p>
      {!recipes.length && <p className="text-sm text-amber-600">No items have recipes yet. Add components to an item (type “Composite / recipe”).</p>}
      <Field label="Finished item"><VariantSelect variants={recipes} value={v?.id || ''} onChange={setV} /></Field>
      {v && <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800">Per unit: {v.components.map((c: any) => `${variants.find((x) => x.id === c.component_variant_id)?.name} × ${c.qty}`).join(', ')}</div>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Quantity to produce"><input className="input" type="number" step="any" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <Field label="Batch note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      <button className="btn-primary" disabled={!v} onClick={produce}>Record production batch</button>
    </div>
  );
}

function History() {
  const { storeId } = useSession();
  const range = useRange('week');
  const { data, loading } = useAsync(() => boApi<any[]>(`/movements?${range.query}`), [range.query, storeId]);
  const cols = ['created_at', 'product_name', 'variant_name', 'reason', 'qty_change', 'qty_after', 'user_name', 'note'].map((k) => ({ key: k, label: k }));
  return (
    <div>
      <div className="mb-3 flex flex-wrap justify-between gap-2">{range.ui}<ExportButtons name="stock-history" rows={data || []} cols={cols} /></div>
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !data?.length ? <Empty /> : (
          <table className="table">
            <thead><tr><th>Date</th><th>Item</th><th>Reason</th><th className="text-right">Change</th><th className="text-right">After</th><th>By</th><th>Note</th></tr></thead>
            <tbody>{data.map((m) => (
              <tr key={m.id}>
                <td>{dt(m.created_at)}</td><td>{m.product_name}{m.variant_name ? ` (${m.variant_name})` : ''}</td><td className="capitalize">{m.reason.replace(/_/g, ' ')}</td>
                <td className={`text-right tabular-nums ${m.qty_change < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{m.qty_change > 0 ? '+' : ''}{qty(m.qty_change)}</td>
                <td className="text-right tabular-nums">{m.qty_after != null ? qty(m.qty_after) : ''}</td><td>{m.user_name}</td><td className="text-xs text-slate-400">{m.note}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
