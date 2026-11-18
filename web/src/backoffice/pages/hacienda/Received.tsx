import { useEffect, useState } from 'react';
import { Upload, MailCheck, FileText, Check, X } from 'lucide-react';
import { boApi, openFile } from '../../../lib/api';
import { dt } from '../../../lib/format';
import { Badge, Empty, Field, Modal, SearchInput, Spinner, useAsync, useToast } from '../../../components/ui';
import { fmtConsecutivo } from '../../../components/Receipt';
import { ExportButtons, useRange } from '../../widgets';
import { fmtCur } from './ManualInvoice';

/** Documentos recibidos: supplier invoices → accept / reject to Hacienda (Mensaje Receptor) → expense. */
const MR_STATUS: Record<string, [string, any]> = {
  pending: ['Enviando', 'amber'], sent: ['En proceso', 'blue'], accepted: ['Registrado en Hacienda', 'green'], rejected: ['Hacienda rechazó', 'red'], error: ['Error', 'red'],
};
const DECISION: Record<string, [string, any]> = { '05': ['Aceptado', 'green'], '06': ['Aceptado parcial', 'amber'], '07': ['Rechazado', 'red'] };
const DOC: Record<string, string> = { '01': 'Factura', '02': 'Nota de débito', '03': 'Nota de crédito' };
const CATEGORIES = ['Compras', 'Insumos de cocina', 'Insumos de bar', 'Limpieza', 'Mantenimiento', 'Servicios públicos', 'Servicios profesionales', 'Activos', 'Otros'];

export default function Received() {
  const toast = useToast();
  const range = useRange('month');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [deciding, setDeciding] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const qs = `${range.query}${q ? `&q=${encodeURIComponent(q)}` : ''}${status ? `&status=${status}` : ''}`;
  const { data, loading, reload } = useAsync(() => boApi(`/hacienda/received?${qs}`), [qs]);
  useEffect(() => {
    if (!data?.rows.some((d: any) => d.mr_status === 'pending' || d.mr_status === 'sent')) return;
    const t = setTimeout(reload, 5000);
    return () => clearTimeout(t);
  }, [data]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy('upload');
    try {
      const list = await Promise.all([...files].map((f) => f.text().then((content) => ({ name: f.name, content }))));
      const r = await boApi('/hacienda/received/import', { body: { files: list } });
      const okN = r.results.filter((x: any) => x.ok && x.created).length;
      const dup = r.results.filter((x: any) => x.ok && !x.created).length;
      const errs = r.results.filter((x: any) => !x.ok);
      toast(`${okN} importado(s)${dup ? `, ${dup} ya existían` : ''}${errs.length ? ` · ${errs.map((e: any) => `${e.name}: ${e.error}`).join(' · ')}` : ''}`, errs.length ? 'err' : 'ok');
      reload();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy('');
    }
  }
  async function checkInbox() {
    setBusy('inbox');
    try {
      const r = await boApi('/hacienda/received/check-inbox', { body: {} });
      toast(`Buzón revisado: ${r.imported} nueva(s)${r.errors?.length ? ` · ${r.errors.join(' · ')}` : ''}`);
      reload();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy('');
    }
  }
  const rows: any[] = data?.rows || [];
  const cols = [
    { key: 'issued_at', label: 'Fecha' }, { key: 'consecutivo', label: 'Consecutivo' }, { key: 'emisor_name', label: 'Proveedor' }, { key: 'emisor_id', label: 'Cédula' },
    { key: 'currency', label: 'Moneda' }, { key: 'total_tax', label: 'IVA' }, { key: 'total', label: 'Total' }, { key: 'decision', label: 'Decisión' }, { key: 'mr_status', label: 'Hacienda' },
    { key: 'expense_category', label: 'Categoría' }, { key: 'clave', label: 'Clave' },
  ];

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {range.ui}
        <select className="input w-auto py-1.5" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado">
          <option value="">Todos</option>
          <option value="new">Sin responder</option>
          <option value="accepted">Registrados en Hacienda</option>
          <option value="rejected">Rechazados por Hacienda</option>
        </select>
        <SearchInput value={q} onChange={setQ} placeholder="Proveedor, cédula, consecutivo o clave" className="max-w-xs flex-1" />
        <ExportButtons name="documentos-recibidos" rows={rows} cols={cols} />
        <div className="ml-auto flex gap-2">
          {data?.inbox?.configured && <button className="btn-secondary" disabled={!!busy} onClick={checkInbox}><MailCheck size={16} />Revisar correo</button>}
          <label className={`btn-primary cursor-pointer ${busy ? 'pointer-events-none opacity-60' : ''}`}>
            <Upload size={16} />Subir XML
            <input type="file" accept=".xml,text/xml,application/xml" multiple className="hidden" onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
          </label>
        </div>
      </div>
      {data && (
        <div className="mb-3 text-sm text-slate-500">
          {data.pending > 0 && <><b className="text-amber-600">{data.pending}</b> documento(s) sin responder · </>}
          {data.inbox?.configured
            ? <>Buzón de facturas: revisado {data.inbox.last_check ? dt(data.inbox.last_check) : 'nunca'}{data.inbox.error && <span className="text-rose-600"> · {data.inbox.error}</span>}</>
            : <>Configure el buzón de correo en Configuración para recibir las facturas de proveedores automáticamente.</>}
        </div>
      )}
      <div className="card overflow-x-auto">
        {loading && !data ? <div className="flex justify-center py-10"><Spinner /></div> : !rows.length ? <Empty>No hay documentos recibidos en este período</Empty> : (
          <table className="table text-sm">
            <thead><tr><th>Fecha</th><th>Proveedor</th><th>Documento</th><th className="text-right">IVA</th><th className="text-right">Total</th><th>Respuesta</th><th /></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="whitespace-nowrap">{dt(d.issued_at || d.created_at)}{d.source === 'email' && <div className="text-xs text-slate-400">por correo</div>}</td>
                  <td>{d.emisor_name}<div className="text-xs text-slate-500">{d.emisor_id}</div></td>
                  <td>{DOC[d.doc_type] || d.doc_type}<div className="font-mono text-xs text-slate-500">{fmtConsecutivo(d.consecutivo || '')}</div></td>
                  <td className="text-right tabular-nums">{fmtCur(d.total_tax, d.currency)}</td>
                  <td className="text-right font-medium tabular-nums">{fmtCur(d.total, d.currency)}</td>
                  <td>
                    {d.decision ? <Badge color={DECISION[d.decision]?.[1]}>{DECISION[d.decision]?.[0]}</Badge> : <Badge color="amber">Sin responder</Badge>}
                    {d.mr_status && <div className="mt-0.5"><Badge color={MR_STATUS[d.mr_status]?.[1]}>{MR_STATUS[d.mr_status]?.[0]}</Badge></div>}
                    {d.expense_category && d.decision !== '07' && <div className="text-xs text-slate-500">Gasto: {d.expense_category}</div>}
                    {d.mr_message && <div className="max-w-xs text-xs text-rose-600">{d.mr_message}</div>}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <button className="btn-secondary px-2 py-1 text-xs" onClick={() => openFile(boApi, `/hacienda/received/${d.id}/pdf`).catch((e) => toast(e.message, 'err'))}><FileText size={12} />PDF</button>
                    {(!d.decision || d.mr_status === 'rejected' || d.mr_status === 'error') && (
                      <button className="btn-primary ml-1 px-2 py-1 text-xs" onClick={() => setDeciding(d)}>Responder</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {deciding && <DecideModal doc={deciding} onClose={() => setDeciding(null)} onDone={() => { setDeciding(null); reload(); }} />}
    </>
  );
}

function DecideModal({ doc, onClose, onDone }: { doc: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [decision, setDecision] = useState('05');
  const [detail, setDetail] = useState('');
  const [category, setCategory] = useState(doc.expense_category || 'Compras');
  const [condicion, setCondicion] = useState('01');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await boApi(`/hacienda/received/${doc.id}/decide`, { body: { decision, detail, category, condicion, amount_accepted: decision === '06' ? Number(amount) : undefined } });
      toast(decision === '07' ? 'Rechazo enviado a Hacienda' : 'Aceptación enviada a Hacienda y gasto registrado');
      onDone();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={`${DOC[doc.doc_type] || 'Documento'} de ${doc.emisor_name}`}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className={decision === '07' ? 'btn-danger' : 'btn-primary'} disabled={busy} onClick={save}>{decision === '07' ? <X size={16} /> : <Check size={16} />}Enviar respuesta a Hacienda</button></>}>
      <div className="space-y-3">
        <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800">
          N° <span className="font-mono">{fmtConsecutivo(doc.consecutivo || '')}</span> · {dt(doc.issued_at)}<br />
          Total <b>{fmtCur(doc.total, doc.currency)}</b> (IVA {fmtCur(doc.total_tax, doc.currency)})
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[['05', 'Aceptar'], ['06', 'Aceptar parcial'], ['07', 'Rechazar']].map(([k, l]) => (
            <button key={k} className={`rounded-lg border p-2 text-sm font-medium ${decision === k ? (k === '07' ? 'border-rose-500 bg-rose-50 text-rose-700 dark:bg-rose-900/30' : 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/30') : 'border-slate-200 dark:border-slate-700'}`} onClick={() => setDecision(k)}>{l}</button>
          ))}
        </div>
        {decision !== '07' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Categoría del gasto">
              <input className="input" list="exp-cats" value={category} onChange={(e) => setCategory(e.target.value)} />
              <datalist id="exp-cats">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
            </Field>
            <Field label="IVA">
              <select className="input" value={condicion} onChange={(e) => setCondicion(e.target.value)}>
                <option value="01">Crédito fiscal (IVA acreditable)</option>
                <option value="04">Gasto corriente (sin crédito)</option>
                <option value="02">Crédito parcial</option>
                <option value="03">Bienes de capital</option>
                <option value="05">Proporcionalidad</option>
              </select>
            </Field>
            {decision === '06' && <Field label={`Monto aceptado (${doc.currency})`}><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>}
          </div>
        )}
        {decision !== '05' && <Field label="Motivo (se envía a Hacienda y al proveedor)"><input className="input" maxLength={160} value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Ej. Mercadería no recibida" /></Field>}
      </div>
    </Modal>
  );
}
