import { useEffect, useState } from 'react';
import { Lock, Unlock, Scale, CalendarCheck } from 'lucide-react';
import { boApi } from '../../../lib/api';
import { Field, Spinner, useAsync, useToast } from '../../../components/ui';
import { AccountSelect, ac, crc, today } from './common';

/** Settings, expense-category mapping, period lock, dollar revaluation and year-end close. */
export default function Closing() {
  const toast = useToast();
  const settings = useAsync(() => ac('/settings'), []);
  const accounts = useAsync(() => ac<any[]>('/accounts'), []);
  const [s, setS] = useState<any>(null);
  const [lockDate, setLockDate] = useState('');
  const [revDate, setRevDate] = useState(today());
  const [revRate, setRevRate] = useState('');
  const [year, setYear] = useState(String(Number(today().slice(0, 4)) - 1));
  const [busy, setBusy] = useState('');
  useEffect(() => {
    if (settings.data) { setS({ ...settings.data, category_map: settings.data.category_map || {} }); setLockDate(settings.data.locked_until ? String(settings.data.locked_until).slice(0, 10) : ''); }
  }, [settings.data]);
  useEffect(() => { boApi('/hacienda/fx').then((r) => r.rate && setRevRate(String(r.rate))).catch(() => {}); }, []);
  if (!s) return <div className="flex justify-center py-10"><Spinner /></div>;
  const run = async (key: string, fn: () => Promise<any>, msg: (r: any) => string, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(key);
    try { const r = await fn(); toast(msg(r)); settings.reload(); } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(''); }
  };
  const expenseAccounts = (accounts.data || []).filter((a) => a.type === 'expense');
  const cats: string[] = [...new Set([...(s.expense_categories || []), ...Object.keys(s.category_map || {}), 'Compras', 'Insumos de cocina', 'Insumos de bar', 'Limpieza', 'Mantenimiento', 'Servicios públicos', 'Servicios profesionales', 'Petty cash'])];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="card space-y-3 p-5">
        <div className="font-semibold">Configuración</div>
        <Field label="Contabilizar automáticamente desde" hint="Movimientos anteriores se ingresan como saldos de apertura (vacío = todo el historial)">
          <input type="date" className="input" value={s.start_date ? String(s.start_date).slice(0, 10) : ''} onChange={(e) => setS({ ...s, start_date: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cargas sociales patronales (%)" hint="CCSS patronal sobre salarios (26,67 % en 2026)"><input className="input" inputMode="decimal" value={s.employer_ccss_rate} onChange={(e) => setS({ ...s, employer_ccss_rate: e.target.value })} /></Field>
          <Field label="Gastos ingresados a mano se pagan de">
            <select className="input" value={s.expense_paid_from} onChange={(e) => setS({ ...s, expense_paid_from: e.target.value })}><option value="cash">Caja general</option><option value="petty_cash">Caja chica</option><option value="bank_crc">Banco colones</option></select>
          </Field>
        </div>
        <div className="text-sm font-medium">Categorías de gasto → cuenta contable</div>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {cats.map((c) => (
            <div key={c} className="grid grid-cols-2 items-center gap-2 text-sm">
              <span>{c}</span>
              <AccountSelect accounts={expenseAccounts} value={s.category_map[c] || ''} placeholder="Automático" onChange={(v) => setS({ ...s, category_map: { ...s.category_map, [c]: v || undefined } })} />
            </div>
          ))}
        </div>
        <button className="btn-primary w-full" disabled={!!busy} onClick={() => run('save', () => ac('/settings', { method: 'PUT', body: { start_date: s.start_date || null, employer_ccss_rate: s.employer_ccss_rate, expense_paid_from: s.expense_paid_from, category_map: s.category_map } }), () => 'Guardado')}>Guardar</button>
      </div>

      <div className="space-y-4">
        <div className="card space-y-3 p-5">
          <div className="flex items-center gap-2 font-semibold"><Lock size={18} />Cierre mensual</div>
          <p className="text-sm text-slate-500">Cuando el contador termine un mes, ciérrelo: ya no se podrán registrar asientos manuales con esa fecha y los automáticos tardíos se registran en el primer día abierto.</p>
          <div className="flex items-end gap-2">
            <Field label="Cerrado hasta (inclusive)"><input type="date" className="input" value={lockDate} onChange={(e) => setLockDate(e.target.value)} /></Field>
            <button className="btn-primary" disabled={!!busy || !lockDate} onClick={() => run('lock', () => ac('/close/lock', { body: { date: lockDate } }), () => `Período cerrado hasta ${lockDate}`)}><Lock size={16} />Cerrar</button>
            {s.locked_until && <button className="btn-secondary" disabled={!!busy} onClick={() => run('unlock', () => ac('/close/lock', { body: { date: null } }), () => 'Períodos abiertos', '¿Reabrir todos los períodos?')}><Unlock size={16} />Reabrir</button>}
          </div>
        </div>
        <div className="card space-y-3 p-5">
          <div className="flex items-center gap-2 font-semibold"><Scale size={18} />Revaluación de saldos en dólares</div>
          <p className="text-sm text-slate-500">Al cierre de mes ajusta bancos, cuentas por cobrar y por pagar en dólares al tipo de cambio del día (diferencial cambiario no realizado). Se reversa automáticamente el día siguiente.</p>
          <div className="flex items-end gap-2">
            <Field label="Fecha"><input type="date" className="input" value={revDate} onChange={(e) => setRevDate(e.target.value)} /></Field>
            <Field label="Tipo de cambio"><input className="input w-28" inputMode="decimal" value={revRate} onChange={(e) => setRevRate(e.target.value)} /></Field>
            <button className="btn-primary" disabled={!!busy} onClick={() => run('reval', () => ac('/close/revalue', { body: { date: revDate, rate: Number(revRate) } }), (r) => (r.posted ? `Revaluación registrada: ${crc(r.net)}` : 'No hay saldos en dólares que ajustar'))}>Revaluar</button>
          </div>
        </div>
        <div className="card space-y-3 p-5">
          <div className="flex items-center gap-2 font-semibold"><CalendarCheck size={18} />Cierre anual</div>
          <p className="text-sm text-slate-500">Traslada la utilidad o pérdida del año a "Utilidades retenidas" y cierra el año completo.</p>
          <div className="flex items-end gap-2">
            <Field label="Año"><input className="input w-28" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} /></Field>
            <button className="btn-danger" disabled={!!busy} onClick={() => run('year', () => ac('/close/year', { body: { year: Number(year) } }), (r) => `Año ${year} cerrado · resultado ${crc(r.result)}`, `¿Cerrar el año ${year}? Esta acción cierra todos sus períodos.`)}>Cerrar año</button>
          </div>
        </div>
      </div>
    </div>
  );
}
