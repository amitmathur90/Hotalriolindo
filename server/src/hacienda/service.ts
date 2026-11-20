import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import { db, json, type Q } from '../db.ts';
import { bad, notify, receiptSig } from '../util.ts';
import { DOC_NAMES, ID_TYPES, RULES_VERSION, clave, consecutivo, crDateTime, digits, idNumber, securityCode, validateId, type DocType } from './codes.ts';
import { buildXml, type BuildInput, type Receptor } from './xml.ts';
import { loadP12, signXml, simulationCert, verifyXml, type SigningCert } from './sign.ts';
import { SCHEMA_VERSION, validateComprobante } from './xsd.ts';
import { unknownCodes } from './cabys.ts';
import { decrypt, decryptBuf } from './secrets.ts';
import { documentPdf } from './pdf.ts';
import { SIM_ENV, clearToken, getStatus, getToken, sendDocument, type HaciendaEnv } from './client.ts';

/**
 * Electronic documents lifecycle:
 *  1. issueDocument() runs inside the sale/refund transaction: it reserves the consecutivo and the clave, so the
 *     receipt can print them immediately (status "pending").
 *  2. The background queue builds + signs the XML, sends it to Hacienda ("sent") and polls until Hacienda answers
 *     "accepted" or "rejected". Network problems are retried with back-off; the POS never waits for Hacienda.
 *  3. Accepted facturas / notas de crédito with a receptor e-mail are e-mailed (XML + Hacienda's response).
 */

export const getSettings = (q: Q, businessId: string) => q.one(`SELECT * FROM hacienda_settings WHERE business_id=$1`, [businessId]);

/** Validates and normalises the receptor of a factura (customer's tax details). */
export function cleanReceptor(r: any, requireId = true): Receptor {
  const nombre = String(r?.nombre || r?.name || '').trim();
  if (nombre.length < 3) throw bad('Nombre del cliente requerido (mínimo 3 caracteres)');
  const id_type = String(r?.id_type || '').trim();
  const num = String(r?.id_number || r?.tax_id || '').trim();
  if (requireId || num) {
    const err = validateId(id_type, num);
    if (err) throw bad(err);
  }
  const email = String(r?.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Correo electrónico inválido');
  const activity = digits(r?.activity_code);
  return { nombre: nombre.slice(0, 100), id_type: num ? id_type : null, id_number: num ? idNumber(id_type, num) : null, email: email || null, activity_code: activity.length === 6 ? activity : null };
}

type IssueOpts = {
  businessId: string; storeId: string; saleId?: string | null; docType: DocType; issuedAt: Date; offline?: boolean;
  receptor?: Receptor | null; reference?: any; userId?: string | null;
  /** Documents without a POS sale (manual invoice, Cloudbeds check-out) carry their own lines. */
  source?: 'pos' | 'manual' | 'cloudbeds'; payload?: DocPayload | null; currency?: 'CRC' | 'USD'; exchangeRate?: number; externalRef?: string | null; notes?: string | null;
  /** Same key → same document (a repeated request never creates a second clave). */
  idempotencyKey?: string | null; userName?: string | null;
};

/** Lines of a document that is not a POS sale. Prices exclude IVA and are in the document currency. */
export type DocPayload = {
  lines: { qty: number; name: string; cabys: string; unit?: string; code?: string | null; price: number; discount?: number; tax_rate: number }[];
  payments?: { type: string; name?: string; amount: number }[];
  condition?: string; credit_days?: number | null; service_charge?: number; service_pct?: number; tip?: number;
};

/** Reserves the next consecutivo + clave for a document. Returns null when e-invoicing is not enabled. */
export async function issueDocument(q: Q, o: IssueOpts) {
  const s = await getSettings(q, o.businessId);
  if (!s?.enabled) return null;
  if (o.idempotencyKey) {
    const prev = await q.one(`SELECT * FROM e_documents WHERE business_id=$1 AND idempotency_key=$2`, [o.businessId, o.idempotencyKey]);
    if (prev) return prev;
  }
  const store = await q.one(`SELECT id, hacienda_branch, created_at FROM stores WHERE id=$1`, [o.storeId]);
  let branch = store!.hacienda_branch;
  if (!branch) {
    // Sucursal numbers follow the order the stores were created in: 001, 002, …
    const n = await q.one(`SELECT count(*) AS n FROM stores WHERE business_id=$1 AND created_at <= $2`, [o.businessId, store!.created_at]);
    branch = String(n!.n).padStart(3, '0');
    await q.query(`UPDATE stores SET hacienda_branch=$2 WHERE id=$1`, [store!.id, branch]);
  }
  // Terminal: the POS device that made the sale (if it has its own number), otherwise the company default
  const dev = o.saleId ? await q.one(`SELECT d.hacienda_terminal FROM sales s JOIN pos_devices d ON d.id=s.device_id WHERE s.id=$1`, [o.saleId]) : null;
  const terminal = String(dev?.hacienda_terminal || s.terminal || '00001').replace(/\D/g, '').padStart(5, '0').slice(-5);
  const seq = await q.one(
    `INSERT INTO hacienda_sequences (business_id, environment, branch, terminal, doc_type, last) VALUES ($1,$2,$3,$4,$5,1)
     ON CONFLICT (business_id, environment, branch, terminal, doc_type) DO UPDATE SET last = hacienda_sequences.last + 1 RETURNING last`,
    [o.businessId, s.environment, branch, terminal, o.docType],
  );
  const cons = consecutivo(branch, terminal, o.docType, Number(seq!.last));
  const situacion = o.offline ? '3' : '1'; // 3 = issued without internet (offline POS sale synced later)
  const k = clave(o.issuedAt, s.id_number, cons, situacion, securityCode());
  const doc = await q.one(
    `INSERT INTO e_documents (business_id, store_id, sale_id, doc_type, environment, clave, consecutivo, situacion, issued_at, receptor, reference, created_by,
       source, payload, currency, exchange_rate, external_ref, notes, terminal, idempotency_key, rules_version, schema_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
    [o.businessId, o.storeId, o.saleId ?? null, o.docType, s.environment, k, cons, situacion, o.issuedAt, json(o.receptor ?? null), json(o.reference ?? null), o.userId ?? null,
     o.source || 'pos', json(o.payload ?? null), o.currency || 'CRC', o.currency === 'USD' ? Number(o.exchangeRate) || 1 : 1, o.externalRef ?? null, o.notes ?? null,
     terminal, o.idempotencyKey ?? null, RULES_VERSION, SCHEMA_VERSION],
  );
  await q.query(
    `INSERT INTO e_document_events (document_id, business_id, kind, status, message, detail, created_by, created_by_name) VALUES ($1,$2,'created','pending',$3,$4,$5,$6)`,
    [doc!.id, o.businessId, `${DOC_NAMES[o.docType]} ${cons} reservado (situación ${situacion})`, json({ clave: k, branch, terminal, source: o.source || 'pos', reference: o.reference?.clave || null }), o.userId ?? null, o.userName ?? null],
  );
  return doc;
}

/** The tiquete/factura currently representing a sale (a tiquete replaced by a factura is no longer active). */
export const activeDocument = (q: Q, saleId: string) =>
  q.one(`SELECT * FROM e_documents WHERE sale_id=$1 AND doc_type IN ('01','04') AND replaced_by IS NULL AND status <> 'rejected' ORDER BY created_at DESC LIMIT 1`, [saleId]);

/** Nota de crédito for a refund, referencing the original sale's tiquete/factura. */
export async function issueRefundNote(q: Q, o: { businessId: string; storeId: string; refundSaleId: string; originalSaleId: string; full: boolean; reason: string; userId?: string | null }) {
  const orig = await activeDocument(q, o.originalSaleId);
  if (!orig) return null; // sale was made before e-invoicing was enabled
  return issueDocument(q, {
    businessId: o.businessId, storeId: o.storeId, saleId: o.refundSaleId, docType: '03', issuedAt: new Date(), userId: o.userId,
    receptor: orig.receptor,
    reference: { doc_id: orig.id, doc_type: orig.doc_type, clave: orig.clave, issued_at: orig.issued_at, code: o.full ? '01' : '06', reason: `Devolución: ${o.reason}` },
  });
}

/**
 * Factura on demand for a sale that already has a tiquete: the tiquete is annulled with a nota de crédito and a
 * factura with the customer's tax details is issued in its place.
 */
export async function convertToFactura(q: Q, o: { businessId: string; saleId: string; receptor: Receptor; userId?: string | null }) {
  const s = await getSettings(q, o.businessId);
  if (!s?.enabled) throw bad('La facturación electrónica no está activada (Configuración → Hacienda)');
  const sale = await q.one(`SELECT * FROM sales WHERE id=$1 AND business_id=$2 AND type='sale' FOR UPDATE`, [o.saleId, o.businessId]);
  if (!sale) throw bad('Venta no encontrada');
  if (sale.status !== 'completed') throw bad('No se puede emitir factura de una venta con devoluciones');
  const current = await activeDocument(q, sale.id);
  if (current?.doc_type === '01') throw bad('Esta venta ya tiene factura electrónica');
  const now = new Date();
  let nc: any = null;
  if (current) {
    nc = await issueDocument(q, {
      businessId: o.businessId, storeId: sale.store_id, saleId: sale.id, docType: '03', issuedAt: now, userId: o.userId,
      reference: { doc_id: current.id, doc_type: '04', clave: current.clave, issued_at: current.issued_at, code: '01', reason: 'Anula tiquete electrónico: se sustituye por factura electrónica a solicitud del cliente' },
    });
  }
  const fe = await issueDocument(q, {
    businessId: o.businessId, storeId: sale.store_id, saleId: sale.id, docType: '01', issuedAt: new Date(now.getTime() + 1000), userId: o.userId, receptor: o.receptor,
    reference: current ? { doc_id: current.id, doc_type: '04', clave: current.clave, issued_at: current.issued_at, code: '04', reason: 'Sustituye tiquete electrónico' } : null,
  });
  if (current) await q.query(`UPDATE e_documents SET replaced_by=$2, updated_at=now() WHERE id=$1`, [current.id, fe!.id]);
  return { factura: fe, nota: nc };
}

// ---------------------------------------------------------------------------------------------- XML for a document

function emisorOf(s: any) {
  return {
    nombre: s.legal_name, id_type: s.id_type, id_number: s.id_number, nombre_comercial: s.trade_name,
    provincia: s.provincia, canton: s.canton, distrito: s.distrito, barrio: s.barrio, otras_senas: s.otras_senas, phone: s.phone, email: s.email,
    registro_fiscal_8707: s.registro_fiscal_8707,
  };
}

/** Comprobante data for a manual / Cloudbeds document (lines stored on the document itself). */
function payloadInput(d: any, s: any): BuildInput {
  const p: DocPayload = d.payload;
  return {
    docType: d.doc_type, clave: d.clave, consecutivo: d.consecutivo, fecha: new Date(d.issued_at),
    providerId: s.provider_id || s.id_number, activityCode: s.activity_code, emisor: emisorOf(s), receptor: d.receptor,
    lines: p.lines.map((l) => {
      const gross = Number(l.price) * Number(l.qty);
      const discount = Math.min(gross, Number(l.discount) || 0);
      return { qty: Number(l.qty), name: l.name, cabys: l.cabys || s.default_cabys || '', unit: l.unit || 'Unid', code: l.code || null, gross, discount, total: gross - discount, taxes: [{ rate: Number(l.tax_rate) || 0, inclusive: false }] };
    }),
    serviceCharge: Number(p.service_charge) || 0, servicePct: Number(p.service_pct) || 10, tip: Number(p.tip) || 0,
    payments: (p.payments || []).map((x) => ({ type: x.type, name: x.name || x.type, amount: Number(x.amount) })),
    references: d.reference ? [d.reference] : [],
    currency: d.currency, exchangeRate: Number(d.exchange_rate), condition: p.condition || '01', creditDays: p.credit_days ?? null, notes: d.notes,
  };
}

async function buildInput(d: any, s: any): Promise<BuildInput> {
  if (d.payload?.lines) return payloadInput(d, s);
  const biz = await db.one(`SELECT service_charge_pct FROM businesses WHERE id=$1`, [d.business_id]);
  const sale = await db.one(`SELECT * FROM sales WHERE id=$1`, [d.sale_id]);
  const items = await db.query(
    `SELECT si.*, p.cabys AS p_cabys, p.type AS p_type, p.hacienda_unit AS p_unit, c.cabys AS c_cabys, v.sku
       FROM sale_items si LEFT JOIN products p ON p.id=si.product_id LEFT JOIN categories c ON c.id=si.category_id LEFT JOIN variants v ON v.id=si.variant_id
      WHERE si.sale_id=$1 ORDER BY si.ctid`,
    [d.sale_id],
  );
  const pays = await db.query(`SELECT method_name, method_type, amount FROM sale_payments WHERE sale_id=$1`, [d.sale_id]);
  return {
    docType: d.doc_type, clave: d.clave, consecutivo: d.consecutivo, fecha: new Date(d.issued_at),
    providerId: s.provider_id || s.id_number, activityCode: s.activity_code,
    emisor: emisorOf(s),
    receptor: d.receptor,
    lines: items.map((it) => ({
      qty: Number(it.qty),
      name: [it.product_name, it.variant_name && `(${it.variant_name})`, ...(it.modifiers || []).map((m: any) => `+ ${m.name}`)].filter(Boolean).join(' '),
      cabys: it.p_cabys || it.c_cabys || s.default_cabys || '',
      unit: it.p_unit || (it.p_type === 'service' ? 'Sp' : 'Unid'),
      code: it.sku,
      gross: Number(it.gross), discount: Number(it.discount), total: Number(it.total),
      taxes: (it.taxes || []).map((t: any) => ({ rate: Number(t.rate), inclusive: !!t.inclusive })),
    })),
    serviceCharge: Number(sale!.service_charge), servicePct: Number(biz!.service_charge_pct) || 10, tip: Number(sale!.tip),
    payments: pays.map((p) => ({ type: p.method_type, name: p.method_name, amount: Number(p.amount) })),
    references: d.reference ? [d.reference] : [],
    notes: d.notes || (sale!.receipt_no ? `POS #${sale!.receipt_no}` : null),
  };
}

/** Comprobante XML for display (PDF): the signed one when available, otherwise built on the fly (unsigned). */
export async function documentXml(d: any) {
  if (d.xml_signed) return d.xml_signed as string;
  if (d.xml_unsigned) return d.xml_unsigned as string;
  const s = await getSettings(db, d.business_id);
  return buildXml(await buildInput(d, await withBranch(d, s))).xml;
}

/**
 * Anula a manual / Cloudbeds document with a full nota de crédito (POS sales are annulled with a refund in Receipts,
 * which also returns the stock).
 */
export async function annulDocument(q: Q, o: { businessId: string; docId: string; reason: string; userId?: string | null }) {
  const d = await q.one(`SELECT * FROM e_documents WHERE id=$1 AND business_id=$2 FOR UPDATE`, [o.docId, o.businessId]);
  if (!d) throw bad('Documento no encontrado');
  if (d.doc_type === '03') throw bad('Una nota de crédito no se anula');
  if (d.annulled_by) throw bad('El documento ya fue anulado');
  if (d.replaced_by) throw bad('El documento fue sustituido por otro');
  if (d.status === 'rejected') throw bad('Hacienda rechazó este documento: no requiere anulación');
  if (!d.payload) throw bad('Las ventas del POS se anulan con una devolución (Recibos → Reembolsar), que también devuelve el inventario');
  const nc = await issueDocument(q, {
    businessId: o.businessId, storeId: d.store_id, saleId: d.sale_id, docType: '03', issuedAt: new Date(), userId: o.userId,
    receptor: d.receptor, source: d.source, payload: d.payload, currency: d.currency, exchangeRate: Number(d.exchange_rate), externalRef: d.external_ref,
    notes: `Anula ${DOC_NAMES[d.doc_type as DocType]} ${d.consecutivo}`,
    reference: { doc_id: d.id, doc_type: d.doc_type, clave: d.clave, issued_at: d.issued_at, code: '01', reason: o.reason || 'Anulación del comprobante' },
  });
  if (!nc) throw bad('La facturación electrónica no está activada');
  await q.query(`UPDATE e_documents SET annulled_by=$2, updated_at=now() WHERE id=$1`, [d.id, nc.id]);
  return nc;
}

const TAX_RATES = [0, 0.5, 1, 2, 4, 8, 13];
/** Validates manual document lines (prices without IVA, in the document currency). */
export function cleanLines(raw: any[], s: any): DocPayload['lines'] {
  if (!Array.isArray(raw) || !raw.length) throw bad('Agregue al menos una línea');
  if (raw.length > 1000) throw bad('Máximo 1000 líneas');
  return raw.map((l, i) => {
    const n = i + 1;
    const qty = Number(l.qty), price = Number(l.price), discount = Number(l.discount) || 0, tax_rate = Number(l.tax_rate ?? 13);
    const name = String(l.name || '').trim();
    const cabys = digits(l.cabys) || digits(s?.default_cabys);
    if (name.length < 3) throw bad(`Línea ${n}: descripción requerida`);
    if (!(qty > 0)) throw bad(`Línea ${n}: cantidad inválida`);
    if (!(price >= 0) || l.price === '' || l.price == null) throw bad(`Línea ${n}: precio inválido`);
    if (discount < 0 || discount > qty * price) throw bad(`Línea ${n}: descuento inválido`);
    if (!TAX_RATES.includes(tax_rate)) throw bad(`Línea ${n}: tarifa de IVA inválida`);
    if (!/^\d{13}$/.test(cabys)) throw bad(`Línea ${n}: código CABYS requerido (13 dígitos)`);
    return { qty, price, discount, tax_rate, name: name.slice(0, 200), cabys, unit: String(l.unit || 'Unid').slice(0, 10), code: l.code ? String(l.code).slice(0, 20) : null };
  });
}
export const payloadTotal = (p: DocPayload) =>
  Math.round(p.lines.reduce((s, l) => { const sub = Math.max(0, l.qty * l.price - (l.discount || 0)); return s + sub * (1 + l.tax_rate / 100); }, 0) * 100) / 100
  + (Number(p.service_charge) || 0) + (Number(p.tip) || 0);

/**
 * Nota de crédito (03) or nota de débito (02) referencing an existing factura / tiquete (PRD §5.5).
 * Without lines a credit note annuls the whole document (code 01). The original is never modified, only linked.
 */
export async function createAdjustmentNote(q: Q, o: { businessId: string; docId: string; type: '02' | '03'; reason: string; lines?: any[] | null; code?: string | null; userId?: string | null; userName?: string | null }) {
  const s = await getSettings(q, o.businessId);
  if (!s?.enabled) throw bad('La facturación electrónica no está activada');
  const d = await q.one(`SELECT * FROM e_documents WHERE id=$1 AND business_id=$2 FOR UPDATE`, [o.docId, o.businessId]);
  if (!d) throw bad('Documento no encontrado');
  if (!['01', '04', '02'].includes(d.doc_type)) throw bad('Solo se pueden ajustar facturas, tiquetes o notas de débito');
  if (d.status === 'rejected' || d.status === 'validation_failed') throw bad('El documento original no fue aceptado por Hacienda: corríjalo o reemítalo en lugar de ajustarlo');
  if (d.annulled_by) throw bad('El documento ya fue anulado');
  if (d.replaced_by) throw bad('El documento fue sustituido por otro');
  const reason = String(o.reason || '').trim();
  if (reason.length < 5) throw bad('Indique el motivo (mínimo 5 caracteres)');
  const full = o.type === '03' && !(o.lines && o.lines.length);
  if (full && !d.payload) throw bad('Las ventas del POS se anulan con una devolución (Recibos → Reembolsar), que también devuelve el inventario. Para un ajuste parcial indique las líneas.');
  if (o.type === '02' && !(o.lines && o.lines.length)) throw bad('La nota de débito necesita las líneas del cargo adicional');
  const lines = full ? d.payload.lines : cleanLines(o.lines!, s);
  const payload: DocPayload = full ? d.payload : { lines, payments: d.payload?.payments || [{ type: 'cash', amount: 1 }], condition: d.payload?.condition || '01', credit_days: d.payload?.credit_days ?? null };
  if (o.type === '03' && !full) {
    const prev = await q.query(`SELECT payload FROM e_documents WHERE business_id=$1 AND doc_type='03' AND status <> 'rejected' AND reference->>'doc_id'=$2`, [o.businessId, d.id]);
    const credited = prev.reduce((t, n) => t + (n.payload?.lines ? payloadTotal(n.payload) : 0), 0);
    const original = Number(d.total) || (d.payload ? payloadTotal(d.payload) : 0);
    if (original && credited + payloadTotal(payload) > original + 0.01) throw bad(`El total de las notas de crédito superaría el del documento original (${original})`);
  }
  const code = full ? '01' : o.code && /^(0[1-9]|1[0-2]|99)$/.test(o.code) && o.code !== '99' ? o.code : '04';
  const note = await issueDocument(q, {
    businessId: o.businessId, storeId: d.store_id, saleId: null, docType: o.type, issuedAt: new Date(), userId: o.userId, userName: o.userName,
    receptor: d.receptor, source: d.source === 'pos' ? 'manual' : d.source, payload, currency: d.currency, exchangeRate: Number(d.exchange_rate), externalRef: d.external_ref,
    notes: `${o.type === '03' ? (full ? 'Anula' : 'Ajusta') : 'Cargo adicional a'} ${DOC_NAMES[d.doc_type as DocType]} ${d.consecutivo}`,
    reference: { doc_id: d.id, doc_type: d.doc_type, clave: d.clave, issued_at: d.issued_at, code, reason: reason.slice(0, 180) },
  });
  if (!note) throw bad('La facturación electrónica no está activada');
  if (full) await q.query(`UPDATE e_documents SET annulled_by=$2, updated_at=now() WHERE id=$1`, [d.id, note.id]);
  await q.query(`INSERT INTO e_document_events (document_id, business_id, kind, status, message, created_by, created_by_name) VALUES ($1,$2,'note',$3,$4,$5,$6)`,
    [d.id, o.businessId, d.status, `${DOC_NAMES[o.type]} ${note.consecutivo} emitida: ${reason}`, o.userId ?? null, o.userName ?? null]);
  return note;
}

const certCache = new Map<string, SigningCert>();
async function signingCert(s: any) {
  if (!s?.cert_p12_enc && s?.environment === SIM_ENV) return simulationCert();
  const k = `${s.business_id}:${new Date(s.updated_at).getTime()}`;
  let c = certCache.get(k);
  if (!c) {
    c = await loadP12(decryptBuf(s.cert_p12_enc), decrypt(s.cert_pin_enc));
    certCache.clear();
    certCache.set(k, c);
  }
  return c;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Branch-specific economic activity (e.g. restaurant vs. hotel) overrides the company's main activity. */
async function withBranch(d: any, s: any) {
  const st = await db.one(`SELECT hacienda_activity FROM stores WHERE id=$1`, [d.store_id]);
  return st?.hacienda_activity && digits(st.hacienda_activity).length === 6 ? { ...s, activity_code: st.hacienda_activity } : s;
}

/** Generates the unsigned comprobante XML and validates it against the official XSD. */
export async function renderUnsigned(d: any, s: any) {
  const input = await buildInput(d, await withBranch(d, s));
  // CABYS codes must exist in the official catalogue (when one has been imported)
  const missing = await unknownCodes(input.lines.map((l) => digits(l.cabys)).filter((c) => c.length === 13));
  if (missing.length) throw new Error(`Código(s) CABYS que no existen o no están vigentes en el catálogo oficial: ${missing.join(', ')}`);
  const { xml, total } = buildXml(input);
  const v = await validateComprobante(xml);
  return { xml, total, validation: v };
}

/** Builds and signs the XML of a document (also used to preview / re-download). */
export async function renderSigned(d: any, s: any) {
  const { xml, total, validation } = await renderUnsigned(d, s);
  if (!validation.valid) throw new Error('XML inválido según el esquema oficial: ' + validation.errors.slice(0, 3).join(' · '));
  return { xml: await signXml(xml, await signingCert(s)), total };
}

// ---------------------------------------------------------------------------------------------- Lifecycle events

export async function logEvent(d: { id?: any; business_id?: any } | Record<string, any>, kind: string, f: { status?: string | null; http?: number | null; message?: string | null; detail?: any; userId?: string | null; userName?: string | null } = {}) {
  await db.query(
    `INSERT INTO e_document_events (document_id, business_id, kind, status, http_status, message, detail, created_by, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [d.id, d.business_id, kind, f.status ?? null, f.http ?? null, f.message ? String(f.message).slice(0, 2000) : null, json(f.detail ?? null), f.userId ?? null, f.userName ?? null],
  ).catch((e) => console.error('[hacienda] event', e.message));
}

// ---------------------------------------------------------------------------------------------- Background queue
/**
 * Status model (PRD §6.2):
 *   pending (queued) → validation_failed | signed → sent (submitted) → processing → accepted | rejected
 *   error (Hacienda refused the submission) · auth_error (credentials) · manual_review (cannot determine the outcome).
 * A successful HTTP 201/202 never means "accepted": only Hacienda's final answer does. A send that times out is marked
 * ambiguous and is reconciled with a status query before it is ever sent again (same clave, same signed XML).
 */
export const QUEUE_STATUSES = ['pending', 'signed', 'sent', 'processing', 'auth_error'];
const RETRY_BASE_S = Number(process.env.HACIENDA_RETRY_BASE_S || 15);
const MAX_RECONCILE = Number(process.env.HACIENDA_MAX_RECONCILE || 20);
const backoff = (attempts: number) => Math.min(3600, RETRY_BASE_S * 2 ** Math.min(attempts, 8)); // 15 s, 30 s, 1 min … 1 h
const detalle = (xml: string | null) => {
  const m = xml && /<DetalleMensaje>([\s\S]*?)<\/DetalleMensaje>/.exec(xml);
  return m ? m[1].replace(/&#13;|\r/g, '').trim().slice(0, 2000) : null;
};

async function update(id: string, f: Record<string, any>) {
  const keys = Object.keys(f);
  await db.query(`UPDATE e_documents SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [id, ...keys.map((k) => f[k])]);
}

async function processDoc(d: any) {
  const env = d.environment as HaciendaEnv;
  const later = (n = d.attempts) => new Date(Date.now() + backoff(n) * 1000);
  const retry = async (message: string, extra: Record<string, any> = {}) => {
    await update(d.id, { attempts: d.attempts + 1, next_attempt_at: later(), message, ...extra });
  };
  const final = async (status: string, message: string, extra: Record<string, any> = {}, notifyUser = true) => {
    await update(d.id, { status, message, attempts: d.attempts + 1, ...extra });
    await logEvent(d, status, { status, message, http: extra._http });
    if (notifyUser) {
      const word = status === 'rejected' ? 'rechazado' : status === 'validation_failed' ? 'no pasó la validación' : status === 'manual_review' ? 'requiere revisión' : 'con error';
      await notify(d.business_id, d.store_id, 'hacienda', `Hacienda: ${DOC_NAMES[d.doc_type as DocType]} ${d.consecutivo} ${word} — ${message.slice(0, 200)}`, { id: d.id });
    }
  };
  const s = await getSettings(db, d.business_id);

  // 1. Validate + sign (only once: the signed XML is an immutable snapshot)
  if (d.status === 'pending' && !d.xml_signed) {
    if (!s?.cert_p12_enc && env !== SIM_ENV) return retry('Falta la llave criptográfica (.p12) en Configuración → Hacienda');
    let r;
    try {
      r = await renderUnsigned(d, s);
    } catch (e: any) {
      return final('validation_failed', e.message);
    }
    if (!r.validation.valid) return final('validation_failed', 'XML inválido según el esquema oficial ' + r.validation.schema + ': ' + r.validation.errors.slice(0, 3).join(' · '), { xml_unsigned: r.xml, xml_hash: sha256(r.xml), total: r.total });
    await logEvent(d, 'validated', { status: 'pending', message: `XML válido (${r.validation.schema})`, detail: { hash: sha256(r.xml) } });
    let signed: string;
    try {
      const cert = env === SIM_ENV && !s?.cert_p12_enc ? await simulationCert() : await signingCert(s);
      if (cert.notAfter < new Date()) return final('validation_failed', `La llave criptográfica venció el ${cert.notAfter.toLocaleDateString('es-CR')}`);
      signed = await signXml(r.xml, cert);
      if (!(await verifyXml(signed))) throw new Error('La firma generada no es válida');
    } catch (e: any) {
      return final('validation_failed', `Error al firmar: ${e.message}`);
    }
    Object.assign(d, { xml_signed: signed, status: 'signed' });
    await update(d.id, {
      xml_unsigned: r.xml, xml_hash: sha256(r.xml), xml_signed: signed, signed_hash: sha256(signed), total: r.total, status: 'signed',
      schema_version: SCHEMA_VERSION, rules_version: RULES_VERSION, message: null,
    });
    await logEvent(d, 'signed', { status: 'signed', message: 'Firmado (XAdES-EPES) y verificado', detail: { hash: sha256(signed) } });
  }

  // Simulación: never contacts Hacienda; the decision is made locally
  if (env === SIM_ENV) return simulateDecision(d);

  // 2. Authenticate
  if (!s?.api_username || !s.api_password_enc) return retry('Faltan el usuario y la contraseña de la API de Hacienda');
  let token: string;
  try {
    token = await getToken(env, s.api_username, decrypt(s.api_password_enc));
  } catch (e: any) {
    const denied = /incorrect|invalid_grant|401/i.test(e.message);
    if (denied && d.status !== 'auth_error') {
      await update(d.id, { status: 'auth_error', message: e.message, attempts: d.attempts + 1, next_attempt_at: later(6) });
      await logEvent(d, 'auth_error', { status: 'auth_error', message: e.message });
      return;
    }
    return retry(e.message, denied ? { next_attempt_at: later(6) } : {});
  }
  if (d.status === 'auth_error') {
    const back = d.submitted_at ? 'sent' : d.xml_signed ? 'signed' : 'pending';
    await update(d.id, { status: back, message: null });
    d.status = back;
  }

  // 3. Submit
  if (d.status === 'signed' || (d.status === 'pending' && d.xml_signed)) {
    const rc = d.receptor;
    let res;
    try {
      res = await sendDocument(env, token, {
        clave: d.clave,
        fecha: crDateTime(new Date(d.issued_at)),
        emisor: { tipoIdentificacion: s.id_type, numeroIdentificacion: idNumber(s.id_type, s.id_number) },
        ...(rc?.id_type && rc?.id_number && rc.id_type !== '05' && rc.id_type !== '06' ? { receptor: { tipoIdentificacion: rc.id_type, numeroIdentificacion: rc.id_number } } : {}),
        comprobanteXml: Buffer.from(d.xml_signed, 'utf8').toString('base64'),
      });
    } catch (e: any) {
      // No answer: Hacienda may or may not have received it → reconcile with a status query before any resend
      await update(d.id, { status: 'sent', ambiguous: true, attempts: d.attempts + 1, next_attempt_at: later(1), message: `${e.message}; verificando si Hacienda lo recibió` });
      await logEvent(d, 'submit', { status: 'sent', message: `Sin respuesta: ${e.message} (se verificará antes de reenviar)` });
      return;
    }
    await logEvent(d, 'submit', { http: res.status, message: res.cause, status: res.status === 201 || res.status === 202 ? 'sent' : d.status });
    if (res.status === 201 || res.status === 202 || (res.status === 400 && /ya.{0,40}(recibid|registrad|existe)|duplicad/i.test(res.cause || ''))) {
      return update(d.id, { status: 'sent', ambiguous: false, submitted_at: d.submitted_at || new Date(), message: null, attempts: d.attempts + 1, next_attempt_at: new Date(Date.now() + Math.min(10, RETRY_BASE_S) * 1000) });
    }
    if (res.status === 401 || res.status === 403) {
      clearToken(env, s.api_username);
      return retry('Sesión con Hacienda vencida; reintentando');
    }
    if (res.status === 400) return final('error', `Hacienda no aceptó el envío: ${res.cause || 'sin detalle'}`, { _http: 400 } as any);
    return retry(`Hacienda respondió ${res.status}${res.cause ? ': ' + res.cause : ''}`);
  }

  // 4. Status (sent / processing) → final answer
  let st;
  try {
    st = await getStatus(env, token, d.clave);
  } catch (e: any) {
    return retry(e.message);
  }
  if (st.http === 401 || st.http === 403) {
    clearToken(env, s.api_username);
    return retry('Sesión con Hacienda vencida; reintentando');
  }
  if (st.state === 'aceptado') {
    await update(d.id, { status: 'accepted', response_xml: st.responseXml, message: null, attempts: d.attempts + 1, decided_at: new Date(), ambiguous: false, submitted_at: d.submitted_at || new Date() });
    await logEvent(d, 'accepted', { status: 'accepted', http: st.http, message: detalle(st.responseXml) || 'Aceptado' });
    if (d.receptor?.email && smtpConfigured()) await emailDocument(d.id).catch(() => {});
    return;
  }
  if (st.state === 'rechazado') return final('rejected', detalle(st.responseXml) || 'Rechazado por Hacienda', { response_xml: st.responseXml, decided_at: new Date(), ambiguous: false });
  if (st.state === 'error') return final('manual_review', detalle(st.responseXml) || st.cause || 'Hacienda respondió con error de procesamiento', { response_xml: st.responseXml });
  if (st.http === 404) {
    if (d.ambiguous) {
      // reconciled: Hacienda never got it → resend the same signed document (same clave)
      await update(d.id, { status: 'signed', ambiguous: false, next_attempt_at: new Date(), message: 'Hacienda no lo recibió; se reenviará' });
      await logEvent(d, 'reconcile', { status: 'signed', http: 404, message: 'Verificado: no recibido; se reenvía el mismo documento firmado' });
      return;
    }
    if (d.attempts >= MAX_RECONCILE) return final('manual_review', 'Hacienda no registra el comprobante después de varios intentos');
    return retry('Hacienda todavía no registra el comprobante');
  }
  if (d.ambiguous) {
    await update(d.id, { ambiguous: false, submitted_at: d.submitted_at || new Date() });
    await logEvent(d, 'reconcile', { status: 'processing', http: st.http, message: 'Verificado: Hacienda sí lo recibió' });
  }
  if (d.status !== 'processing') await update(d.id, { status: 'processing' });
  return retry('Hacienda está procesando el comprobante');
}

/** Local "answer" for Simulación documents. Receptor name RECHAZAR → rechazado (to try the rejection flow). */
async function simulateDecision(d: any) {
  if (!d.xml_signed) return;
  const reject = /RECHAZAR/i.test(d.receptor?.nombre || d.receptor?.name || '');
  const msg = reject ? 'SIMULACIÓN: rechazo de prueba (receptor RECHAZAR)' : 'SIMULACIÓN: aceptado localmente. Este documento NO fue enviado a Hacienda y no tiene validez fiscal.';
  const responseXml = `<?xml version="1.0" encoding="utf-8"?>
<MensajeHacienda simulacion="true"><Clave>${d.clave}</Clave><Mensaje>${reject ? 3 : 1}</Mensaje><DetalleMensaje>${msg}</DetalleMensaje></MensajeHacienda>`;
  const now = new Date();
  await update(d.id, { status: reject ? 'rejected' : 'accepted', response_xml: responseXml, message: reject ? msg : null, attempts: d.attempts + 1, submitted_at: d.submitted_at || now, decided_at: now, ambiguous: false });
  await logEvent(d, reject ? 'rejected' : 'accepted', { status: reject ? 'rejected' : 'accepted', message: msg });
}

let running = false;
export async function processQueue() {
  if (running) return;
  running = true;
  try {
    const docs = await db.query(
      `SELECT * FROM e_documents WHERE status = ANY($1::text[]) AND next_attempt_at <= now() ORDER BY created_at LIMIT 25`, [QUEUE_STATUSES],
    );
    for (const d of docs) {
      await processDoc(d).catch(async (e) => {
        console.error('[hacienda]', d.clave, e);
        await update(d.id, { attempts: d.attempts + 1, next_attempt_at: new Date(Date.now() + backoff(d.attempts) * 1000), message: String(e.message || e).slice(0, 500) }).catch(() => {});
      });
    }
  } finally {
    running = false;
  }
}
export const kickQueue = () => setTimeout(() => processQueue().catch(console.error), 300);

/** Alerts the administrators 30 days before the llave criptográfica expires (repeated weekly). */
export async function checkCertificates() {
  const rows = await db.query(
    `SELECT business_id, cert_expires_at FROM hacienda_settings WHERE cert_expires_at IS NOT NULL AND cert_expires_at < now() + interval '30 days'
       AND (cert_alert_sent_at IS NULL OR cert_alert_sent_at < now() - interval '7 days')`);
  for (const r of rows) {
    const days = Math.ceil((new Date(r.cert_expires_at).getTime() - Date.now()) / 86400000);
    await notify(r.business_id, null, 'hacienda', days > 0 ? `La llave criptográfica de Hacienda vence en ${days} día(s): descargue una nueva en ATV y cárguela en Configuración → Hacienda` : 'La llave criptográfica de Hacienda está vencida: no se pueden firmar comprobantes', {});
    await db.query(`UPDATE hacienda_settings SET cert_alert_sent_at=now() WHERE business_id=$1`, [r.business_id]);
  }
}

export function startHaciendaWorker() {
  setInterval(() => processQueue().catch(console.error), Number(process.env.HACIENDA_POLL_MS || 15000));
  setTimeout(() => processQueue().catch(console.error), 3000);
  setInterval(() => checkCertificates().catch(console.error), 6 * 3600 * 1000);
  setTimeout(() => checkCertificates().catch(console.error), 60000);
}

// ---------------------------------------------------------------------------------------------- E-mail to the customer

export const smtpConfigured = () => !!process.env.SMTP_HOST;

export async function emailDocument(id: string, to?: string, userId?: string | null) {
  const d = await db.one(`SELECT * FROM e_documents WHERE id=$1`, [id]);
  if (!d) throw bad('Documento no encontrado');
  const email = to || d.receptor?.email;
  if (!email) throw bad('El documento no tiene correo del receptor');
  if (!smtpConfigured()) throw bad('El envío de correos no está configurado (variables SMTP_HOST, SMTP_USER, SMTP_PASS)');
  if (!d.xml_signed) throw bad('El documento aún no ha sido generado');
  const s = await getSettings(db, d.business_id);
  const port = Number(process.env.SMTP_PORT || 587);
  const mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  const base = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  const link = base ? (d.sale_id ? `${base}/r/${d.sale_id}/${receiptSig(d.sale_id)}` : `${base}/api/public/edoc/${d.id}/${receiptSig(d.id)}.pdf`) : null;
  const name = DOC_NAMES[d.doc_type as DocType];
  const pdf = await documentPdf(d).catch((e) => { console.error('[hacienda] pdf', e); return null; });
  const cur = d.currency === 'USD' ? 'US$' : '₡';
  const files = [pdf && `${d.clave}.pdf`, `${d.clave}.xml`, d.response_xml && `${d.clave}_respuesta.xml`].filter(Boolean) as string[];
  const log = async (status: 'sent' | 'failed', error: string | null) => {
    await db.query(`INSERT INTO e_document_emails (document_id, business_id, recipient, status, error, attachments, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [d.id, d.business_id, email, status, error, files, userId ?? null]);
    await logEvent(d, 'email', { status: d.status, message: status === 'sent' ? `Correo enviado a ${email}` : `Correo a ${email} falló: ${error}`, userId });
  };
  try {
  await mailer.sendMail({
    from: process.env.SMTP_FROM || s?.email || process.env.SMTP_USER,
    to: email,
    subject: `${name} ${d.consecutivo} — ${s?.trade_name || s?.legal_name || ''}`,
    html:
      `<p>Estimado(a) ${escapeHtml(d.receptor?.nombre || 'cliente')}:</p>` +
      `<p>Adjuntamos su <b>${name}</b> N° <b>${d.consecutivo}</b> emitida por ${escapeHtml(s?.legal_name || '')} ` +
      `(${ID_TYPES[s?.id_type]?.label || 'Cédula'} ${escapeHtml(s?.id_number || '')}), por un total de ${cur}${Number(d.total || 0).toLocaleString('es-CR', { minimumFractionDigits: 2 })}.</p>` +
      `<p>Clave: <code>${d.clave}</code></p>` +
      (link ? `<p><a href="${link}">Ver comprobante en línea</a></p>` : '') +
      `<p>Se adjuntan el comprobante en PDF, el comprobante electrónico (XML) y la respuesta del Ministerio de Hacienda.</p>`,
    attachments: [
      ...(pdf ? [{ filename: `${d.clave}.pdf`, content: pdf, contentType: 'application/pdf' }] : []),
      { filename: `${d.clave}.xml`, content: d.xml_signed, contentType: 'application/xml' },
      ...(d.response_xml ? [{ filename: `${d.clave}_respuesta.xml`, content: d.response_xml, contentType: 'application/xml' }] : []),
    ],
  });
  } catch (e: any) {
    // e-mail problems never change the Hacienda status of the document
    await update(d.id, { email_error: String(e.message || e).slice(0, 500) });
    await log('failed', String(e.message || e).slice(0, 500));
    throw bad(`No se pudo enviar el correo: ${e.message || e}`);
  }
  await update(d.id, { emailed_at: new Date(), email_error: null });
  await log('sent', null);
}

const escapeHtml = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
