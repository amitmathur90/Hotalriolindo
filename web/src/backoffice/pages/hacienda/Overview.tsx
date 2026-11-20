import { useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { boApi } from '../../../lib/api';
import { dt } from '../../../lib/format';
import { Empty, Spinner, Tabs, useAsync } from '../../../components/ui';
import { EDOC_NAMES } from '../../../components/Receipt';
import { EDOC_STATUS, EDocStatus } from '../../../components/EInvoice';
import { ExportButtons, useRange } from '../../widgets';
import { fmtCur } from './ManualInvoice';

const crc = (n: any) => fmtCur(n, 'CRC');

/** Electronic invoicing dashboard (PRD §11.1): totals, statuses, taxes and integration health. */
export function Dashboard() {
  const range = useRange('month');
  const { data } = useAsync(() => boApi(`/hacienda/dashboard?${range.query}`), [range.query]);
  if (!data) return <div className="space-y-3">{range.ui}<div className="flex justify-center py-10"><Spinner /></div></div>;
  const s = data.by_status;
  const total = Object.values(s).reduce((a: number, b: any) => a + Number(b), 0) as number;
  const failed = (s.validation_failed || 0) + (s.error || 0) + (s.auth_error || 0) + (s.manual_review || 0);
  const h = data.health;
  const Health = ({ ok, warn, children }: { ok: boolean; warn?: boolean; children: any }) => (
    <div className={`flex items-start gap-2 text-sm ${ok ? 'text-emerald-700' : warn ? 'text-amber-700' : 'text-rose-600'}`}>
      {ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : warn ? <AlertTriangle size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}<span>{children}</span>
    </div>
  );
  const trendDays = [...new Set(data.trend.map((t: any) => t.day))] as string[];
  return (
    <div className="space-y-4">
      {range.ui}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[['Documentos', total, ''], ['Aceptados', s.accepted || 0, 'text-emerald-600'], ['En proceso', (s.pending || 0) + (s.signed || 0) + (s.sent || 0) + (s.processing || 0), 'text-sky-600'],
          ['Rechazados', s.rejected || 0, 'text-rose-600'], ['Con error', failed, failed ? 'text-rose-600' : '']].map(([l, v, c]) => (
          <div key={l as string} className="card p-4"><div className="text-xs text-slate-500">{l}</div><div className={`text-2xl font-bold ${c}`}>{v as number}</div></div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-5">
          <div className="mb-2 font-semibold">Estado de la integración</div>
          <div className="space-y-2">
            <Health ok={h.enabled}>{h.enabled ? `Activa en ${h.environment === 'prod' ? 'producción' : 'pruebas'}` : 'Facturación electrónica desactivada'}</Health>
            <Health ok={h.credentials_ok !== false}>{h.credentials_ok === false ? 'Hacienda rechazó las credenciales de la API' : 'Credenciales de la API funcionando'}</Health>
            <Health ok={h.certificate_days_left == null ? false : h.certificate_days_left > 30} warn={h.certificate_days_left != null && h.certificate_days_left > 0}>
              {h.certificate_days_left == null ? 'Sin llave criptográfica' : h.certificate_days_left > 0 ? `Llave criptográfica vence en ${h.certificate_days_left} días` : 'Llave criptográfica vencida'}
            </Health>
            <Health ok={h.queue === 0 || (h.oldest_in_queue && Date.now() - new Date(h.oldest_in_queue).getTime() < 3600e3)} warn>
              {h.queue ? `${h.queue} documento(s) en cola${h.oldest_in_queue ? ` · el más antiguo ${dt(h.oldest_in_queue)}` : ''}` : 'Cola vacía'}
            </Health>
            <div className="text-xs text-slate-500">Última aceptación: {h.last_accepted ? dt(h.last_accepted) : '—'}</div>
          </div>
        </div>
        <div className="card overflow-x-auto p-5">
          <div className="mb-2 font-semibold">Por tipo de documento</div>
          {!data.by_type.length ? <Empty>Sin documentos</Empty> : (
            <table className="table text-sm"><tbody>
              {data.by_type.map((t: any) => <tr key={t.doc_type}><td>{t.name}</td><td className="text-right">{t.count}</td><td className="text-right tabular-nums">{crc(t.total_crc)}</td></tr>)}
            </tbody></table>
          )}
          <div className="mt-1 text-xs text-slate-500">Totales en colones; las notas de crédito restan.</div>
        </div>
        <div className="card overflow-x-auto p-5">
          <div className="mb-2 font-semibold">Impuestos</div>
          <table className="table text-sm">
            <thead><tr><th>Tarifa</th><th className="text-right">Base</th><th className="text-right">IVA</th></tr></thead>
            <tbody>
              {data.taxes.rates.map((r: any) => <tr key={r.rate}><td>{r.rate}%</td><td className="text-right tabular-nums">{crc(r.base)}</td><td className="text-right tabular-nums">{crc(r.tax)}</td></tr>)}
              <tr><td>Exento</td><td className="text-right tabular-nums">{crc(data.taxes.exempt)}</td><td /></tr>
              <tr className="font-semibold"><td>Total facturado</td><td className="text-right tabular-nums">{crc(data.taxes.total)}</td><td className="text-right tabular-nums">{crc(data.taxes.total_tax)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="card overflow-x-auto p-5">
        <div className="mb-2 font-semibold">Últimos 14 días: aceptados y problemas</div>
        {!trendDays.length ? <Empty>Sin actividad</Empty> : (
          <table className="table text-sm">
            <thead><tr><th>Día</th>{['accepted', 'validation_failed', 'auth_error', 'error', 'rejected', 'manual_review'].map((k) => <th key={k} className="text-right">{EDOC_STATUS[k]?.[0]}</th>)}</tr></thead>
            <tbody>{trendDays.map((d) => (
              <tr key={d}><td>{d}</td>{['accepted', 'validation_failed', 'auth_error', 'error', 'rejected', 'manual_review'].map((k) => {
                const n = data.trend.find((t: any) => t.day === d && t.kind === k)?.n || 0;
                return <td key={k} className={`text-right tabular-nums ${n && k !== 'accepted' ? 'font-semibold text-rose-600' : ''}`}>{n || ''}</td>;
              })}</tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** Reports (PRD §11.5): electronic sales, taxes and submission errors, with CSV/Excel export. */
export function Reports() {
  const [rep, setRep] = useState<'sales' | 'taxes' | 'errors'>('sales');
  const range = useRange('month');
  const [group, setGroup] = useState<'day' | 'month'>('day');
  const { data, loading } = useAsync(() => boApi(rep === 'sales' ? `/hacienda/reports/sales?${range.query}&group=${group}` : `/hacienda/reports/${rep}?${range.query}`), [rep, range.query, group]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs tabs={[{ id: 'sales', label: 'Ventas electrónicas' }, { id: 'taxes', label: 'Impuestos' }, { id: 'errors', label: 'Errores y rechazos' }]} value={rep} onChange={setRep} />
        {range.ui}
        {rep === 'sales' && <select className="input w-auto py-1.5" value={group} onChange={(e) => setGroup(e.target.value as any)} aria-label="Agrupar"><option value="day">Por día</option><option value="month">Por mes</option></select>}
      </div>
      {loading || !data ? <div className="flex justify-center py-10"><Spinner /></div> : rep === 'sales' ? (
        <div className="card overflow-x-auto">
          <div className="p-3"><ExportButtons name="ventas-electronicas" rows={data} cols={[{ key: 'period', label: 'Período' }, { key: 'doc_name', label: 'Tipo' }, { key: 'branch', label: 'Sucursal' }, { key: 'status', label: 'Estado' }, { key: 'currency', label: 'Moneda' }, { key: 'documents', label: 'Documentos' }, { key: 'total', label: 'Total' }, { key: 'total_crc', label: 'Total ₡' }]} /></div>
          {!data.length ? <Empty>Sin documentos</Empty> : (
            <table className="table text-sm">
              <thead><tr><th>Período</th><th>Tipo</th><th>Sucursal</th><th>Estado</th><th className="text-right">Documentos</th><th className="text-right">Total</th><th className="text-right">Total ₡</th></tr></thead>
              <tbody>{data.map((r: any, i: number) => (
                <tr key={i}><td>{r.period}</td><td>{EDOC_NAMES[r.doc_type]}</td><td>{r.branch}</td><td><EDocStatus status={r.status} /></td><td className="text-right">{r.documents}</td><td className="text-right tabular-nums">{fmtCur(r.total, r.currency)}</td><td className="text-right tabular-nums">{crc(r.total_crc)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
      ) : rep === 'taxes' ? (
        <div className="card overflow-x-auto p-4">
          <ExportButtons name="impuestos" rows={data.rates} cols={[{ key: 'rate', label: 'Tarifa %' }, { key: 'base', label: 'Base imponible' }, { key: 'tax', label: 'IVA' }, { key: 'lines', label: 'Líneas' }]} />
          <table className="table mt-2 text-sm">
            <thead><tr><th>Tarifa</th><th className="text-right">Base imponible</th><th className="text-right">IVA</th><th className="text-right">Líneas</th></tr></thead>
            <tbody>
              {data.rates.map((r: any) => <tr key={r.rate}><td>{r.rate}%</td><td className="text-right tabular-nums">{crc(r.base)}</td><td className="text-right tabular-nums">{crc(r.tax)}</td><td className="text-right">{r.lines}</td></tr>)}
              <tr><td>Exento</td><td className="text-right tabular-nums">{crc(data.exempt)}</td><td /><td /></tr>
              <tr><td>Otros cargos (servicio 10 %, propinas)</td><td className="text-right tabular-nums">{crc(data.other_charges)}</td><td /><td /></tr>
              <tr className="font-semibold"><td>Total ({data.documents} documentos)</td><td className="text-right tabular-nums">{crc(data.total)}</td><td className="text-right tabular-nums">{crc(data.total_tax)}</td><td /></tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <div className="p-3"><ExportButtons name="errores-hacienda" rows={data} cols={[{ key: 'created_at', label: 'Fecha' }, { key: 'kind', label: 'Evento' }, { key: 'consecutivo', label: 'Consecutivo' }, { key: 'http_status', label: 'HTTP' }, { key: 'message', label: 'Mensaje' }]} /></div>
          {!data.length ? <Empty>Sin errores en este período</Empty> : (
            <table className="table text-sm">
              <thead><tr><th>Fecha</th><th>Documento</th><th>Evento</th><th>Mensaje</th></tr></thead>
              <tbody>{data.map((r: any, i: number) => (
                <tr key={i}><td className="whitespace-nowrap">{dt(r.created_at)}</td><td>{EDOC_NAMES[r.doc_type]}<div className="font-mono text-xs text-slate-500">{r.consecutivo}</div></td>
                  <td><EDocStatus status={r.kind === 'submit' ? 'error' : r.kind} />{r.http_status && <div className="text-xs text-slate-500">HTTP {r.http_status}</div>}</td><td className="max-w-lg text-xs">{r.message}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
