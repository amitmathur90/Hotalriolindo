import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BedDouble, BookOpenCheck, PlugZap, RefreshCw, Link2, Unlink, FileText } from 'lucide-react';
import { boApi, openFile } from '../../lib/api';
import { dt } from '../../lib/format';
import { Badge, Empty, Field, PageHeader, Spinner, Toggle, useAsync, useToast } from '../../components/ui';
import { CabysPicker } from '../../components/CabysPicker';
import { EDOC_NAMES } from '../../components/Receipt';
import { EDocStatus } from '../../components/EInvoice';
import { fmtCur } from './hacienda/ManualInvoice';

/** Cloudbeds (hotel PMS) and QuickBooks Online: what Cubo did by hand, done automatically. */
export default function Integrations() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { data, reload } = useAsync(() => boApi('/integrations'), []);
  useEffect(() => {
    if (params.get('qb') === 'connected') toast('QuickBooks conectado');
    if (params.get('qb_error')) toast(`QuickBooks: ${params.get('qb_error')}`, 'err');
    if (params.get('qb') || params.get('qb_error')) setParams({}, { replace: true });
  }, []);
  if (!data) return <div className="flex justify-center py-10"><Spinner /></div>;
  return (
    <div>
      <PageHeader title="Integraciones" subtitle="Cloudbeds y QuickBooks Online conectados con la facturación electrónica" />
      <div className="space-y-6">
        <Cloudbeds it={data.cloudbeds} reload={reload} />
        <QuickBooks it={data.quickbooks} redirectUri={data.qb_redirect_uri} reload={reload} />
      </div>
    </div>
  );
}

const Status = ({ it }: { it: any }) => (
  <div className="text-xs text-slate-500">
    {it.last_sync_at ? <>Última sincronización: {dt(it.last_sync_at)}</> : 'Aún no sincronizado'}
    {it.last_error && <div className="text-rose-600">{it.last_error}</div>}
  </div>
);

// ---------------------------------------------------------------- Cloudbeds
function Cloudbeds({ it, reload }: { it: any; reload: () => void }) {
  const toast = useToast();
  const [c, setC] = useState<any>({ currency: 'USD', tax_rate: 13, payment_type: 'card', auto_issue: true, ...it.config });
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState('');
  const res = useAsync(() => boApi<any[]>('/integrations/cloudbeds/reservations'), []);
  const run = async (key: string, fn: () => Promise<any>, msg?: (r: any) => string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (msg) toast(msg(r));
      reload();
      res.reload();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy('');
    }
  };
  const save = (enabled?: boolean) => run('save', () => boApi('/integrations/cloudbeds', {
    method: 'PUT', body: { ...c, ...(apiKey ? { api_key: apiKey } : {}), ...(enabled !== undefined ? { enabled } : {}) },
  }).then((r) => { setApiKey(''); return r; }), () => (enabled === undefined ? 'Guardado' : enabled ? 'Cloudbeds activado' : 'Cloudbeds desactivado'));
  const set = (k: string) => (e: any) => setC({ ...c, [k]: e.target.value });
  const rows: any[] = res.data || [];
  const STAT: Record<string, [string, any]> = { issued: ['Emitido', 'green'], review: ['Revisar', 'amber'], error: ['Error', 'red'], skipped: ['Omitida', 'slate'], new: ['Nueva', 'blue'] };

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-5 dark:border-slate-800">
        <div>
          <div className="flex items-center gap-2 text-lg font-semibold"><BedDouble size={20} />Cloudbeds</div>
          <div className="text-sm text-slate-500">Al hacer check-out en Cloudbeds se emite automáticamente la factura electrónica (si el huésped o su empresa tiene cédula en Cloudbeds) o el tiquete, y se envía a Hacienda.</div>
          <Status it={it} />
        </div>
        <div className="flex items-center gap-3">
          {it.enabled ? <Badge color="green">Activo</Badge> : <Badge>Inactivo</Badge>}
          <Toggle checked={!!it.enabled} onChange={(v) => save(v)} label={it.enabled ? 'Activado' : 'Activar'} />
        </div>
      </div>
      <div className="grid gap-4 p-5 lg:grid-cols-3">
        <Field label="API key de Cloudbeds" hint={c.has_api_key ? 'Guardada (cifrada). Escriba solo para cambiarla.' : 'Cloudbeds → Cuenta → Apps & Marketplace → API Credentials'}>
          <input className="input" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={c.has_api_key ? '••••••••' : 'cbat_…'} />
        </Field>
        <Field label="Property ID (opcional)" hint="Solo si la llave tiene acceso a varias propiedades"><input className="input" value={c.property_id || ''} onChange={set('property_id')} /></Field>
        <Field label="Moneda de las tarifas">
          <select className="input" value={c.currency} onChange={set('currency')}><option value="USD">Dólares (US$)</option><option value="CRC">Colones (₡)</option></select>
        </Field>
        <Field label="CABYS de hospedaje" hint="Ej. servicios de alojamiento en hoteles"><CabysPicker value={c.cabys || ''} onChange={(v) => setC({ ...c, cabys: v })} /></Field>
        <Field label="CABYS de cargos adicionales (opcional)"><CabysPicker value={c.extras_cabys || ''} onChange={(v) => setC({ ...c, extras_cabys: v })} placeholder="Igual al de hospedaje" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="IVA (%)"><select className="input" value={c.tax_rate} onChange={set('tax_rate')}>{[13, 4, 2, 1, 0].map((r) => <option key={r} value={r}>{r}%</option>)}</select></Field>
          <Field label="Medio de pago">
            <select className="input" value={c.payment_type} onChange={set('payment_type')}><option value="card">Tarjeta</option><option value="cash">Efectivo</option><option value="bank">Transferencia</option><option value="sinpe">SINPE</option></select>
          </Field>
        </div>
        <Field label="Facturar salidas desde" hint="Las salidas anteriores ya fueron facturadas en Cubo"><input className="input" type="date" value={c.start_date || ''} onChange={set('start_date')} /></Field>
        <div className="flex items-end"><Toggle checked={c.auto_issue !== false} onChange={(v) => setC({ ...c, auto_issue: v })} label="Emitir automáticamente (si no, quedan para revisar)" /></div>
        <div className="flex flex-wrap items-end gap-2">
          <button className="btn-primary" disabled={!!busy} onClick={() => save()}>Guardar</button>
          <button className="btn-secondary" disabled={!!busy} onClick={() => run('test', () => boApi('/integrations/cloudbeds/test', { body: {} }), (r) => r.message)}><PlugZap size={16} />Probar</button>
          <button className="btn-secondary" disabled={!!busy || !it.enabled} onClick={() => run('sync', () => boApi('/integrations/cloudbeds/sync', { body: {} }), (r) => `${r.checked} salidas revisadas · ${r.issued} emitidas · ${r.review} por revisar${r.errors ? ` · ${r.errors} con error` : ''}`)}>
            <RefreshCw size={16} className={busy === 'sync' ? 'animate-spin' : ''} />Sincronizar ahora
          </button>
        </div>
      </div>
      <div className="border-t border-slate-200 dark:border-slate-800">
        <div className="px-5 pt-4 font-medium">Salidas (check-out)</div>
        {res.loading && !res.data ? <div className="flex justify-center py-6"><Spinner /></div> : !rows.length ? <Empty>Sin salidas sincronizadas todavía</Empty> : (
          <div className="overflow-x-auto">
            <table className="table text-sm">
              <thead><tr><th>Reservación</th><th>Huésped</th><th>Estadía</th><th className="text-right">Total Cloudbeds</th><th>Comprobante</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.reservation_id}>
                    <td className="font-mono text-xs">{r.reservation_id}</td>
                    <td>{r.guest_name}</td>
                    <td className="whitespace-nowrap text-xs">{r.check_in ? String(r.check_in).slice(0, 10) : ''} → {r.check_out ? String(r.check_out).slice(0, 10) : ''}</td>
                    <td className="text-right tabular-nums">{r.total != null ? fmtCur(r.total, r.currency || c.currency) : '—'}</td>
                    <td>
                      <Badge color={STAT[r.status]?.[1]}>{STAT[r.status]?.[0] || r.status}</Badge>
                      {r.doc_id && <div className="mt-0.5 flex items-center gap-1 text-xs">{EDOC_NAMES[r.doc_type]} <EDocStatus status={r.doc_status} /></div>}
                      {r.message && r.status !== 'issued' && <div className="max-w-xs text-xs text-slate-500">{r.message}</div>}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      {r.doc_id && <button className="btn-secondary px-2 py-1 text-xs" onClick={() => openFile(boApi, `/hacienda/documents/${r.doc_id}/pdf`).catch((e) => toast(e.message, 'err'))}><FileText size={12} />PDF</button>}
                      {(r.status === 'review' || r.status === 'error') && (
                        <>
                          <button className="btn-primary ml-1 px-2 py-1 text-xs" disabled={!!busy} onClick={() => confirm('¿Emitir el comprobante con los cargos de Cloudbeds?') && run('issue', () => boApi(`/integrations/cloudbeds/reservations/${r.reservation_id}/issue`, { body: {} }), () => 'Comprobante emitido')}>Emitir</button>
                          <button className="btn-secondary ml-1 px-2 py-1 text-xs" disabled={!!busy} onClick={() => run('skip', () => boApi(`/integrations/cloudbeds/reservations/${r.reservation_id}/skip`, { body: {} }), () => 'Omitida')}>Omitir</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- QuickBooks
const ACCOUNTS: [string, string, string][] = [
  ['deposit_cash', 'Ventas en efectivo → cuenta', 'Caja'], ['deposit_card', 'Ventas con tarjeta → cuenta', 'Banco / tarjetas'], ['deposit_other', 'SINPE / transferencias → cuenta', 'Banco'],
  ['income', 'Ingresos por ventas', 'Ventas'], ['tax', 'IVA por pagar', 'Pasivo'], ['service', 'Impuesto de servicio 10%', 'Pasivo o ingreso'], ['tips', 'Propinas', 'Pasivo'],
  ['expense', 'Gastos (facturas de proveedores)', 'Gasto'], ['tax_credit', 'IVA soportado (crédito fiscal)', 'Activo — opcional'],
];
function QuickBooks({ it, redirectUri, reload }: { it: any; redirectUri: string; reload: () => void }) {
  const toast = useToast();
  const [c, setC] = useState<any>({ environment: 'production', ...it.config, accounts: it.config.accounts || {} });
  const [secretVal, setSecretVal] = useState('');
  const [accounts, setAccounts] = useState<any[] | null>(null);
  const [busy, setBusy] = useState('');
  const postings = useAsync(() => (it.connected ? boApi<any[]>('/integrations/quickbooks/postings') : Promise.resolve([])), [it.connected]);
  useEffect(() => {
    if (it.connected) boApi<any[]>('/integrations/quickbooks/accounts').then(setAccounts).catch((e) => toast(e.message, 'err'));
  }, [it.connected]);
  const run = async (key: string, fn: () => Promise<any>, msg?: (r: any) => string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (msg) toast(msg(r));
      reload();
      postings.reload();
      return r;
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy('');
    }
  };
  const save = () => run('save', () => boApi('/integrations/quickbooks', { method: 'PUT', body: { client_id: c.client_id, environment: c.environment, start_date: c.start_date || '', accounts: c.accounts, ...(secretVal ? { client_secret: secretVal } : {}) } }).then((r) => { setSecretVal(''); return r; }), () => 'Guardado');
  const connect = async () => {
    await save();
    const r = await run('connect', () => boApi('/integrations/quickbooks/connect'));
    if (r?.url) location.href = r.url;
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-5 dark:border-slate-800">
        <div>
          <div className="flex items-center gap-2 text-lg font-semibold"><BookOpenCheck size={20} />QuickBooks Online</div>
          <div className="text-sm text-slate-500">Cada día cerrado se registra un asiento con las ventas aceptadas por Hacienda (ventas, IVA, servicio, propinas por medio de pago), y cada factura de proveedor aceptada se registra como factura por pagar (bill). Montos en colones.</div>
          <Status it={it} />
        </div>
        <div className="flex items-center gap-2">
          {it.connected ? <Badge color="green">Conectado{c.company_name ? `: ${c.company_name}` : ''}</Badge> : <Badge>No conectado</Badge>}
        </div>
      </div>
      <div className="grid gap-4 p-5 lg:grid-cols-3">
        <Field label="Client ID (app de Intuit)" hint="developer.intuit.com → su app → Keys & credentials"><input className="input" value={c.client_id || ''} onChange={(e) => setC({ ...c, client_id: e.target.value })} /></Field>
        <Field label="Client Secret" hint={c.has_client_secret ? 'Guardado (cifrado)' : undefined}><input className="input" type="password" autoComplete="new-password" value={secretVal} onChange={(e) => setSecretVal(e.target.value)} placeholder={c.has_client_secret ? '••••••••' : ''} /></Field>
        <Field label="Ambiente">
          <select className="input" value={c.environment} onChange={(e) => setC({ ...c, environment: e.target.value })} disabled={it.connected}><option value="production">Producción</option><option value="sandbox">Sandbox (pruebas)</option></select>
        </Field>
        <div className="lg:col-span-2">
          <Field label="Redirect URI (regístrela en la app de Intuit)"><input className="input font-mono text-xs" readOnly value={redirectUri} onFocus={(e) => e.target.select()} /></Field>
        </div>
        <Field label="Enviar desde la fecha" hint="Días anteriores ya registrados por Cubo"><input className="input" type="date" value={c.start_date || ''} onChange={(e) => setC({ ...c, start_date: e.target.value })} /></Field>
      </div>
      {it.connected && (
        <div className="border-t border-slate-200 p-5 dark:border-slate-800">
          <div className="mb-3 font-medium">Cuentas contables</div>
          {!accounts ? <Spinner /> : (
            <div className="grid gap-3 md:grid-cols-3">
              {ACCOUNTS.map(([k, label, hint]) => (
                <Field key={k} label={label} hint={hint}>
                  <select className="input" value={c.accounts[k] || ''} onChange={(e) => setC({ ...c, accounts: { ...c.accounts, [k]: e.target.value } })}>
                    <option value="">—</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.type}</option>)}
                  </select>
                </Field>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2 border-t border-slate-200 p-5 dark:border-slate-800">
        <button className="btn-primary" disabled={!!busy} onClick={save}>Guardar</button>
        {!it.connected
          ? <button className="btn-secondary" disabled={!!busy || !c.client_id} onClick={connect}><Link2 size={16} />Conectar con QuickBooks</button>
          : <>
              <button className="btn-secondary" disabled={!!busy} onClick={() => run('sync', () => boApi('/integrations/quickbooks/sync', { body: {} }), (r) => `${r.days.filter((d: any) => d.status === 'posted').length} día(s) y ${r.bills.filter((b: any) => b.status === 'posted').length} factura(s) de proveedor enviadas${[...r.days, ...r.bills].some((x: any) => x.status === 'error') ? ' · revise los errores' : ''}`)}>
                <RefreshCw size={16} className={busy === 'sync' ? 'animate-spin' : ''} />Enviar ahora
              </button>
              <button className="btn-secondary text-rose-600" disabled={!!busy} onClick={() => confirm('¿Desconectar QuickBooks?') && run('disc', () => boApi('/integrations/quickbooks/disconnect', { body: {} }), () => 'Desconectado')}><Unlink size={16} />Desconectar</button>
            </>}
      </div>
      {it.connected && (postings.data?.length || 0) > 0 && (
        <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-800">
          <table className="table text-sm">
            <thead><tr><th>Fecha</th><th>Tipo</th><th>Referencia</th><th className="text-right">Monto</th><th>Estado</th></tr></thead>
            <tbody>
              {postings.data!.map((p) => (
                <tr key={p.kind + p.ref}>
                  <td className="whitespace-nowrap">{dt(p.created_at)}</td>
                  <td>{p.kind === 'sales_day' ? 'Asiento de ventas' : 'Factura de proveedor'}</td>
                  <td className="font-mono text-xs">{p.kind === 'sales_day' ? p.ref : p.ref.slice(0, 8)}{p.qb_id && <span className="text-slate-400"> · QB #{p.qb_id}</span>}</td>
                  <td className="text-right tabular-nums">{p.amount != null ? fmtCur(p.amount, 'CRC') : '—'}</td>
                  <td>{p.status === 'ok' ? <Badge color="green">Enviado</Badge> : <><Badge color="red">Error</Badge><div className="max-w-sm text-xs text-rose-600">{p.message}</div></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
