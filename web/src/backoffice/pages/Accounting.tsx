import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PageHeader, Tabs, useAsync, useToast } from '../../components/ui';
import { useSession } from '../BackOffice';
import { ac, crc, monthStart, today } from './accounting/common';
import Journal from './accounting/Journal';
import Chart from './accounting/Chart';
import OpenItems from './accounting/OpenItems';
import Banks from './accounting/Banks';
import Statements from './accounting/Statements';
import Closing from './accounting/Closing';

type Tab = 'summary' | 'journal' | 'ar' | 'ap' | 'banks' | 'reports' | 'chart' | 'closing';

/** Contabilidad: replaces QuickBooks. Entries are created automatically from the POS, Hacienda, suppliers and payroll. */
export default function Accounting() {
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>('summary');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'summary', label: 'Resumen' }, { id: 'journal', label: 'Asientos' }, { id: 'ar', label: 'Cuentas por cobrar' }, { id: 'ap', label: 'Cuentas por pagar' },
    { id: 'banks', label: 'Bancos' }, { id: 'reports', label: 'Reportes' }, { id: 'chart', label: 'Catálogo de cuentas' },
  ];
  if (can('accounting.manage')) tabs.push({ id: 'closing', label: 'Cierre y ajustes' });
  return (
    <div>
      <PageHeader title="Contabilidad" subtitle="Asientos automáticos de ventas, facturas, proveedores, gastos y planilla · estados financieros · IVA" />
      <div className="mb-4"><Tabs tabs={tabs} value={tab} onChange={setTab} /></div>
      {tab === 'summary' && <Summary go={setTab} />}
      {tab === 'journal' && <Journal />}
      {tab === 'ar' && <OpenItems kind="ar" />}
      {tab === 'ap' && <OpenItems kind="ap" />}
      {tab === 'banks' && <Banks />}
      {tab === 'reports' && <Statements />}
      {tab === 'chart' && <Chart />}
      {tab === 'closing' && <Closing />}
    </div>
  );
}

function Summary({ go }: { go: (t: Tab) => void }) {
  const toast = useToast();
  const { can } = useSession();
  const [busy, setBusy] = useState(false);
  const accounts = useAsync(() => ac<any[]>('/accounts'), []);
  const pnl = useAsync(() => ac(`/reports/pnl?from=${monthStart()}&to=${today()}`), []);
  const settings = useAsync(() => ac('/settings'), []);
  const ar = useAsync(() => ac(`/reports/ageing?kind=ar&as_of=${today()}`), []);
  const ap = useAsync(() => ac(`/reports/ageing?kind=ap&as_of=${today()}`), []);
  const list = accounts.data || [];
  const sum = (f: (a: any) => boolean) => list.filter(f).reduce((s, a) => s + Number(a.balance), 0);
  const key = (k: string) => list.find((a) => a.key === k);
  const cash = sum((a) => a.subtype === 'cash' || a.subtype === 'bank');
  const overdue = (t: any) => Object.values(t?.totals || {}).reduce((s: number, x: any) => s + x.d1_30 + x.d31_60 + x.d61_90 + x.d90, 0) as number;
  const sync = async () => {
    setBusy(true);
    try {
      const r = await ac('/sync', { body: {} });
      toast(`Actualizado · ${Object.values(r).reduce((s: number, n: any) => s + Number(n), 0)} asiento(s) nuevos o corregidos`);
      accounts.reload(); pnl.reload();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const Tile = ({ label, value, sub, onClick }: any) => (
    <button onClick={onClick} className="card p-4 text-left hover:ring-2 hover:ring-brand-500/40">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </button>
  );
  const p = pnl.data?.totals;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Caja y bancos" value={crc(cash)} onClick={() => go('banks')} sub={key('bank_usd') && Number(key('bank_usd').balance_fc) ? `incl. US$${Number(key('bank_usd').balance_fc).toLocaleString('es-CR')}` : undefined} />
        <Tile label="Cuentas por cobrar" value={crc(key('ar')?.balance || 0)} sub={overdue(ar.data) > 0 ? `${crc(overdue(ar.data))} vencido (moneda original)` : 'Al día'} onClick={() => go('ar')} />
        <Tile label="Cuentas por pagar" value={crc(-(key('ap')?.balance || 0))} sub={overdue(ap.data) > 0 ? `${crc(overdue(ap.data))} vencido` : 'Al día'} onClick={() => go('ap')} />
        <Tile label="IVA neto por pagar" value={crc(-(Number(key('iva_payable')?.balance || 0) + Number(key('iva_credit')?.balance || 0)))} sub="IVA ventas − IVA soportado" onClick={() => go('reports')} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <div className="mb-2 font-semibold">Este mes</div>
          {p ? (
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div><div className="text-slate-500">Ingresos</div><div className="text-lg font-semibold tabular-nums">{crc(p.income)}</div></div>
              <div><div className="text-slate-500">Costo de ventas</div><div className="text-lg font-semibold tabular-nums">{crc(p.cogs)}</div></div>
              <div><div className="text-slate-500">Gastos</div><div className="text-lg font-semibold tabular-nums">{crc(p.expenses)}</div></div>
              <div><div className="text-slate-500">Utilidad</div><div className={`text-lg font-bold tabular-nums ${p.net < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{crc(p.net)}</div></div>
            </div>
          ) : <div className="text-sm text-slate-500">Cargando…</div>}
        </div>
        <div className="card space-y-2 p-5 text-sm">
          <div className="font-semibold">Contabilidad automática</div>
          <p className="text-slate-500">Las ventas del POS, facturas, Cloudbeds, facturas de proveedores, gastos y planillas se registran solas cada 5 minutos.</p>
          <div className="text-xs text-slate-500">Última actualización: {settings.data?.last_sync_at ? new Date(settings.data.last_sync_at).toLocaleString('es-CR') : '—'}</div>
          {settings.data?.locked_until && <div className="text-xs text-amber-700">Período cerrado hasta {String(settings.data.locked_until).slice(0, 10)}</div>}
          {can('accounting.manage') && <button className="btn-secondary w-full" disabled={busy} onClick={sync}><RefreshCw size={16} className={busy ? 'animate-spin' : ''} />Actualizar ahora</button>}
        </div>
      </div>
    </div>
  );
}
