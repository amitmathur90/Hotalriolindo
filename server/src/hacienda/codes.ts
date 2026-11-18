/**
 * Costa Rica electronic invoicing (Ministerio de Hacienda, comprobantes electrónicos v4.4) — codes and numbering.
 * Code lists are taken from the official v4.4 XSDs (cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/).
 */
export type DocType = '01' | '03' | '04';
export const DOC_NAMES: Record<DocType, string> = { '01': 'Factura electrónica', '03': 'Nota de crédito electrónica', '04': 'Tiquete electrónico' };
export const DOC_SHORT: Record<DocType, string> = { '01': 'FE', '03': 'NC', '04': 'TE' };
export const ROOT: Record<DocType, string> = { '01': 'FacturaElectronica', '03': 'NotaCreditoElectronica', '04': 'TiqueteElectronico' };
const NS_BASE = 'https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/';
export const NAMESPACE: Record<DocType, string> = {
  '01': NS_BASE + 'facturaElectronica',
  '03': NS_BASE + 'notaCreditoElectronica',
  '04': NS_BASE + 'tiqueteElectronico',
};
/** Printed on receipts; editable in Settings → Hacienda. */
export const DEFAULT_RESOLUTION = 'Autorizado mediante resolución MH-DGT-RES-0027-2024 · Comprobantes electrónicos v4.4';

/** Identification types. */
export const ID_TYPES: Record<string, { label: string; len: number[] }> = {
  '01': { label: 'Cédula física', len: [9] },
  '02': { label: 'Cédula jurídica', len: [10] },
  '03': { label: 'DIMEX', len: [11, 12] },
  '04': { label: 'NITE', len: [10] },
  '05': { label: 'Extranjero no domiciliado', len: [] },
  '06': { label: 'No contribuyente', len: [] },
};
export const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/** Guesses the ID type from the number of digits (9 física, 10 jurídica, 11-12 DIMEX). */
export function guessIdType(num: string): string | null {
  const d = digits(num);
  if (d.length === 9) return '01';
  if (d.length === 10) return '02';
  if (d.length === 11 || d.length === 12) return '03';
  return null;
}

/** Normalised identification number as sent to Hacienda (digits only, except foreign IDs). */
export const idNumber = (type: string, num: string) => (type === '05' ? String(num || '').trim().slice(0, 20) : digits(num));

export function validateId(type: string, num: string): string | null {
  const t = ID_TYPES[type];
  if (!t) return 'Tipo de identificación inválido';
  const d = idNumber(type, num);
  if (!d) return 'Número de identificación requerido';
  if (t.len.length && !t.len.includes(d.length)) return `${t.label} debe tener ${t.len.join(' u ')} dígitos`;
  if (d.length > 20) return 'Identificación demasiado larga';
  return null;
}

/** IVA rate → CodigoTarifaIVA. 0% items are reported as "Tarifa Exenta" (10). */
export function tarifaCode(rate: number): string {
  const map: Record<string, string> = { '13': '08', '8': '07', '4': '04', '2': '03', '1': '02', '0.5': '09', '0': '10' };
  const code = map[String(Number(rate))];
  if (!code) throw new Error(`Tarifa de IVA ${rate}% no válida para Hacienda`);
  return code;
}

/** POS payment method → TipoMedioPago. */
export function medioPago(type: string, name: string): { code: string; other?: string } {
  const n = name.toLowerCase();
  if (type === 'cash') return { code: '01' };
  if (type === 'card') return { code: '02' };
  if (n.includes('sinpe')) return { code: '06' };
  if (type === 'bank' || n.includes('transfer')) return { code: '04' };
  return { code: '99', other: name.slice(0, 100) };
}

/** Units of measure that make a line a service. Everything else is merchandise. */
export const SERVICE_UNITS = new Set(['Sp', 'Os', 'Spe', 'St', 'Al', 'Alc', 'Cm', 'I', 'd', 'h', 'min', 's']);

// Costa Rica is UTC-6 all year (no daylight saving time).
const CR_OFFSET_MS = -6 * 3600 * 1000;
const p2 = (n: number) => String(n).padStart(2, '0');
function crParts(d: Date) {
  const t = new Date(d.getTime() + CR_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
}
/** xs:dateTime in Costa Rica time, e.g. 2026-11-13T15:20:00-06:00 */
export function crDateTime(d: Date) {
  const x = crParts(d);
  return `${x.y}-${p2(x.m)}-${p2(x.d)}T${p2(x.h)}:${p2(x.mi)}:${p2(x.s)}-06:00`;
}

/** NumeroConsecutivo (20): sucursal(3) + terminal(5) + tipo(2) + número(10). */
export function consecutivo(branch: string, terminal: string, doc: DocType | '05' | '06' | '07', n: number) {
  return digits(branch).padStart(3, '0').slice(-3) + digits(terminal).padStart(5, '0').slice(-5) + doc + String(n).padStart(10, '0');
}

/**
 * Clave numérica (50): país 506 + DDMMAA + identificación del emisor (12) + consecutivo (20) + situación (1) + código de seguridad (8).
 * Situación: 1 normal, 2 contingencia, 3 sin internet.
 */
export function clave(date: Date, emisorId: string, cons: string, situacion: '1' | '2' | '3', security: string) {
  const x = crParts(date);
  const c = '506' + p2(x.d) + p2(x.m) + p2(x.y % 100) + digits(emisorId).padStart(12, '0') + cons + situacion + digits(security).padStart(8, '0').slice(-8);
  if (!/^\d{50}$/.test(c)) throw new Error('Clave inválida: ' + c);
  return c;
}
export const securityCode = () => String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
