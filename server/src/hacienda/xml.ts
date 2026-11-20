import { NAMESPACE, ROOT, SERVICE_UNITS, crDateTime, digits, idNumber, medioPago, tarifaCode, type DocType } from './codes.ts';

/** Builds unsigned comprobante XML (v4.4) for a tiquete, factura or nota de crédito from POS sale data. */

export type Emisor = {
  nombre: string; id_type: string; id_number: string; nombre_comercial?: string | null;
  provincia: string; canton: string; distrito: string; barrio?: string | null; otras_senas: string;
  phone?: string | null; email: string;
  registro_fiscal_8707?: string | null; // bebidas alcohólicas (Ley 8707)
};
export type Receptor = { nombre: string; id_type?: string | null; id_number?: string | null; email?: string | null; activity_code?: string | null };
export type DocLine = {
  qty: number; name: string; cabys: string; unit?: string; code?: string | null;
  gross: number; discount: number; total: number; // as stored on sale_items (gross/discount include IVA when prices are tax-inclusive)
  taxes: { rate: number; inclusive: boolean }[];
};
export type DocReference = { doc_type: string; clave: string; issued_at: Date | string; code: string; reason: string };
export type BuildInput = {
  docType: DocType; clave: string; consecutivo: string; fecha: Date;
  providerId: string; activityCode: string; emisor: Emisor; receptor?: Receptor | null;
  lines: DocLine[]; serviceCharge: number; servicePct: number; tip: number;
  payments: { type: string; name: string; amount: number }[];
  references?: DocReference[];
  currency?: 'CRC' | 'USD'; exchangeRate?: number;   // amounts are in the document currency; TipoCambio = colones per unit
  condition?: string; creditDays?: number | null;    // CondicionVenta 01 contado | 02 crédito …
  notes?: string | null;                             // printed in "Otros / OtroTexto"
};

const r5 = (n: number) => Math.round((n + Number.EPSILON) * 1e5) / 1e5;
const m = (n: number) => r5(n).toFixed(5);
const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const el = (name: string, value: unknown) => `<${name}>${esc(value)}</${name}>`;
const opt = (name: string, value: unknown) => (value === null || value === undefined || value === '' ? '' : el(name, value));
const clip = (s: string, min: number, max: number) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
  return t.length >= min ? t : t.padEnd(min, '.');
};

/** Line amounts in Hacienda terms: unit price and discount exclude IVA; tax is computed on the net base (5 decimals). */
export function lineAmounts(l: DocLine) {
  const rate = l.taxes.reduce((s, t) => s + Number(t.rate || 0), 0);
  const inclusive = l.taxes.length > 0 && l.taxes.every((t) => t.inclusive);
  const qty = Number(l.qty);
  const grossEx = inclusive ? Number(l.gross) / (1 + rate / 100) : Number(l.gross);
  const netEx = inclusive ? Number(l.total) / (1 + rate / 100) : Number(l.gross) - Number(l.discount);
  const precio = r5(grossEx / qty);
  const montoTotal = r5(precio * qty);
  let descuento = Number(l.discount) > 0 ? r5(montoTotal - netEx) : 0;
  if (descuento < 0.00001) descuento = 0;
  const subTotal = r5(montoTotal - descuento);
  const impuesto = r5((subTotal * rate) / 100);
  return { rate, qty, precio, montoTotal, descuento, subTotal, impuesto, totalLinea: r5(subTotal + impuesto), tarifa: tarifaCode(rate) };
}

function ubicacion(e: Emisor) {
  return (
    '<Ubicacion>' + el('Provincia', digits(e.provincia).slice(0, 1)) + el('Canton', digits(e.canton).padStart(2, '0').slice(-2)) +
    el('Distrito', digits(e.distrito).padStart(2, '0').slice(-2)) + (e.barrio && e.barrio.trim().length >= 5 ? el('Barrio', e.barrio.trim().slice(0, 50)) : '') +
    el('OtrasSenas', clip(e.otras_senas, 5, 250)) + '</Ubicacion>'
  );
}

export function buildXml(d: BuildInput): { xml: string; total: number } {
  const e = d.emisor;
  const phone = digits(e.phone).replace(/^506(?=\d{8}$)/, '');
  const emisor =
    '<Emisor>' + el('Nombre', clip(e.nombre, 5, 100)) +
    '<Identificacion>' + el('Tipo', e.id_type) + el('Numero', idNumber(e.id_type, e.id_number)) + '</Identificacion>' +
    (e.registro_fiscal_8707 && e.registro_fiscal_8707.trim() ? el('Registrofiscal8707', e.registro_fiscal_8707.trim().slice(0, 12)) : '') +
    (e.nombre_comercial && e.nombre_comercial.trim().length >= 3 ? el('NombreComercial', e.nombre_comercial.trim().slice(0, 80)) : '') +
    ubicacion(e) +
    (phone.length >= 3 ? '<Telefono>' + el('CodigoPais', '506') + el('NumTelefono', phone.slice(0, 20)) + '</Telefono>' : '') +
    el('CorreoElectronico', e.email.trim()) + '</Emisor>';

  let receptor = '';
  const rc = d.receptor;
  if (rc && rc.nombre) {
    const hasId = rc.id_type && rc.id_number;
    receptor =
      '<Receptor>' + el('Nombre', clip(rc.nombre, 3, 100)) +
      (hasId ? '<Identificacion>' + el('Tipo', rc.id_type) + el('Numero', idNumber(rc.id_type!, rc.id_number!)) + '</Identificacion>' : '') +
      opt('CorreoElectronico', rc.email?.trim()) + '</Receptor>';
  }

  // Lines and totals
  const t = { servG: 0, servE: 0, mercG: 0, mercE: 0, desc: 0, tax: 0 };
  const desglose = new Map<string, number>();
  const lines = d.lines.map((l, i) => {
    const a = lineAmounts(l);
    const unit = l.unit || 'Unid';
    const service = SERVICE_UNITS.has(unit);
    const taxed = a.rate > 0;
    if (service) taxed ? (t.servG += a.montoTotal) : (t.servE += a.montoTotal);
    else taxed ? (t.mercG += a.montoTotal) : (t.mercE += a.montoTotal);
    t.desc += a.descuento;
    t.tax += a.impuesto;
    if (a.impuesto > 0) desglose.set(a.tarifa, (desglose.get(a.tarifa) || 0) + a.impuesto);
    if (!/^\d{13}$/.test(digits(l.cabys))) throw new Error(`"${l.name}" no tiene un código CABYS válido (13 dígitos)`);
    return (
      '<LineaDetalle>' + el('NumeroLinea', i + 1) + el('CodigoCABYS', digits(l.cabys)) +
      (l.code ? '<CodigoComercial>' + el('Tipo', '01') + el('Codigo', String(l.code).slice(0, 20)) + '</CodigoComercial>' : '') +
      el('Cantidad', a.qty.toFixed(3)) + el('UnidadMedida', unit) + el('Detalle', clip(l.name, 3, 200)) +
      el('PrecioUnitario', m(a.precio)) + el('MontoTotal', m(a.montoTotal)) +
      (a.descuento > 0 ? '<Descuento>' + el('MontoDescuento', m(a.descuento)) + el('CodigoDescuento', '07') + '</Descuento>' : '') +
      el('SubTotal', m(a.subTotal)) + el('BaseImponible', m(a.subTotal)) +
      '<Impuesto>' + el('Codigo', '01') + el('CodigoTarifaIVA', a.tarifa) + el('Tarifa', a.rate.toFixed(2)) + el('Monto', m(a.impuesto)) + '</Impuesto>' +
      el('ImpuestoAsumidoEmisorFabrica', m(0)) + el('ImpuestoNeto', m(a.impuesto)) + el('MontoTotalLinea', m(a.totalLinea)) +
      '</LineaDetalle>'
    );
  });
  if (!lines.length) throw new Error('El comprobante no tiene líneas');

  // Other charges: the restaurant's 10% service charge (code 06) and the voluntary tip
  let otros = '';
  let totalOtros = 0;
  if (d.serviceCharge > 0) {
    totalOtros += r5(d.serviceCharge);
    otros += '<OtrosCargos>' + el('TipoDocumentoOC', '06') + el('Detalle', 'Impuesto de servicio 10%') + el('PorcentajeOC', r5(d.servicePct).toFixed(5)) + el('MontoCargo', m(d.serviceCharge)) + '</OtrosCargos>';
  }
  if (d.tip > 0) {
    totalOtros += r5(d.tip);
    otros += '<OtrosCargos>' + el('TipoDocumentoOC', '99') + el('TipoDocumentoOTROS', 'Propina voluntaria') + el('Detalle', 'Propina') + el('MontoCargo', m(d.tip)) + '</OtrosCargos>';
  }

  const totalGravado = r5(t.servG + t.mercG);
  const totalExento = r5(t.servE + t.mercE);
  const totalVenta = r5(totalGravado + totalExento);
  const totalDesc = r5(t.desc);
  const ventaNeta = r5(totalVenta - totalDesc);
  const totalImpuesto = r5(t.tax);
  const totalComprobante = r5(ventaNeta + totalImpuesto + totalOtros);

  // Payment methods (max 4 per comprobante); amounts are scaled so they add up exactly to the comprobante total
  const groups = new Map<string, { code: string; other?: string; amount: number }>();
  for (const p of d.payments) {
    if (!(Number(p.amount) > 0)) continue;
    const mp = medioPago(p.type, p.name);
    const k = mp.code + (mp.other || '');
    const g = groups.get(k) || { ...mp, amount: 0 };
    g.amount += Number(p.amount);
    groups.set(k, g);
  }
  let pays = [...groups.values()];
  if (pays.length > 4) pays = [...pays.slice(0, 3), { code: '99', other: 'Otros medios', amount: pays.slice(3).reduce((s, p) => s + p.amount, 0) }];
  if (!pays.length) pays = [{ code: '01', amount: totalComprobante }];
  const paidSum = pays.reduce((s, p) => s + p.amount, 0) || 1;
  let left = totalComprobante;
  const medio = pays
    .map((p, i) => {
      const amt = i === pays.length - 1 ? r5(left) : r5((totalComprobante * p.amount) / paidSum);
      left = r5(left - amt);
      return '<MedioPago>' + el('TipoMedioPago', p.code) + (p.code === '99' ? el('MedioPagoOtros', clip(p.other || 'Otros', 3, 100)) : '') + el('TotalMedioPago', m(amt)) + '</MedioPago>';
    })
    .join('');

  const resumen =
    '<ResumenFactura>' +
    '<CodigoTipoMoneda>' + el('CodigoMoneda', d.currency || 'CRC') + el('TipoCambio', m(d.currency === 'USD' ? Number(d.exchangeRate) || 1 : 1)) + '</CodigoTipoMoneda>' +
    el('TotalServGravados', m(t.servG)) + el('TotalServExentos', m(t.servE)) +
    el('TotalMercanciasGravadas', m(t.mercG)) + el('TotalMercanciasExentas', m(t.mercE)) +
    el('TotalGravado', m(totalGravado)) + el('TotalExento', m(totalExento)) +
    el('TotalVenta', m(totalVenta)) + el('TotalDescuentos', m(totalDesc)) + el('TotalVentaNeta', m(ventaNeta)) +
    [...desglose.entries()].map(([code, amt]) => '<TotalDesgloseImpuesto>' + el('Codigo', '01') + el('CodigoTarifaIVA', code) + el('TotalMontoImpuesto', m(amt)) + '</TotalDesgloseImpuesto>').join('') +
    el('TotalImpuesto', m(totalImpuesto)) + (totalOtros > 0 ? el('TotalOtrosCargos', m(totalOtros)) : '') +
    medio + el('TotalComprobante', m(totalComprobante)) + '</ResumenFactura>';

  const refs = (d.references || [])
    .map((r) =>
      '<InformacionReferencia>' + el('TipoDocIR', r.doc_type) + el('Numero', r.clave) + el('FechaEmisionIR', crDateTime(new Date(r.issued_at))) +
      el('Codigo', r.code) + el('Razon', clip(r.reason, 1, 180)) + '</InformacionReferencia>',
    )
    .join('');
  if ((d.docType === '03' || d.docType === '02') && !refs) throw new Error(`La nota de ${d.docType === '03' ? 'crédito' : 'débito'} requiere un documento de referencia`);

  const root = ROOT[d.docType];
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<${root} xmlns="${NAMESPACE[d.docType]}" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    el('Clave', d.clave) + el('ProveedorSistemas', idNumber('01', d.providerId).slice(0, 20)) + el('CodigoActividadEmisor', digits(d.activityCode).padStart(6, '0')) +
    (d.docType === '01' && rc?.activity_code && digits(rc.activity_code).length === 6 ? el('CodigoActividadReceptor', digits(rc.activity_code)) : '') +
    el('NumeroConsecutivo', d.consecutivo) + el('FechaEmision', crDateTime(d.fecha)) +
    emisor + receptor + el('CondicionVenta', d.condition || '01') +
    ((d.condition === '02' || d.condition === '10') && Number(d.creditDays) > 0 ? el('PlazoCredito', Math.round(Number(d.creditDays))) : '') +
    '<DetalleServicio>' + lines.join('') + '</DetalleServicio>' + otros + resumen + refs +
    (d.notes && d.notes.trim() ? '<Otros>' + el('OtroTexto', d.notes.replace(/\s+/g, ' ').trim().slice(0, 500)) + '</Otros>' : '') +
    `</${root}>`;
  return { xml, total: totalComprobante };
}
