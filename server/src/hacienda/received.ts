import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { db, tx, type Q } from '../db.ts';
import { bad, notify } from '../util.ts';
import { consecutivo, crDateTime, digits, idNumber } from './codes.ts';
import { parseComprobante } from './pdf.ts';
import { decrypt, decryptBuf } from './secrets.ts';
import { loadP12, signXml, simulationCert } from './sign.ts';
import { SIM_ENV, clearToken, getStatus, getToken, sendDocument, type HaciendaEnv } from './client.ts';
import { getSettings } from './service.ts';

/**
 * Documentos recibidos: supplier facturas / notas sent to the hotel. They arrive by XML upload or by e-mail (IMAP inbox),
 * and the hotel answers each one to Hacienda with a signed "Mensaje Receptor":
 *   05 aceptado · 06 aceptado parcialmente · 07 rechazado.
 * Accepted documents become expenses (and QuickBooks bills when connected).
 */
const MR_NS = 'https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/mensajeReceptor';
export const DECISIONS: Record<string, { label: string; mensaje: string }> = {
  '05': { label: 'Aceptado', mensaje: '1' },
  '06': { label: 'Aceptado parcialmente', mensaje: '2' },
  '07': { label: 'Rechazado', mensaje: '3' },
};
const ACCEPTED_ROOTS: Record<string, string> = { FacturaElectronica: '01', NotaDebitoElectronica: '02', NotaCreditoElectronica: '03' };

/** Stores a supplier comprobante. Returns { doc, created } — duplicates (same clave) are ignored. */
export async function importReceivedXml(businessId: string, xml: string, source: 'upload' | 'email' = 'upload') {
  xml = xml.replace(/^﻿/, '').trim();
  if (/<MensajeHacienda[\s>]/.test(xml) || /<MensajeReceptor[\s>]/.test(xml)) throw bad('Este XML es una respuesta de Hacienda, no un comprobante');
  let p;
  try {
    p = parseComprobante(xml);
  } catch {
    throw bad('El archivo no es un XML válido');
  }
  const docType = ACCEPTED_ROOTS[p.kind];
  if (!docType) throw bad(p.kind === 'TiqueteElectronico' ? 'Los tiquetes electrónicos no se aceptan como gasto (no tienen receptor): pida una factura electrónica' : `Tipo de documento no soportado: ${p.kind}`);
  if (!/^\d{50}$/.test(p.clave)) throw bad('El comprobante no tiene una clave válida');
  const s = await getSettings(db, businessId);
  const ours = digits(s?.id_number);
  const theirs = digits(p.receptor?.id);
  if (ours && theirs && ours !== theirs) throw bad(`El comprobante fue emitido a otra identificación (${p.receptor?.id}), no a ${s!.id_number}`);
  const existing = await db.one(`SELECT * FROM received_documents WHERE business_id=$1 AND clave=$2`, [businessId, p.clave]);
  if (existing) return { doc: existing, created: false };
  const doc = await db.one(
    `INSERT INTO received_documents (business_id, clave, doc_type, consecutivo, issued_at, emisor_name, emisor_id_type, emisor_id, emisor_email, receptor_id,
       currency, exchange_rate, total, total_tax, activity_code, xml, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [businessId, p.clave, docType, p.consecutivo, p.fecha ? new Date(p.fecha) : null, p.emisor?.nombre, p.emisor?.idType, p.emisor?.id, p.emisor?.email || null,
      p.receptor?.id || null, p.moneda, p.tipoCambio, p.resumen.total, p.resumen.impuesto, p.actividad || null, xml, source],
  );
  if (s?.auto_accept) {
    await decideReceived(businessId, doc!.id, { decision: '05', category: s.expense_category || 'Compras', userId: null }).catch((e) =>
      db.query(`UPDATE received_documents SET mr_message=$2 WHERE id=$1`, [doc!.id, String(e.message)]));
  }
  return { doc: (await db.one(`SELECT * FROM received_documents WHERE id=$1`, [doc!.id]))!, created: true };
}

async function supplierFor(q: Q, businessId: string, r: any) {
  const idn = digits(r.emisor_id) || r.emisor_id;
  let sup = idn ? await q.one(`SELECT id FROM suppliers WHERE business_id=$1 AND regexp_replace(coalesce(gstin,''),'\\D','','g')=$2`, [businessId, idn]) : null;
  if (!sup) sup = await q.one(`INSERT INTO suppliers (business_id, name, gstin, email) VALUES ($1,$2,$3,$4) RETURNING id`, [businessId, r.emisor_name || 'Proveedor', r.emisor_id, r.emisor_email]);
  return sup!.id as string;
}

/** Accept (05), partially accept (06) or reject (07) a supplier document: reserves the receptor consecutivo and queues the signed message. */
export async function decideReceived(businessId: string, id: string, o: { decision: string; detail?: string; condicion?: string; category?: string; amountAccepted?: number; userId: string | null }) {
  if (!DECISIONS[o.decision]) throw bad('Decisión inválida');
  if (o.decision !== '05' && !(o.detail && o.detail.trim().length >= 5)) throw bad('Indique el motivo (mínimo 5 caracteres)');
  return tx(async (q) => {
    const s = await getSettings(q, businessId);
    if (!s?.id_number) throw bad('Configure primero los datos del emisor (Hacienda → Configuración)');
    const r = await q.one(`SELECT * FROM received_documents WHERE id=$1 AND business_id=$2 FOR UPDATE`, [id, businessId]);
    if (!r) throw bad('Documento no encontrado');
    if (r.decision && r.mr_status !== 'rejected' && r.mr_status !== 'error') throw bad('Este documento ya fue respondido');
    const store = await q.one(`SELECT hacienda_branch FROM stores WHERE business_id=$1 ORDER BY created_at LIMIT 1`, [businessId]);
    const branch = store?.hacienda_branch || '001';
    const terminal = String(s.terminal || '00001').replace(/\D/g, '').padStart(5, '0').slice(-5);
    const seq = await q.one(
      `INSERT INTO hacienda_sequences (business_id, environment, branch, terminal, doc_type, last) VALUES ($1,$2,$3,$4,$5,1)
       ON CONFLICT (business_id, environment, branch, terminal, doc_type) DO UPDATE SET last = hacienda_sequences.last + 1 RETURNING last`,
      [businessId, s.environment, branch, terminal, o.decision],
    );
    const cons = consecutivo(branch, terminal, o.decision as any, Number(seq!.last));
    let expenseId = r.expense_id;
    let supplierId = r.supplier_id;
    const category = (o.category || s.expense_category || 'Compras').slice(0, 60);
    if (o.decision !== '07' && r.doc_type !== '03' && !expenseId) {
      supplierId = await supplierFor(q, businessId, r);
      const full = Number(r.total) * (Number(r.exchange_rate) || 1);
      const amount = o.decision === '06' && Number(o.amountAccepted) > 0 ? Number(o.amountAccepted) * (Number(r.exchange_rate) || 1) : full;
      const e = await q.one(
        `INSERT INTO expenses (business_id, category, amount, note, spent_on, user_id, supplier_id, received_doc_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [businessId, category, Math.round(amount * 100) / 100, `Factura ${r.consecutivo} · ${r.emisor_name}`.slice(0, 200), (r.issued_at ? new Date(r.issued_at) : new Date()).toISOString().slice(0, 10), o.userId, supplierId, r.id],
      );
      expenseId = e!.id;
    }
    await q.query(
      `UPDATE received_documents SET decision=$2, decision_detail=$3, condicion_impuesto=$4, mr_consecutivo=$5, mr_status='pending', mr_message=NULL, mr_xml=NULL,
         mr_response_xml=NULL, mr_attempts=0, mr_next_attempt_at=now(), expense_id=$6, supplier_id=$7, expense_category=$8, decided_by=$9, decided_at=now() WHERE id=$1`,
      [id, o.decision, o.detail?.trim() || null, o.condicion || '01', cons, expenseId, supplierId, category, o.userId],
    );
    return q.one(`SELECT * FROM received_documents WHERE id=$1`, [id]);
  });
}

const r5 = (n: number) => (Math.round((Number(n) + Number.EPSILON) * 1e5) / 1e5).toFixed(5);
const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildMensajeReceptor(r: any, s: any) {
  const condicion = r.condicion_impuesto || '01';
  const tax = Number(r.total_tax) || 0;
  const acreditar = r.decision === '07' ? 0 : condicion === '04' ? 0 : tax;
  return (
    `<?xml version="1.0" encoding="utf-8"?><MensajeReceptor xmlns="${MR_NS}" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<Clave>${r.clave}</Clave><NumeroCedulaEmisor>${esc(idNumber(r.emisor_id_type || '02', r.emisor_id || '').slice(0, 20))}</NumeroCedulaEmisor>` +
    `<FechaEmisionDoc>${crDateTime(new Date())}</FechaEmisionDoc><Mensaje>${DECISIONS[r.decision].mensaje}</Mensaje>` +
    (r.decision_detail ? `<DetalleMensaje>${esc(String(r.decision_detail).slice(0, 160))}</DetalleMensaje>` : '') +
    (tax > 0 ? `<MontoTotalImpuesto>${r5(tax)}</MontoTotalImpuesto>` : '') +
    (digits(s.activity_code).length === 6 ? `<CodigoActividad>${digits(s.activity_code)}</CodigoActividad>` : '') +
    (r.decision !== '07' && tax > 0 ? `<CondicionImpuesto>${condicion}</CondicionImpuesto><MontoTotalImpuestoAcreditar>${r5(acreditar)}</MontoTotalImpuestoAcreditar>` +
      `<MontoTotalDeGastoAplicable>${r5(Number(r.total) - acreditar)}</MontoTotalDeGastoAplicable>` : '') +
    `<TotalFactura>${r5(r.total)}</TotalFactura><NumeroCedulaReceptor>${digits(s.id_number)}</NumeroCedulaReceptor>` +
    `<NumeroConsecutivoReceptor>${r.mr_consecutivo}</NumeroConsecutivoReceptor></MensajeReceptor>`
  );
}

// ------------------------------------------------------------------ queue: send the Mensaje Receptor
const RETRY_BASE_S = Number(process.env.HACIENDA_RETRY_BASE_S || 15);
const backoff = (n: number) => Math.min(3600, RETRY_BASE_S * 2 ** Math.min(n, 8));
const upd = (id: string, f: Record<string, any>) => {
  const k = Object.keys(f);
  return db.query(`UPDATE received_documents SET ${k.map((x, i) => `${x}=$${i + 2}`).join(', ')} WHERE id=$1`, [id, ...k.map((x) => f[x])]);
};

async function processOne(r: any) {
  const s = await getSettings(db, r.business_id);
  const env = (s?.environment || 'stag') as HaciendaEnv;
  const retry = (m: string) => upd(r.id, { mr_attempts: r.mr_attempts + 1, mr_next_attempt_at: new Date(Date.now() + backoff(r.mr_attempts) * 1000), mr_message: m });
  if (s?.enabled && env === SIM_ENV) {
    // Simulación: signed locally, never sent to Hacienda
    const cert = s.cert_p12_enc ? await loadP12(decryptBuf(s.cert_p12_enc), decrypt(s.cert_pin_enc)) : await simulationCert();
    const xml = r.mr_xml || (await signXml(buildMensajeReceptor(r, s), cert));
    return upd(r.id, { mr_xml: xml, mr_status: 'accepted', mr_message: 'SIMULACIÓN: no enviado a Hacienda', mr_response_xml: null });
  }
  if (!s?.enabled || !s.api_username || !s.api_password_enc || !s.cert_p12_enc) return retry('La facturación electrónica no está activa o faltan credenciales');
  let token: string;
  try {
    token = await getToken(env, s.api_username, decrypt(s.api_password_enc));
  } catch (e: any) {
    return retry(e.message);
  }
  if (r.mr_status === 'pending') {
    let xml = r.mr_xml;
    if (!xml) {
      const cert = await loadP12(decryptBuf(s.cert_p12_enc), decrypt(s.cert_pin_enc));
      xml = await signXml(buildMensajeReceptor(r, s), cert);
      await upd(r.id, { mr_xml: xml });
    }
    const res = await sendDocument(env, token, {
      clave: r.clave, fecha: crDateTime(new Date()),
      emisor: { tipoIdentificacion: r.emisor_id_type || '02', numeroIdentificacion: idNumber(r.emisor_id_type || '02', r.emisor_id) },
      receptor: { tipoIdentificacion: s.id_type, numeroIdentificacion: idNumber(s.id_type, s.id_number) },
      consecutivoReceptor: r.mr_consecutivo,
      comprobanteXml: Buffer.from(xml, 'utf8').toString('base64'),
    });
    if (res.status === 201 || res.status === 202) return upd(r.id, { mr_status: 'sent', mr_message: null, mr_attempts: r.mr_attempts + 1, mr_next_attempt_at: new Date(Date.now() + Math.min(10, RETRY_BASE_S) * 1000) });
    // Already received (e.g. a retry after a lost response): just ask for its status
    if (res.status === 400 && /ya.{0,40}(recibid|registrad|existe)|duplicad/i.test(res.cause || '')) return upd(r.id, { mr_status: 'sent', mr_next_attempt_at: new Date() });
    if (res.status === 401 || res.status === 403) { clearToken(env, s.api_username); return retry('Sesión con Hacienda vencida'); }
    if (res.status === 400) return upd(r.id, { mr_status: 'error', mr_message: `Hacienda no aceptó el mensaje: ${res.cause || 'sin detalle'}` });
    return retry(`Hacienda respondió ${res.status}`);
  }
  const st = await getStatus(env, token, `${r.clave}-${r.mr_consecutivo}`);
  if (st.state === 'aceptado') return upd(r.id, { mr_status: 'accepted', mr_response_xml: st.responseXml, mr_message: null });
  if (st.state === 'rechazado' || st.state === 'error') {
    const m = st.responseXml && /<DetalleMensaje>([\s\S]*?)<\/DetalleMensaje>/.exec(st.responseXml);
    await upd(r.id, { mr_status: 'rejected', mr_response_xml: st.responseXml, mr_message: (m?.[1] || 'Rechazado por Hacienda').trim().slice(0, 1000) });
    return notify(r.business_id, null, 'hacienda', `Hacienda rechazó la respuesta a la factura ${r.consecutivo} de ${r.emisor_name}`, { id: r.id });
  }
  return retry('Hacienda está procesando el mensaje');
}

let running = false;
export async function processReceivedQueue() {
  if (running) return;
  running = true;
  try {
    const rows = await db.query(`SELECT * FROM received_documents WHERE mr_status IN ('pending','sent') AND mr_next_attempt_at <= now() ORDER BY decided_at LIMIT 25`);
    for (const r of rows) await processOne(r).catch((e) => console.error('[hacienda] mensaje receptor', r.clave, e));
  } finally {
    running = false;
  }
}

// ------------------------------------------------------------------ e-mail inbox (IMAP)
/** Reads unread e-mails of the invoices inbox and imports every comprobante XML attached. */
export async function pollInbox(businessId: string) {
  const s = await getSettings(db, businessId);
  if (!s?.imap_host || !s.imap_user || !s.imap_pass_enc) return { imported: 0, skipped: 0, configured: false };
  const client = new ImapFlow({
    host: s.imap_host, port: Number(s.imap_port) || 993, secure: (Number(s.imap_port) || 993) === 993,
    auth: { user: s.imap_user, pass: decrypt(s.imap_pass_enc) }, logger: false, socketTimeout: 60000,
  });
  let imported = 0, skipped = 0;
  const errors: string[] = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = (await client.search({ seen: false }, { uid: true })) || [];
      for (const uid of uids.slice(0, 200)) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const mail = await simpleParser(msg.source);
        for (const a of mail.attachments || []) {
          if (!/\.xml$/i.test(a.filename || '') && !/xml/.test(a.contentType)) continue;
          const xml = a.content.toString('utf8');
          if (!/<(FacturaElectronica|NotaCreditoElectronica|NotaDebitoElectronica)[\s>]/.test(xml)) continue;
          try {
            const r = await importReceivedXml(businessId, xml, 'email');
            r.created ? imported++ : skipped++;
          } catch (e: any) {
            errors.push(`${a.filename}: ${e.message}`);
          }
        }
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
    await client.logout();
    await db.query(`UPDATE hacienda_settings SET imap_last_check=now(), imap_error=$2 WHERE business_id=$1`, [businessId, errors.length ? errors.slice(0, 5).join(' · ') : null]);
  } catch (e: any) {
    await db.query(`UPDATE hacienda_settings SET imap_last_check=now(), imap_error=$2 WHERE business_id=$1`, [businessId, String(e.responseText || e.message || e)]);
    client.close();
    throw bad(`No se pudo leer el buzón: ${e.responseText || e.message}`);
  }
  if (imported) await notify(businessId, null, 'hacienda', `${imported} factura(s) de proveedores recibida(s) por correo`, {});
  return { imported, skipped, errors, configured: true };
}
