import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { boApi } from '../lib/api';
import { Spinner } from './ui';

export type CabysItem = { codigo: string; descripcion: string; impuesto: number };

/**
 * 13-digit CABYS code input with a search of Hacienda's CABYS catalogue (by word or code).
 * Picking a result fills the code; onPick also receives the suggested IVA rate.
 */
export function CabysPicker({ value, onChange, onPick, placeholder = '13 dígitos', className = '' }: {
  value: string; onChange: (code: string) => void; onPick?: (item: CabysItem) => void; placeholder?: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<CabysItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    // the list is position:fixed, so close it when the page (not the list itself) scrolls
    const s = (e: Event) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('scroll', s, true);
    return () => { document.removeEventListener('mousedown', h); window.removeEventListener('scroll', s, true); };
  }, [open]);
  useEffect(() => {
    if (!open || q.trim().length < 3) { setItems([]); return; }
    const t = setTimeout(async () => {
      setBusy(true);
      setErr('');
      try {
        const qs = /^\d{13}$/.test(q.trim()) ? `codigo=${q.trim()}` : `q=${encodeURIComponent(q.trim())}`;
        setItems((await boApi<{ items: CabysItem[] }>(`/hacienda/cabys?${qs}`)).items);
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setBusy(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [q, open]);

  return (
    <div ref={box} className={`relative ${className}`}>
      <div className="flex gap-1">
        <input className="input font-mono" inputMode="numeric" maxLength={13} value={value || ''} placeholder={placeholder}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} aria-label="Código CABYS" />
        <button type="button" className="btn-secondary px-2.5" title="Buscar en el catálogo CABYS de Hacienda" onClick={() => {
          // fixed position so the list is not clipped by scrollable tables
          const r = box.current!.getBoundingClientRect();
          setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 460)) });
          setOpen(!open);
        }}><Search size={16} /></button>
      </div>
      {open && (
        <div style={pos ? { position: "fixed", top: pos.top, left: pos.left } : undefined} className="z-50 w-[28rem] max-w-[90vw] rounded-lg border border-slate-200 bg-white p-2 shadow-xl dark:border-slate-700 dark:bg-slate-900">
          <input autoFocus className="input" placeholder="Buscar: cerveza, hospedaje, desayuno… o el código" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="mt-2 max-h-72 overflow-y-auto text-sm">
            {busy && <div className="flex justify-center py-3"><Spinner /></div>}
            {err && <div className="p-2 text-xs text-rose-600">{err}</div>}
            {!busy && !err && q.trim().length >= 3 && !items.length && <div className="p-2 text-xs text-slate-500">Sin resultados</div>}
            {q.trim().length < 3 && <div className="p-2 text-xs text-slate-500">Escriba al menos 3 letras. Fuente: catálogo CABYS del Ministerio de Hacienda.</div>}
            {items.map((it) => (
              <button key={it.codigo} type="button" className="block w-full rounded px-2 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
                onClick={() => { onChange(it.codigo); onPick?.(it); setOpen(false); }}>
                <div className="flex justify-between gap-2"><span className="font-mono text-xs text-slate-500">{it.codigo}</span><span className="text-xs text-slate-500">IVA {it.impuesto}%</span></div>
                <div>{it.descripcion}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
