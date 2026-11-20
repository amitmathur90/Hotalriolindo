import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { DOMParser } from '@xmldom/xmldom';
import { db } from '../db.ts';
import { receiptSig } from '../util.ts';
import { APP_NAME } from '../config.ts';
import { amountInWords } from './words.ts';
import { DEFAULT_RESOLUTION } from './codes.ts';
/** Stored resolution text, upgrading the short text older versions saved to the full legal wording. */
const resolutionText = (s: any) => (!s?.resolution_text || /^Autorizado mediante resoluci.n MH-DGT-RES-0027-2024 ·/.test(s.resolution_text) ? DEFAULT_RESOLUTION : s.resolution_text);

/**
 * PDF of a comprobante electrónico (Hacienda v4.4), laid out like the usual Costa Rican invoice PDF:
 * header with type / N° / clave / status, emisor & receptor, condition bar, lines, otros cargos, totals with the
 * amount in words, notes, legal footer and a QR code. Built from the XML itself, so it works for our documents and for
 * supplier documents received from Hacienda alike.
 */

// ------------------------------------------------------------------ XML → model
const kids = (e: any, name: string): any[] => {
  const out: any[] = [];
  for (let n = e?.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (n.localName || n.nodeName) === name) out.push(n);
  return out;
};
const kid = (e: any, name: string) => kids(e, name)[0];
const txt = (e: any, ...path: string[]) => {
  let n = e;
  for (const p of path) n = kid(n, p);
  return n ? String(n.textContent || '').trim() : '';
};
const num = (s: string) => Number(s) || 0;

export const DOC_TITLES: Record<string, string> = {
  FacturaElectronica: 'Factura Electrónica', TiqueteElectronico: 'Tiquete Electrónico', NotaCreditoElectronica: 'Nota de Crédito Electrónica',
  NotaDebitoElectronica: 'Nota de Débito Electrónica', FacturaElectronicaCompra: 'Factura Electrónica de Compra', FacturaElectronicaExportacion: 'Factura Electrónica de Exportación',
};
const ID_LABEL: Record<string, string> = { '01': 'Cédula Física', '02': 'Cédula Jurídica', '03': 'DIMEX', '04': 'NITE', '05': 'Extranjero', '06': 'No contribuyente' };
const CONDICION: Record<string, string> = {
  '01': 'Contado', '02': 'Crédito', '03': 'Consignación', '04': 'Apartado', '05': 'Arrendamiento con opción de compra', '06': 'Arrendamiento financiero',
  '07': 'Cobro a favor de un tercero', '08': 'Servicios al Estado', '09': 'Pago de servicios al Estado', '10': 'Crédito IVA hasta 90 días', '99': 'Otros',
};
const MEDIO: Record<string, string> = { '01': 'Efectivo', '02': 'Tarjeta', '03': 'Cheque', '04': 'Transferencia', '05': 'Recaudado por terceros', '06': 'SINPE Móvil', '07': 'Plataforma digital', '99': 'Otros' };
const REF_CODE: Record<string, string> = { '01': 'Anula documento de referencia', '02': 'Corrige texto', '04': 'Referencia a otro documento', '05': 'Sustituye comprobante provisional', '06': 'Devolución de mercancía', '07': 'Sustituye comprobante electrónico', '99': 'Otros' };

export type ParsedDoc = ReturnType<typeof parseComprobante>;

export function parseComprobante(xml: string) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const root: any = doc.documentElement;
  if (!root) throw new Error('XML inválido');
  const kind = root.localName || root.nodeName;
  const party = (e: any) => e && {
    nombre: txt(e, 'Nombre'), comercial: txt(e, 'NombreComercial'),
    idType: txt(e, 'Identificacion', 'Tipo'), id: txt(e, 'Identificacion', 'Numero') || txt(e, 'IdentificacionExtranjero'),
    email: txt(e, 'CorreoElectronico'), phone: txt(e, 'Telefono', 'NumTelefono'),
    address: [placeName(txt(e, 'Ubicacion', 'Provincia'), txt(e, 'Ubicacion', 'Canton'), txt(e, 'Ubicacion', 'Distrito')), txt(e, 'Ubicacion', 'OtrasSenas'), txt(e, 'OtrasSenasExtranjero')].filter(Boolean).join('. '),
  };
  const res = kid(root, 'ResumenFactura');
  const moneda = res ? kid(res, 'CodigoTipoMoneda') : null;
  const detalle = kid(root, 'DetalleServicio');
  return {
    kind, title: DOC_TITLES[kind] || kind,
    clave: txt(root, 'Clave'), consecutivo: txt(root, 'NumeroConsecutivo'), fecha: txt(root, 'FechaEmision'),
    actividad: txt(root, 'CodigoActividadEmisor') || txt(root, 'CodigoActividad'),
    emisor: party(kid(root, 'Emisor'))!, receptor: party(kid(root, 'Receptor')),
    condicion: txt(root, 'CondicionVenta'), plazo: txt(root, 'PlazoCredito'),
    moneda: (moneda && txt(moneda, 'CodigoMoneda')) || 'CRC', tipoCambio: num((moneda && txt(moneda, 'TipoCambio')) || '1') || 1,
    lines: (detalle ? kids(detalle, 'LineaDetalle') : []).map((l) => {
      const imp = kids(l, 'Impuesto');
      return {
        n: txt(l, 'NumeroLinea'), cabys: txt(l, 'CodigoCABYS') || txt(l, 'Codigo'), detalle: txt(l, 'Detalle'), cantidad: num(txt(l, 'Cantidad')), unidad: txt(l, 'UnidadMedida'),
        precio: num(txt(l, 'PrecioUnitario')), montoTotal: num(txt(l, 'MontoTotal')), descuento: kids(l, 'Descuento').reduce((s, d) => s + num(txt(d, 'MontoDescuento')), 0),
        subTotal: num(txt(l, 'SubTotal')), tarifa: imp.length ? num(txt(imp[0], 'Tarifa')) : 0, impuesto: imp.reduce((s, i) => s + num(txt(i, 'Monto')), 0),
        total: num(txt(l, 'MontoTotalLinea')),
      };
    }),
    otros: kids(root, 'OtrosCargos').map((o) => ({ tipo: txt(o, 'TipoDocumentoOC') || txt(o, 'TipoDocumento'), detalle: txt(o, 'Detalle'), pct: num(txt(o, 'PorcentajeOC') || txt(o, 'Porcentaje')), monto: num(txt(o, 'MontoCargo')) })),
    medios: res ? kids(res, 'MedioPago').map((m) => ({ code: txt(m, 'TipoMedioPago'), amount: num(txt(m, 'TotalMedioPago')) })) : [],
    medioLegacy: kids(root, 'MedioPago').map((m) => ({ code: String(m.textContent || '').trim(), amount: 0 })),
    resumen: {
      totalVenta: num(txt(res, 'TotalVenta')), descuentos: num(txt(res, 'TotalDescuentos')), ventaNeta: num(txt(res, 'TotalVentaNeta')),
      impuesto: num(txt(res, 'TotalImpuesto')), otros: num(txt(res, 'TotalOtrosCargos')), total: num(txt(res, 'TotalComprobante')),
      gravado: num(txt(res, 'TotalGravado')), exento: num(txt(res, 'TotalExento')),
    },
    referencias: kids(root, 'InformacionReferencia').map((r) => ({ tipo: txt(r, 'TipoDocIR') || txt(r, 'TipoDoc'), numero: txt(r, 'Numero'), fecha: txt(r, 'FechaEmisionIR') || txt(r, 'FechaEmision'), codigo: txt(r, 'Codigo'), razon: txt(r, 'Razon') })),
    notas: kids(kid(root, 'Otros') || {}, 'OtroTexto').map((o) => String(o.textContent || '').trim()).filter(Boolean),
  };
}

// ------------------------------------------------------------------ rendering
const fmt = (n: number, cur: string) => {
  const neg = n < 0;
  const [i, d] = Math.abs(n).toFixed(2).split('.');
  return `${neg ? '-' : ''}${cur} ${i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${d}`;
};
const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace('.', ','));
const fmtDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  let h = Number(m[4]);
  const ap = h >= 12 ? 'p. m.' : 'a. m.';
  h = h % 12 || 12;
  return `${m[3]}/${m[2]}/${m[1]}, ${String(h).padStart(2, '0')}:${m[5]} ${ap}`;
};

/** Names of the territorial division (provincia / cantón / distrito) printed in the address, like Cubo does. */
const PROVINCIAS: Record<string, string> = { '1': 'San José', '2': 'Alajuela', '3': 'Cartago', '4': 'Heredia', '5': 'Guanacaste', '6': 'Puntarenas', '7': 'Limón' };
const CANTONES: Record<string, string> = {
  '6-01': 'Puntarenas', '6-02': 'Esparza', '6-03': 'Buenos Aires', '6-04': 'Montes de Oro', '6-05': 'Osa', '6-06': 'Quepos', '6-07': 'Golfito',
  '6-08': 'Coto Brus', '6-09': 'Parrita', '6-10': 'Corredores', '6-11': 'Garabito',
};
const DISTRITOS: Record<string, string> = {
  '6-05-01': 'Puerto Cortés', '6-05-02': 'Palmar', '6-05-03': 'Sierpe', '6-05-04': 'Bahía Ballena', '6-05-05': 'Piedras Blancas', '6-05-06': 'Bahía Drake',
};
function placeName(prov: string | null, canton: string | null, distrito: string | null) {
  const p = String(Number(prov || 0)), c = String(canton || '').padStart(2, '0'), d = String(distrito || '').padStart(2, '0');
  return [PROVINCIAS[p], CANTONES[`${p}-${c}`], DISTRITOS[`${p}-${c}-${d}`]].filter(Boolean).join(', ') || null;
}
/** Activity descriptions printed under the emisor (code → Hacienda's description). */
const ACTIVIDADES: Record<string, string> = {
  '551001': '5510.1 - Actividades de alojamiento para estancias cortas en hoteles y moteles',
};

export type PdfOptions = {
  status?: 'accepted' | 'rejected' | 'pending' | 'sent' | 'error' | string | null;
  environment?: string | null; activityLabel?: string | null; resolution?: string | null; qrUrl?: string | null; footerNote?: string | null;
};
const STATUS_BADGE: Record<string, [string, string]> = {
  accepted: ['ACEPTADO', '#22c55e'], rejected: ['RECHAZADO', '#ef4444'], error: ['CON ERROR', '#ef4444'], pending: ['PENDIENTE', '#f59e0b'], sent: ['EN PROCESO', '#0ea5e9'],
};

export async function renderPdf(p: ParsedDoc, o: PdfOptions = {}): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', bufferPages: true, margins: { top: 40, bottom: 40, left: 40, right: 40 }, info: { Title: `${p.title} ${p.consecutivo}`, Creator: APP_NAME } });
  const chunks: Buffer[] = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  const L = 40, R = doc.page.width - 40, W = R - L;
  const ink = '#0f172a', muted = '#64748b', line = '#e2e8f0', head = '#1e293b', soft = '#f1f5f9';
  const cur = p.moneda;

  // --- page frame like Cubo's: dark band on top, grey strip on the left
  doc.save().rect(0, 0, doc.page.width, 8).fill('#1e293b').rect(0, 8, 12, doc.page.height - 8).fill('#e5e7eb').restore();

  // --- header (right aligned)
  let y = 40;
  if (o.environment === 'sim') {
    doc.save().rect(L, y, 200, 18).fill('#fee2e2').fillColor('#991b1b').font('Helvetica-Bold').fontSize(8).text('SIMULACIÓN · NO ENVIADO A HACIENDA', L + 6, y + 5).restore();
  } else if (o.environment === 'stag') {
    doc.save().rect(L, y, 150, 18).fill('#fef3c7').fillColor('#92400e').font('Helvetica-Bold').fontSize(8).text('PRUEBAS · SIN VALIDEZ FISCAL', L + 6, y + 5).restore();
  }
  doc.fillColor(ink).font('Helvetica-Bold').fontSize(18).text(p.title, L, y, { width: W, align: 'right' });
  y = doc.y + 2;
  doc.font('Helvetica').fontSize(11).fillColor(ink).text(`N° ${p.consecutivo}`, L, y, { width: W, align: 'right' });
  doc.fontSize(6.5).fillColor(ink).text(`Clave: ${p.clave}`, L, doc.y + 1, { width: W, align: 'right' });
  doc.fontSize(9).text(fmtDate(p.fecha), L, doc.y + 1, { width: W, align: 'right' });
  y = doc.y + 8;
  const badge = o.status ? STATUS_BADGE[o.status] : null;
  if (badge) {
    const bw = doc.font('Helvetica-Bold').fontSize(8).widthOfString(badge[0]) + 22;
    doc.roundedRect(R - bw, y, bw, 16, 8).fill(badge[1]);
    doc.fillColor('#ffffff').text(badge[0], R - bw, y + 4.5, { width: bw, align: 'center' });
    y += 22;
  }
  y += 6;
  doc.moveTo(L, y).lineTo(R, y).strokeColor(line).lineWidth(0.8).stroke();
  y += 12;

  // --- emisor / receptor
  const colW = W / 2 - 10;
  const block = (x: number, title: string, party: any, isEmisor: boolean) => {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(ink).text(title, x, y, { width: colW });
    let yy = doc.y + 3;
    if (!party || !party.nombre) {
      doc.font('Helvetica-Bold').fontSize(10).text('—', x, yy);
      return doc.y;
    }
    doc.font('Helvetica-Bold').fontSize(10).text(party.nombre.toUpperCase(), x, yy, { width: colW });
    yy = doc.y + 2;
    doc.font('Helvetica').fontSize(8.5);
    if (party.comercial && party.comercial !== party.nombre) { doc.text(party.comercial, x, yy, { width: colW }); yy = doc.y + 1; }
    if (party.id) { doc.text(`${ID_LABEL[party.idType] || 'Identificación'}: ${party.id}`, x, yy, { width: colW }); yy = doc.y + 1; }
    if (isEmisor && (o.activityLabel || p.actividad)) { doc.fontSize(7.5).text(o.activityLabel || ACTIVIDADES[p.actividad || ''] || `Actividad económica: ${p.actividad}`, x, yy, { width: colW }); yy = doc.y + 1; doc.fontSize(8.5); }
    if (party.email) { doc.text(`Email: ${party.email}`, x, yy, { width: colW }); yy = doc.y + 1; }
    if (party.phone) { doc.text(`Tel: ${party.phone}`, x, yy, { width: colW }); yy = doc.y + 1; }
    if (party.address) { doc.fontSize(8).text(party.address.toUpperCase(), x, yy, { width: colW }); }
    return doc.y;
  };
  const yE = block(L, 'EMISOR', p.emisor, true);
  const yR = block(L + W / 2 + 10, 'RECEPTOR', p.receptor, false);
  y = Math.max(yE, yR) + 16;

  // --- condition bar
  const medios = (p.medios.length ? p.medios : p.medioLegacy).map((m) => MEDIO[m.code] || m.code);
  const parts: [string, string][] = [['Condición', CONDICION[p.condicion] || p.condicion || '—']];
  if (p.plazo) parts.push(['Plazo', `${p.plazo} días`]);
  parts.push(['Pago', [...new Set(medios)].join(', ') || '—'], ['Moneda', cur]);
  if (cur !== 'CRC') parts.push(['T/C', `CRC ${p.tipoCambio.toFixed(2)}`]);
  doc.roundedRect(L, y, W, 26, 6).fill(soft);
  let x = L + 14;
  for (const [k, v] of parts) {
    doc.font('Helvetica').fontSize(8).fillColor(ink).text(`${k}: `, x, y + 9, { continued: true }).font('Helvetica-Bold').text(v);
    x += doc.font('Helvetica').widthOfString(`${k}: `) + doc.font('Helvetica-Bold').widthOfString(v) + 26;
  }
  y += 40;

  // --- lines table
  const cols = [
    { k: '#', w: 34, a: 'left' }, { k: 'Descripción', w: W - 34 - 40 - 90 - 40 - 92, a: 'left' }, { k: 'Cant', w: 40, a: 'center' },
    { k: 'P. Unit', w: 90, a: 'right' }, { k: 'IVA', w: 40, a: 'center' }, { k: 'Total', w: 92, a: 'right' },
  ] as const;
  const tableHeader = () => {
    doc.rect(L, y, W, 24).fill(head);
    let cx = L;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
    for (const c of cols) { doc.text(c.k, cx + 8, y + 8, { width: c.w - 16, align: c.a as any }); cx += c.w; }
    y += 24;
  };
  const pageBreak = (need: number) => {
    if (y + need > doc.page.height - 120) { doc.addPage(); y = 40; return true; }
    return false;
  };
  tableHeader();
  p.lines.forEach((l, i) => {
    doc.font('Helvetica').fontSize(8.5);
    const desc = l.detalle + (l.descuento > 0 ? `\nDescuento: ${fmt(l.descuento, cur)}` : '');
    const h = Math.max(22, doc.heightOfString(desc, { width: cols[1].w - 16 }) + 12);
    if (pageBreak(h)) tableHeader();
    if (i % 2 === 0) doc.rect(L, y, W, h).fill('#f8fafc');
    const vals = [l.n, desc, fmtQty(l.cantidad), fmt(l.precio, cur), `${l.tarifa}%`, fmt(l.total, cur)];
    let cx = L;
    cols.forEach((c, j) => {
      doc.font(j === 0 || j === 5 ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(ink).text(String(vals[j]), cx + 8, y + 6, { width: c.w - 16, align: c.a as any });
      cx += c.w;
    });
    y += h;
    doc.moveTo(L, y).lineTo(R, y).strokeColor(line).lineWidth(0.5).stroke();
  });
  y += 14;

  // --- otros cargos
  if (p.otros.length) {
    pageBreak(30 + p.otros.length * 22);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(ink).text('Otros Cargos', L, y);
    y = doc.y + 6;
    doc.rect(L, y, W, 20).fill(soft);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(muted).text('#', L + 8, y + 6).text('Detalle', L + 40, y + 6).text('%', R - 190, y + 6, { width: 60, align: 'center' }).text('Monto', R - 110, y + 6, { width: 100, align: 'right' });
    y += 20;
    p.otros.forEach((c, i) => {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(ink).text(String(i + 1), L + 8, y + 6);
      doc.font('Helvetica').text(c.detalle || 'Otro cargo', L + 40, y + 6, { width: W - 250 });
      doc.text(c.pct ? `${Number(c.pct.toFixed(2))}%` : '—', R - 190, y + 6, { width: 60, align: 'center' });
      doc.font('Helvetica-Bold').text(fmt(c.monto, cur), R - 110, y + 6, { width: 100, align: 'right' });
      y += 22;
      doc.moveTo(L, y).lineTo(R, y).strokeColor(line).lineWidth(0.5).stroke();
    });
    y += 14;
  }

  // --- totals box (right)
  const rows: [string, number][] = [['Subtotal:', p.resumen.totalVenta]];
  if (p.resumen.descuentos) rows.push(['Descuento:', -p.resumen.descuentos]);
  rows.push(['Impuesto:', p.resumen.impuesto]);
  if (p.resumen.otros) rows.push(['Otros Cargos:', p.resumen.otros]);
  const words = amountInWords(p.resumen.total, cur);
  const boxH = 16 + rows.length * 17 + 30 + 22;
  pageBreak(boxH + 10);
  const bx = R - 230;
  doc.roundedRect(bx, y, 230, boxH, 8).lineWidth(0.8).strokeColor(line).fillAndStroke('#f8fafc', line);
  let by = y + 12;
  for (const [k, v] of rows) {
    doc.font('Helvetica').fontSize(8.5).fillColor(muted).text(k, bx + 16, by).text(fmt(v, cur), bx + 100, by, { width: 114, align: 'right' });
    by += 17;
  }
  doc.moveTo(bx + 16, by).lineTo(bx + 214, by).strokeColor('#cbd5e1').stroke();
  by += 7;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(ink).text('Total:', bx + 16, by).text(fmt(p.resumen.total, cur), bx + 90, by, { width: 124, align: 'right' });
  by += 20;
  doc.moveTo(bx + 16, by).lineTo(bx + 214, by).strokeColor(line).stroke();
  doc.font('Helvetica-Oblique').fontSize(7).fillColor(muted).text(words, bx + 16, by + 6, { width: 198 });
  y += boxH + 18;

  // --- references and notes
  if (p.referencias.length) {
    pageBreak(40 + p.referencias.length * 24);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(ink).text('Documento de referencia', L, y);
    y = doc.y + 4;
    for (const r of p.referencias) {
      doc.font('Helvetica').fontSize(8).fillColor(ink).text(`${REF_CODE[r.codigo] || r.codigo}: ${r.numero} (${fmtDate(r.fecha)})${r.razon ? ' — ' + r.razon : ''}`, L, y, { width: W });
      y = doc.y + 4;
    }
    y += 8;
  }
  const notes = [...p.notas, o.footerNote].filter(Boolean) as string[];
  if (notes.length) {
    doc.font('Helvetica').fontSize(8.5);
    const nh = doc.heightOfString(notes.join('\n'), { width: W - 40 }) + 36;
    pageBreak(nh);
    doc.roundedRect(L, y, W, nh, 8).lineWidth(0.8).strokeColor(line).stroke();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(ink).text('Notas', L + 20, y + 12);
    doc.font('Helvetica').fontSize(8.5).fillColor('#334155').text(notes.join('\n'), L + 20, y + 26, { width: W - 40 });
  }

  // --- footer (last page): legal text + QR
  doc.page.margins.bottom = 0;
  const fy = doc.page.height - 110;
  const legal = [o.resolution, `Generado por ${APP_NAME}`, 'Versión del Documento Electrónico: 4.4'].filter(Boolean).join('\n');
  doc.font('Helvetica').fontSize(6.5).fillColor('#94a3b8').text(legal, L + 120, fy + 30, { width: W - 240, align: 'center' });
  const qrData = o.qrUrl || p.clave;
  if (qrData) {
    const png = await QRCode.toBuffer(qrData, { margin: 0, width: 160 });
    doc.image(png, R - 70, fy + 8, { width: 70 });
    doc.fontSize(5.5).text('Consultar documento', R - 80, fy + 81, { width: 90, align: 'center' });
  }
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(6.5).fillColor('#94a3b8').text(`Página ${i + 1} de ${range.count}`, L, doc.page.height - 40, { lineBreak: false });
  }
  doc.end();
  return done;
}

/** Public link (no login) to a document's PDF — printed as the QR code and sent in e-mails. */
export function publicPdfUrl(id: string) {
  const base = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  return base ? `${base}/api/public/edoc/${id}/${receiptSig(id)}.pdf` : null;
}

/** PDF of one of our documents (e_documents row). */
export async function documentPdf(d: any): Promise<Buffer> {
  const { documentXml } = await import('./service.ts');
  const s = await db.one(`SELECT * FROM hacienda_settings WHERE business_id=$1`, [d.business_id]);
  const xml = await documentXml(d);
  return renderPdf(parseComprobante(xml), {
    status: d.status, environment: d.environment, resolution: resolutionText(s), qrUrl: publicPdfUrl(d.id),
    footerNote: d.replaced_by ? 'Documento sustituido por factura electrónica' : d.annulled_by ? 'Documento anulado mediante nota de crédito' : null,
  });
}

const STATUS_TEXT: Record<string, string> = { accepted: 'ACEPTADO POR HACIENDA', rejected: 'RECHAZADO', pending: 'PENDIENTE DE ENVÍO', signed: 'PENDIENTE DE ENVÍO', sent: 'EN PROCESO', processing: 'EN PROCESO' };

/** 80 mm / 58 mm thermal receipt of a comprobante (PDF to send to a receipt printer). */
export async function renderThermal(p: ParsedDoc, o: PdfOptions & { width: '80mm' | '58mm' }) {
  const W = o.width === '58mm' ? 164 : 226; // points (58 mm / 80 mm paper)
  const M = 8, CW = W - 2 * M;
  const fs = o.width === '58mm' ? 6.5 : 7.5;
  // measure height first with a scratch document
  const draw = async (doc: PDFKit.PDFDocument) => {
    const cur = p.moneda;
    const center = (t: string, size = fs, bold = false) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).text(t, M, doc.y, { width: CW, align: 'center' });
    const lr = (l: string, r: string, bold = false) => {
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs).text(l, M, y, { width: CW * 0.6 });
      const y2 = doc.y;
      doc.text(r, M, y, { width: CW, align: 'right' });
      doc.y = Math.max(y2, doc.y);
    };
    const hr = () => { doc.moveTo(M, doc.y + 2).lineTo(W - M, doc.y + 2).dash(1.5, { space: 1.5 }).strokeColor('#000').lineWidth(0.5).stroke().undash(); doc.y += 5; };
    doc.y = M;
    if (o.environment === 'stag') center('*** PRUEBAS - SIN VALIDEZ FISCAL ***', fs, true);
    if (o.environment === 'sim') center('*** SIMULACION - SIN VALIDEZ FISCAL ***', fs, true);
    center(p.emisor.comercial || p.emisor.nombre, fs + 2, true);
    if (p.emisor.comercial) center(p.emisor.nombre);
    center(`${ID_LABEL[p.emisor.idType] || 'Céd.'} ${p.emisor.id}`);
    if (p.emisor.phone) center(`Tel ${p.emisor.phone}`);
    if (p.emisor.address) center(p.emisor.address, fs - 0.5);
    hr();
    center(p.title.toUpperCase(), fs + 1, true);
    center(`N° ${p.consecutivo}`, fs, true);
    center(fmtDate(p.fecha));
    if (p.receptor?.nombre) { hr(); doc.font('Helvetica').fontSize(fs).text(`Cliente: ${p.receptor.nombre}`, M, doc.y, { width: CW }); if (p.receptor.id) doc.text(`${ID_LABEL[p.receptor.idType] || 'ID'}: ${p.receptor.id}`, M, doc.y, { width: CW }); }
    hr();
    for (const l of p.lines) {
      doc.font('Helvetica').fontSize(fs).text(`${fmtQty(l.cantidad)} x ${l.detalle}`, M, doc.y, { width: CW });
      lr(`   ${fmt(l.precio, cur)}${l.tarifa ? `  IVA ${l.tarifa}%` : '  Exento'}`, fmt(l.total, cur));
      if (l.descuento) lr('   Descuento', '-' + fmt(l.descuento, cur));
    }
    hr();
    lr('Subtotal', fmt(p.resumen.totalVenta, cur));
    if (p.resumen.descuentos) lr('Descuentos', '-' + fmt(p.resumen.descuentos, cur));
    lr('IVA', fmt(p.resumen.impuesto, cur));
    for (const c of p.otros) lr(c.detalle || 'Otro cargo', fmt(c.monto, cur));
    lr('TOTAL', fmt(p.resumen.total, cur), true);
    doc.font('Helvetica-Oblique').fontSize(fs - 1).text(amountInWords(p.resumen.total, cur), M, doc.y, { width: CW });
    const medios = (p.medios.length ? p.medios : p.medioLegacy).map((m) => MEDIO[m.code] || m.code);
    doc.font('Helvetica').fontSize(fs).text(`${CONDICION[p.condicion] || ''} · ${[...new Set(medios)].join(', ')}${cur !== 'CRC' ? ` · T/C ${p.tipoCambio.toFixed(2)}` : ''}`, M, doc.y, { width: CW });
    for (const r of p.referencias) doc.fontSize(fs - 1).text(`Ref. ${REF_CODE[r.codigo] || r.codigo}: ${r.numero}`, M, doc.y, { width: CW });
    for (const n of p.notas) doc.fontSize(fs - 1).text(n, M, doc.y, { width: CW });
    hr();
    center('Clave numérica', fs - 1, true);
    center(p.clave.replace(/(.{25})/, '$1 '), fs - 1.5);
    if (o.status && STATUS_TEXT[o.status]) center(STATUS_TEXT[o.status], fs, true);
    const qrData = o.qrUrl || p.clave;
    const png = await QRCode.toBuffer(qrData, { margin: 0, width: 200 });
    const qs = o.width === '58mm' ? 80 : 100;
    doc.image(png, (W - qs) / 2, doc.y + 4, { width: qs });
    doc.y += qs + 8;
    if (o.resolution) center(o.resolution, fs - 1.5);
    center('Versión del documento electrónico 4.4', fs - 1.5);
    return doc.y + M;
  };
  const probe = new PDFDocument({ size: [W, 5000], margin: 0, autoFirstPage: true });
  const height = await draw(probe);
  probe.end();
  const doc = new PDFDocument({ size: [W, Math.ceil(height)], margin: 0, info: { Title: `${p.title} ${p.consecutivo}`, Creator: APP_NAME } });
  const chunks: Buffer[] = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  await draw(doc);
  doc.end();
  return done;
}

export async function documentThermalPdf(d: any, width: '80mm' | '58mm') {
  const { documentXml } = await import('./service.ts');
  const s = await db.one(`SELECT * FROM hacienda_settings WHERE business_id=$1`, [d.business_id]);
  return renderThermal(parseComprobante(await documentXml(d)), { width, status: d.status, environment: d.environment, resolution: resolutionText(s), qrUrl: publicPdfUrl(d.id) });
}
