import { Router } from 'express';
import { db, tx } from '../db.ts';
import { requirePerm, requireUser } from '../auth.ts';
import { ah, audit, bad, notFound, range } from '../util.ts';
import { ID_TYPES, digits, validateId, DEFAULT_RESOLUTION, DOC_NAMES, type DocType } from '../hacienda/codes.ts';
import { encrypt, decrypt, decryptBuf } from '../hacienda/secrets.ts';
import { loadP12, signXml, verifyXml } from '../hacienda/sign.ts';
import { getToken } from '../hacienda/client.ts';
import { cleanReceptor, convertToFactura, emailDocument, getSettings, issueDocument, kickQueue, processQueue, smtpConfigured } from '../hacienda/service.ts';

const r = Router();

const FIELDS = ['environment', 'legal_name', 'trade_name', 'id_type', 'id_number', 'activity_code', 'provider_id', 'provincia', 'canton', 'distrito',
  'barrio', 'otras_senas', 'phone', 'email', 'default_cabys', 'resolution_text', 'api_username'] as const;

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
  }
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
  d.reference, d.replaced_by, d.emailed_at, d.email_error, d.sale_id, s.receipt_no, s.type AS sale_type, st.name AS store_name`;

r.get('/documents', requirePerm('reports.view', 'settings.manage'), ah(async (req, res) => {
  const { from, to } = range(req);
  const params: any[] = [req.auth.businessId, from, to];
  let where = `d.business_id=$1 AND d.issued_at >= $2 AND d.issued_at < $3`;
  if (req.query.status) where += ` AND d.status=$${params.push(req.query.status)}`;
  if (req.query.doc_type) where += ` AND d.doc_type=$${params.push(req.query.doc_type)}`;
  if (req.query.q) {
    const i = params.push(`%${req.query.q}%`);
    where += ` AND (d.clave ILIKE $${i} OR d.consecutivo ILIKE $${i} OR s.receipt_no ILIKE $${i} OR d.receptor->>'nombre' ILIKE $${i} OR d.receptor->>'id_number' ILIKE $${i})`;
  }
  const rows = await db.query(
    `SELECT ${LIST_COLS} FROM e_documents d JOIN sales s ON s.id=d.sale_id JOIN stores st ON st.id=d.store_id WHERE ${where} ORDER BY d.issued_at DESC, d.created_at DESC LIMIT 1000`,
    params,
  );
  const counts = await db.query(`SELECT status, count(*)::int AS n FROM e_documents WHERE business_id=$1 GROUP BY status`, [req.auth.businessId]);
  res.json({ rows, counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) });
}));

async function loadDoc(req: any) {
  const d = await db.one(`SELECT * FROM e_documents WHERE id=$1 AND business_id=$2`, [req.params.id, req.auth.businessId]);
  if (!d) throw notFound('Documento');
  return d;
}

r.get('/documents/:id/xml', requirePerm('reports.view', 'settings.manage', 'pos.sell'), ah(async (req, res) => {
  const d = await loadDoc(req);
  const xml = req.query.kind === 'response' ? d.response_xml : d.xml_signed;
  if (!xml) throw notFound(req.query.kind === 'response' ? 'Respuesta de Hacienda' : 'XML firmado');
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${d.clave}${req.query.kind === 'response' ? '_respuesta' : ''}.xml"`);
  res.send(xml);
}));

/** Retry a document that failed before Hacienda accepted it (rebuilds the XML with the current product/settings data). */
r.post('/documents/:id/retry', requirePerm('settings.manage', 'reports.view'), ah(async (req, res) => {
  const d = await loadDoc(req);
  if (d.status === 'accepted') throw bad('El documento ya fue aceptado por Hacienda');
  if (d.status === 'rejected') throw bad('Un documento rechazado no se puede reenviar: use "Reemitir"');
  await db.query(`UPDATE e_documents SET status=CASE WHEN status='sent' THEN 'sent' ELSE 'pending' END, xml_signed=CASE WHEN status='sent' THEN xml_signed ELSE NULL END,
    attempts=0, next_attempt_at=now(), message=NULL, updated_at=now() WHERE id=$1`, [d.id]);
  await audit(req, 'hacienda_retry', 'e_documents', d.id, { clave: d.clave });
  await processQueue();
  res.json(await db.one(`SELECT id, status, message FROM e_documents WHERE id=$1`, [d.id]));
}));

/** Issue a new document (new consecutivo/clave) for one that Hacienda rejected. */
r.post('/documents/:id/reissue', requirePerm('settings.manage'), ah(async (req, res) => {
  const d = await loadDoc(req);
  if (d.status !== 'rejected' && d.status !== 'error') throw bad('Solo se reemiten documentos rechazados o con error');
  const nd = await tx(async (q) => {
    const n = await issueDocument(q, {
      businessId: d.business_id, storeId: d.store_id, saleId: d.sale_id, docType: d.doc_type, issuedAt: new Date(), receptor: d.receptor,
      reference: d.reference, userId: req.auth.userId,
    });
    if (!n) throw bad('La facturación electrónica no está activada');
    await q.query(`UPDATE e_documents SET replaced_by=$2, status=CASE WHEN status='error' THEN 'rejected' ELSE status END, updated_at=now() WHERE id=$1`, [d.id, n.id]);
    return n;
  });
  await audit(req, 'hacienda_reissue', 'e_documents', nd.id, { replaces: d.clave });
  kickQueue();
  res.status(201).json(nd);
}));

r.post('/documents/:id/email', requirePerm('pos.sell', 'reports.view'), ah(async (req, res) => {
  const d = await loadDoc(req);
  await emailDocument(d.id, req.body?.email || undefined);
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

/** Labels for the UI. */
r.get('/meta', ah(async (_req, res) => res.json({ doc_names: DOC_NAMES, id_types: ID_TYPES })));

export default r;
export type { DocType };
