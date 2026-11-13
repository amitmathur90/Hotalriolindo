// End-to-end check of Costa Rica e-invoicing against the mock Hacienda (scripts/hacienda-mock.ts).
// Usage: node scripts/hacienda-e2e.mjs [apiBase] [mockBase]   (fresh demo database)
import forge from 'node-forge';

const BASE = process.argv[2] || 'http://localhost:4100';
const MOCK = process.argv[3] || 'http://localhost:4199';
let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✔', msg); } else { fail++; console.log('  ✘', msg, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)); }
};
async function api(method, path, body, token) {
  const res = await fetch(BASE + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDoc(saleId, token, pred, ms = 25000) {
  const end = Date.now() + ms;
  let s;
  while (Date.now() < end) {
    s = (await api('GET', `/sales/${saleId}`, null, token)).data;
    if (pred(s.e_documents || [])) return s;
    await sleep(500);
  }
  return s;
}
function testP12(pin) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400e3);
  const attrs = [{ name: 'commonName', value: 'HOTEL RIO LINDO PRUEBA' }, { type: '2.5.4.5', value: 'CPJ-3-101-123456' }, { name: 'countryName', value: 'CR' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], pin, { algorithm: '3des' })).getBytes(), 'binary').toString('base64');
}
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(1000); }

console.log('Single-hotel mode');
const cfg = (await api('GET', '/public/config')).data;
ok(cfg.multi_tenant === false && cfg.setup_needed === false && cfg.business_name === 'Hotel Rio Lindo', 'public config: single hotel, no setup needed', cfg);
const reg = await api('POST', '/auth/register', { businessName: 'Otro Hotel', ownerName: 'X', email: 'x@x.com', password: 'secret12' });
ok(reg.status === 403, 'public sign-up is closed', reg.data);
const sa = await api('POST', '/auth/login', { email: 'admin@itspos.local', password: 'admin123' });
ok(sa.status === 401 || sa.status === 403, 'no platform super admin in single-hotel mode', sa.status);

const owner = (await api('POST', '/auth/login', { email: 'owner@demo.com', password: 'demo123' })).data;
const O = owner.token;
const store = owner.stores[0];
const dev = (await api('POST', '/auth/devices', { store_id: store.id, name: 'Hacienda E2E' }, O)).data;
const C = (await api('POST', '/auth/pin', { pin: '3333' }, dev.token)).data.token;
const M = (await api('POST', '/auth/pin', { pin: '2222' }, dev.token)).data.token;
await api('POST', '/shifts/open', { opening_cash: 0 }, C);
const cat = (await api('GET', '/pos/catalog', null, C)).data;
const P = (n) => cat.products.find((p) => p.name === n);
const cash = cat.paymentMethods.find((m) => m.type === 'cash');
const card = cat.paymentMethods.find((m) => m.type === 'card');
const sinpe = cat.paymentMethods.find((m) => /sinpe/i.test(m.name));
const empanada = P('Empanada de queso'), casado = P('Casado con pollo'), cerveza = P('Cerveza Imperial');
const saleBody = (extra = {}) => ({
  client_uuid: crypto.randomUUID(), dining_option: 'dine_in',
  items: [{ variant_id: casado.variants[0].id, qty: 1 }, { variant_id: empanada.variants[0].id, qty: 2 }, { variant_id: cerveza.variants[0].id, qty: 1 }],
  payments: [{ method_id: cash.id, amount: 20000 }], ...extra,
});

console.log('Before activation');
const s0 = await api('POST', '/sales', saleBody(), C);
ok(s0.status === 201 && s0.data.e_documents.length === 0, 'sales work without e-invoicing (no documents)');
const fe0 = await api('POST', '/sales', saleBody({ einvoice: { type: 'FE', receptor: { nombre: 'Juan Pérez', id_type: '01', id_number: '111111111' } } }), C);
ok(fe0.status === 400 && /no está activada/.test(fe0.data.error), 'factura refused while e-invoicing is off', fe0.data);

console.log('Settings');
let st = (await api('GET', '/hacienda/settings', null, O)).data;
ok(st.enabled === false && st.missing.length >= 5, `settings start disabled, missing ${st.missing.length} items`);
ok((await api('GET', '/hacienda/settings', null, C)).status === 403, 'cashier cannot see Hacienda settings');
st = (await api('PUT', '/hacienda/settings', {
  environment: 'stag', legal_name: 'Hotel Rio Lindo S.A.', trade_name: 'Hotel Rio Lindo', id_type: '02', id_number: '3-101-123456',
  activity_code: '551001', provider_id: '3101123456', provincia: '6', canton: '01', distrito: '01', otras_senas: 'Frente al río, Puntarenas',
  phone: '2222-3333', email: 'facturas@riolindo.test', api_username: 'cpj-test', api_password: 'secret',
}, O)).data;
ok(st.has_password === true && st.api_password_enc === undefined, 'API password stored (never returned)');
const en1 = await api('PUT', '/hacienda/settings', { enabled: true }, O);
ok(en1.status === 400 && /Llave/.test(en1.data.error), 'cannot enable without the llave criptográfica', en1.data);
const p12 = testP12('4321');
const badPin = await api('POST', '/hacienda/settings/certificate', { p12_base64: p12, pin: '0000' }, O);
ok(badPin.status === 400 && /PIN/.test(badPin.data.error), 'wrong .p12 PIN rejected');
const up = await api('POST', '/hacienda/settings/certificate', { p12_base64: p12, pin: '4321' }, O);
ok(up.status === 200 && up.data.has_certificate && /RIO LINDO/.test(up.data.cert_subject) && !up.data.warning, 'certificate uploaded and matches the cédula', up.data);
const test = (await api('POST', '/hacienda/settings/test', {}, O)).data;
ok(test.credentials.ok && test.certificate.ok, 'connection test: credentials + signature OK', test);
const en2 = await api('PUT', '/hacienda/settings', { enabled: true }, O);
ok(en2.status === 200 && en2.data.enabled && en2.data.missing.length === 0, 'e-invoicing enabled');

console.log('Tiquete electrónico');
const t1 = await api('POST', '/sales', saleBody(), C);
const te = t1.data.e_documents?.[0];
ok(t1.status === 201 && te?.doc_type === '04', 'sale issues a tiquete electrónico', t1.data.e_documents);
ok(/^\d{50}$/.test(te?.clave) && te.clave.startsWith('506') && te.clave.slice(9, 21) === '003101123456', `clave has 50 digits with the hotel's cédula (${te?.clave})`);
ok(/^0010000104\d{10}$/.test(te?.consecutivo), `consecutivo 001-00001-04-… (${te?.consecutivo})`);
ok(te.clave.slice(21, 41) === te.consecutivo && te.clave[41] === '1', 'clave embeds the consecutivo and situación normal');
let s1 = await waitDoc(t1.data.id, C, (d) => d[0]?.status === 'error');
ok(s1.e_documents[0].status === 'error' && /CABYS/.test(s1.e_documents[0].message), 'missing CABYS code is reported, not silently sent', s1.e_documents[0]);
await api('PUT', '/hacienda/settings', { default_cabys: '6331000000100' }, O);
const retry = await api('POST', `/hacienda/documents/${te.id}/retry`, {}, O);
ok(retry.status === 200, 'retry after fixing the CABYS code', retry.data);
s1 = await waitDoc(t1.data.id, C, (d) => d[0]?.status === 'accepted');
ok(s1.e_documents[0].status === 'accepted', 'tiquete accepted by Hacienda', s1.e_documents[0]);
const t2 = await api('POST', '/sales', saleBody(), C);
ok(t2.data.e_documents[0].consecutivo.endsWith('0000000002'), 'next tiquete gets the next consecutive number');

console.log('Factura electrónica at checkout');
const cust = (await api('POST', '/customers', { name: 'Comercial Pacífico S.A.', phone: '88887777' }, C)).data;
const badId = await api('POST', '/sales', saleBody({ einvoice: { type: 'FE', receptor: { nombre: 'Comercial Pacífico', id_type: '02', id_number: '12345' } } }), C);
ok(badId.status === 400 && /10 dígitos/.test(badId.data.error), 'invalid cédula jurídica rejected', badId.data);
const f1 = await api('POST', '/sales', saleBody({
  customer_id: cust.id, payments: [{ method_id: card.id, amount: t2.data.total - 5000 }, { method_id: sinpe.id, amount: 5000 }],
  einvoice: { type: 'FE', receptor: { nombre: 'Comercial Pacífico S.A.', id_type: '02', id_number: '3-101-654321', email: 'compras@pacifico.test', activity_code: '471101' } },
}), C);
const fe = f1.data.e_documents?.[0];
ok(f1.status === 201 && fe?.doc_type === '01' && fe.receptor.id_number === '3101654321', 'sale issues a factura electrónica with the customer tax details', f1.data);
ok(/^0010000101/.test(fe.consecutivo), 'factura consecutivo uses type 01');
const custAfter = (await api('GET', `/customers/${cust.id}`, null, O)).data;
ok(custAfter.tax_id === '3101654321' && custAfter.id_type === '02' && custAfter.email === 'compras@pacifico.test', 'customer tax details remembered for next time', custAfter);
const f1s = await waitDoc(f1.data.id, C, (d) => d[0]?.status === 'accepted');
ok(f1s.e_documents[0].status === 'accepted', 'factura accepted');

console.log('Factura on demand (tiquete → factura)');
const conv = await api('POST', `/hacienda/sales/${t2.data.id}/factura`, { receptor: { nombre: 'María Solano', id_type: '01', id_number: '1-0234-0567', email: 'maria@example.test' } }, C);
ok(conv.status === 201 && conv.data.factura.doc_type === '01' && conv.data.nota.doc_type === '03', 'tiquete annulled by nota de crédito and replaced by factura', conv.data);
ok(conv.data.nota.reference.clave === t2.data.e_documents[0].clave && conv.data.nota.reference.code === '01', 'nota de crédito references and annuls the tiquete');
const again = await api('POST', `/hacienda/sales/${t2.data.id}/factura`, { receptor: { nombre: 'María Solano', id_type: '01', id_number: '102340567' } }, C);
ok(again.status === 400 && /ya tiene factura/.test(again.data.error), 'second factura for the same sale refused');
const t2s = await waitDoc(t2.data.id, C, (d) => d.length === 3 && d.every((x) => x.status === 'accepted'));
ok(t2s.e_documents.length === 3 && t2s.e_documents.every((x) => x.status === 'accepted'), 'tiquete, nota de crédito and factura all accepted', t2s.e_documents.map((d) => [d.doc_type, d.status]));
ok(t2s.e_documents.find((d) => d.doc_type === '04').replaced_by === conv.data.factura.id, 'tiquete marked as replaced by the factura');

console.log('Refund → nota de crédito');
const appr = (await api('POST', '/auth/approve', { pin: '2222', permission: 'pos.refund' }, C)).data.approval_token;
const ref = await api('POST', `/sales/${f1.data.id}/refund`, { reason: 'Producto equivocado', items: [{ sale_item_id: f1.data.items[1].id, qty: 1 }], approval_token: appr }, C);
const nc = ref.data.e_documents?.[0];
ok(ref.status === 201 && nc?.doc_type === '03' && nc.reference.clave === fe.clave && nc.reference.code === '06', 'partial refund issues a nota de crédito referencing the factura (devolución)', ref.data.e_documents);
ok(nc.receptor?.id_number === '3101654321', 'nota de crédito keeps the factura receptor');
const refS = await waitDoc(ref.data.id, M, (d) => d[0]?.status === 'accepted');
ok(refS.e_documents[0].status === 'accepted', 'nota de crédito accepted');

console.log('Rejected documents');
const rj = await api('POST', '/sales', saleBody({ einvoice: { type: 'FE', receptor: { nombre: 'RECHAZAR', id_type: '01', id_number: '109990999' } } }), C);
const rjS = await waitDoc(rj.data.id, C, (d) => d[0]?.status === 'rejected');
ok(rjS.e_documents[0].status === 'rejected' && /rechazado/i.test(rjS.e_documents[0].message), 'Hacienda rejection is recorded with its message', rjS.e_documents[0]);
const notif = (await api('GET', '/settings/notifications', null, O)).data;
ok(Array.isArray(notif) && notif.some((n) => n.type === 'hacienda'), 'owner notified about the rejection');
const re = await api('POST', `/hacienda/documents/${rjS.e_documents[0].id}/reissue`, {}, O);
ok(re.status === 201 && re.data.clave !== rjS.e_documents[0].clave, 'rejected document can be re-issued with a new clave', re.data);

console.log('Documents, downloads, offline');
const list = (await api('GET', `/hacienda/documents?from=${new Date(Date.now() - 2 * 86400e3).toISOString()}&to=${new Date(Date.now() + 86400e3).toISOString()}`, null, O)).data;
ok(list.rows.length >= 8 && list.counts.accepted >= 6, `documents list (${list.rows.length} docs, ${list.counts.accepted} accepted)`, list.counts);
const xml = await api('GET', `/hacienda/documents/${fe.id}/xml`, null, O);
ok(xml.status === 200 && String(xml.data).includes('<FacturaElectronica') && String(xml.data).includes('<ds:Signature'), 'signed XML downloadable');
const resp = await api('GET', `/hacienda/documents/${fe.id}/xml?kind=response`, null, O);
ok(resp.status === 200 && String(resp.data).includes('MensajeHacienda'), 'Hacienda response XML downloadable');
const off = await api('POST', '/sales', saleBody({ offline: true, created_at: new Date(Date.now() - 3600e3).toISOString() }), C);
ok(off.data.e_documents[0].clave[41] === '3', 'offline sale synced later is issued with situación 3 (sin internet)');
const received = await (await fetch(MOCK + '/_received')).json();
ok(received.length >= 7 && received.every((r) => r.signatureValid), `mock Hacienda verified every signature (${received.length} docs)`);
ok(received.some((r) => r.receptor?.numeroIdentificacion === '3101654321'), 'factura sent with receptor identification');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
