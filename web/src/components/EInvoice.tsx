import { Badge, Field } from './ui';
import { EDOC_NAMES, fmtConsecutivo } from './Receipt';

/** Costa Rica factura electrónica — the customer's tax details (receptor). */
export type ReceptorInput = { nombre: string; id_type: string; id_number: string; email: string; activity_code: string };

export const ID_TYPES: [string, string, number[]][] = [
  ['01', 'Cédula física', [9]],
  ['02', 'Cédula jurídica', [10]],
  ['03', 'DIMEX', [11, 12]],
  ['04', 'NITE', [10]],
  ['05', 'Extranjero no domiciliado', []],
];
const digits = (s: string) => String(s || '').replace(/\D/g, '');

export function guessIdType(num: string) {
  const d = digits(num);
  return d.length === 9 ? '01' : d.length === 10 ? '02' : d.length === 11 || d.length === 12 ? '03' : '';
}

/** Receptor prefilled from the customer attached to the sale (if any). */
export function receptorFromCustomer(c: any): ReceptorInput {
  const num = c?.tax_id || '';
  return { nombre: c?.name || '', id_type: c?.id_type || guessIdType(num) || '01', id_number: num, email: c?.email || '', activity_code: c?.activity_code || '' };
}

/** Returns an error message, or null when the receptor can be sent to Hacienda. */
export function receptorError(r: ReceptorInput): string | null {
  if (r.nombre.trim().length < 3) return 'Ingrese el nombre del cliente';
  const t = ID_TYPES.find((x) => x[0] === r.id_type);
  if (!t) return 'Seleccione el tipo de identificación';
  const n = r.id_type === '05' ? r.id_number.trim() : digits(r.id_number);
  if (!n) return 'Ingrese el número de identificación';
  if (t[2].length && !t[2].includes(n.length)) return `${t[1]}: ${t[2].join(' u ')} dígitos`;
  if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email.trim())) return 'Correo electrónico inválido';
  return null;
}

export function ReceptorForm({ value, onChange }: { value: ReceptorInput; onChange: (v: ReceptorInput) => void }) {
  const set = (k: keyof ReceptorInput) => (e: any) => {
    const v = { ...value, [k]: e.target.value };
    if (k === 'id_number' && !value.id_number && guessIdType(e.target.value)) v.id_type = guessIdType(e.target.value);
    onChange(v);
  };
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label="Tipo de identificación">
        <select className="input" value={value.id_type} onChange={set('id_type')}>{ID_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </Field>
      <Field label="Número"><input className="input" inputMode="numeric" value={value.id_number} onChange={set('id_number')} placeholder="3101123456" /></Field>
      <div className="col-span-2"><Field label="Nombre o razón social"><input className="input" value={value.nombre} onChange={set('nombre')} /></Field></div>
      <Field label="Correo (recibe la factura)"><input className="input" type="email" value={value.email} onChange={set('email')} /></Field>
      <Field label="Actividad económica (opcional)"><input className="input" inputMode="numeric" maxLength={6} value={value.activity_code} onChange={set('activity_code')} /></Field>
    </div>
  );
}

const STATUS: Record<string, [string, 'green' | 'amber' | 'red' | 'slate' | 'blue']> = {
  pending: ['En cola', 'amber'],
  validation_failed: ['Validación fallida', 'red'],
  signed: ['Firmado', 'blue'],
  sent: ['Enviado', 'blue'],
  processing: ['Procesando', 'blue'],
  accepted: ['Aceptado', 'green'],
  rejected: ['Rechazado', 'red'],
  error: ['Error de envío', 'red'],
  auth_error: ['Error de credenciales', 'red'],
  manual_review: ['Revisión manual', 'amber'],
};
export const EDOC_STATUS = STATUS;
export const EDocStatus = ({ status }: { status: string }) => {
  const [l, c] = STATUS[status] || [status, 'slate'];
  return <Badge color={c as any}>{l}</Badge>;
};

/** Compact list of a sale's electronic documents with their Hacienda status. */
export function EDocList({ docs, onDownload }: { docs: any[]; onDownload?: (d: any, kind: 'signed' | 'response' | 'pdf') => void }) {
  if (!docs?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
      <div className="mb-1 font-medium">Hacienda</div>
      {docs.map((d) => (
        <div key={d.id} className={`py-1 ${d.replaced_by ? 'opacity-60' : ''}`}>
          <div className="flex items-center justify-between gap-2">
            <span>{EDOC_NAMES[d.doc_type]} {d.replaced_by && '(sustituido)'}</span>
            <EDocStatus status={d.status} />
          </div>
          <div className="font-mono text-xs text-slate-500">N° {fmtConsecutivo(d.consecutivo)}</div>
          {d.receptor?.nombre && <div className="text-xs text-slate-500">{d.receptor.nombre} · {d.receptor.id_number}</div>}
          {d.message && d.status !== 'accepted' && <div className="text-xs text-rose-600">{d.message}</div>}
          {onDownload && (
            <div className="mt-0.5 flex gap-3 text-xs">
              <button className="text-brand-700 hover:underline" onClick={() => onDownload(d, 'pdf')}>PDF</button>
              <button className="text-brand-700 hover:underline" onClick={() => onDownload(d, 'signed')}>XML</button>
              {d.status === 'accepted' || d.status === 'rejected' ? <button className="text-brand-700 hover:underline" onClick={() => onDownload(d, 'response')}>Respuesta Hacienda</button> : null}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
