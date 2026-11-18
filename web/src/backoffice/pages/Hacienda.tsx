import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Upload, RefreshCw, PlugZap, Mail, FileText, Ban, DollarSign } from 'lucide-react';
import { boApi, openFile } from '../../lib/api';
import { CabysPicker } from '../../components/CabysPicker';
import ManualInvoice, { fmtCur } from './hacienda/ManualInvoice';
import Received from './hacienda/Received';
import { dt, money } from '../../lib/format';
import { Badge, Empty, Field, PageHeader, SearchInput, Spinner, Tabs, Toggle, useAsync, useToast } from '../../components/ui';
import { SaleDetail } from '../../components/SaleDetail';
import { EDOC_NAMES, fmtConsecutivo } from '../../components/Receipt';
import { EDocStatus, ID_TYPES } from '../../components/EInvoice';
import { useSession } from '../BackOffice';
import { ExportButtons, useRange } from '../widgets';

/** Costa Rica electronic invoicing (Ministerio de Hacienda, v4.4): documents and configuration. */
export default function Hacienda() {
  const { can } = useSession();
  const [tab, setTab] = useState<'docs' | 'new' | 'received' | 'config'>('docs');
  const [fx, setFx] = useState<any>(null);
  useEffect(() => { boApi('/hacienda/fx').then(setFx).catch(() => {}); }, []);
  const tabs: { id: typeof tab; label: string }[] = [{ id: 'docs', label: 'Emitidos' }];
  if (can('settings.manage') || can('pos.sell')) tabs.push({ id: 'new', label: 'Nueva factura' });
  if (can('settings.manage') || can('purchases.manage')) tabs.push({ id: 'received', label: 'Recibidos (proveedores)' });
  if (can('settings.manage')) tabs.push({ id: 'config', label: 'Configuración' });
  return (
    <div>
      <PageHeader title="Hacienda · Facturación electrónica" subtitle="Tiquetes, facturas y notas de crédito electrónicas (versión 4.4)"
        actions={fx?.rate ? <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-sm dark:bg-slate-800" title={`Tipo de cambio de venta ${fx.date}${fx.source === 'manual' ? ' (fijo)' : ' · Hacienda/BCCR'}`}><DollarSign size={14} />T/C: <b>₡{Number(fx.rate).toFixed(2)}</b></span> : undefined} />
      {tabs.length > 1 && <div className="mb-4"><Tabs tabs={tabs} value={tab} onChange={setTab} /></div>}
      {tab === 'docs' ? <Documents /> : tab === 'new' ? <ManualInvoice /> : tab === 'received' ? <Received /> : <Config />}
    </div>
  );
}

// ---------------------------------------------------------------- Documents

function Documents() {
  const { business, can } = useSession();
  const toast = useToast();
  const range = useRange('today');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [docType, setDocType] = useState('');
  const [open, setOpen] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const qs = `${range.query}${q ? `&q=${encodeURIComponent(q)}` : ''}${status ? `&status=${status}` : ''}${docType ? `&doc_type=${docType}` : ''}`;
  const { data, loading, reload } = useAsync(() => boApi<{ rows: any[]; counts: Record<string, number> }>(`/hacienda/documents?${qs}`), [qs]);
  // Keep statuses fresh while documents are on their way to Hacienda
  useEffect(() => {
    if (!data?.rows.some((d) => d.status === 'pending' || d.status === 'sent')) return;
    const t = setTimeout(reload, 5000);
    return () => clearTimeout(t);
  }, [data]);

  const act = async (d: any, action: 'retry' | 'reissue' | 'email') => {
    if (action === 'reissue' && !confirm('Se emitirá un nuevo comprobante (nuevo consecutivo y clave) para esta venta. ¿Continuar?')) return;
    setBusy(d.id + action);
    try {
      await boApi(`/hacienda/documents/${d.id}/${action}`, { body: {} });
      toast(action === 'email' ? 'Correo enviado' : action === 'retry' ? 'Reenviando a Hacienda…' : 'Nuevo comprobante emitido');
      reload();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(null);
    }
  };
  const annul = async (d: any) => {
    const reason = prompt('Motivo de la anulación (se envía a Hacienda en la nota de crédito):', 'Anulación a solicitud del cliente');
    if (!reason) return;
    setBusy(d.id + 'annul');
    try {
      const nc = await boApi(`/hacienda/documents/${d.id}/annul`, { body: { reason } });
      toast(`Nota de crédito N° ${nc.consecutivo} emitida`);
      reload();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(null);
    }
  };
  const pdf = (d: any) => openFile(boApi, `/hacienda/documents/${d.id}/pdf`).catch((e) => toast(e.message, 'err'));
  const show = async (saleId: string) => {
    try { setOpen(await boApi(`/sales/${saleId}`)); } catch (e: any) { toast(e.message, 'err'); }
  };
  const counts = data?.counts || {};
  const cols = [
    { key: 'doc_type', label: 'Tipo' }, { key: 'consecutivo', label: 'Consecutivo' }, { key: 'clave', label: 'Clave' }, { key: 'issued_at', label: 'Fecha' },
    { key: 'receipt_no', label: 'Recibo' }, { key: 'external_ref', label: 'Cloudbeds' }, { key: 'source', label: 'Origen' }, { key: 'status', label: 'Estado' }, { key: 'currency', label: 'Moneda' }, { key: 'total', label: 'Total' }, { key: 'message', label: 'Mensaje' },
  ];

  return (
    <>
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[['accepted', 'Aceptados', 'text-emerald-600'], ['sent', 'En proceso', 'text-sky-600'], ['pending', 'Pendientes', 'text-amber-600'], ['rejected', 'Rechazados', 'text-rose-600'], ['error', 'Con error', 'text-rose-600']].map(([k, l, c]) => (
          <button key={k} onClick={() => setStatus(status === k ? '' : k)} className={`card p-3 text-left ${status === k ? 'ring-2 ring-brand-500' : ''}`}>
            <div className="text-xs text-slate-500">{l}</div>
            <div className={`text-2xl font-bold ${c}`}>{counts[k] || 0}</div>
          </button>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {range.ui}
        <select className="input w-auto py-1.5" value={docType} onChange={(e) => setDocType(e.target.value)} aria-label="Tipo de documento">
          <option value="">Todos los tipos</option>
          {Object.entries(EDOC_NAMES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <SearchInput value={q} onChange={setQ} placeholder="Clave, consecutivo, recibo, reservación, cliente o cédula" className="max-w-sm flex-1" />
        <ExportButtons name="comprobantes-hacienda" rows={(data?.rows || []).map((d) => ({ ...d, doc_type: EDOC_NAMES[d.doc_type] }))} cols={cols} />
      </div>
      <div className="card overflow-x-auto">
        {loading && !data ? <div className="flex justify-center py-10"><Spinner /></div> : !data?.rows.length ? <Empty>No hay comprobantes en este período</Empty> : (
          <table className="table">
            <thead><tr><th>Comprobante</th><th>Fecha</th><th>Origen</th><th>Receptor</th><th>Estado</th><th className="text-right">Total</th><th /></tr></thead>
            <tbody>
              {data.rows.map((d) => (
                <tr key={d.id} className={d.replaced_by ? 'opacity-60' : ''}>
                  <td>
                    <div className="font-medium">{EDOC_NAMES[d.doc_type]}{d.environment === 'stag' && <span className="ml-1 text-xs text-amber-600">pruebas</span>}</div>
                    <div className="font-mono text-xs text-slate-500">{fmtConsecutivo(d.consecutivo)}</div>
                    {d.reference?.clave && <div className="text-xs text-slate-400">Ref. {fmtConsecutivo(d.reference.clave.slice(21, 41))}</div>}
                  </td>
                  <td className="whitespace-nowrap">{dt(d.issued_at)}</td>
                  <td>{d.sale_id ? <button className="text-brand-700 hover:underline" onClick={() => show(d.sale_id)}>POS #{d.receipt_no}</button>
                    : d.source === 'cloudbeds' ? <span className="text-xs">Cloudbeds<div className="text-slate-500">{d.external_ref}</div></span>
                    : <span className="text-xs">Manual</span>}</td>
                  <td className="text-sm">{d.receptor?.nombre ? <>{d.receptor.nombre}<div className="text-xs text-slate-500">{d.receptor.id_number}</div></> : <span className="text-slate-400">—</span>}</td>
                  <td>
                    <EDocStatus status={d.status} />
                    {d.replaced_by && <div className="text-xs text-slate-500">sustituido</div>}
                    {d.annulled_by && <div className="text-xs text-slate-500">anulado</div>}
                    {d.message && d.status !== 'accepted' && <div className="mt-0.5 max-w-xs text-xs text-rose-600">{d.message}</div>}
                    {d.receptor?.email && d.status === 'accepted' && <div className="text-xs text-slate-500">{d.emailed_at ? 'Correo enviado' : d.email_error ? `Correo: ${d.email_error}` : ''}</div>}
                  </td>
                  <td className="text-right tabular-nums">{d.total != null ? (d.currency === 'USD' ? fmtCur(d.total, 'USD') : money(d.total)) : '—'}{d.currency === 'USD' && <div className="text-xs text-slate-400">T/C {Number(d.exchange_rate).toFixed(2)}</div>}</td>
                  <td className="whitespace-nowrap text-right">
                    <button className="btn-secondary px-2 py-1 text-xs" onClick={() => pdf(d)} title="Ver PDF"><FileText size={12} />PDF</button>
                    {d.source !== 'pos' && d.doc_type !== '03' && !d.annulled_by && !d.replaced_by && d.status !== 'rejected' && can('settings.manage') && (
                      <button className="btn-secondary ml-1 px-2 py-1 text-xs text-rose-600" disabled={!!busy} onClick={() => annul(d)}><Ban size={12} />Anular</button>
                    )}
                    {(d.status === 'error' || d.status === 'pending') && !d.replaced_by && (
                      <button className="btn-secondary px-2 py-1 text-xs" disabled={!!busy} onClick={() => act(d, 'retry')}><RefreshCw size={12} />Reintentar</button>
                    )}
                    {(d.status === 'rejected' || d.status === 'error') && !d.replaced_by && can('settings.manage') && (
                      <button className="btn-secondary ml-1 px-2 py-1 text-xs" disabled={!!busy} onClick={() => act(d, 'reissue')}>Reemitir</button>
                    )}
                    {d.status === 'accepted' && d.receptor?.email && (
                      <button className="btn-secondary ml-1 px-2 py-1 text-xs" disabled={!!busy} onClick={() => act(d, 'email')} title={`Enviar a ${d.receptor.email}`}><Mail size={12} />Correo</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && <SaleDetail sale={open} business={business} api={boApi} canRefund={can('pos.refund')} onChanged={(s) => { setOpen(s); reload(); }} onClose={() => setOpen(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- Configuration

function Config() {
  const toast = useToast();
  const [s, setS] = useState<any>(null);
  const [password, setPassword] = useState('');
  const [p12, setP12] = useState<{ name: string; b64: string } | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState('');
  const [test, setTest] = useState<any>(null);
  const [imapPassword, setImapPassword] = useState('');
  useEffect(() => { boApi('/hacienda/settings').then(setS).catch((e) => toast(e.message, 'err')); }, []);
  if (!s) return <div className="flex justify-center py-10"><Spinner /></div>;
  const set = (k: string) => (e: any) => setS({ ...s, [k]: e.target.value });

  const run = async (key: string, fn: () => Promise<any>, okMsg?: string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (r && 'missing' in r) setS(r);
      if (r?.warning) toast(r.warning, 'err');
      else if (okMsg) toast(okMsg);
      return r;
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy('');
    }
  };
  const FIELDS = ['environment', 'legal_name', 'trade_name', 'id_type', 'id_number', 'activity_code', 'provider_id', 'provincia', 'canton', 'distrito', 'barrio', 'otras_senas', 'phone', 'email', 'default_cabys', 'resolution_text', 'api_username',
    'terminal', 'usd_rate_manual', 'imap_host', 'imap_port', 'imap_user', 'expense_category'];
  const save = () => run('save', async () => {
    const body: any = Object.fromEntries(FIELDS.map((f) => [f, s[f] ?? '']));
    body.auto_accept = !!s.auto_accept;
    if (password) body.api_password = password;
    if (imapPassword) body.imap_password = imapPassword;
    const r = await boApi('/hacienda/settings', { method: 'PUT', body });
    setPassword('');
    setImapPassword('');
    return r;
  }, 'Configuración guardada');
  const uploadCert = () => run('cert', async () => {
    const r = await boApi('/hacienda/settings/certificate', { body: { p12_base64: p12!.b64, pin } });
    setP12(null);
    setPin('');
    return r;
  }, 'Llave criptográfica cargada');
  const toggle = (enabled: boolean) => {
    if (enabled && s.environment === 'prod' && !confirm('Se activará la facturación en PRODUCCIÓN: cada venta generará un comprobante con validez fiscal. ¿Continuar?')) return;
    run('enable', () => boApi('/hacienda/settings', { method: 'PUT', body: { enabled } }), enabled ? 'Facturación electrónica activada' : 'Facturación electrónica desactivada');
  };
  const pickFile = (f?: File) => {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setP12({ name: f.name, b64: String(r.result).split(',')[1] });
    r.readAsDataURL(f);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="card space-y-3 p-5 lg:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-semibold">Estado</div>
            <div className="text-sm text-slate-500">
              {s.enabled ? <>Activa en <b>{s.environment === 'prod' ? 'PRODUCCIÓN' : 'PRUEBAS (sandbox)'}</b> — cada venta emite un comprobante electrónico.</> : 'Desactivada — las ventas no envían comprobantes a Hacienda.'}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {s.enabled ? <Badge color={s.environment === 'prod' ? 'green' : 'amber'}>{s.environment === 'prod' ? 'Producción' : 'Pruebas'}</Badge> : <Badge>Inactiva</Badge>}
            <Toggle checked={!!s.enabled} onChange={toggle} label={s.enabled ? 'Activada' : 'Activar'} />
          </div>
        </div>
        {!s.enabled && s.missing?.length > 0 && (
          <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">Para activar complete: {s.missing.join(' · ')}</div>
        )}
        {!s.smtp_configured && <div className="text-xs text-slate-500">Correo: el servidor no tiene SMTP configurado, las facturas no se enviarán por correo automáticamente (variables SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM).</div>}
      </div>

      <div className="card space-y-3 p-5">
        <div className="font-semibold">Emisor</div>
        <Field label="Nombre o razón social (como aparece en Hacienda)"><input className="input" value={s.legal_name || ''} onChange={set('legal_name')} /></Field>
        <Field label="Nombre comercial"><input className="input" value={s.trade_name || ''} onChange={set('trade_name')} placeholder="Hotel Rio Lindo" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tipo de identificación">
            <select className="input" value={s.id_type || '02'} onChange={set('id_type')}>{ID_TYPES.filter(([k]) => k !== '05').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </Field>
          <Field label="Número de identificación"><input className="input" value={s.id_number || ''} onChange={set('id_number')} placeholder="3101123456" /></Field>
          <Field label="Código de actividad económica" hint="6 dígitos, ej. 551001 (hoteles)"><input className="input" maxLength={6} value={s.activity_code || ''} onChange={set('activity_code')} /></Field>
          <Field label="Cédula del proveedor de sistemas" hint="Quien provee el software; si es propio, su cédula"><input className="input" value={s.provider_id || ''} onChange={set('provider_id')} /></Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Provincia" hint="1 dígito"><input className="input" maxLength={1} value={s.provincia || ''} onChange={set('provincia')} /></Field>
          <Field label="Cantón" hint="2 dígitos"><input className="input" maxLength={2} value={s.canton || ''} onChange={set('canton')} /></Field>
          <Field label="Distrito" hint="2 dígitos"><input className="input" maxLength={2} value={s.distrito || ''} onChange={set('distrito')} /></Field>
        </div>
        <Field label="Barrio (opcional)"><input className="input" value={s.barrio || ''} onChange={set('barrio')} /></Field>
        <Field label="Otras señas"><input className="input" value={s.otras_senas || ''} onChange={set('otras_senas')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Teléfono"><input className="input" value={s.phone || ''} onChange={set('phone')} /></Field>
          <Field label="Correo del emisor"><input className="input" type="email" value={s.email || ''} onChange={set('email')} /></Field>
        </div>
      </div>

      <div className="space-y-4">
        <div className="card space-y-3 p-5">
          <div className="font-semibold">Conexión con Hacienda (ATV)</div>
          <Field label="Ambiente">
            <select className="input" value={s.environment} onChange={set('environment')} disabled={s.enabled}>
              <option value="stag">Pruebas (sandbox) — sin validez fiscal</option>
              <option value="prod">Producción</option>
            </select>
          </Field>
          {s.enabled && <p className="text-xs text-slate-500">Desactive la facturación para cambiar de ambiente.</p>}
          <Field label="Usuario de la API" hint="Generado en ATV → Comprobantes electrónicos → Generar usuario"><input className="input" value={s.api_username || ''} onChange={set('api_username')} placeholder="cpj-3-101-123456@stag.comprobanteselectronicos.go.cr" /></Field>
          <Field label="Contraseña de la API" hint={s.has_password ? 'Guardada (cifrada). Escriba solo para cambiarla.' : undefined}>
            <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={s.has_password ? '••••••••' : ''} />
          </Field>
          <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <div className="text-sm font-medium">Llave criptográfica (.p12)</div>
            {s.has_certificate ? (
              <div className="text-xs text-slate-500">{s.cert_subject}<br />Vence: {s.cert_expires_at ? new Date(s.cert_expires_at).toLocaleDateString('es-CR') : '—'}</div>
            ) : <div className="text-xs text-slate-500">Descárguela en ATV junto con su PIN de 4 dígitos.</div>}
            <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
              <label className="btn-secondary cursor-pointer justify-start truncate text-sm">
                <Upload size={14} />{p12 ? p12.name : s.has_certificate ? 'Reemplazar archivo…' : 'Seleccionar archivo .p12…'}
                <input type="file" accept=".p12,.pfx" className="hidden" onChange={(e) => pickFile(e.target.files?.[0])} />
              </label>
              <input className="input w-24" type="password" inputMode="numeric" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} aria-label="PIN de la llave" />
            </div>
            <button className="btn-secondary mt-2 w-full" disabled={!p12 || !pin || busy === 'cert'} onClick={uploadCert}>Cargar llave</button>
          </div>
          <button className="btn-secondary w-full" disabled={busy === 'test'} onClick={() => run('test', async () => setTest(await boApi('/hacienda/settings/test', { body: {} })))}>
            <PlugZap size={16} />Probar conexión y firma
          </button>
          {test && (
            <div className="space-y-1 text-sm">
              {[test.credentials, test.certificate].map((t: any, i: number) => (
                <div key={i} className={`flex items-start gap-2 ${t.ok ? 'text-emerald-700' : 'text-rose-600'}`}>{t.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}{t.message}</div>
              ))}
            </div>
          )}
        </div>

        <div className="card space-y-3 p-5">
          <div className="font-semibold">Comprobantes</div>
          <Field label="CABYS por defecto" hint="Se usa cuando el producto y su categoría no tienen CABYS (13 dígitos)"><CabysPicker value={s.default_cabys || ''} onChange={(v) => setS({ ...s, default_cabys: v })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Terminal" hint="5 dígitos del consecutivo. Use una distinta a la de Cubo u otro sistema."><input className="input" inputMode="numeric" maxLength={5} value={s.terminal || ''} onChange={set('terminal')} /></Field>
            <Field label="Tipo de cambio fijo (₡ por US$)" hint="Vacío = tipo de cambio diario de Hacienda/BCCR"><input className="input" inputMode="decimal" value={s.usd_rate_manual || ''} onChange={set('usd_rate_manual')} /></Field>
          </div>
          <Field label="Leyenda en el tiquete"><input className="input" value={s.resolution_text || ''} onChange={set('resolution_text')} /></Field>
        </div>
        <div className="card space-y-3 p-5">
          <div className="font-semibold">Facturas de proveedores (buzón de correo)</div>
          <p className="text-xs text-slate-500">Los proveedores envían sus facturas electrónicas a este correo. El sistema lo revisa cada 10 minutos, importa los XML y (si lo activa) los acepta ante Hacienda automáticamente.</p>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Servidor IMAP" className="col-span-2"><input className="input" value={s.imap_host || ''} onChange={set('imap_host')} placeholder="imap.gmail.com" /></Field>
            <Field label="Puerto"><input className="input" inputMode="numeric" value={s.imap_port || ''} onChange={set('imap_port')} placeholder="993" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Usuario / correo"><input className="input" value={s.imap_user || ''} onChange={set('imap_user')} placeholder="facturas@…" /></Field>
            <Field label="Contraseña" hint={s.has_imap_password ? 'Guardada (cifrada)' : 'Gmail: use una "contraseña de aplicación"'}>
              <input className="input" type="password" autoComplete="new-password" value={imapPassword} onChange={(e) => setImapPassword(e.target.value)} placeholder={s.has_imap_password ? '••••••••' : ''} />
            </Field>
          </div>
          {s.imap_error && <div className="text-xs text-rose-600">Último error: {s.imap_error}</div>}
          <Field label="Categoría de gasto predeterminada"><input className="input" value={s.expense_category || ''} onChange={set('expense_category')} placeholder="Compras" /></Field>
          <Toggle checked={!!s.auto_accept} onChange={(v) => setS({ ...s, auto_accept: v })} label="Aceptar automáticamente ante Hacienda las facturas recibidas" />
        </div>
        <Sequences />
        <button className="btn-primary w-full" disabled={busy === 'save'} onClick={save}>Guardar configuración</button>
      </div>
    </div>
  );
}

/** Consecutive numbers per terminal and document type; lets the hotel continue after the numbers used in Cubo. */
function Sequences() {
  const toast = useToast();
  const { data, reload } = useAsync(() => boApi<any[]>('/hacienda/sequences'), []);
  const [f, setF] = useState({ branch: '001', terminal: '', doc_type: '04', next: '' });
  const NAMES: Record<string, string> = { '01': 'Factura', '03': 'Nota de crédito', '04': 'Tiquete', '05': 'Aceptación', '06': 'Aceptación parcial', '07': 'Rechazo' };
  const save = async () => {
    try {
      await boApi('/hacienda/sequences', { method: 'PUT', body: { ...f, next: Number(f.next) } });
      toast('Numeración actualizada');
      setF({ ...f, next: '' });
      reload();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };
  return (
    <div className="card space-y-3 p-5">
      <div className="font-semibold">Numeración (consecutivos)</div>
      {data?.length ? (
        <table className="table text-sm">
          <thead><tr><th>Sucursal</th><th>Terminal</th><th>Tipo</th><th className="text-right">Último</th></tr></thead>
          <tbody>{data.map((r) => <tr key={r.branch + r.terminal + r.doc_type}><td>{r.branch}</td><td>{r.terminal}</td><td>{NAMES[r.doc_type] || r.doc_type}</td><td className="text-right tabular-nums">{r.last}</td></tr>)}</tbody>
        </table>
      ) : <div className="text-xs text-slate-500">Aún no se han emitido documentos en este ambiente.</div>}
      <div className="grid grid-cols-4 gap-2">
        <Field label="Sucursal"><input className="input" value={f.branch} onChange={(e) => setF({ ...f, branch: e.target.value })} /></Field>
        <Field label="Terminal"><input className="input" value={f.terminal} onChange={(e) => setF({ ...f, terminal: e.target.value })} placeholder="actual" /></Field>
        <Field label="Tipo"><select className="input" value={f.doc_type} onChange={(e) => setF({ ...f, doc_type: e.target.value })}>{Object.entries(NAMES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Siguiente N°"><input className="input" inputMode="numeric" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
      </div>
      <button className="btn-secondary w-full" disabled={!f.next} onClick={save}>Fijar siguiente número</button>
    </div>
  );
}
