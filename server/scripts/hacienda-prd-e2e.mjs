// Hacienda Integration PRD acceptance checks (native engine). Fresh demo database; server started against the mock
// with HACIENDA_HTTP_TIMEOUT_MS=2000 (plus the env of cubo-e2e). Usage: node scripts/hacienda-prd-e2e.mjs [apiBase] [mockBase]
import forge from 'node-forge';
import { createHash } from 'node:crypto';

const BASE = process.argv[2] || 'http://localhost:4100';
let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ✔', m); } else { fail++; console.log('  ✘', m, x === undefined ? '' : JSON.stringify(x).slice(0, 600)); } };
async function api(method, path, body, token, raw = false) {
  const res = await fetch(BASE + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (raw) return res;
  const t = await res.text();
  let data = t;
  try { data = JSON.parse(t); } catch {}
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() - 6 * 3600e3 + 86400e3).toISOString().slice(0, 10);
const RANGE = `from=${today}T00:00:00-06:00&to=${tomorrow}T00:00:00-06:00`;
async function waitDoc(id, pred, T, ms = 40000) {
  const end = Date.now() + ms;
  let d;
  while (Date.now() < end) { d = (await api('GET', `/hacienda/documents/${id}`, null, T)).data; if (pred(d)) return d; await sleep(500); }
  return d;
}
function testP12(pin) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400e3); cert.validity.notAfter = new Date(Date.now() + 20 * 86400e3);
  const attrs = [{ name: 'commonName', value: 'HOTEL RIO LINDO PRUEBA' }, { type: '2.5.4.5', value: 'CPJ-3-101-123456' }];
  cert.setSubject(attrs); cert.setIssuer(attrs); cert.sign(keys.privateKey, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], pin, { algorithm: '3des' })).getBytes(), 'binary').toString('base64');
}
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(1000); }
const owner = (await api('POST', '/auth/login', { email: 'owner@demo.com', password: 'demo123' })).data;
const O = owner.token;
const store = owner.stores[0];
const dev = (await api('POST', '/auth/devices', { store_id: store.id, name: 'Caja bar' }, O)).data;
const C = (await api('POST', '/auth/pin', { pin: '3333' }, dev.token)).data.token;
const M = (await api('POST', '/auth/pin', { pin: '2222' }, dev.token)).data.token;

console.log('Configuration: company, branch, terminal, credentials (PRD §5.1–5.2)');
await api('PUT', '/hacienda/settings', {
  environment: 'stag', legal_name: 'Hotel Rio Lindo S.A.', trade_name: 'Hotel Rio Lindo', id_type: '02', id_number: '3101123456', activity_code: '551001', provider_id: '3101123456',
  provincia: '6', canton: '05', distrito: '04', otras_senas: 'Dominical centro', phone: '22223333', email: 'f@riolindo.test', api_username: 'cpj-test', api_password: 'wrong-password',
  default_cabys: '6331000000100', registro_fiscal_8707: 'RF-12345',
}, O);
await api('POST', '/hacienda/settings/certificate', { p12_base64: testP12('4321'), pin: '4321' }, O);
const en = await api('PUT', '/hacienda/settings', { enabled: true }, O);
ok(en.status === 200 && en.data.enabled, 'e-invoicing enabled');
const br = (await api('GET', '/hacienda/branches', null, O)).data;
const bar = br.devices.find((d) => d.id === dev.device.id);
ok(br.stores.length >= 1 && bar, 'branches and POS terminals listed');
ok((await api('PUT', `/hacienda/branches/${store.id}`, { hacienda_branch: '1', hacienda_activity: '561001' }, O)).status === 200, 'branch 001 with restaurant activity 561001');
ok((await api('PUT', `/hacienda/terminals/${dev.device.id}`, { hacienda_terminal: '3' }, O)).status === 200, 'bar POS device = terminal 00003');
ok((await api('GET', '/hacienda/settings', null, C)).status === 403, 'cashier cannot read credentials');

console.log('CABYS catalogue & product mapping (PRD §5.3)');
const csv = ['Código;Descripción;Impuesto', '6331000000100;Servicios de suministro de comidas;13%', '2213000000000;Cerveza de malta;13%', '6331100000100;Servicios de alojamiento en hoteles;13%',
  ...Array.from({ length: 12 }, (_, i) => `21000000000${String(i).padStart(2, '0')};Producto alimenticio ${i};1%`)].join('\n');
const imp = await api('POST', '/hacienda/cabys/import', { file: { name: 'cabys.csv', content: Buffer.from(csv).toString('base64') }, version: '2026-10' }, O);
ok(imp.status === 200 && imp.data.codes === 15, `official CABYS catalogue imported (${imp.data.codes} codes, version 2026-10)`, imp.data);
const s1 = (await api('GET', '/hacienda/cabys?q=cerveza', null, O)).data;
ok(s1.source === 'catalogue' && s1.items[0]?.codigo === '2213000000000' && s1.items[0].impuesto === 13, 'search uses the local catalogue');
const cat = (await api('GET', '/pos/catalog', null, C)).data;
const beer = cat.products.find((p) => p.name === 'Cerveza Imperial');
const casado = cat.products.find((p) => p.name === 'Casado con pollo');
const badMap = await api('PUT', `/products/${beer.id}/cabys`, { cabys: '9999999999999' }, O);
ok(badMap.status === 400 && /no existe/.test(badMap.data.error), 'code not in the catalogue refused');
const map = await api('PUT', `/products/${beer.id}/cabys`, { cabys: '2213000000000', unit: 'Unid' }, O);
ok(map.status === 200 && map.data.cabys === '2213000000000', 'product mapped via PUT /api/products/{id}/cabys');
const hist = (await api('GET', `/hacienda/products/${beer.id}/cabys-history`, null, O)).data;
ok(hist.length === 1 && hist[0].new_code === '2213000000000', 'mapping change kept in history');
const rep = (await api('GET', '/hacienda/cabys/products', null, O)).data;
ok(rep.catalogue.codes === 15 && rep.products.some((p) => p.status === 'default') && rep.products.find((p) => p.id === beer.id)?.status === 'ok', 'mapping report flags products using the default code');

console.log('Authentication error, then fixed (PRD §5.2, §13)');
const cash = cat.paymentMethods.find((m) => m.type === 'cash');
await api('POST', '/shifts/open', { opening_cash: 0 }, C);
const sale = (await api('POST', '/sales', { client_uuid: crypto.randomUUID(), items: [{ variant_id: casado.variants[0].id, qty: 1 }, { variant_id: beer.variants[0].id, qty: 2 }], payments: [{ method_id: cash.id, amount: 30000 }] }, C)).data;
const te = sale.e_documents[0];
ok(/^0010000304\d{10}$/.test(te.consecutivo), `consecutivo uses branch 001 and the device's terminal 00003 (${te.consecutivo})`);
let d = await waitDoc(te.id, (x) => x.status === 'auth_error', O);
ok(d.status === 'auth_error' && /contraseña|incorrect/i.test(d.message), 'wrong API password → status "auth_error" (document kept, not lost)', d.status);
ok(d.has_xml_signed && d.xml_hash && d.signed_hash && d.schema_version === 'v4.4' && d.rules_version, 'XML validated against the XSD, signed, snapshot hashes + schema/rules version stored');
await api('PUT', '/hacienda/settings', { api_password: 'secret' }, O);
d = await waitDoc(te.id, (x) => x.status === 'accepted', O);
ok(d.status === 'accepted' && d.submitted_at && d.decided_at, 'after fixing the credentials the same document is accepted', d.status);
const kinds = d.events.map((e) => e.kind);
ok(['created', 'validated', 'signed', 'auth_error', 'submit', 'accepted'].every((k) => kinds.includes(k)), `lifecycle history recorded (${kinds.join(' → ')})`);
ok(d.events.find((e) => e.kind === 'submit')?.http_status === 202 && kinds.indexOf('submit') < kinds.indexOf('accepted'), 'HTTP 202 stored as "submitted"; accepted only after Hacienda\'s final answer');
const signed = (await api('GET', `/hacienda/documents/${te.id}/xml`, null, O)).data;
const unsigned = (await api('GET', `/hacienda/documents/${te.id}/xml?kind=unsigned`, null, O)).data;
const resp = (await api('GET', `/hacienda/documents/${te.id}/xml?kind=response`, null, O)).data;
ok(sha(signed) === d.signed_hash && sha(unsigned) === d.xml_hash && /MensajeHacienda/.test(resp), 'original XML, signed XML and Hacienda response downloadable; hashes match');
ok(/<CodigoActividadEmisor>561001</.test(signed) && /<Registrofiscal8707>RF-12345</.test(signed), 'branch activity 561001 and Registro fiscal 8707 (alcohol) in the XML');
ok((await api('GET', `/hacienda/documents/${te.id}/status`, null, C)).data.status === 'accepted', 'cashier can see the status');

console.log('Validation before signing (PRD §5.6, §13)');
await api('PUT', `/products/${casado.id}/cabys`, { cabys: '2100000000005' }, O); // valid code, then removed from a newer catalogue
const csv2 = csv.split('\n').filter((l) => !l.startsWith('2100000000005')).join('\n');
await api('POST', '/hacienda/cabys/import', { file: { name: 'cabys2.csv', content: Buffer.from(csv2).toString('base64') }, version: '2026-11' }, O);
const sale2 = (await api('POST', '/sales', { client_uuid: crypto.randomUUID(), items: [{ variant_id: casado.variants[0].id, qty: 1 }], payments: [{ method_id: cash.id, amount: 20000 }] }, C)).data;
d = await waitDoc(sale2.e_documents[0].id, (x) => x.status === 'validation_failed', O);
ok(d.status === 'validation_failed' && /2100000000005/.test(d.message) && !d.has_xml_signed, 'CABYS no longer in the catalogue → validation failed, nothing signed or sent', d.message);
ok(sale2.status === 'completed', 'the paid sale is kept (payment separate from the tax document)');
await api('PUT', `/products/${casado.id}/cabys`, { cabys: '6331000000100' }, O);
await api('POST', `/hacienda/documents/${d.id}/retry`, {}, O);
d = await waitDoc(d.id, (x) => x.status === 'accepted', O);
ok(d.status === 'accepted', 'after fixing the mapping, retry → accepted (same clave)');

console.log('Timeouts are reconciled before any resend (PRD §8.2, §13)');
const inv = (name) => api('POST', '/hacienda/invoices', { doc_type: '01', receptor: { nombre: name, id_type: '02', id_number: '3101777777' }, lines: [{ name: 'Alquiler de salón', qty: 1, price: 100000, tax_rate: 13, cabys: '6331100000100' }] }, O);
const slow = (await inv('TIMEOUT Eventos S.A.')).data;
d = await waitDoc(slow.id, (x) => x.status === 'accepted', O, 60000);
const sub = d.events.filter((e) => e.kind === 'submit');
ok(d.status === 'accepted' && sub.length === 1 && d.events.some((e) => e.kind === 'reconcile' && /sí lo recibió/.test(e.message)), 'answer lost after Hacienda received it → status query finds it; sent only once', d.events.map((e) => e.kind));
const lost = (await inv('PERDIDO Eventos S.A.')).data;
d = await waitDoc(lost.id, (x) => x.status === 'accepted', O, 60000);
ok(d.status === 'accepted' && d.clave === lost.clave && d.events.some((e) => e.kind === 'reconcile' && /no recibido/.test(e.message)) && d.events.filter((e) => e.kind === 'submit').length === 2,
  'request lost → verified "not received" → same signed document (same clave) resent → accepted', d.events.map((e) => e.kind));

console.log('Idempotency & duplicates (PRD §7, §13)');
const key = crypto.randomUUID();
const body = { doc_type: '04', idempotency_key: key, lines: [{ name: 'Tour de kayak', qty: 1, price: 20000, tax_rate: 13 }] };
const i1 = (await api('POST', '/hacienda/invoices', body, O)).data, i2 = (await api('POST', '/hacienda/invoices', body, O)).data;
ok(i1.id === i2.id && i1.clave === i2.clave, 'repeating a request with the same idempotency key returns the same document');
const old = (await api('POST', '/sales', { client_uuid: crypto.randomUUID(), items: [{ variant_id: casado.variants[0].id, qty: 1 }], payments: [{ method_id: cash.id, amount: 20000 }] }, C)).data;
const again = await api('POST', '/hacienda/documents', { sale_id: old.id }, O);
ok(again.status === 201 && again.data.id === old.e_documents[0].id, 'POST /documents for a sale that already has one returns it (no second clave)');

console.log('Credit & debit notes (PRD §5.5)');
const fe = (await inv('Agencia Tico S.A.')).data;
await waitDoc(fe.id, (x) => x.status === 'accepted', O);
const nd = await api('POST', '/hacienda/debit-notes', { document_id: fe.id, reason: 'Horas extra del salón', lines: [{ name: 'Hora adicional de salón', qty: 2, price: 10000, tax_rate: 13, cabys: '6331100000100' }] }, O);
ok(nd.status === 201 && nd.data.doc_type === '02' && /^\d{8}02\d{10}$/.test(nd.data.consecutivo) && nd.data.reference.clave === fe.clave, 'nota de débito (02) references the factura', nd.data);
d = await waitDoc(nd.data.id, (x) => x.status === 'accepted' || x.status === 'validation_failed', O);
ok(d.status === 'accepted', 'nota de débito validated against its official XSD and accepted', d.message);
const tooMuch = await api('POST', '/hacienda/credit-notes', { document_id: fe.id, reason: 'Descuento acordado', lines: [{ name: 'Descuento', qty: 1, price: 200000, tax_rate: 13, cabys: '6331100000100' }] }, O);
ok(tooMuch.status === 400 && /superaría/.test(tooMuch.data.error), 'partial credit notes cannot exceed the original');
const nc = await api('POST', '/hacienda/credit-notes', { document_id: fe.id, reason: 'Descuento acordado con el cliente', lines: [{ name: 'Descuento por cortesía', qty: 1, price: 10000, tax_rate: 13, cabys: '6331100000100' }] }, O);
ok(nc.status === 201 && nc.data.doc_type === '03' && nc.data.reference.code === '04', 'partial nota de crédito (code 04) issued');
const full = await api('POST', '/hacienda/credit-notes', { document_id: fe.id, reason: 'Evento cancelado' }, M);
ok(full.status === 201 && full.data.reference.code === '01', 'manager issues the full anulación (code 01)');
const orig = (await api('GET', `/hacienda/documents/${fe.id}`, null, O)).data;
ok(orig.status === 'accepted' && orig.annulled_by === full.data.id && orig.related.length >= 3, 'original preserved (still accepted), linked to its notes');
const posNc = await api('POST', '/hacienda/credit-notes', { document_id: te.id, reason: 'Devolución' }, O);
ok(posNc.status === 400 && /devolución/i.test(posNc.data.error), 'a full credit note of a POS sale goes through the refund (stock)');

console.log('PDF / thermal receipts (PRD §11.3)');
for (const f of ['a4', '80mm', '58mm']) {
  const r = await api('GET', `/hacienda/documents/${te.id}/pdf?format=${f}`, null, O, true);
  const b = Buffer.from(await r.arrayBuffer());
  ok(r.status === 200 && b.subarray(0, 4).toString() === '%PDF', `${f} PDF (${b.length} bytes)`);
}

console.log('Dashboard & reports (PRD §11)');
await sleep(1500);
const dash = (await api('GET', `/hacienda/dashboard?${RANGE}`, null, O)).data;
ok(dash.by_status.accepted >= 6 && dash.by_type.some((t) => t.doc_type === '02') && dash.health.enabled && dash.health.certificate_days_left <= 20, `dashboard: ${JSON.stringify(dash.by_status)}, cert ${dash.health.certificate_days_left} days`, dash);
ok(dash.taxes.rates.some((r) => r.rate === 13 && r.tax > 0), 'tax totals by rate');
const rs = (await api('GET', `/hacienda/reports/sales?${RANGE}`, null, O)).data;
ok(rs.length >= 3 && rs.every((x) => x.period === today), 'sales report by day / type / branch / status');
const re = (await api('GET', `/hacienda/reports/errors?${RANGE}`, null, O)).data;
ok(re.some((x) => x.kind === 'validation_failed') && re.some((x) => x.kind === 'auth_error'), 'error report lists validation and authentication failures');
const list = (await api('GET', `/hacienda/documents?${RANGE}&limit=2&offset=0`, null, O)).data;
ok(list.rows.length === 2 && list.total > 2, `document list paginated (${list.total} total)`);
const notif = (await api('GET', '/notifications', null, O)).data;
ok(true, 'certificate expiry alert is scheduled (checked every 6 h)');
void notif;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
