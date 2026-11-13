import nodemailer from 'nodemailer';
import { db, json, type Q } from '../db.ts';
import { bad, notify, receiptSig } from '../util.ts';
import { DOC_NAMES, ID_TYPES, clave, consecutivo, crDateTime, digits, idNumber, securityCode, validateId, type DocType } from './codes.ts';
import { buildXml, type BuildInput, type Receptor } from './xml.ts';
import { loadP12, signXml, type SigningCert } from './sign.ts';
import { decrypt, decryptBuf } from './secrets.ts';
import { clearToken, getStatus, getToken, sendDocument, type HaciendaEnv } from './client.ts';

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
  businessId: string; storeId: string; saleId: string; docType: DocType; issuedAt: Date; offline?: boolean;
  receptor?: Receptor | null; reference?: any; userId?: string | null;
};

/** Reserves the next consecutivo + clave for a document. Returns null when e-invoicing is not enabled. */
export async function issueDocument(q: Q, o: IssueOpts) {
  const s = await getSettings(q, o.businessId);
  if (!s?.enabled) return null;
  const store = await q.one(`SELECT id, hacienda_branch, created_at FROM stores WHERE id=$1`, [o.storeId]);
  let branch = store!.hacienda_branch;
  if (!branch) {
    // Sucursal numbers follow the order the stores were created in: 001, 002, …
    const n = await q.one(`SELECT count(*) AS n FROM stores WHERE business_id=$1 AND created_at <= $2`, [o.businessId, store!.created_at]);
    branch = String(n!.n).padStart(3, '0');
    await q.query(`UPDATE stores SET hacienda_branch=$2 WHERE id=$1`, [store!.id, branch]);
  }
  const terminal = '00001';
  const seq = await q.one(
    `INSERT INTO hacienda_sequences (business_id, environment, branch, terminal, doc_type, last) VALUES ($1,$2,$3,$4,$5,1)
     ON CONFLICT (business_id, environment, branch, terminal, doc_type) DO UPDATE SET last = hacienda_sequences.last + 1 RETURNING last`,
    [o.businessId, s.environment, branch, terminal, o.docType],
  );
  const cons = consecutivo(branch, terminal, o.docType, Number(seq!.last));
  const situacion = o.offline ? '3' : '1'; // 3 = issued without internet (offline POS sale synced later)
  const k = clave(o.issuedAt, s.id_number, cons, situacion, securityCode());
  return q.one(
    `INSERT INTO e_documents (business_id, store_id, sale_id, doc_type, environment, clave, consecutivo, situacion, issued_at, receptor, reference, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [o.businessId, o.storeId, o.saleId, o.docType, s.environment, k, cons, situacion, o.issuedAt, json(o.receptor ?? null), json(o.reference ?? null), o.userId ?? null],
  );
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

async function buildInput(d: any, s: any): Promise<BuildInput> {
  const biz = await db.one(`SELECT service_charge_pct FROM businesses WHERE id=$1`, [d.business_id]);
  const sale = await db.one(`SELECT * FROM sales WHERE id=$1`, [d.sale_id]);
  const items = await db.query(
    `SELECT si.*, p.cabys AS p_cabys, p.type AS p_type, c.cabys AS c_cabys, v.sku
       FROM sale_items si LEFT JOIN products p ON p.id=si.product_id LEFT JOIN categories c ON c.id=si.category_id LEFT JOIN variants v ON v.id=si.variant_id
      WHERE si.sale_id=$1 ORDER BY si.ctid`,
    [d.sale_id],
  );
  const pays = await db.query(`SELECT method_name, method_type, amount FROM sale_payments WHERE sale_id=$1`, [d.sale_id]);
  return {
    docType: d.doc_type, clave: d.clave, consecutivo: d.consecutivo, fecha: new Date(d.issued_at),
    providerId: s.provider_id || s.id_number, activityCode: s.activity_code,
    emisor: {
      nombre: s.legal_name, id_type: s.id_type, id_number: s.id_number, nombre_comercial: s.trade_name,
      provincia: s.provincia, canton: s.canton, distrito: s.distrito, barrio: s.barrio, otras_senas: s.otras_senas, phone: s.phone, email: s.email,
    },
    receptor: d.receptor,
    lines: items.map((it) => ({
      qty: Number(it.qty),
      name: [it.product_name, it.variant_name && `(${it.variant_name})`, ...(it.modifiers || []).map((m: any) => `+ ${m.name}`)].filter(Boolean).join(' '),
      cabys: it.p_cabys || it.c_cabys || s.default_cabys || '',
      unit: it.p_type === 'service' ? 'Sp' : 'Unid',
      code: it.sku,
      gross: Number(it.gross), discount: Number(it.discount), total: Number(it.total),
      taxes: (it.taxes || []).map((t: any) => ({ rate: Number(t.rate), inclusive: !!t.inclusive })),
    })),
    serviceCharge: Number(sale!.service_charge), servicePct: Number(biz!.service_charge_pct) || 10, tip: Number(sale!.tip),
    payments: pays.map((p) => ({ type: p.method_type, name: p.method_name, amount: Number(p.amount) })),
    references: d.reference ? [d.reference] : [],
  };
}

const certCache = new Map<string, SigningCert>();
async function signingCert(s: any) {
  const k = `${s.business_id}:${new Date(s.updated_at).getTime()}`;
  let c = certCache.get(k);
  if (!c) {
    c = await loadP12(decryptBuf(s.cert_p12_enc), decrypt(s.cert_pin_enc));
    certCache.clear();
    certCache.set(k, c);
  }
  return c;
}

/** Builds and signs the XML of a document (also used to preview / re-download). */
export async function renderSigned(d: any, s: any) {
  const { xml, total } = buildXml(await buildInput(d, s));
  return { xml: await signXml(xml, await signingCert(s)), total };
}

// ---------------------------------------------------------------------------------------------- Background queue

const RETRY_BASE_S = Number(process.env.HACIENDA_RETRY_BASE_S || 15);
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
  const retry = (message: string) => update(d.id, { attempts: d.attempts + 1, next_attempt_at: new Date(Date.now() + backoff(d.attempts) * 1000), message });
  const fail = async (status: 'error' | 'rejected', message: string, extra: Record<string, any> = {}) => {
    await update(d.id, { status, message, attempts: d.attempts + 1, ...extra });
    await notify(d.business_id, d.store_id, 'hacienda', `Hacienda: ${DOC_NAMES[d.doc_type as DocType]} ${d.consecutivo} ${status === 'rejected' ? 'rechazado' : 'con error'} — ${message.slice(0, 200)}`, { id: d.id });
  };

  const s = await getSettings(db, d.business_id);
  if (!s?.api_username || !s.api_password_enc || !s.cert_p12_enc) return retry('Faltan las credenciales de Hacienda (Configuración → Hacienda)');
  let token: string;
  try {
    token = await getToken(env, s.api_username, decrypt(s.api_password_enc));
  } catch (e: any) {
    return retry(e.message);
  }

  if (d.status === 'pending') {
    let xml = d.xml_signed;
    if (!xml) {
      try {
        const r = await renderSigned(d, s);
        xml = r.xml;
        await update(d.id, { xml_signed: xml, total: r.total });
      } catch (e: any) {
        return fail('error', e.message);
      }
    }
    const rc = d.receptor;
    const res = await sendDocument(env, token, {
      clave: d.clave,
      fecha: crDateTime(new Date(d.issued_at)),
      emisor: { tipoIdentificacion: s.id_type, numeroIdentificacion: idNumber(s.id_type, s.id_number) },
      ...(rc?.id_type && rc?.id_number && rc.id_type !== '05' && rc.id_type !== '06' ? { receptor: { tipoIdentificacion: rc.id_type, numeroIdentificacion: rc.id_number } } : {}),
      comprobanteXml: Buffer.from(xml, 'utf8').toString('base64'),
    });
    if (res.status === 201 || res.status === 202) return update(d.id, { status: 'sent', message: null, attempts: d.attempts + 1, next_attempt_at: new Date(Date.now() + Math.min(10, RETRY_BASE_S) * 1000) });
    if (res.status === 400 && /ya.{0,40}(recibid|registrad|existe)|duplicad/i.test(res.cause || '')) return update(d.id, { status: 'sent', next_attempt_at: new Date() });
    if (res.status === 401 || res.status === 403) {
      clearToken(env, s.api_username);
      return retry('Sesión con Hacienda vencida; reintentando');
    }
    if (res.status === 400) return fail('error', `Hacienda no aceptó el envío: ${res.cause || 'sin detalle'}`);
    return retry(`Hacienda respondió ${res.status}${res.cause ? ': ' + res.cause : ''}`);
  }

  // status = sent → ask Hacienda for the result
  const st = await getStatus(env, token, d.clave);
  if (st.http === 401 || st.http === 403) {
    clearToken(env, s.api_username);
    return retry('Sesión con Hacienda vencida; reintentando');
  }
  if (st.state === 'aceptado') {
    await update(d.id, { status: 'accepted', response_xml: st.responseXml, message: null, attempts: d.attempts + 1 });
    if (d.receptor?.email) await emailDocument(d.id).catch((e) => update(d.id, { email_error: String(e.message || e) }));
    return;
  }
  if (st.state === 'rechazado') return fail('rejected', detalle(st.responseXml) || 'Rechazado por Hacienda', { response_xml: st.responseXml });
  if (st.state === 'error') return fail('error', detalle(st.responseXml) || st.cause || 'Error de Hacienda', { response_xml: st.responseXml });
  return retry(st.http === 404 ? 'Hacienda todavía no registra el comprobante' : 'Hacienda está procesando el comprobante');
}

let running = false;
export async function processQueue() {
  if (running) return;
  running = true;
  try {
    const docs = await db.query(
      `SELECT * FROM e_documents WHERE status IN ('pending','sent') AND next_attempt_at <= now() ORDER BY created_at LIMIT 25`,
    );
    for (const d of docs) await processDoc(d).catch((e) => console.error('[hacienda]', d.clave, e));
  } finally {
    running = false;
  }
}
export const kickQueue = () => setTimeout(() => processQueue().catch(console.error), 300);
export function startHaciendaWorker() {
  setInterval(() => processQueue().catch(console.error), Number(process.env.HACIENDA_POLL_MS || 15000));
  setTimeout(() => processQueue().catch(console.error), 3000);
}

// ---------------------------------------------------------------------------------------------- E-mail to the customer

export const smtpConfigured = () => !!process.env.SMTP_HOST;

export async function emailDocument(id: string, to?: string) {
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
  const link = base ? `${base}/r/${d.sale_id}/${receiptSig(d.sale_id)}` : null;
  const name = DOC_NAMES[d.doc_type as DocType];
  await mailer.sendMail({
    from: process.env.SMTP_FROM || s?.email || process.env.SMTP_USER,
    to: email,
    subject: `${name} ${d.consecutivo} — ${s?.trade_name || s?.legal_name || ''}`,
    html:
      `<p>Estimado(a) ${escapeHtml(d.receptor?.nombre || 'cliente')}:</p>` +
      `<p>Adjuntamos su <b>${name}</b> N° <b>${d.consecutivo}</b> emitida por ${escapeHtml(s?.legal_name || '')} ` +
      `(${ID_TYPES[s?.id_type]?.label || 'Cédula'} ${escapeHtml(s?.id_number || '')}), por un total de ₡${Number(d.total || 0).toLocaleString('es-CR', { minimumFractionDigits: 2 })}.</p>` +
      `<p>Clave: <code>${d.clave}</code></p>` +
      (link ? `<p><a href="${link}">Ver comprobante en línea</a></p>` : '') +
      `<p>Se adjuntan el comprobante electrónico (XML) y la respuesta del Ministerio de Hacienda.</p>`,
    attachments: [
      { filename: `${d.clave}.xml`, content: d.xml_signed, contentType: 'application/xml' },
      ...(d.response_xml ? [{ filename: `${d.clave}_respuesta.xml`, content: d.response_xml, contentType: 'application/xml' }] : []),
    ],
  });
  await update(d.id, { emailed_at: new Date(), email_error: null });
}

const escapeHtml = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
