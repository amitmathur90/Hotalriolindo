import { useState } from 'react';
import { Upload, Save } from 'lucide-react';
import { boApi } from '../../../lib/api';
import { dt } from '../../../lib/format';
import { Badge, Field, SearchInput, Spinner, useAsync, useToast } from '../../../components/ui';
import { CabysPicker } from '../../../components/CabysPicker';
import { ExportButtons } from '../../widgets';

/** Sucursales (branch number + economic activity) and terminals (one per POS device). */
export function Branches() {
  const toast = useToast();
  const { data, reload } = useAsync(() => boApi('/hacienda/branches'), []);
  const [edit, setEdit] = useState<Record<string, any>>({});
  if (!data) return <Spinner />;
  const val = (id: string, k: string, def: any) => edit[id]?.[k] ?? def ?? '';
  const set = (id: string, k: string, v: string) => setEdit({ ...edit, [id]: { ...edit[id], [k]: v } });
  const save = async (path: string, body: any) => {
    try { await boApi(path, { method: 'PUT', body }); toast('Guardado'); setEdit({}); reload(); } catch (e: any) { toast(e.message, 'err'); }
  };
  return (
    <div className="card space-y-3 p-5">
      <div className="font-semibold">Sucursales y terminales</div>
      <p className="text-xs text-slate-500">Cada local es una sucursal (3 dígitos) y cada caja (dispositivo POS) puede tener su propia terminal (5 dígitos) en el consecutivo. Use terminales distintas a las de Cubo u otro sistema. La actividad económica del local (ej. 561001 restaurante) reemplaza la de la empresa en sus comprobantes.</p>
      {data.stores.map((s: any) => (
        <div key={s.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <div className="grid grid-cols-[1fr_6rem_8rem_auto] items-end gap-2">
            <div className="font-medium">{s.name}</div>
            <Field label="Sucursal"><input className="input" maxLength={3} value={val(s.id, 'hacienda_branch', s.hacienda_branch)} onChange={(e) => set(s.id, 'hacienda_branch', e.target.value)} placeholder="001" /></Field>
            <Field label="Actividad"><input className="input" maxLength={6} value={val(s.id, 'hacienda_activity', s.hacienda_activity)} onChange={(e) => set(s.id, 'hacienda_activity', e.target.value)} placeholder="Empresa" /></Field>
            <button className="btn-secondary" disabled={!edit[s.id]} onClick={() => save(`/hacienda/branches/${s.id}`, { hacienda_branch: val(s.id, 'hacienda_branch', s.hacienda_branch), hacienda_activity: val(s.id, 'hacienda_activity', s.hacienda_activity) })}><Save size={14} /></button>
          </div>
          <div className="mt-2 space-y-1">
            {data.devices.filter((d: any) => d.store_id === s.id).map((d: any) => (
              <div key={d.id} className="grid grid-cols-[1fr_8rem_auto] items-center gap-2 pl-4 text-sm">
                <span>{d.name}{!d.active && <Badge>Inactivo</Badge>}<span className="ml-2 text-xs text-slate-400">{d.last_seen_at ? `visto ${dt(d.last_seen_at)}` : ''}</span></span>
                <input className="input" maxLength={5} value={val(d.id, 'hacienda_terminal', d.hacienda_terminal)} onChange={(e) => set(d.id, 'hacienda_terminal', e.target.value)} placeholder="Predeterminada" aria-label={`Terminal de ${d.name}`} />
                <button className="btn-secondary" disabled={!edit[d.id]} onClick={() => save(`/hacienda/terminals/${d.id}`, { hacienda_terminal: val(d.id, 'hacienda_terminal', d.hacienda_terminal) })}><Save size={14} /></button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const MAP_STATUS: Record<string, [string, any]> = {
  ok: ['Asignado', 'green'], category: ['De la categoría', 'blue'], default: ['Código predeterminado', 'amber'], missing: ['Sin CABYS', 'red'], not_in_catalogue: ['No está en el catálogo', 'red'],
};
const UNITS = ['Unid', 'Sp', 'd', 'h', 'kg', 'g', 'L', 'mL', 'Os'];

/** Official CABYS catalogue (import + version) and the product → CABYS / unit mapping (with history). */
export function CabysSetup() {
  const toast = useToast();
  const { data, reload } = useAsync(() => boApi('/hacienda/cabys/products'), []);
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState('issues');
  const [edit, setEdit] = useState<Record<string, { cabys?: string; unit?: string }>>({});
  const upload = (f?: File) => {
    if (!f) return;
    const r = new FileReader();
    r.onload = async () => {
      setBusy(true);
      try {
        const out = await boApi('/hacienda/cabys/import', { body: { file: { name: f.name, content: String(r.result).split(',')[1] }, version } });
        toast(`Catálogo ${out.version} importado: ${out.codes} códigos`);
        reload();
      } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
    };
    r.readAsDataURL(f);
  };
  const save = async (p: any) => {
    const e = edit[p.id] || {};
    try {
      await boApi(`/hacienda/products/${p.id}/cabys`, { method: 'PUT', body: { cabys: e.cabys ?? p.cabys, unit: e.unit ?? p.hacienda_unit } });
      toast(`${p.name}: guardado`);
      setEdit({ ...edit, [p.id]: {} });
      reload();
    } catch (err: any) { toast(err.message, 'err'); }
  };
  if (!data) return <Spinner />;
  const c = data.catalogue;
  const list = data.products.filter((p: any) => (only === 'all' || p.status !== 'ok') && (!q || p.name.toLowerCase().includes(q.toLowerCase())));
  const issues = data.products.filter((p: any) => p.status !== 'ok').length;
  return (
    <div className="card space-y-3 p-5 lg:col-span-2">
      <div className="font-semibold">Catálogo CABYS y productos</div>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <div>{c.codes ? <>Catálogo oficial <b>{c.version}</b> · {c.codes.toLocaleString('es-CR')} códigos · importado {dt(c.imported_at)}</> : <span className="text-amber-700">No se ha importado el catálogo oficial: la búsqueda usa la API pública de Hacienda.</span>}</div>
        <Field label="Versión"><input className="input w-32" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="2026-11" /></Field>
        <label className={`btn-secondary cursor-pointer ${busy ? 'pointer-events-none opacity-60' : ''}`}><Upload size={16} />Importar catálogo (Excel o CSV)
          <input type="file" accept=".xlsx,.csv,.txt" className="hidden" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>
      <p className="text-xs text-slate-500">Descargue el catálogo CABYS vigente del BCCR / Hacienda. Cada producto debe tener su código asignado por una persona autorizada; el sistema no asigna códigos por parecido de nombres. Los cambios quedan en el historial.</p>
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-auto py-1.5" value={only} onChange={(e) => setOnly(e.target.value)} aria-label="Filtro"><option value="issues">Por revisar ({issues})</option><option value="all">Todos ({data.products.length})</option></select>
        <SearchInput value={q} onChange={setQ} placeholder="Producto" className="max-w-xs" />
        <ExportButtons name="productos-cabys" rows={data.products} cols={[{ key: 'name', label: 'Producto' }, { key: 'category', label: 'Categoría' }, { key: 'effective_cabys', label: 'CABYS' }, { key: 'cabys_description', label: 'Descripción CABYS' }, { key: 'hacienda_unit', label: 'Unidad' }, { key: 'status', label: 'Estado' }]} />
      </div>
      <div className="max-h-[32rem] overflow-y-auto">
        <table className="table text-sm">
          <thead><tr><th>Producto</th><th>Estado</th><th className="w-64">CABYS</th><th className="w-28">Unidad</th><th /></tr></thead>
          <tbody>
            {list.map((p: any) => (
              <tr key={p.id}>
                <td>{p.name}<div className="text-xs text-slate-500">{p.category}{p.cabys_description ? ` · ${p.cabys_description}` : ''}</div></td>
                <td><Badge color={MAP_STATUS[p.status][1]}>{MAP_STATUS[p.status][0]}</Badge>{p.status !== 'ok' && p.effective_cabys && <div className="font-mono text-xs text-slate-400">{p.effective_cabys}</div>}</td>
                <td><CabysPicker value={edit[p.id]?.cabys ?? p.cabys ?? ''} onChange={(v) => setEdit({ ...edit, [p.id]: { ...edit[p.id], cabys: v } })} /></td>
                <td><select className="input" value={edit[p.id]?.unit ?? p.hacienda_unit ?? ''} onChange={(e) => setEdit({ ...edit, [p.id]: { ...edit[p.id], unit: e.target.value } })}><option value="">{p.type === 'service' ? 'Sp' : 'Unid'} (auto)</option>{UNITS.map((u) => <option key={u}>{u}</option>)}</select></td>
                <td><button className="btn-secondary px-2 py-1 text-xs" disabled={!edit[p.id] || !Object.keys(edit[p.id]).length} onClick={() => save(p)}><Save size={12} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
