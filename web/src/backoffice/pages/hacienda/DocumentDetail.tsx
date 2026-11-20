import { useState } from 'react';
import { FileText, Download, RefreshCw, Mail, MinusCircle, PlusCircle, Printer } from 'lucide-react';
import { boApi, openFile } from '../../../lib/api';
import { dt } from '../../../lib/format';
import { Field, Modal, Spinner, useAsync, useToast } from '../../../components/ui';
import { EDOC_NAMES, fmtConsecutivo } from '../../../components/Receipt';
import { EDocStatus } from '../../../components/EInvoice';
import { CabysPicker } from '../../../components/CabysPicker';
import { useSession } from '../../BackOffice';
import { fmtCur } from './ManualInvoice';

const EVENT: Record<string, string> = {
  created: 'Creado', validated: 'Validado (XSD)', validation_failed: 'Validación fallida', signed: 'Firmado', submit: 'Envío a Hacienda', status: 'Consulta de estado',
  accepted: 'Aceptado', rejected: 'Rechazado', error: 'Error de envío', auth_error: 'Error de credenciales', manual_review: 'Revisión manual', reconcile: 'Conciliación',
  email: 'Correo', retry: 'Reintento', note: 'Nota / reemisión',
};

/** Document detail: lifecycle history, downloads, e-mail, credit / debit notes (PRD §11.2). */
export default function DocumentDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged?: () => void }) {
  const toast = useToast();
  const { can } = useSession();
  const { data: d, reload } = useAsync(() => boApi(`/hacienda/documents/${id}`), [id]);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<'02' | '03' | null>(null);
  const [email, setEmail] = useState('');
  const run = async (key: string, fn: () => Promise<any>, msg: string) => {
    setBusy(key);
    try { await fn(); toast(msg); reload(); onChanged?.(); } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(''); }
  };
  const xml = (kind: string) => boApi<string>(`/hacienda/documents/${id}/xml?kind=${kind}`, { text: true }).then((x) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([x], { type: 'application/xml' }));
    a.download = `${d.clave}${kind === 'signed' ? '' : '_' + kind}.xml`;
    a.click();
  }).catch((e) => toast(e.message, 'err'));
  if (!d) return <Modal open onClose={onClose} title="Comprobante"><div className="flex justify-center py-10"><Spinner /></div></Modal>;
  const adjustable = ['01', '04', '02'].includes(d.doc_type) && !d.annulled_by && !d.replaced_by && !['rejected', 'validation_failed'].includes(d.status) && (can('settings.manage') || can('pos.refund') || can('accounting.manage'));
  return (
    <Modal open onClose={onClose} size="lg" title={`${EDOC_NAMES[d.doc_type]} ${fmtConsecutivo(d.consecutivo)}`}>
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <EDocStatus status={d.status} />
          {d.environment === 'stag' && <span className="text-xs text-amber-600">ambiente de pruebas</span>}
          <span className="tabular-nums font-semibold">{d.total != null ? fmtCur(d.total, d.currency) : '—'}</span>
          {d.ambiguous && <span className="text-xs text-amber-700">verificando si Hacienda lo recibió</span>}
        </div>
        {d.message && d.status !== 'accepted' && <div className="rounded-lg bg-rose-50 p-3 text-rose-700 dark:bg-rose-900/20">{d.message}</div>}
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <div><span className="text-slate-500">Clave:</span> <span className="font-mono">{d.clave}</span></div>
          <div><span className="text-slate-500">Sucursal / terminal:</span> {d.store?.hacienda_branch || d.consecutivo.slice(0, 3)} / {d.terminal || d.consecutivo.slice(3, 8)} · {d.store?.name}</div>
          <div><span className="text-slate-500">Emitido:</span> {dt(d.issued_at)} (situación {d.situacion})</div>
          <div><span className="text-slate-500">Enviado / respuesta:</span> {d.submitted_at ? dt(d.submitted_at) : '—'} / {d.decided_at ? dt(d.decided_at) : '—'}</div>
          <div><span className="text-slate-500">Receptor:</span> {d.receptor?.nombre || '—'} {d.receptor?.id_number}</div>
          <div><span className="text-slate-500">Esquema / reglas:</span> {d.schema_version || '—'} · {d.rules_version || '—'}</div>
          {d.reference?.clave && <div className="col-span-2"><span className="text-slate-500">Referencia:</span> {EDOC_NAMES[d.reference.doc_type]} {fmtConsecutivo(d.reference.clave.slice(21, 41))} · código {d.reference.code} · {d.reference.reason}</div>}
          {d.xml_hash && <div className="col-span-2 truncate"><span className="text-slate-500">SHA-256 firmado:</span> <span className="font-mono">{d.signed_hash}</span></div>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary px-2 py-1 text-xs" onClick={() => openFile(boApi, `/hacienda/documents/${id}/pdf`).catch((e) => toast(e.message, 'err'))}><FileText size={12} />PDF</button>
          <button className="btn-secondary px-2 py-1 text-xs" onClick={() => openFile(boApi, `/hacienda/documents/${id}/pdf?format=80mm`).catch((e) => toast(e.message, 'err'))}><Printer size={12} />Tiquete 80 mm</button>
          <button className="btn-secondary px-2 py-1 text-xs" onClick={() => openFile(boApi, `/hacienda/documents/${id}/pdf?format=58mm`).catch((e) => toast(e.message, 'err'))}><Printer size={12} />58 mm</button>
          {d.has_xml_unsigned && <button className="btn-secondary px-2 py-1 text-xs" onClick={() => xml('unsigned')}><Download size={12} />XML original</button>}
          {d.has_xml_signed && <button className="btn-secondary px-2 py-1 text-xs" onClick={() => xml('signed')}><Download size={12} />XML firmado</button>}
          {d.has_response && <button className="btn-secondary px-2 py-1 text-xs" onClick={() => xml('response')}><Download size={12} />Respuesta Hacienda</button>}
          {!['accepted', 'rejected'].includes(d.status) && <button className="btn-secondary px-2 py-1 text-xs" disabled={!!busy} onClick={() => run('retry', () => boApi(`/hacienda/documents/${id}/retry`, { body: {} }), 'Reintentando')}><RefreshCw size={12} />{['sent', 'processing', 'manual_review'].includes(d.status) ? 'Consultar estado' : 'Reintentar'}</button>}
          {adjustable && <>
            <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setNote('03')}><MinusCircle size={12} />Nota de crédito</button>
            <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setNote('02')}><PlusCircle size={12} />Nota de débito</button>
          </>}
        </div>
        {d.status === 'accepted' && (
          <div className="flex items-end gap-2">
            <Field label="Reenviar por correo" className="flex-1"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={d.receptor?.email || 'correo@cliente.com'} /></Field>
            <button className="btn-secondary" disabled={!!busy || !(email || d.receptor?.email)} onClick={() => run('mail', () => boApi(`/hacienda/documents/${id}/email`, { body: { email: email || undefined } }), 'Correo enviado')}><Mail size={16} />Enviar</button>
          </div>
        )}
        {d.related?.length > 0 && (
          <div>
            <div className="mb-1 font-medium">Documentos relacionados</div>
            {d.related.map((r: any) => <div key={r.id} className="flex justify-between text-xs"><span>{EDOC_NAMES[r.doc_type]} {fmtConsecutivo(r.consecutivo)}</span><span><EDocStatus status={r.status} /> {r.total != null ? fmtCur(r.total, r.currency) : ''}</span></div>)}
          </div>
        )}
        <div>
          <div className="mb-1 font-medium">Historial</div>
          <ol className="max-h-64 space-y-1 overflow-y-auto border-l-2 border-slate-200 pl-3 text-xs dark:border-slate-700">
            {d.events.map((e: any) => (
              <li key={e.id}><span className="text-slate-500">{dt(e.created_at)}</span> · <b>{EVENT[e.kind] || e.kind}</b>{e.http_status ? ` · HTTP ${e.http_status}` : ''}{e.message ? ` — ${e.message}` : ''}{e.created_by_name ? ` (${e.created_by_name})` : ''}</li>
            ))}
          </ol>
        </div>
        {d.emails?.length > 0 && (
          <div><div className="mb-1 font-medium">Correos</div>{d.emails.map((m: any) => <div key={m.id} className="text-xs">{dt(m.created_at)} · {m.recipient} · {m.status === 'sent' ? 'enviado' : `falló: ${m.error}`}</div>)}</div>
        )}
      </div>
      {note && <NoteModal type={note} doc={d} onClose={() => setNote(null)} onDone={() => { setNote(null); reload(); onChanged?.(); }} />}
    </Modal>
  );
}

function NoteModal({ type, doc, onClose, onDone }: { type: '02' | '03'; doc: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [full, setFull] = useState(type === '03' && !!doc.payload);
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState([{ name: '', qty: '1', price: '', tax_rate: '13', cabys: '' }]);
  const [busy, setBusy] = useState(false);
  const set = (i: number, k: string, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const save = async () => {
    setBusy(true);
    try {
      const n = await boApi(type === '03' ? '/hacienda/credit-notes' : '/hacienda/debit-notes', {
        body: { document_id: doc.id, reason, lines: full ? null : lines.map((l) => ({ ...l, qty: Number(l.qty), price: Number(l.price), tax_rate: Number(l.tax_rate) })) },
      });
      toast(`${type === '03' ? 'Nota de crédito' : 'Nota de débito'} N° ${n.consecutivo} emitida`);
      onDone();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={type === '03' ? 'Nota de crédito' : 'Nota de débito'} footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={busy} onClick={save}>Emitir</button></>}>
      <div className="space-y-3 text-sm">
        <p className="text-slate-500">Referencia: {EDOC_NAMES[doc.doc_type]} {fmtConsecutivo(doc.consecutivo)} · {fmtCur(doc.total, doc.currency)}. El documento original no se modifica.</p>
        {type === '03' && doc.payload && (
          <div className="flex gap-4">
            <label className="flex items-center gap-2"><input type="radio" checked={full} onChange={() => setFull(true)} />Anular todo (código 01)</label>
            <label className="flex items-center gap-2"><input type="radio" checked={!full} onChange={() => setFull(false)} />Ajuste parcial</label>
          </div>
        )}
        {type === '03' && !doc.payload && <p className="text-xs text-amber-700">Venta del POS: para devolver productos use Recibos → Reembolsar (también devuelve el inventario). Aquí puede emitir un ajuste parcial, por ejemplo un descuento posterior.</p>}
        <Field label="Motivo (se envía a Hacienda)"><input className="input" maxLength={180} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {!full && (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-slate-500"><th>CABYS</th><th>Detalle</th><th className="w-16">Cant.</th><th className="w-28">Precio sin IVA</th><th className="w-20">IVA</th></tr></thead>
            <tbody>{lines.map((l, i) => (
              <tr key={i}>
                <td className="w-56 pr-1"><CabysPicker value={l.cabys} onChange={(v) => set(i, 'cabys', v)} placeholder="Predeterminado" /></td>
                <td className="pr-1"><input className="input" value={l.name} onChange={(e) => set(i, 'name', e.target.value)} placeholder={type === '03' ? 'Descuento, ajuste…' : 'Cargo adicional…'} /></td>
                <td className="pr-1"><input className="input" value={l.qty} onChange={(e) => set(i, 'qty', e.target.value)} /></td>
                <td className="pr-1"><input className="input" value={l.price} onChange={(e) => set(i, 'price', e.target.value)} /></td>
                <td><select className="input" value={l.tax_rate} onChange={(e) => set(i, 'tax_rate', e.target.value)}>{['13', '8', '4', '2', '1', '0.5', '0'].map((r) => <option key={r} value={r}>{r}%</option>)}</select></td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {!full && <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setLines([...lines, { name: '', qty: '1', price: '', tax_rate: '13', cabys: '' }])}><PlusCircle size={12} />Línea</button>}
      </div>
    </Modal>
  );
}
