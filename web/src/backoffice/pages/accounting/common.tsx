import { useState } from 'react';
import { boApi } from '../../../lib/api';

export const ac = <T = any,>(path: string, opts?: any) => boApi<T>(`/accounting${path}`, opts);
export const today = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
export const yearStart = () => today().slice(0, 4) + '-01-01';
export const monthStart = () => today().slice(0, 8) + '01';

/** ₡ 1 234 567,89 / US$ 1 234,56 */
export const crc = (n: any) => `${Number(n) < 0 ? '-' : ''}₡${Math.abs(Number(n) || 0).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const cur = (n: any, c: string) => (c === 'USD' ? `${Number(n) < 0 ? '-' : ''}US$${Math.abs(Number(n) || 0).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : crc(n));
export const d10 = (d: any) => (d ? String(d).slice(0, 10) : '');

export const TYPE_LABEL: Record<string, string> = { asset: 'Activo', liability: 'Pasivo', equity: 'Patrimonio', income: 'Ingreso', expense: 'Gasto' };
export const SOURCE_LABEL: Record<string, string> = {
  manual: 'Manual', opening: 'Apertura', sale: 'Venta POS', edoc: 'Factura', received: 'Factura proveedor', expense: 'Gasto', payroll: 'Planilla',
  payroll_payment: 'Pago planilla', payment: 'Cobro / pago', bank: 'Banco', reval: 'Revaluación', closing: 'Cierre', reversal: 'Reversión',
};

export function useDates(from = yearStart(), to = today()) {
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const ui = (
    <div className="flex items-center gap-2">
      <input type="date" className="input w-auto py-1.5" value={f} onChange={(e) => setF(e.target.value)} aria-label="Desde" />
      <span className="text-slate-400">→</span>
      <input type="date" className="input w-auto py-1.5" value={t} onChange={(e) => setT(e.target.value)} aria-label="Hasta" />
    </div>
  );
  return { from: f, to: t, ui, qs: `from=${f}&to=${t}` };
}

export function AccountSelect({ accounts, value, onChange, filter, placeholder = '— Cuenta —', className = '' }: {
  accounts: any[]; value: string; onChange: (v: string) => void; filter?: (a: any) => boolean; placeholder?: string; className?: string;
}) {
  const list = accounts.filter((a) => a.active !== false && (!filter || filter(a)));
  return (
    <select className={`input ${className}`} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {list.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}{a.currency === 'USD' ? ' (US$)' : ''}</option>)}
    </select>
  );
}
