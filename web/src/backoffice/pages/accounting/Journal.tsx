import { useState } from 'react';
import { Plus, Trash2, Undo2 } from 'lucide-react';
import { Badge, Empty, Field, Modal, SearchInput, Spinner, useAsync, useToast } from '../../../components/ui';
import { useSession } from '../../BackOffice';
import { ExportButtons } from '../../widgets';
import { AccountSelect, ac, crc, d10, SOURCE_LABEL, today, useDates } from './common';

/** Libro diario: every entry with its lines; manual entries and reversals. */
export default function Journal() {
  const { can } = useSession();
  const toast = useToast();
  const dates = useDates();
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const qs = `${dates.qs}${q ? `&q=${encodeURIComponent(q)}` : ''}${source ? `&source=${source}` : ''}`;
  const { data, loading, reload } = useAsync(() => ac<any[]>(`/entries?${qs}`), [qs]);
  const accounts = useAsync(() => ac<any[]>('/accounts'), []);
  const reverse = async (e: any) => {
    if (!confirm(`¿Reversar el asiento #${e.number}? Se registrará un asiento inverso con fecha de hoy.`)) return;
    try { await ac(`/entries/${e.id}/reverse`, { body: { date: today() } }); toast('Asiento reversado'); reload(); } catch (err: any) { toast(err.message, 'err'); }
  };
  const rows = (data || []).flatMap((e) => e.lines.map((l: any) => ({ number: e.number, date: d10(e.entry_date), memo: e.memo, source: SOURCE_LABEL[e.source] || e.source, account: `${l.code} ${l.account_name}`, debit: l.debit, credit: l.credit, partner: l.partner || '', detail: l.description || '' })));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {dates.ui}
        <select className="input w-auto py-1.5" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Origen">
          <option value="">Todos los orígenes</option>
          {Object.entries(SOURCE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <SearchInput value={q} onChange={setQ} placeholder="Descripción, cliente, proveedor o #" className="max-w-xs flex-1" />
        <ExportButtons name="libro-diario" rows={rows} cols={[{ key: 'number', label: '#' }, { key: 'date', label: 'Fecha' }, { key: 'memo', label: 'Descripción' }, { key: 'source', label: 'Origen' }, { key: 'account', label: 'Cuenta' }, { key: 'detail', label: 'Detalle' }, { key: 'partner', label: 'Tercero' }, { key: 'debit', label: 'Débito' }, { key: 'credit', label: 'Crédito' }]} />
        {can('accounting.manage') && <button className="btn-primary ml-auto" onClick={() => setAdding(true)}><Plus size={16} />Asiento manual</button>}
      </div>
      <div className="card overflow-x-auto">
        {loading && !data ? <div className="flex justify-center py-10"><Spinner /></div> : !data?.length ? <Empty>No hay asientos en este período</Empty> : (
          <table className="table text-sm">
            <thead><tr><th className="w-16">#</th><th className="w-28">Fecha</th><th>Descripción</th><th>Origen</th><th className="text-right">Monto</th><th /></tr></thead>
            <tbody>
              {data.map((e) => [
                <tr key={e.id} className={`cursor-pointer ${!e.active ? 'opacity-60' : ''}`} onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <td className="tabular-nums">{e.number}</td>
                  <td className="whitespace-nowrap">{d10(e.entry_date)}</td>
                  <td>{e.memo}{e.created_by_name && <div className="text-xs text-slate-400">por {e.created_by_name}</div>}</td>
                  <td><Badge color={e.source === 'manual' || e.source === 'opening' ? 'blue' : e.source === 'reversal' ? 'amber' : 'slate'}>{SOURCE_LABEL[e.source] || e.source}</Badge>{!e.active && <div className="text-xs text-slate-400">{e.reverses ? 'reversión' : 'reversado'}</div>}</td>
                  <td className="text-right tabular-nums">{crc(e.total)}</td>
                  <td className="text-right">{can('accounting.manage') && e.active && ['manual', 'opening', 'bank'].includes(e.source) && <button className="btn-secondary px-2 py-1 text-xs" onClick={(ev) => { ev.stopPropagation(); reverse(e); }}><Undo2 size={12} />Reversar</button>}</td>
                </tr>,
                open === e.id && (
                  <tr key={e.id + 'l'}><td colSpan={6} className="bg-slate-50 p-0 dark:bg-slate-800/40">
                    <table className="w-full text-xs">
                      <tbody>
                        {e.lines.map((l: any) => (
                          <tr key={l.id} className="border-t border-slate-200 dark:border-slate-700">
                            <td className="py-1.5 pl-8">{l.code} · {l.account_name}</td>
                            <td className="text-slate-500">{[l.description, l.partner].filter(Boolean).join(' · ')}{l.amount_fc ? ` · US$${Number(l.amount_fc).toLocaleString('es-CR')}` : ''}</td>
                            <td className="w-36 text-right tabular-nums">{Number(l.debit) ? crc(l.debit) : ''}</td>
                            <td className="w-36 pr-4 text-right tabular-nums">{Number(l.credit) ? crc(l.credit) : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td></tr>
                ),
              ])}
            </tbody>
          </table>
        )}
      </div>
      {adding && <EntryModal accounts={accounts.data || []} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
    </>
  );
}

function EntryModal({ accounts, onClose, onSaved }: { accounts: any[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(today());
  const [memo, setMemo] = useState('');
  const [opening, setOpening] = useState(false);
  const [lines, setLines] = useState([{ account_id: '', debit: '', credit: '', amount_fc: '', description: '' }, { account_id: '', debit: '', credit: '', amount_fc: '', description: '' }]);
  const [busy, setBusy] = useState(false);
  const set = (i: number, k: string, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const dr = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0), cr = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const diff = Math.round((dr - cr) * 100) / 100;
  const save = async () => {
    setBusy(true);
    try {
      await ac('/entries', { body: { date, memo, opening, lines: lines.filter((l) => l.account_id) } });
      toast('Asiento registrado');
      onSaved();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const isUsd = (id: string) => accounts.find((a) => a.id === id)?.currency === 'USD';
  return (
    <Modal open onClose={onClose} title="Asiento manual" size="lg"
      footer={<><span className={`mr-auto text-sm ${diff ? 'text-rose-600' : 'text-emerald-600'}`}>Débitos {crc(dr)} · Créditos {crc(cr)}{diff ? ` · diferencia ${crc(diff)}` : ' · cuadrado'}</span><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={busy || !!diff || !dr} onClick={save}>Registrar</button></>}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Fecha"><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Descripción" className="col-span-2"><input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Ej. Depreciación de noviembre, aporte de socios…" /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={opening} onChange={(e) => setOpening(e.target.checked)} />Asiento de apertura (saldos iniciales traídos de QuickBooks / contabilidad anterior)</label>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-slate-500"><th>Cuenta</th><th>Detalle</th><th className="w-32">Débito ₡</th><th className="w-32">Crédito ₡</th><th className="w-28">US$</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="pr-2 py-1"><AccountSelect accounts={accounts} value={l.account_id} onChange={(v) => set(i, 'account_id', v)} /></td>
                <td className="pr-2"><input className="input" value={l.description} onChange={(e) => set(i, 'description', e.target.value)} /></td>
                <td className="pr-2"><input className="input" inputMode="decimal" value={l.debit} onChange={(e) => set(i, 'debit', e.target.value)} /></td>
                <td className="pr-2"><input className="input" inputMode="decimal" value={l.credit} onChange={(e) => set(i, 'credit', e.target.value)} /></td>
                <td className="pr-2">{isUsd(l.account_id) && <input className="input" inputMode="decimal" value={l.amount_fc} onChange={(e) => set(i, 'amount_fc', e.target.value)} placeholder="±" />}</td>
                <td>{lines.length > 2 && <button className="btn-ghost p-1 text-rose-600" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Quitar"><Trash2 size={14} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn-secondary" onClick={() => setLines([...lines, { account_id: '', debit: '', credit: '', amount_fc: '', description: '' }])}><Plus size={14} />Línea</button>
      </div>
    </Modal>
  );
}
