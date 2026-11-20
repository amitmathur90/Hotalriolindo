import { Router } from 'express';
import { db, tx } from '../db.ts';
import { requirePerm, requireUser } from '../auth.ts';
import { ah, audit, bad, notFound, range } from '../util.ts';
import { ID_TYPES, digits, validateId, DEFAULT_RESOLUTION, DOC_NAMES, type DocType } from '../hacienda/codes.ts';
import { encrypt, decrypt, decryptBuf } from '../hacienda/secrets.ts';
import { loadP12, signXml, verifyXml } from '../hacienda/sign.ts';
import { getToken } from '../hacienda/client.ts';
import { annulDocument, cleanLines, cleanReceptor, convertToFactura, createAdjustmentNote, emailDocument, getSettings, issueDocument, kickQueue, logEvent, processQueue, smtpConfigured, type DocPayload } from '../hacienda/service.ts';
import { documentPdf, documentThermalPdf, parseComprobante, renderPdf } from '../hacienda/pdf.ts';
import { usdRate } from '../hacienda/fx.ts';
import { assignProductCabys, catalogueInfo, importCabys, mappingReport, searchLocal } from '../hacienda/cabys.ts';
import { DECISIONS, decideReceived, importReceivedXml, pollInbox, processReceivedQueue } from '../hacienda/received.ts';

const r = Router();

const FIELDS = ['environment', 'legal_name', 'trade_name', 'id_type', 'id_number', 'activity_code', 'provider_id', 'provincia', 'canton', 'distrito',
  'barrio', 'otras_senas', 'phone', 'email', 'default_cabys', 'resolution_text', 'api_username', 'terminal', 'usd_rate_manual', 'imap_host', 'imap_port', 'imap_user', 'registro_fiscal_8707',
  'expense_category'] as const;

/** Settings as shown to the Back Office (secrets are never returned). */
function publicSettings(s: any) {
  const out: any = { enabled: false, environment: 'stag', id_type: '02', resolution_text: DEFAULT_RESOLUTION };
  if (s) {
    for (const f of FIELDS) out[f] = s[f];
    out.enabled = s.enabled;
    out.has_password = !!s.api_password_enc;
    out.has_certificate = !!s.cert_p12_enc;
    out.cert_subject = s.cert_subject;
    out.cert_expires_at = s.cert_expires_at;
    out.resolution_text = s.resolution_text || DEFAULT_RESOLUTION;
    out.auto_accept = !!s.auto_accept;
    out.has_imap_password = !!s.imap_pass_enc;
    out.imap_last_check = s.imap_last_check;
    out.imap_error = s.imap_error;
  }
  out.terminal = out.terminal || '00001';
  out.smtp_configured = smtpConfigured();
  return out;
}

/** What is still missing before documents can be issued. */
function missing(s: any): string[] {
  const m: string[] = [];
  if (!s?.legal_name || s.legal_name.trim().length < 5) m.push('Nombre o razón social');
  if (!s?.id_number || validateId(s.id_type, s.id_number)) m.push('Identificación del emisor');
  if (digits(s?.activity_code).length !== 6) m.push('Código de actividad económica (6 dígitos)');
  if (!/^\d$/.test(digits(s?.provincia)) || !digits(s?.canton) || !digits(s?.distrito)) m.push('Provincia / cantón / distrito');
  if (!s?.otras_senas || s.otras_senas.trim().length < 5) m.push('Otras señas (dirección)');
  if (!s?.email) m.push('Correo electrónico del emisor');
  if (!s?.api_username || !s?.api_password_enc) m.push('Usuario y contraseña de la API (ATV)');
  if (!s?.cert_p12_enc) m.push('Llave criptográfica (.p12)');
  return m;
}

r.get('/settings', requirePerm('settings.manage'), ah(async (req, res) => {
  const s = await getSettings(db, req.auth.businessId);
  res.json({ ...publicSettings(s), missing: missing(s), id_types: ID_TYPES });
}));

r.put('/settings', requirePerm('settings.manage'), ah(async (req, res) => {
  const b = req.body || {};
  const bid = req.auth.businessId;
  await db.query(`INSERT INTO hacienda_settings (business_id) VALUES ($1) ON CONFLICT (business_id) DO NOTHING`, [bid]);
  const data: Record<string, any> = {};
  for (const f of FIELDS) if (f in b) data[f] = b[f] === '' ? null : String(b[f]).trim();
  if (data.environment && !['stag', 'prod'].includes(data.environment)) throw bad('Ambiente inválido');
  if (data.id_number) data.id_number = digits(data.id_number);
  if (data.provider_id) data.provider_id = digits(data.provider_id);
  if (data.default_cabys && !/^\d{13}$/.test(digits(data.default_cabys))) throw bad('El CABYS debe tener 13 dígitos');
  if (b.api_password) data.api_password_enc = encrypt(String(b.api_password));
  // New credentials: documents waiting on an authentication error are retried right away
  if (b.api_password || 'api_username' in data) await db.query(`UPDATE e_documents SET next_attempt_at=now() WHERE business_id=$1 AND status='auth_error'`, [bid]);
  if (b.imap_password) data.imap_pass_enc = encrypt(String(b.imap_password));
  if ('auto_accept' in b) data.auto_accept = !!b.auto_accept;
  if ('terminal' in data) {
    if (data.terminal && !/^\d{1,5}$/.test(data.terminal)) throw bad('La terminal debe ser un número de hasta 5 dígitos');
    data.terminal = String(data.terminal || '1').padStart(5, '0');
  }
  if ('usd_rate_manual' in data) data.usd_rate_manual = data.usd_rate_manual ? Number(data.usd_rate_manual) || null : null;
  if ('imap_port' in data) data.imap_port = data.imap_port ? Number(data.imap_port) || null : null;
  const keys = Object.keys(data);
  if (keys.length) {
    await db.query(`UPDATE hacienda_settings SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE business_id=$1`, [bid, ...keys.map((k) => data[k])]);
  }
  let s = await getSettings(db, bid);
  if ('enabled' in b) {
    if (b.enabled && missing(s).length) throw bad('Para activar falta: ' + missing(s).join(', '));
    await db.query(`UPDATE hacienda_settings SET enabled=$2, updated_at=now() WHERE business_id=$1`, [bid, !!b.enabled]);
    s = await getSettings(db, bid);
  }
  await audit(req, 'hacienda_settings', 'hacienda_settings', bid, { ...data, api_password_enc: data.api_password_enc ? '***' : undefined, enabled: s!.enabled });
  res.json({ ...publicSettings(s), missing: missing(s), id_types: ID_TYPES });
}));

/** Upload the "llave criptográfica" (.p12 from ATV) and its PIN. */
r.post('/settings/certificate', requirePerm('settings.manage'), ah(async (req, res) => {
  const { p12_base64, pin } = req.body || {};
  if (!p12_base64 || !pin) throw bad('Seleccione el archivo .p12 e ingrese el PIN');
  const buf = Buffer.from(String(p12_base64).replace(/^data:[^,]*,/, ''), 'base64');
  let cert;
  try {
    cert = await loadP12(buf, String(pin));
  } catch (e: any) {
    throw bad(e.message);
  }
  if (cert.notAfter < new Date()) throw bad(`La llave criptográfica venció el ${cert.notAfter.toLocaleDateString('es-CR')}`);
  const bid = req.auth.businessId;
  await db.query(`INSERT INTO hacienda_settings (business_id) VALUES ($1) ON CONFLICT (business_id) DO NOTHING`, [bid]);
  await db.query(
    `UPDATE hacienda_settings SET cert_p12_enc=$2, cert_pin_enc=$3, cert_subject=$4, cert_expires_at=$5, updated_at=now() WHERE business_id=$1`,
    [bid, encrypt(buf), encrypt(String(pin)), cert.subject, cert.notAfter],
  );
  const s = await getSettings(db, bid);
  const idDigits = digits(s!.id_number);
  const warning = idDigits && cert.serialName && !digits(cert.serialName).endsWith(idDigits) ? `La llave pertenece a ${cert.serialName}, que no coincide con la identificación ${s!.id_number}` : null;
  await audit(req, 'hacienda_certificate', 'hacienda_settings', bid, { subject: cert.subject, expires: cert.notAfter });
  res.json({ ...publicSettings(s), missing: missing(s), id_types: ID_TYPES, warning });
}));

/** Checks the API credentials (gets a token) and the certificate (signs + verifies a test document). */
r.post('/settings/test', requirePerm('settings.manage'), ah(async (req, res) => {
  const s = await getSettings(db, req.auth.businessId);
  const out: any = { credentials: null, certificate: null };
  try {
    if (!s?.api_username || !s.api_password_enc) throw new Error('Falta usuario o contraseña de la API');
    await getToken(s.environment, s.api_username, decrypt(s.api_password_enc));
    out.credentials = { ok: true, message: `Conexión correcta con Hacienda (${s.environment === 'prod' ? 'producción' : 'pruebas'})` };
  } catch (e: any) {
    out.credentials = { ok: false, message: e.message };
  }
  try {
    if (!s?.cert_p12_enc) throw new Error('Falta la llave criptográfica');
    const cert = await loadP12(decryptBuf(s.cert_p12_enc), decrypt(s.cert_pin_enc));
    const signed = await signXml('<Prueba xmlns="urn:its-pos:prueba"><Texto>ok</Texto></Prueba>', cert);
    if (!(await verifyXml(signed))) throw new Error('La firma de prueba no es válida');
    out.certificate = { ok: true, message: `Firma correcta · ${cert.subject} · vence ${cert.notAfter.toLocaleDateString('es-CR')}` };
  } catch (e: any) {
    out.certificate = { ok: false, message: e.message };
  }
  res.json(out);
}));

// ---------------------------------------------------------------- Documents

const LIST_COLS = `d.id, d.doc_type, d.environment, d.clave, d.consecutivo, d.issued_at, d.status, d.message, d.attempts, d.total, d.receptor,
  d.reference, d.replaced_by, d.emailed_at, d.email_error, d.sale_id, s.receipt_no, s.type AS sale_type, st.name AS store_name, d.store_id,
  d.source, d.currency, d.exchange_rate, d.external_ref, d.annulled_by, d.notes, d.terminal, d.submitted_at, d.decided_at, d.ambiguous`;

const VIEW_DOCS = requirePerm('reports.view', 'settings.manage', 'accounting.view');
const ADJUST = requirePerm('settings.manage', 'pos.refund', 'accounting.manage');

/** List with filters (date range, status, type, source, currency, branch, text) and pagination. */
r.get('/documents', VIEW_DOCS, ah(async (req, res) => {
  const { from, to } = range(req);
  const params: any[] = [req.auth.businessId, from, to];
  let where = `d.business_id=$1 AND d.issued_at >= $2 AND d.issued_at < $3`;
  if (req.query.status) where += ` AND d.status = ANY($${params.push(String(req.query.status).split(','))}::text[])`;
  if (req.query.doc_type) where += ` AND d.doc_type=$${params.push(req.query.doc_type)}`;
  if (req.query.source) where += ` AND d.source=$${params.push(req.query.source)}`;
  if (req.query.currency) where += ` AND d.currency=$${params.push(req.query.currency)}`;
  if (req.query.store_id) where += ` AND d.store_id=$${params.push(req.query.store_id)}`;
  if (req.query.q) {
    const i = params.push(`%${req.query.q}%`);
    where += ` AND (d.clave ILIKE $${i} OR d.consecutivo ILIKE $${i} OR s.receipt_no ILIKE $${i} OR d.external_ref ILIKE $${i} OR d.receptor->>'nombre' ILIKE $${i} OR d.receptor->>'id_number' ILIKE $${i})`;
  }
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 500));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = await db.query(
    `SELECT ${LIST_COLS} FROM e_documents d LEFT JOIN sales s ON s.id=d.sale_id JOIN stores st ON st.id=d.store_id WHERE ${where}
      ORDER BY d.issued_at DESC, d.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  const tot = await db.one(`SELECT count(*)::int AS n FROM e_documents d LEFT JOIN sales s ON s.id=d.sale_id WHERE ${where}`, params);
  const counts = await db.query(`SELECT status, count(*)::int AS n FROM e_documents WHERE business_id=$1 GROUP BY status`, [req.auth.businessId]);
  res.json({ rows, total: Number(tot?.n || 0), limit, offset, counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) });
}));

async function loadDoc(req: any) {
  const d = await db.one(`SELECT * FROM e_documents WHERE id=$1 AND business_id=$2`, [req.params.id, req.auth.businessId]);
  if (!d) throw notFound('Documento');
  return d;
}
const publicDoc = (d: any) => {
  const { xml_signed, xml_unsigned, response_xml, ...rest } = d;
  return { ...rest, has_xml_unsigned: !!xml_unsigned, has_xml_signed: !!xml_signed, has_response: !!response_xml };
};

/** Document detail: lifecycle history, e-mails, related notes. */
r.get('/documents/:id', requirePerm('reports.view', 'settings.manage', 'accounting.view', 'pos.sell'), ah(async (req, res) => {
  const d = await loadDoc(req);
  const [events, emails, related, sale, store] = await Promise.all([
    db.query(`SELECT * FROM e_document_events WHERE document_id=$1 ORDER BY created_at, kind`, [d.id]),
    db.query(`SELECT * FROM e_document_emails WHERE document_id=$1 ORDER BY created_at DESC`, [d.id]),
    db.query(`SELECT id, doc_type, consecutivo, status, issued_at, total, currency, reference FROM e_documents WHERE business_id=$1 AND (reference->>'doc_id'=$2 OR id=$3 OR replaced_by=$2::uuid)`,
      [d.business_id, d.id, d.reference?.doc_id || d.replaced_by || d.annulled_by || '00000000-0000-0000-0000-000000000000']),
    d.sale_id ? db.one(`SELECT id, receipt_no, total, created_at FROM sales WHERE id=$1`, [d.sale_id]) : null,
    db.one(`SELECT name, hacienda_branch FROM stores WHERE id=$1`, [d.store_id]),
  ]);
  res.json({ ...publicDoc(d), events, emails, related: related.filter((x) => x.id !== d.id), sale, store });
}));

r.get('/documents/:id/status', requirePerm('reports.view', 'settings.manage', 'accounting.view', 'pos.sell'), ah(async (req, res) => {
  const d = await loadDoc(req);
  res.json({ id: d.id, clave: d.clave, consecutivo: d.consecutivo, status: d.status, message: d.message, submitted_at: d.submitted_at, decided_at: d.decided_at, ambiguous: d.ambiguous, attempts: d.attempts });
}));

/** XML artifacts: kind=signed (default) | unsigned | response */
r.get('/documents/:id/xml', requirePerm('reports.view', 'settings.manage', 'accounting.view', 'pos.sell'), ah(async (req, res) => {
  const d = await loadDoc(req);
  const kind = String(req.query.kind || 'signed');
  const xml = kind === 'response' ? d.response_xml : kind === 'unsigned' ? d.xml_unsigned : d.xml_signed;
  if (!xml) throw notFound(kind === 'response' ? 'Respuesta de Hacienda' : kind === 'unsigned' ? 'XML original' : 'XML firmado');
  await audit(req, 'hacienda_download_xml', 'e_documents', d.id, { kind });
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${d.clave}${kind === 'response' ? '_respuesta' : kind === 'unsigned' ? '_sin_firma' : ''}.xml"`);
  res.send(xml);
}));

/** Create the electronic document of a POS sale that has none (e.g. sold before e-invoicing was enabled). Idempotent per sale. */
r.post('/documents', requirePerm('settings.manage', 'pos.sell'), ah(async (req, res) => {
  const b = req.body || {};
  const bid = req.auth.businessId;
  const sale = await db.one(`SELECT * FROM sales WHERE id=$1 AND business_id=$2`, [b.sale_id, bid]);
  if (!sale) throw notFound('Venta');
  if (sale.type !== 'sale') throw bad('Las devoluciones generan su nota de crédito automáticamente');
  const docType: DocType = b.doc_type === '01' ? '01' : '04';
  const receptor = docType === '01' ? cleanReceptor(b.receptor || {}) : b.receptor?.nombre ? cleanReceptor(b.receptor, false) : null;
  const doc = await tx(async (q) => {
    const cur = await q.one(`SELECT * FROM e_documents WHERE sale_id=$1 AND doc_type IN ('01','04') AND status <> 'rejected' AND replaced_by IS NULL`, [sale.id]);
    if (cur) return cur;
    const d = await issueDocument(q, { businessId: bid, storeId: sale.store_id, saleId: sale.id, docType, issuedAt: new Date(), receptor, userId: req.auth.userId, userName: req.auth.userName, idempotencyKey: `sale:${sale.id}` });
    if (!d) throw bad('La facturación electrónica no está activada');
    return d;
  });
  await audit(req, 'hacienda_document_create', 'e_documents', doc.id, { sale: sale.receipt_no, clave: doc.clave });
  kickQueue();
  res.status(201).json(publicDoc(doc));
}));

/**
 * Retry after the cause was fixed. Documents never received by Hacienda are rebuilt (validation errors, refused at
 * reception); documents that may have been received are only re-checked (reconciliation), never re-signed.
 */
r.post('/documents/:id/retry', requirePerm('settings.manage', 'reports.view', 'accounting.manage'), ah(async (req, res) => {
  const d = await loadDoc(req);
  if (d.status === 'accepted') throw bad('El documento ya fue aceptado por Hacienda');
  if (d.status === 'rejected') throw bad('Un documento rechazado no se puede reenviar: use "Reemitir"');
  let next: Record<string, any>;
  if (d.status === 'validation_failed' || (d.status === 'error' && !d.submitted_at) || (d.status === 'pending' && !d.submitted_at)) {
    next = { status: 'pending', xml_signed: null, xml_unsigned: null, xml_hash: null, signed_hash: null };
  } else if (d.status === 'manual_review') {
    next = { status: 'sent', ambiguous: true }; // ask Hacienda again before deciding anything
  } else if (d.status === 'auth_error') {
    next = { status: d.submitted_at ? 'sent' : d.xml_signed ? 'signed' : 'pending' };
  } else next = {}; // signed / sent / processing: just check now
  const keys = Object.keys(next);
  await db.query(`UPDATE e_documents SET ${keys.map((k, i) => `${k}=$${i + 2}, `).join('')}attempts=0, next_attempt_at=now(), message=NULL, updated_at=now() WHERE id=$1`, [d.id, ...keys.map((k) => next[k])]);
  await logEvent(d, 'retry', { status: next.status || d.status, message: 'Reintento solicitado', userId: req.auth.userId, userName: req.auth.userName });
  await audit(req, 'hacienda_retry', 'e_documents', d.id, { clave: d.clave, from: d.status });
  await processQueue();
  res.json(await db.one(`SELECT id, status, message FROM e_documents WHERE id=$1`, [d.id]));
}));

/** Issue a new document (new consecutivo/clave) for one that Hacienda rejected or refused. */
r.post('/documents/:id/reissue', requirePerm('settings.manage'), ah(async (req, res) => {
  const d = await loadDoc(req);
  if (!['rejected', 'error', 'validation_failed'].includes(d.status)) throw bad('Solo se reemiten documentos rechazados, con error o que no pasaron la validación');
  const nd = await tx(async (q) => {
    const n = await issueDocument(q, {
      businessId: d.business_id, storeId: d.store_id, saleId: d.sale_id, docType: d.doc_type, issuedAt: new Date(), receptor: d.receptor,
      reference: d.reference, userId: req.auth.userId, userName: req.auth.userName, source: d.source, payload: d.payload, currency: d.currency, exchangeRate: Number(d.exchange_rate),
      externalRef: d.external_ref, notes: d.notes,
    });
    if (!n) throw bad('La facturación electrónica no está activada');
    await q.query(`UPDATE e_documents SET replaced_by=$2, status=CASE WHEN status IN ('error','validation_failed') THEN 'rejected' ELSE status END, updated_at=now() WHERE id=$1`, [d.id, n.id]);
    return n;
  });
  await logEvent(d, 'note', { status: 'rejected', message: `Reemitido como ${nd.consecutivo}`, userId: req.auth.userId, userName: req.auth.userName });
  await audit(req, 'hacienda_reissue', 'e_documents', nd.id, { replaces: d.clave });
  kickQueue();
  res.status(201).json(nd);
}));

/** PDF: format=a4 (default) | 80mm | 58mm */
r.get('/documents/:id/pdf', requirePerm('reports.view', 'settings.manage', 'accounting.view', 'pos.sell'), ah(async (req, res) => {
  const d = await loadDoc(req);
  const fmt = String(req.query.format || 'a4');
  const pdf = fmt === '80mm' || fmt === '58mm' ? await documentThermalPdf(d, fmt) : await documentPdf(d);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${d.consecutivo}${fmt !== 'a4' ? '_' + fmt : ''}.pdf"`);
  res.send(pdf);
}));

/** Anular a manual / Cloudbeds document (full nota de crédito). */
r.post('/documents/:id/annul', ADJUST, ah(async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) throw bad('Indique el motivo de la anulación');
  const nc = await tx((q) => annulDocument(q, { businessId: req.auth.businessId, docId: req.params.id, reason, userId: req.auth.userId }));
  await audit(req, 'hacienda_annul', 'e_documents', req.params.id, { nota: nc.clave, reason });
  kickQueue();
  res.status(201).json(nc);
}));

/** Credit note (full or partial) / debit note referencing an original document. */
const noteRoute = (type: '02' | '03') => ah(async (req: any, res: any) => {
  const b = req.body || {};
  const note = await tx((q) => createAdjustmentNote(q, {
    businessId: req.auth.businessId, docId: String(b.document_id || b.doc_id || ''), type, reason: b.reason, lines: b.lines || null, code: b.code || null,
    userId: req.auth.userId, userName: req.auth.userName,
  }));
  await audit(req, type === '03' ? 'hacienda_credit_note' : 'hacienda_debit_note', 'e_documents', note.id, { original: b.document_id || b.doc_id, reason: b.reason, clave: note.clave });
  kickQueue();
  res.status(201).json(note);
});
r.post('/credit-notes', ADJUST, noteRoute('03'));
r.post('/debit-notes', ADJUST, noteRoute('02'));

/** Resend the e-mail (never changes the Hacienda status). */
r.post('/documents/:id/email', requirePerm('pos.sell', 'reports.view', 'accounting.view'), ah(async (req, res) => {
  const d = await loadDoc(req);
  await emailDocument(d.id, req.body?.email || undefined, req.auth.userId);
  res.json({ ok: true });
}));

/** Factura electrónica on demand for an existing sale (annuls its tiquete with a nota de crédito). */
r.post('/sales/:id/factura', requireUser, requirePerm('pos.sell'), ah(async (req, res) => {
  const receptor = cleanReceptor(req.body?.receptor || {});
  const bid = req.auth.businessId;
  const out = await tx(async (q) => {
    const result = await convertToFactura(q, { businessId: bid, saleId: req.params.id, receptor, userId: req.auth.userId });
    // Remember the tax details on the customer for the next factura
    if (req.body?.customer_id) {
      await q.query(`UPDATE customers SET tax_id=$3, id_type=$4, email=COALESCE(NULLIF($5,''), email), activity_code=COALESCE($6, activity_code) WHERE id=$1 AND business_id=$2`,
        [req.body.customer_id, bid, receptor.id_number, receptor.id_type, receptor.email || '', receptor.activity_code]);
      await q.query(`UPDATE sales SET customer_id=COALESCE(customer_id, $2) WHERE id=$1`, [req.params.id, req.body.customer_id]);
    }
    return result;
  });
  await audit(req, 'hacienda_factura', 'sales', req.params.id, { clave: out.factura?.clave, receptor: receptor.id_number });
  kickQueue();
  res.status(201).json(out);
}));

// ---------------------------------------------------------------- Manual invoices (not from the POS)

r.post('/invoices', requirePerm('settings.manage', 'pos.sell'), ah(async (req, res) => {
  const b = req.body || {};
  const bid = req.auth.businessId;
  const docType = b.doc_type === '04' ? '04' : '01';
  const currency = b.currency === 'USD' ? 'USD' : 'CRC';
  const s = await getSettings(db, bid);
  if (!s?.enabled) throw bad('La facturación electrónica no está activada (Hacienda → Configuración)');
  const lines: DocPayload['lines'] = cleanLines(b.lines, s);
  const receptor = docType === '01' ? cleanReceptor(b.receptor || {}) : b.receptor?.nombre ? cleanReceptor(b.receptor, false) : null;
  const condition = String(b.condition || '01');
  if (!['01', '02', '03', '04', '05', '06', '07', '08', '10', '99'].includes(condition)) throw bad('Condición de venta inválida');
  const creditDays = condition === '02' || condition === '10' ? Math.max(1, Math.round(Number(b.credit_days) || 30)) : null;
  let rate = 1;
  if (currency === 'USD') rate = Number(b.exchange_rate) > 0 ? Number(b.exchange_rate) : (await usdRate(bid)).rate;
  const payments = (Array.isArray(b.payments) && b.payments.length ? b.payments : [{ type: b.payment_type || 'cash', amount: 1 }])
    .map((p: any) => ({ type: String(p.type || 'cash'), name: p.name ? String(p.name) : undefined, amount: Number(p.amount) || 1 }));
  const storeId = b.store_id || req.storeId || (await db.one(`SELECT id FROM stores WHERE business_id=$1 ORDER BY created_at LIMIT 1`, [bid]))!.id;
  const doc = await tx(async (q) => {
    const d = await issueDocument(q, {
      businessId: bid, storeId, docType, issuedAt: new Date(), userId: req.auth.userId, userName: req.auth.userName, source: 'manual',
      idempotencyKey: b.idempotency_key ? `manual:${String(b.idempotency_key).slice(0, 80)}` : null, receptor, currency, exchangeRate: rate,
      notes: b.notes ? String(b.notes).slice(0, 500) : null,
      payload: { lines, payments, condition, credit_days: creditDays, service_charge: Number(b.service_charge) || 0, tip: Number(b.tip) || 0 },
    });
    if (b.customer_id && receptor?.id_number) {
      await q.query(`UPDATE customers SET tax_id=$3, id_type=$4, email=COALESCE(NULLIF($5,''), email), activity_code=COALESCE($6, activity_code) WHERE id=$1 AND business_id=$2`,
        [b.customer_id, bid, receptor.id_number, receptor.id_type, receptor.email || '', receptor.activity_code]);
    }
    return d;
  });
  await audit(req, 'hacienda_manual_invoice', 'e_documents', doc!.id, { clave: doc!.clave, currency, lines: lines.length });
  kickQueue();
  res.status(201).json(doc);
}));

// ---------------------------------------------------------------- Numbering (consecutivos)

r.get('/sequences', requirePerm('settings.manage'), ah(async (req, res) => {
  const s = await getSettings(db, req.auth.businessId);
  res.json(await db.query(`SELECT environment, branch, terminal, doc_type, last FROM hacienda_sequences WHERE business_id=$1 AND environment=$2 ORDER BY branch, terminal, doc_type`,
    [req.auth.businessId, s?.environment || 'stag']));
}));

/** Sets the next number of a sequence, e.g. to continue after the numbers already used in another system (Cubo). */
r.put('/sequences', requirePerm('settings.manage'), ah(async (req, res) => {
  const bid = req.auth.businessId;
  const s = await getSettings(db, bid);
  const branch = digits(req.body?.branch || '001').padStart(3, '0').slice(-3);
  const terminal = digits(req.body?.terminal || s?.terminal || '1').padStart(5, '0').slice(-5);
  const docType = String(req.body?.doc_type || '');
  const next = Math.floor(Number(req.body?.next));
  if (!['01', '03', '04', '05', '06', '07'].includes(docType)) throw bad('Tipo de documento inválido');
  if (!(next >= 1 && next < 1e10)) throw bad('Número inválido');
  const used = await db.one(`SELECT max(substring(consecutivo, 11, 10)::bigint) AS n FROM e_documents WHERE business_id=$1 AND environment=$2 AND substring(consecutivo,1,3)=$3 AND substring(consecutivo,4,5)=$4 AND doc_type=$5`,
    [bid, s?.environment || 'stag', branch, terminal, docType]);
  if (Number(used?.n) >= next) throw bad(`Ya se emitió el número ${used!.n} en esta terminal: el siguiente debe ser mayor`);
  await db.query(
    `INSERT INTO hacienda_sequences (business_id, environment, branch, terminal, doc_type, last) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (business_id, environment, branch, terminal, doc_type) DO UPDATE SET last=EXCLUDED.last`,
    [bid, s?.environment || 'stag', branch, terminal, docType, next - 1],
  );
  await audit(req, 'hacienda_sequence', 'hacienda_sequences', null, { branch, terminal, docType, next });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Exchange rate & CABYS

r.get('/fx', ah(async (req, res) => {
  try {
    res.json(await usdRate(req.auth.businessId));
  } catch (e: any) {
    res.json({ rate: null, error: e.message });
  }
}));

const cabysCache = new Map<string, { at: number; data: any }>();
/** CABYS catalogue search (Hacienda's public API), e.g. ?q=cerveza or ?codigo=2213000000000 */
r.get('/cabys', ah(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const codigo = digits(req.query.codigo);
  if (!q && !codigo) return res.json({ items: [] });
  // Official catalogue imported → search it locally (versioned, works offline)
  const local = await searchLocal(q, codigo || undefined);
  if (local) return res.json({ items: local.map((x: any) => ({ ...x, impuesto: x.impuesto == null ? null : Number(x.impuesto) })), total: local.length, source: 'catalogue' });
  const key = codigo ? 'c:' + codigo : 'q:' + q.toLowerCase();
  const hit = cabysCache.get(key);
  if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return res.json(hit.data);
  const baseUrl = (process.env.HACIENDA_CABYS_URL || 'https://api.hacienda.go.cr/fe/cabys').replace(/\/$/, '');
  const url = codigo ? `${baseUrl}?codigo=${codigo}` : `${baseUrl}?q=${encodeURIComponent(q)}&top=30`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);
  try {
    const r2 = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!r2.ok) throw new Error(String(r2.status));
    const b: any = await r2.json();
    const list: any[] = Array.isArray(b) ? b : b.cabys || [];
    const data = { items: list.map((x) => ({ codigo: String(x.codigo), descripcion: x.descripcion, impuesto: Number(x.impuesto), categorias: x.categorias || [] })), total: b.total ?? list.length };
    if (cabysCache.size > 500) cabysCache.clear();
    cabysCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch (e: any) {
    throw bad(`No se pudo consultar el catálogo CABYS de Hacienda (${e.name === 'AbortError' ? 'tiempo agotado' : e.message})`);
  } finally {
    clearTimeout(t);
  }
}));

// ---------------------------------------------------------------- Documentos recibidos (supplier invoices)

const REC_COLS = `id, clave, doc_type, consecutivo, issued_at, emisor_name, emisor_id, emisor_email, currency, exchange_rate, total, total_tax, source, decision,
  decision_detail, condicion_impuesto, mr_consecutivo, mr_status, mr_message, expense_id, expense_category, decided_at, created_at`;
r.get('/received', requirePerm('reports.view', 'settings.manage'), ah(async (req, res) => {
  const bid = req.auth.businessId;
  const params: any[] = [bid];
  let where = 'business_id=$1';
  if (req.query.from) where += ` AND coalesce(issued_at, created_at) >= $${params.push(new Date(String(req.query.from)))}`;
  if (req.query.to) where += ` AND coalesce(issued_at, created_at) < $${params.push(new Date(String(req.query.to)))}`;
  if (req.query.status === 'new') where += ' AND decision IS NULL';
  else if (req.query.status) where += ` AND mr_status=$${params.push(req.query.status)}`;
  if (req.query.q) {
    const i = params.push(`%${req.query.q}%`);
    where += ` AND (clave ILIKE $${i} OR consecutivo ILIKE $${i} OR emisor_name ILIKE $${i} OR emisor_id ILIKE $${i})`;
  }
  const rows = await db.query(`SELECT ${REC_COLS} FROM received_documents WHERE ${where} ORDER BY coalesce(issued_at, created_at) DESC LIMIT 1000`, params);
  const pending = await db.one(`SELECT count(*)::int AS n FROM received_documents WHERE business_id=$1 AND decision IS NULL`, [bid]);
  const s = await getSettings(db, bid);
  res.json({ rows, pending: Number(pending?.n || 0), decisions: DECISIONS, inbox: { configured: !!(s?.imap_host && s.imap_user), last_check: s?.imap_last_check, error: s?.imap_error } });
}));

/** Upload one or more supplier XML files: { files: [{ name, content }] } (content = XML text or base64). */
r.post('/received/import', requirePerm('settings.manage', 'purchases.manage'), ah(async (req, res) => {
  const files: any[] = Array.isArray(req.body?.files) ? req.body.files : req.body?.xml ? [{ name: 'documento.xml', content: req.body.xml }] : [];
  if (!files.length) throw bad('Seleccione los archivos XML de los proveedores');
  const out: any[] = [];
  for (const f of files.slice(0, 100)) {
    let xml = String(f.content || '');
    if (!xml.trimStart().startsWith('<')) xml = Buffer.from(xml.replace(/^data:[^,]*,/, ''), 'base64').toString('utf8');
    try {
      const r2 = await importReceivedXml(req.auth.businessId, xml, 'upload');
      out.push({ name: f.name, ok: true, created: r2.created, id: r2.doc.id, emisor: r2.doc.emisor_name, total: r2.doc.total });
    } catch (e: any) {
      out.push({ name: f.name, ok: false, error: e.message });
    }
  }
  await audit(req, 'hacienda_received_import', 'received_documents', null, { files: out.length, ok: out.filter((x) => x.ok).length });
  setTimeout(() => processReceivedQueue().catch(console.error), 300);
  res.json({ results: out });
}));

r.post('/received/check-inbox', requirePerm('settings.manage', 'purchases.manage'), ah(async (req, res) => {
  const r2 = await pollInbox(req.auth.businessId);
  if (!r2.configured) throw bad('Configure el buzón de correo de facturas en Hacienda → Configuración');
  setTimeout(() => processReceivedQueue().catch(console.error), 300);
  res.json(r2);
}));

r.post('/received/:id/decide', requirePerm('settings.manage', 'purchases.manage'), ah(async (req, res) => {
  const b = req.body || {};
  const doc = await decideReceived(req.auth.businessId, req.params.id, {
    decision: String(b.decision), detail: b.detail, condicion: b.condicion, category: b.category, amountAccepted: Number(b.amount_accepted) || undefined, userId: req.auth.userId ?? null,
  });
  await audit(req, 'hacienda_received_decision', 'received_documents', req.params.id, { decision: b.decision, clave: doc!.clave });
  setTimeout(() => processReceivedQueue().catch(console.error), 300);
  res.json(doc);
}));

async function loadReceived(req: any) {
  const d = await db.one(`SELECT * FROM received_documents WHERE id=$1 AND business_id=$2`, [req.params.id, req.auth.businessId]);
  if (!d) throw notFound('Documento');
  return d;
}
r.get('/received/:id/pdf', requirePerm('reports.view', 'settings.manage', 'purchases.manage'), ah(async (req, res) => {
  const d = await loadReceived(req);
  const status = d.mr_status === 'accepted' ? (d.decision === '07' ? 'rejected' : 'accepted') : d.mr_status || null;
  const pdf = await renderPdf(parseComprobante(d.xml), { status, footerNote: d.decision ? `Respuesta del receptor: ${DECISIONS[d.decision]?.label}${d.decision_detail ? ' — ' + d.decision_detail : ''}` : null });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${d.consecutivo || d.clave}.pdf"`);
  res.send(pdf);
}));
r.get('/received/:id/xml', requirePerm('reports.view', 'settings.manage', 'purchases.manage'), ah(async (req, res) => {
  const d = await loadReceived(req);
  const xml = req.query.kind === 'mensaje' ? d.mr_xml : req.query.kind === 'response' ? d.mr_response_xml : d.xml;
  if (!xml) throw notFound('XML');
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${d.clave}${req.query.kind ? '_' + req.query.kind : ''}.xml"`);
  res.send(xml);
}));

// ---------------------------------------------------------------- Dashboard & reports (PRD §11)

const crcExpr = `COALESCE(d.total,0) * CASE WHEN d.currency='USD' THEN d.exchange_rate ELSE 1 END * CASE WHEN d.doc_type='03' THEN -1 ELSE 1 END`;

r.get('/dashboard', VIEW_DOCS, ah(async (req, res) => {
  const bid = req.auth.businessId;
  const { from, to } = range(req);
  const [byStatus, byType, trend, queue, last, s] = await Promise.all([
    db.query(`SELECT status, count(*)::int AS n FROM e_documents d WHERE business_id=$1 AND issued_at >= $2 AND issued_at < $3 GROUP BY status`, [bid, from, to]),
    db.query(`SELECT doc_type, count(*)::int AS n, COALESCE(SUM(${crcExpr}),0) AS total_crc FROM e_documents d WHERE business_id=$1 AND issued_at >= $2 AND issued_at < $3 AND status <> 'rejected' GROUP BY doc_type`, [bid, from, to]),
    db.query(`SELECT to_char(created_at - interval '6 hours','YYYY-MM-DD') AS day, kind, count(*)::int AS n FROM e_document_events
               WHERE business_id=$1 AND created_at >= now() - interval '14 days' AND kind IN ('validation_failed','error','rejected','auth_error','manual_review','accepted') GROUP BY 1,2 ORDER BY 1`, [bid]),
    db.one(`SELECT count(*)::int AS n, min(created_at) AS oldest FROM e_documents WHERE business_id=$1 AND status = ANY($2::text[])`, [bid, ['pending', 'signed', 'sent', 'processing', 'auth_error']]),
    db.one(`SELECT max(decided_at) AS last_accepted FROM e_documents WHERE business_id=$1 AND status='accepted'`, [bid]),
    getSettings(db, bid),
  ]);
  const taxes = await taxSummary(bid, from, to);
  const lastAuth = await db.one(`SELECT kind, created_at FROM e_document_events WHERE business_id=$1 AND kind IN ('auth_error','submit','accepted') ORDER BY created_at DESC LIMIT 1`, [bid]);
  const certDays = s?.cert_expires_at ? Math.floor((new Date(s.cert_expires_at).getTime() - Date.now()) / 86400000) : null;
  res.json({
    from, to,
    by_status: Object.fromEntries(byStatus.map((x) => [x.status, Number(x.n)])),
    by_type: byType.map((x) => ({ doc_type: x.doc_type, name: DOC_NAMES[x.doc_type as DocType], count: Number(x.n), total_crc: Math.round(Number(x.total_crc) * 100) / 100 })),
    taxes, trend,
    health: {
      enabled: !!s?.enabled, environment: s?.environment || 'stag', queue: Number(queue?.n || 0), oldest_in_queue: queue?.oldest || null,
      last_accepted: last?.last_accepted || null, credentials_ok: lastAuth ? lastAuth.kind !== 'auth_error' : null,
      certificate_days_left: certDays, certificate_expires_at: s?.cert_expires_at || null,
    },
  });
}));

/** Tax summary by IVA rate from the document XML snapshots (colones). */
async function taxSummary(bid: string, from: string, to: string, storeId?: string | null) {
  const docs = await db.query(
    `SELECT id, doc_type, xml_signed, xml_unsigned FROM e_documents WHERE business_id=$1 AND issued_at >= $2 AND issued_at < $3 AND status NOT IN ('rejected','validation_failed')
       AND ($4::uuid IS NULL OR store_id=$4) AND (xml_signed IS NOT NULL OR xml_unsigned IS NOT NULL)`, [bid, from, to, storeId || null]);
  const rates: Record<string, { rate: number; base: number; tax: number; lines: number }> = {};
  let exempt = 0, otros = 0, total = 0;
  for (const d of docs) {
    let p;
    try { p = parseComprobante(d.xml_signed || d.xml_unsigned); } catch { continue; }
    const k = (['03'].includes(d.doc_type) ? -1 : 1) * (p.tipoCambio || 1);
    for (const l of p.lines) {
      if (l.tarifa > 0) {
        const x = (rates[l.tarifa] ||= { rate: l.tarifa, base: 0, tax: 0, lines: 0 });
        x.base += l.subTotal * k; x.tax += l.impuesto * k; x.lines++;
      } else exempt += l.subTotal * k;
    }
    otros += p.resumen.otros * k;
    total += p.resumen.total * k;
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    documents: docs.length,
    rates: Object.values(rates).map((x) => ({ rate: x.rate, base: r2(x.base), tax: r2(x.tax), lines: x.lines })).sort((a, b) => b.rate - a.rate),
    exempt: r2(exempt), other_charges: r2(otros), total: r2(total), total_tax: r2(Object.values(rates).reduce((s, x) => s + x.tax, 0)),
  };
}

/** Electronic sales report grouped by day or month, document type, branch and status. */
r.get('/reports/sales', VIEW_DOCS, ah(async (req, res) => {
  const { from, to } = range(req);
  const g = req.query.group === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
  const params: any[] = [req.auth.businessId, from, to];
  let where = 'd.business_id=$1 AND d.issued_at >= $2 AND d.issued_at < $3';
  if (req.query.store_id) where += ` AND d.store_id=$${params.push(req.query.store_id)}`;
  if (req.query.doc_type) where += ` AND d.doc_type=$${params.push(req.query.doc_type)}`;
  if (req.query.status) where += ` AND d.status=$${params.push(req.query.status)}`;
  const rows = await db.query(
    `SELECT to_char(d.issued_at - interval '6 hours', '${g}') AS period, d.doc_type, st.name AS branch, d.status, d.currency, count(*)::int AS documents,
        COALESCE(SUM(d.total),0) AS total, COALESCE(SUM(${crcExpr}),0) AS total_crc
       FROM e_documents d JOIN stores st ON st.id=d.store_id WHERE ${where} GROUP BY 1,2,3,4,5 ORDER BY 1 DESC, 2`, params);
  res.json(rows.map((x) => ({ ...x, doc_name: DOC_NAMES[x.doc_type as DocType], total: Math.round(Number(x.total) * 100) / 100, total_crc: Math.round(Number(x.total_crc) * 100) / 100 })));
}));

r.get('/reports/taxes', VIEW_DOCS, ah(async (req, res) => {
  const { from, to } = range(req);
  res.json(await taxSummary(req.auth.businessId, from, to, (req.query.store_id as string) || null));
}));

/** Submission errors and rejections (with Hacienda's message). */
r.get('/reports/errors', VIEW_DOCS, ah(async (req, res) => {
  const { from, to } = range(req);
  res.json(await db.query(
    `SELECT e.created_at, e.kind, e.http_status, e.message, d.id AS document_id, d.doc_type, d.consecutivo, d.status
       FROM e_document_events e JOIN e_documents d ON d.id=e.document_id
      WHERE e.business_id=$1 AND e.created_at >= $2 AND e.created_at < $3 AND (e.kind IN ('validation_failed','error','rejected','auth_error','manual_review') OR (e.kind='submit' AND e.http_status >= 400))
      ORDER BY e.created_at DESC LIMIT 1000`, [req.auth.businessId, from, to]));
}));

// ---------------------------------------------------------------- CABYS catalogue & product mapping (PRD §5.3)

r.get('/cabys/catalogue', ah(async (_req, res) => res.json(await catalogueInfo())));
r.post('/cabys/import', requirePerm('settings.manage'), ah(async (req, res) => {
  const f = req.body?.file;
  if (!f?.content) throw bad('Seleccione el archivo del catálogo CABYS (Excel o CSV)');
  const out = await importCabys(f, req.body?.version, req.auth.userId ?? null);
  await audit(req, 'cabys_import', 'cabys_versions', null, out);
  res.json(out);
}));
r.get('/cabys/products', requirePerm('products.manage', 'settings.manage', 'reports.view'), ah(async (req, res) => res.json(await mappingReport(req.auth.businessId))));
export const assignCabysHandler = ah(async (req: any, res: any) => {
  const out = await assignProductCabys(req.auth.businessId, req.params.id, req.body?.cabys ?? null, req.body?.unit ?? null, { id: req.auth.userId ?? null, name: req.auth.userName ?? null });
  await audit(req, 'product_cabys', 'products', req.params.id, out);
  res.json(out);
});
r.put('/products/:id/cabys', requirePerm('products.manage', 'settings.manage'), assignCabysHandler);
r.get('/products/:id/cabys-history', requirePerm('products.manage', 'settings.manage'), ah(async (req, res) => {
  res.json(await db.query(`SELECT * FROM product_cabys_history WHERE business_id=$1 AND product_id=$2 ORDER BY created_at DESC`, [req.auth.businessId, req.params.id]));
}));

// ---------------------------------------------------------------- Branches (sucursales) & terminals (PRD §5.1)

r.get('/branches', requirePerm('settings.manage'), ah(async (req, res) => {
  const bid = req.auth.businessId;
  res.json({
    stores: await db.query(`SELECT id, name, hacienda_branch, hacienda_activity FROM stores WHERE business_id=$1 ORDER BY created_at`, [bid]),
    devices: await db.query(`SELECT id, name, store_id, kind, active, hacienda_terminal, last_seen_at FROM pos_devices WHERE business_id=$1 AND kind='pos' ORDER BY created_at`, [bid]),
  });
}));
r.put('/branches/:id', requirePerm('settings.manage'), ah(async (req, res) => {
  const bid = req.auth.businessId;
  const branch = req.body?.hacienda_branch ? digits(req.body.hacienda_branch).padStart(3, '0') : null;
  const activity = req.body?.hacienda_activity ? digits(req.body.hacienda_activity) : null;
  if (branch && (branch.length !== 3 || branch === '000')) throw bad('La sucursal debe ser un número de 3 dígitos (001–999)');
  if (activity && activity.length !== 6) throw bad('La actividad económica debe tener 6 dígitos');
  if (branch && (await db.one(`SELECT 1 FROM stores WHERE business_id=$1 AND hacienda_branch=$2 AND id<>$3`, [bid, branch, req.params.id]))) throw bad(`La sucursal ${branch} ya está asignada a otro local`);
  const used = await db.one(`SELECT hacienda_branch FROM stores WHERE id=$1 AND business_id=$2`, [req.params.id, bid]);
  if (!used) throw notFound('Local');
  if (used.hacienda_branch && branch !== used.hacienda_branch && (await db.one(`SELECT 1 FROM e_documents WHERE store_id=$1 LIMIT 1`, [req.params.id]))) throw bad('Este local ya emitió comprobantes: cambiar su sucursal cambiaría la numeración. Cree un local nuevo si abre otra sucursal.');
  await db.query(`UPDATE stores SET hacienda_branch=COALESCE($2, hacienda_branch), hacienda_activity=$3 WHERE id=$1`, [req.params.id, branch, activity]);
  await audit(req, 'hacienda_branch', 'stores', req.params.id, { branch, activity });
  res.json({ ok: true });
}));
r.put('/terminals/:id', requirePerm('settings.manage'), ah(async (req, res) => {
  const bid = req.auth.businessId;
  const t = req.body?.hacienda_terminal ? digits(req.body.hacienda_terminal).padStart(5, '0') : null;
  if (t && (t.length !== 5 || t === '00000')) throw bad('La terminal debe ser un número de hasta 5 dígitos');
  const dev = await db.one(`SELECT * FROM pos_devices WHERE id=$1 AND business_id=$2`, [req.params.id, bid]);
  if (!dev) throw notFound('Dispositivo');
  if (t && (await db.one(`SELECT 1 FROM pos_devices WHERE business_id=$1 AND store_id=$2 AND hacienda_terminal=$3 AND id<>$4`, [bid, dev.store_id, t, dev.id]))) throw bad(`La terminal ${t} ya está asignada a otro dispositivo de este local`);
  await db.query(`UPDATE pos_devices SET hacienda_terminal=$2 WHERE id=$1`, [dev.id, t]);
  await audit(req, 'hacienda_terminal', 'pos_devices', dev.id, { terminal: t });
  res.json({ ok: true });
}));

/** Labels for the UI. */
r.get('/meta', ah(async (_req, res) => res.json({ doc_names: DOC_NAMES, id_types: ID_TYPES })));

export default r;
export type { DocType };
