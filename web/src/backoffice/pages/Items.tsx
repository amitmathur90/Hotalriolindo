import { useRef, useState } from 'react';
import { Plus, Trash2, Upload, Barcode as BarcodeIcon, ImagePlus } from 'lucide-react';
import { boApi } from '../../lib/api';
import { money } from '../../lib/format';
import { parseCSV } from '../../lib/csv';
import { imageToDataUrl } from '../../lib/misc';
import { Badge, Empty, Field, Modal, PageHeader, SearchInput, Spinner, Tabs, Toggle, useAsync, useToast } from '../../components/ui';
import { useSession } from '../BackOffice';
import { CrudPage, ExportButtons } from '../widgets';

export default function Items() {
  const [tab, setTab] = useState<'items' | 'categories' | 'modifiers'>('items');
  return (
    <div>
      <PageHeader title="Items" subtitle="Products, variants, categories and modifiers" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'items', label: 'Item list' }, { id: 'categories', label: 'Categories' }, { id: 'modifiers', label: 'Modifiers' }]} />
      {tab === 'items' && <ItemList />}
      {tab === 'categories' && (
        <CrudPage header={false} title="Categories" path="/categories" perm="products.manage" defaults={{ color: '#0d9488', sort: 0 }}
          subtitle="Kitchen station routes the category's items to that Kitchen Display / printer (e.g. Kitchen, Bar)."
          columns={[{ key: 'name', label: 'Name', render: (r) => <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: r.color }} />{r.name}</span> }, { key: 'kitchen_station', label: 'Kitchen station' }, { key: 'sort', label: 'Sort' }]}
          fields={[{ key: 'name', label: 'Name', required: true }, { key: 'color', label: 'Color', type: 'color' }, { key: 'kitchen_station', label: 'Kitchen station', hint: 'Leave empty if not prepared' }, { key: 'sort', label: 'Sort order', type: 'number' }]} />
      )}
      {tab === 'modifiers' && <Modifiers />}
    </div>
  );
}

function ItemList() {
  const { can, storeId } = useSession();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { data, loading, reload } = useAsync(() => boApi<any[]>(`/products?include_inactive=1&q=${encodeURIComponent(q)}${cat ? `&category_id=${cat}` : ''}`), [q, cat, storeId]);
  const meta = useAsync(async () => ({ cats: await boApi<any[]>('/categories'), taxes: await boApi<any[]>('/taxes'), groups: await boApi<any[]>('/modifier-groups') }), []);
  const rows = data || [];

  async function bulk(action: string, value?: any) {
    try {
      await boApi('/products/bulk', { body: { ids: [...sel], action, value } });
      toast('Updated');
      setSel(new Set());
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  }
  async function importCsv(file: File) {
    try {
      const rows = parseCSV(await file.text());
      const r = await boApi('/products/import', { body: { rows } });
      toast(`Imported ${r.count} items`);
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  }
  const flat = rows.flatMap((p) => p.variants.map((v: any) => ({ name: p.name, variant: v.name, category: p.category_name, sku: v.sku, barcode: v.barcode, price: v.price, cost: v.cost, stock: v.stock, reorder_level: v.reorder_level, track_stock: p.track_stock, unit: p.unit })));
  const exportCols = ['name', 'variant', 'category', 'sku', 'barcode', 'price', 'cost', 'stock', 'reorder_level', 'track_stock', 'unit'].map((k) => ({ key: k, label: k }));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Search name, SKU, barcode" className="w-64" />
        <select className="input w-auto" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {meta.data?.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="ml-auto flex flex-wrap gap-2">
          <ExportButtons name="items" rows={flat} cols={exportCols} />
          {can('products.manage') && (
            <>
              <input ref={fileRef} type="file" accept=".csv" hidden onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])} />
              <button className="btn-secondary px-2.5 py-1.5 text-xs" onClick={() => fileRef.current?.click()} title="Columns: name, variant, category, sku, barcode, price, cost, stock, tax, track_stock"><Upload size={14} />Import CSV</button>
              <button className="btn-secondary px-2.5 py-1.5 text-xs" onClick={async () => { const r = await boApi('/products/generate-barcodes', { body: {} }); toast(`${r.count} barcodes generated`); reload(); }}><BarcodeIcon size={14} />Generate barcodes</button>
              <button className="btn-primary" onClick={() => setEdit({ name: '', type: 'standard', unit: 'pcs', track_stock: true, tax_ids: [], modifier_group_ids: [], variants: [{ name: '', price: '', cost: '' }], active: true })}><Plus size={16} />Add item</button>
            </>
          )}
        </div>
      </div>
      {sel.size > 0 && (
        <div className="card mb-3 flex flex-wrap items-center gap-2 p-2 text-sm">
          <span className="px-2 font-medium">{sel.size} selected</span>
          <button className="btn-secondary py-1" onClick={() => bulk('activate')}>Activate</button>
          <button className="btn-secondary py-1" onClick={() => bulk('deactivate')}>Deactivate</button>
          <select className="input w-auto py-1" defaultValue="" onChange={(e) => e.target.value && bulk('category', e.target.value)} aria-label="Set category">
            <option value="">Set category…</option>{meta.data?.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="input w-auto py-1" defaultValue="" onChange={(e) => e.target.value && bulk('tax', [e.target.value])} aria-label="Set tax">
            <option value="">Set tax…</option>{meta.data?.taxes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button className="btn-secondary py-1" onClick={() => { const v = prompt('Change prices by % (e.g. 10 or -5)'); if (v) bulk('price_pct', Number(v)); }}>Change price %</button>
        </div>
      )}
      <div className="card overflow-x-auto">
        {loading ? <div className="flex justify-center py-10"><Spinner /></div> : !rows.length ? <Empty>No items. Add one or import a CSV.</Empty> : (
          <table className="table">
            <thead><tr>
              <th className="w-8"><input type="checkbox" checked={sel.size === rows.length} onChange={(e) => setSel(new Set(e.target.checked ? rows.map((r) => r.id) : []))} aria-label="Select all" /></th>
              <th>Item</th><th>Category</th><th className="text-right">Price</th><th className="text-right">Cost</th><th className="text-right">Margin</th><th className="text-right">In stock</th><th>Status</th>
            </tr></thead>
            <tbody>
              {rows.map((p) => {
                const v = p.variants[0] || {};
                const stock = p.variants.reduce((s: number, x: any) => s + Number(x.stock), 0);
                const low = p.track_stock && p.variants.some((x: any) => Number(x.stock) <= Number(x.reorder_level));
                return (
                  <tr key={p.id} className="cursor-pointer" onClick={() => setEdit(JSON.parse(JSON.stringify(p)))}>
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(p.id)} onChange={(e) => { const s = new Set(sel); e.target.checked ? s.add(p.id) : s.delete(p.id); setSel(s); }} aria-label={`Select ${p.name}`} /></td>
                    <td>
                      <div className="flex items-center gap-3">
                        {p.image_url ? <img src={p.image_url} className="h-9 w-9 rounded-lg object-cover" alt="" /> : <div className="flex h-9 w-9 items-center justify-center rounded-lg text-xs font-bold text-white" style={{ background: p.color || p.category_color || '#94a3b8' }}>{p.name.slice(0, 2).toUpperCase()}</div>}
                        <div><div className="font-medium">{p.name}</div><div className="text-xs text-slate-400">{p.variants.length > 1 ? `${p.variants.length} variants` : v.sku}{p.type !== 'standard' ? ` · ${p.type}` : ''}</div></div>
                      </div>
                    </td>
                    <td>{p.category_name || '—'}</td>
                    <td className="text-right tabular-nums">{p.variants.length > 1 ? `${money(Math.min(...p.variants.map((x: any) => x.price)))}+` : money(v.price)}</td>
                    <td className="text-right tabular-nums">{money(v.cost)}</td>
                    <td className="text-right tabular-nums">{v.price ? `${Math.round(((v.price - v.cost) / v.price) * 100)}%` : '—'}</td>
                    <td className={`text-right tabular-nums ${low ? 'font-semibold text-rose-600' : ''}`}>{p.track_stock ? stock : '—'}</td>
                    <td>{p.active ? <Badge color="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {edit && meta.data && <ProductEditor product={edit} meta={meta.data} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function ProductEditor({ product, meta, onClose, onSaved }: { product: any; meta: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [p, setP] = useState<any>(product);
  const [busy, setBusy] = useState(false);
  const all = useAsync(() => boApi<any[]>('/products'), []);
  const componentOptions = (all.data || []).flatMap((x) => x.variants.map((v: any) => ({ id: v.id, label: `${x.name}${v.name ? ` (${v.name})` : ''}`, unit: x.unit })));
  const set = (k: string, v: any) => setP({ ...p, [k]: v });
  const setV = (i: number, k: string, v: any) => set('variants', p.variants.map((x: any, j: number) => (i === j ? { ...x, [k]: v } : x)));
  const toggleIn = (k: string, id: string) => set(k, p[k].includes(id) ? p[k].filter((x: string) => x !== id) : [...p[k], id]);

  async function save() {
    setBusy(true);
    try {
      const body = { ...p, variants: p.variants.map((v: any) => ({ ...v, price: v.base_price ?? v.price, store_price: v.store_price === '' ? null : v.store_price })) };
      if (p.id) await boApi(`/products/${p.id}`, { method: 'PUT', body });
      else await boApi('/products', { body });
      toast('Item saved');
      onSaved();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} size="xl" title={p.id ? `Edit ${product.name}` : 'New item'}
      footer={<>{p.id && <button className="btn-ghost mr-auto text-rose-600" onClick={async () => { await boApi(`/products/${p.id}`, { method: 'DELETE' }); onSaved(); }}>Deactivate</button>}
        <button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy} onClick={save}>Save item</button></>}>
      <div className="grid gap-4 md:grid-cols-[1fr_200px]">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name *" className="sm:col-span-2"><input className="input" value={p.name} onChange={(e) => set('name', e.target.value)} autoFocus /></Field>
          <Field label="Category"><select className="input" value={p.category_id || ''} onChange={(e) => set('category_id', e.target.value || null)}><option value="">No category</option>{meta.cats.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Type">
            <select className="input" value={p.type} onChange={(e) => set('type', e.target.value)}>
              <option value="standard">Standard</option><option value="weighted">Sold by weight</option><option value="composite">Composite / recipe</option>
              <option value="service">Service</option><option value="digital">Digital</option>
            </select>
          </Field>
          <Field label="Unit"><select className="input" value={p.unit} onChange={(e) => set('unit', e.target.value)}>{['pcs', 'kg', 'g', 'l', 'ml', 'm', 'box', 'pack'].map((u) => <option key={u}>{u}</option>)}</select></Field>
          <Field label="Description"><input className="input" value={p.description || ''} onChange={(e) => set('description', e.target.value)} /></Field>
          <div className="flex flex-wrap gap-4 sm:col-span-2">
            <Toggle checked={p.track_stock} onChange={(v) => set('track_stock', v)} label="Track stock" />
            <Toggle checked={p.is_favorite} onChange={(v) => set('is_favorite', v)} label="Favorite on POS" />
            <Toggle checked={p.active} onChange={(v) => set('active', v)} label="Active" />
          </div>
        </div>
        <div>
          <span className="label">Image</span>
          <label className="flex aspect-square cursor-pointer items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-slate-300 text-slate-400 hover:border-brand-500 dark:border-slate-700">
            {p.image_url ? <img src={p.image_url} className="h-full w-full object-cover" alt="" /> : <ImagePlus size={28} />}
            <input type="file" accept="image/*" hidden onChange={async (e) => e.target.files?.[0] && set('image_url', await imageToDataUrl(e.target.files[0]))} />
          </label>
          {p.image_url && <button className="mt-1 text-xs text-rose-600" onClick={() => set('image_url', null)}>Remove image</button>}
          <Field label="Tile color" className="mt-2"><input type="color" className="input h-9 p-1" value={p.color || '#0d9488'} onChange={(e) => set('color', e.target.value)} /></Field>
        </div>
      </div>

      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between"><div className="text-sm font-semibold">Variants, pricing & stock</div>
          <button className="btn-ghost py-1 text-sm" onClick={() => set('variants', [...p.variants, { name: '', price: p.variants[0]?.price || '', cost: p.variants[0]?.cost || '' }])}><Plus size={14} />Add variant</button></div>
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
          <table className="table">
            <thead><tr><th>Variant</th><th>Price</th><th>Store price</th><th>Cost</th><th>Wholesale</th><th>SKU</th><th>Barcode</th><th>Reorder at</th>{!p.id && <th>Opening stock</th>}<th /></tr></thead>
            <tbody>
              {p.variants.map((v: any, i: number) => (
                <tr key={v.id || i}>
                  <td><input className="input min-w-24" placeholder={p.variants.length > 1 ? 'e.g. Large' : 'Default'} value={v.name || ''} onChange={(e) => setV(i, 'name', e.target.value)} /></td>
                  <td><input className="input w-24" type="number" step="any" value={v.base_price ?? v.price ?? ''} onChange={(e) => setP({ ...p, variants: p.variants.map((x: any, j: number) => (i === j ? { ...x, price: e.target.value, base_price: e.target.value } : x)) })} /></td>
                  <td><input className="input w-24" type="number" step="any" placeholder="—" title="Override price for the selected store" value={v.store_price ?? ''} onChange={(e) => setV(i, 'store_price', e.target.value)} /></td>
                  <td><input className="input w-24" type="number" step="any" value={v.cost ?? ''} onChange={(e) => setV(i, 'cost', e.target.value)} /></td>
                  <td><input className="input w-24" type="number" step="any" value={v.wholesale_price ?? ''} onChange={(e) => setV(i, 'wholesale_price', e.target.value)} /></td>
                  <td><input className="input w-28" value={v.sku || ''} onChange={(e) => setV(i, 'sku', e.target.value)} /></td>
                  <td><input className="input w-36" value={v.barcode || ''} onChange={(e) => setV(i, 'barcode', e.target.value)} /></td>
                  <td><input className="input w-20" type="number" step="any" value={v.reorder_level ?? ''} onChange={(e) => setV(i, 'reorder_level', e.target.value)} /></td>
                  {!p.id && <td><input className="input w-20" type="number" step="any" value={v.stock ?? ''} onChange={(e) => setV(i, 'stock', e.target.value)} /></td>}
                  <td>{p.variants.length > 1 && <button className="btn-ghost p-1.5 text-rose-600" onClick={() => set('variants', p.variants.filter((_: any, j: number) => j !== i))} aria-label="Remove variant"><Trash2 size={15} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(p.type === 'composite' || p.variants.some((v: any) => v.components?.length)) && (
        <div className="mt-5">
          <div className="mb-1 text-sm font-semibold">Recipe / components</div>
          <p className="mb-2 text-xs text-slate-500">Selling one unit deducts these ingredients from stock. Use Inventory → Production to make finished goods in batches.</p>
          {p.variants.map((v: any, i: number) => (
            <div key={i} className="mb-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              {p.variants.length > 1 && <div className="mb-2 text-sm font-medium">{v.name || 'Default'}</div>}
              {(v.components || []).map((c: any, ci: number) => (
                <div key={ci} className="mb-2 flex gap-2">
                  <select className="input" value={c.component_variant_id} onChange={(e) => setV(i, 'components', v.components.map((x: any, k: number) => (k === ci ? { ...x, component_variant_id: e.target.value } : x)))}>
                    <option value="">Choose ingredient</option>{componentOptions.filter((o) => o.id !== v.id).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                  <input className="input w-28" type="number" step="any" placeholder="Qty" value={c.qty} onChange={(e) => setV(i, 'components', v.components.map((x: any, k: number) => (k === ci ? { ...x, qty: e.target.value } : x)))} />
                  <button className="btn-ghost p-2 text-rose-600" onClick={() => setV(i, 'components', v.components.filter((_: any, k: number) => k !== ci))} aria-label="Remove ingredient"><Trash2 size={15} /></button>
                </div>
              ))}
              <button className="btn-ghost py-1 text-sm" onClick={() => setV(i, 'components', [...(v.components || []), { component_variant_id: '', qty: 1 }])}><Plus size={14} />Add ingredient</button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <div>
          <div className="mb-2 text-sm font-semibold">Taxes</div>
          <div className="flex flex-wrap gap-2">
            {meta.taxes.map((t: any) => (
              <button key={t.id} onClick={() => toggleIn('tax_ids', t.id)} className={`rounded-full border px-3 py-1 text-sm ${p.tax_ids.includes(t.id) ? 'border-brand-600 bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300' : 'border-slate-300 dark:border-slate-700'}`}>
                {t.name}{t.inclusive ? ' (incl.)' : ''}
              </button>
            ))}
            {!meta.taxes.length && <span className="text-sm text-slate-400">No taxes configured (tax-exempt)</span>}
          </div>
        </div>
        <div>
          <div className="mb-2 text-sm font-semibold">Modifier groups</div>
          <div className="flex flex-wrap gap-2">
            {meta.groups.map((g: any) => (
              <button key={g.id} onClick={() => toggleIn('modifier_group_ids', g.id)} className={`rounded-full border px-3 py-1 text-sm ${p.modifier_group_ids.includes(g.id) ? 'border-brand-600 bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300' : 'border-slate-300 dark:border-slate-700'}`}>{g.name}</button>
            ))}
            {!meta.groups.length && <span className="text-sm text-slate-400">No modifier groups</span>}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Modifiers() {
  const toast = useToast();
  const { can } = useSession();
  const { data, reload } = useAsync(() => boApi<any[]>('/modifier-groups'), []);
  const [edit, setEdit] = useState<any>(null);
  async function save() {
    try {
      const body = { ...edit, options: edit.options.filter((o: any) => o.name).map((o: any) => ({ ...o, id: o.id || crypto.randomUUID().slice(0, 8), price: Number(o.price) || 0 })), min_select: Number(edit.min_select) || 0, max_select: Number(edit.max_select) || 0 };
      if (edit.id) await boApi(`/modifier-groups/${edit.id}`, { method: 'PUT', body });
      else await boApi('/modifier-groups', { body });
      setEdit(null);
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  }
  return (
    <div>
      {can('products.manage') && <div className="mb-3 flex justify-end"><button className="btn-primary" onClick={() => setEdit({ name: '', min_select: 0, max_select: 0, options: [{ name: '', price: 0 }] })}><Plus size={16} />Add modifier group</button></div>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data?.map((g) => (
          <button key={g.id} className="card p-4 text-left hover:border-brand-400" onClick={() => setEdit(JSON.parse(JSON.stringify(g)))}>
            <div className="font-semibold">{g.name}</div>
            <div className="mb-2 text-xs text-slate-400">{g.min_select > 0 ? `Required (min ${g.min_select})` : 'Optional'}{g.max_select > 0 ? ` · max ${g.max_select}` : ' · unlimited'}</div>
            <div className="flex flex-wrap gap-1">{g.options.map((o: any) => <Badge key={o.id}>{o.name}{o.price ? ` +${money(o.price)}` : ''}</Badge>)}</div>
          </button>
        ))}
      </div>
      {!data?.length && <Empty>No modifier groups yet</Empty>}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit modifier group' : 'New modifier group'}
        footer={<>{edit?.id && <button className="btn-ghost mr-auto text-rose-600" onClick={async () => { await boApi(`/modifier-groups/${edit.id}`, { method: 'DELETE' }); setEdit(null); reload(); }}>Delete</button>}<button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button><button className="btn-primary" onClick={save}>Save</button></>}>
        {edit && (
          <div className="space-y-3">
            <Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Minimum selections" hint="1+ makes it required"><input className="input" type="number" min={0} value={edit.min_select} onChange={(e) => setEdit({ ...edit, min_select: e.target.value })} /></Field>
              <Field label="Maximum selections" hint="0 = unlimited"><input className="input" type="number" min={0} value={edit.max_select} onChange={(e) => setEdit({ ...edit, max_select: e.target.value })} /></Field>
            </div>
            <div className="label">Options</div>
            {edit.options.map((o: any, i: number) => (
              <div key={i} className="flex gap-2">
                <input className="input" placeholder="Option name" value={o.name} onChange={(e) => setEdit({ ...edit, options: edit.options.map((x: any, j: number) => (i === j ? { ...x, name: e.target.value } : x)) })} />
                <input className="input w-28" type="number" step="any" placeholder="Price" value={o.price} onChange={(e) => setEdit({ ...edit, options: edit.options.map((x: any, j: number) => (i === j ? { ...x, price: e.target.value } : x)) })} />
                <button className="btn-ghost p-2 text-rose-600" onClick={() => setEdit({ ...edit, options: edit.options.filter((_: any, j: number) => j !== i) })} aria-label="Remove option"><Trash2 size={15} /></button>
              </div>
            ))}
            <button className="btn-ghost py-1 text-sm" onClick={() => setEdit({ ...edit, options: [...edit.options, { name: '', price: 0 }] })}><Plus size={14} />Add option</button>
          </div>
        )}
      </Modal>
    </div>
  );
}
