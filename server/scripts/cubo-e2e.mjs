// End-to-end check of the Cubo replacement features against the mock services (scripts/hacienda-mock.ts):
// manual invoices in CRC/USD, numbering, PDF, anulación, CABYS search, exchange rate, supplier invoices with
// Mensaje Receptor, Cloudbeds check-outs and QuickBooks postings.
// Usage: node scripts/cubo-e2e.mjs [apiBase] [mockBase]   (fresh demo database; server started with the mock env vars,
//        JWT_SECRET=e2e-secret and QB_CLOSE_DAY_OFFSET=0)
import forge from 'node-forge';
import { createHmac } from 'node:crypto';

const BASE = process.argv[2] || 'http://localhost:4100';
const MOCK = process.argv[3] || 'http://localhost:4199';
let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✔', msg); } else { fail++; console.log('  ✘', msg, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500)); }
};
async function api(method, path, body, token, raw = false) {
  const res = await fetch(BASE + '/api' + path, {
    method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() - 6 * 3600e3 + 86400e3).toISOString().slice(0, 10);
async function docs(token, extra = '') {
  return (await api('GET', `/hacienda/documents?from=${today}T00:00:00-06:00&to=${tomorrow}T00:00:00-06:00${extra}`, null, token)).data.rows;
}
async function waitFor(fn, pred, ms = 30000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (pred(v)) return v;
    await sleep(500);
  }
  return v;
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
const supplierXml = (n, { receptor = '3101123456', root = 'FacturaElectronica', total = 11300, tax = 1300, name = 'Distribuidora La Costa S.A.' } = {}) => {
  const cons = '00100001' + '01' + String(n).padStart(10, '0');
  const clave = '506' + '181126' + '003101999999' + cons + '1' + String(10000000 + n).slice(-8);
  return `<?xml version="1.0" encoding="utf-8"?><${root} xmlns="https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/x"><Clave>${clave}</Clave>` +
    `<ProveedorSistemas>3101999999</ProveedorSistemas><CodigoActividadEmisor>461001</CodigoActividadEmisor><NumeroConsecutivo>${cons}</NumeroConsecutivo>` +
    `<FechaEmision>${today}T10:00:00-06:00</FechaEmision><Emisor><Nombre>${name}</Nombre><Identificacion><Tipo>02</Tipo><Numero>3101999999</Numero></Identificacion>` +
    `<CorreoElectronico>ventas@lacosta.test</CorreoElectronico></Emisor>` +
    (root === 'TiqueteElectronico' ? '' : `<Receptor><Nombre>Hotel Rio Lindo S.A.</Nombre><Identificacion><Tipo>02</Tipo><Numero>${receptor}</Numero></Identificacion></Receptor>`) +
    `<CondicionVenta>01</CondicionVenta><DetalleServicio><LineaDetalle><NumeroLinea>1</NumeroLinea><CodigoCABYS>2213000000000</CodigoCABYS><Cantidad>10</Cantidad>` +
    `<UnidadMedida>Unid</UnidadMedida><Detalle>Cerveza nacional caja</Detalle><PrecioUnitario>1000</PrecioUnitario><MontoTotal>10000</MontoTotal><SubTotal>10000</SubTotal>` +
    `<Impuesto><Codigo>01</Codigo><CodigoTarifaIVA>08</CodigoTarifaIVA><Tarifa>13</Tarifa><Monto>${tax}</Monto></Impuesto><MontoTotalLinea>${total}</MontoTotalLinea></LineaDetalle></DetalleServicio>` +
    `<ResumenFactura><CodigoTipoMoneda><CodigoMoneda>CRC</CodigoMoneda><TipoCambio>1</TipoCambio></CodigoTipoMoneda><TotalVenta>10000</TotalVenta><TotalVentaNeta>10000</TotalVentaNeta>` +
    `<TotalImpuesto>${tax}</TotalImpuesto><MedioPago><TipoMedioPago>04</TipoMedioPago><TotalMedioPago>${total}</TotalMedioPago></MedioPago><TotalComprobante>${total}</TotalComprobante></ResumenFactura></${root}>`;
};

for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(1000); }
const owner = (await api('POST', '/auth/login', { email: 'owner@demo.com', password: 'demo123' })).data;
const O = owner.token;
const dev = (await api('POST', '/auth/devices', { store_id: owner.stores[0].id, name: 'Cubo E2E' }, O)).data;
const C = (await api('POST', '/auth/pin', { pin: '3333' }, dev.token)).data.token;

console.log('Setup');
await api('PUT', '/hacienda/settings', {
  environment: 'stag', legal_name: 'Hotel Rio Lindo S.A.', trade_name: 'Hotel Rio Lindo', id_type: '02', id_number: '3-101-123456',
  activity_code: '551001', provider_id: '3101123456', provincia: '6', canton: '05', distrito: '04', otras_senas: 'Dominical centro, Puntarenas',
  phone: '2222-3333', email: 'facturas@riolindo.test', api_username: 'cpj-test', api_password: 'secret', default_cabys: '6331000000100', terminal: '7',
}, O);
await api('POST', '/hacienda/settings/certificate', { p12_base64: testP12('4321'), pin: '4321' }, O);
const en = await api('PUT', '/hacienda/settings', { enabled: true }, O);
ok(en.status === 200 && en.data.enabled && en.data.terminal === '00007', 'e-invoicing enabled on terminal 00007', en.data);

console.log('Exchange rate & CABYS');
const fx = (await api('GET', '/hacienda/fx', null, O)).data;
ok(fx.rate === 505.5 && fx.source === 'hacienda', `dollar rate from Hacienda (₡${fx.rate})`, fx);
const cab = (await api('GET', '/hacienda/cabys?q=alojamiento', null, O)).data;
ok(cab.items?.[0]?.codigo === '6331100000100' && cab.items[0].impuesto === 13, 'CABYS search finds lodging code with 13% IVA', cab);
await api('PUT', '/hacienda/settings', { usd_rate_manual: '510' }, O);
ok((await api('GET', '/hacienda/fx', null, O)).data.rate === 510, 'fixed exchange rate overrides Hacienda');
await api('PUT', '/hacienda/settings', { usd_rate_manual: '' }, O);

console.log('Numbering (continue after Cubo)');
const seq = await api('PUT', '/hacienda/sequences', { branch: '001', terminal: '00007', doc_type: '01', next: 5000 }, O);
ok(seq.status === 200, 'next factura number set to 5000', seq.data);

console.log('Manual factura in USD on credit');
const noRec = await api('POST', '/hacienda/invoices', { doc_type: '01', currency: 'USD', lines: [{ name: 'Evento', qty: 1, price: 10, tax_rate: 13 }] }, O);
ok(noRec.status === 400 && /Nombre/.test(noRec.data.error), 'factura requires the customer tax details', noRec.data);
const badCabys = await api('POST', '/hacienda/invoices', { doc_type: '04', lines: [{ name: 'Algo', qty: 1, price: 10, tax_rate: 13, cabys: '123' }] }, O);
ok(badCabys.status === 400 && /CABYS/.test(badCabys.data.error), 'invalid CABYS rejected', badCabys.data);
const fe = await api('POST', '/hacienda/invoices', {
  doc_type: '01', currency: 'USD', condition: '02', credit_days: 30, notes: 'Evento boda 15-nov · Orden de compra 778',
  receptor: { nombre: 'Eventos del Pacífico S.A.', id_type: '02', id_number: '3101777777', email: 'pagos@eventos.test' },
  lines: [{ name: 'Alquiler de salón para evento', qty: 1, price: 800, tax_rate: 13, cabys: '6331100000100', unit: 'Sp' }, { name: 'Cena buffet por persona', qty: 50, price: 25, discount: 50, tax_rate: 13 }],
  payments: [{ type: 'bank', amount: 1 }],
}, O);
ok(fe.status === 201 && fe.data.doc_type === '01' && fe.data.currency === 'USD' && Number(fe.data.exchange_rate) === 505.5, 'manual factura in USD issued at the day rate', fe.data);
ok(/^0010000701\d{10}$/.test(fe.data.consecutivo) && fe.data.consecutivo.endsWith('0000005000'), `consecutivo continues at 5000 on terminal 7 (${fe.data.consecutivo})`);
const lower = await api('PUT', '/hacienda/sequences', { branch: '001', terminal: '00007', doc_type: '01', next: 4000 }, O);
ok(lower.status === 400, 'numbering cannot go back to an already used number', lower.data);
let d = await waitFor(async () => (await docs(O)).find((x) => x.id === fe.data.id), (x) => x?.status === 'accepted');
ok(d?.status === 'accepted', 'manual factura accepted by Hacienda', d);
ok(Math.abs(Number(d.total) - ((800 + 1250 - 50) * 1.13)) < 0.01, `total USD ${d.total} = (800 + 1250 − 50) + 13% IVA`);
const xml = (await api('GET', `/hacienda/documents/${fe.data.id}/xml`, null, O)).data;
ok(/<CodigoMoneda>USD<\/CodigoMoneda><TipoCambio>505\.50000<\/TipoCambio>/.test(xml), 'XML currency USD with exchange rate');
ok(/<CondicionVenta>02<\/CondicionVenta><PlazoCredito>30<\/PlazoCredito>/.test(xml), 'XML condición crédito 30 días');
ok(/<Otros><OtroTexto>Evento boda/.test(xml) && /<TipoMedioPago>04<\/TipoMedioPago>/.test(xml), 'XML notes and transfer payment');
const pdfRes = await api('GET', `/hacienda/documents/${fe.data.id}/pdf`, null, O, true);
const pdf = Buffer.from(await pdfRes.arrayBuffer());
ok(pdfRes.status === 200 && pdf.subarray(0, 4).toString() === '%PDF' && pdf.length > 3000, `PDF generated (${pdf.length} bytes)`);
const sig = createHmac('sha256', 'e2e-secret').update(`receipt:${fe.data.id}`).digest('hex').slice(0, 16);
const pub = await fetch(`${BASE}/api/public/edoc/${fe.data.id}/${sig}.pdf`);
ok(pub.status === 200 && pub.headers.get('content-type') === 'application/pdf', 'public PDF link works (QR / e-mail)');
ok((await fetch(`${BASE}/api/public/edoc/${fe.data.id}/0000000000000000.pdf`)).status === 404, 'public PDF link needs the signature');

console.log('Manual tiquete in colones + anulación');
const te = await api('POST', '/hacienda/invoices', { doc_type: '04', lines: [{ name: 'Tour de kayak', qty: 2, price: 15000, tax_rate: 13 }], payments: [{ type: 'card', amount: 1 }] }, O);
ok(te.status === 201 && te.data.doc_type === '04' && te.data.currency === 'CRC', 'manual tiquete issued in CRC', te.data);
await waitFor(async () => (await docs(O)).find((x) => x.id === te.data.id), (x) => x?.status === 'accepted');
const shortReason = await api('POST', `/hacienda/documents/${fe.data.id}/annul`, { reason: 'x' }, O);
ok(shortReason.status === 400, 'anulación needs a reason');
const nc = await api('POST', `/hacienda/documents/${fe.data.id}/annul`, { reason: 'Evento cancelado por el cliente' }, O);
ok(nc.status === 201 && nc.data.doc_type === '03' && nc.data.reference.clave === fe.data.clave && nc.data.currency === 'USD', 'factura annulled with a nota de crédito in USD', nc.data);
const again = await api('POST', `/hacienda/documents/${fe.data.id}/annul`, { reason: 'Evento cancelado por el cliente' }, O);
ok(again.status === 400 && /ya fue anulado/.test(again.data.error), 'a document cannot be annulled twice');
d = await waitFor(async () => (await docs(O)).find((x) => x.id === nc.data.id), (x) => x?.status === 'accepted');
ok(d?.status === 'accepted' && Math.abs(Number(d.total) - 2260) < 0.01, 'nota de crédito accepted for the full amount', d);
const listed = await docs(O, '&source=manual');
ok(listed.length === 3 && listed.find((x) => x.id === fe.data.id)?.annulled_by === nc.data.id, 'document list filters manual documents and shows the anulación');

console.log('Supplier invoices (documentos recibidos)');
const imp = (await api('POST', '/hacienda/received/import', { files: [
  { name: 'f1.xml', content: supplierXml(1) },
  { name: 'f1-dup.xml', content: supplierXml(1) },
  { name: 'f2.xml', content: Buffer.from(supplierXml(2, { total: 5650, tax: 650, name: 'Ferretería El Sol' })).toString('base64') },
  { name: 'otro.xml', content: supplierXml(3, { receptor: '3101000000' }) },
  { name: 'tiquete.xml', content: supplierXml(4, { root: 'TiqueteElectronico' }) },
] }, O)).data.results;
ok(imp[0].ok && imp[0].created && imp[1].ok && !imp[1].created, 'supplier XML imported once (duplicate ignored)', imp);
ok(imp[2].ok && imp[2].emisor === 'Ferretería El Sol', 'base64 upload imported');
ok(!imp[3].ok && /otra identificación/.test(imp[3].error), 'invoice addressed to another company refused', imp[3]);
ok(!imp[4].ok && /tiquetes/.test(imp[4].error), 'supplier tiquetes refused (no receptor)', imp[4]);
let rec = (await api('GET', '/hacienda/received', null, O)).data;
ok(rec.rows.length === 2 && rec.pending === 2, '2 supplier documents waiting for an answer');
const r1 = rec.rows.find((x) => x.emisor_name.startsWith('Distribuidora'));
const r2 = rec.rows.find((x) => x.emisor_name.startsWith('Ferretería'));
const noReason = await api('POST', `/hacienda/received/${r2.id}/decide`, { decision: '07' }, O);
ok(noReason.status === 400, 'rejection needs a reason');
const acc = await api('POST', `/hacienda/received/${r1.id}/decide`, { decision: '05', category: 'Insumos de bar', condicion: '01' }, O);
ok(acc.status === 200 && acc.data.mr_status === 'pending' && /^0010000705\d{10}$/.test(acc.data.mr_consecutivo), `accepted: mensaje receptor ${acc.data.mr_consecutivo}`, acc.data);
const rej = await api('POST', `/hacienda/received/${r2.id}/decide`, { decision: '07', detail: 'Mercadería no recibida' }, O);
ok(rej.status === 200 && /^0010000707/.test(rej.data.mr_consecutivo), 'rejected: mensaje receptor type 07');
rec = await waitFor(async () => (await api('GET', '/hacienda/received', null, O)).data, (x) => x.rows.every((r) => r.mr_status === 'accepted'));
ok(rec.rows.every((r) => r.mr_status === 'accepted'), 'Hacienda accepted both mensajes receptor', rec.rows.map((r) => [r.mr_status, r.mr_message]));
const sent = (await (await fetch(MOCK + '/_received')).json()).filter((x) => x.consecutivoReceptor);
ok(sent.length === 2 && sent.every((x) => x.signatureValid && x.receptor?.numeroIdentificacion === '3101123456'), 'mensajes were signed and sent with clave + consecutivoReceptor', sent);
const exp = (await api('GET', '/expenses', null, O)).data;
const expRows = Array.isArray(exp) ? exp : exp.rows || [];
ok(expRows.some((e) => e.category === 'Insumos de bar' && Number(e.amount) === 11300), 'accepted invoice recorded as an expense', expRows.slice(0, 3));
ok(!expRows.some((e) => Number(e.amount) === 5650), 'rejected invoice is not an expense');
const rp = await api('GET', `/hacienda/received/${r1.id}/pdf`, null, O, true);
ok(rp.status === 200 && Buffer.from(await rp.arrayBuffer()).subarray(0, 4).toString() === '%PDF', 'supplier invoice PDF');

console.log('Cloudbeds');
let cb = await api('PUT', '/integrations/cloudbeds', { api_key: 'cbat_bad', cabys: '6331100000100', currency: 'USD', tax_rate: 13, enabled: true }, O);
ok(cb.status === 200 && cb.data.enabled && cb.data.config.has_api_key && !JSON.stringify(cb.data).includes('cbat_'), 'Cloudbeds enabled, API key stored encrypted', cb.data);
const badTest = await api('POST', '/integrations/cloudbeds/test', {}, O);
ok(badTest.status === 400 && /API key/.test(badTest.data.error), 'wrong API key reported', badTest.data);
await api('PUT', '/integrations/cloudbeds', { api_key: 'cbat_test' }, O);
const goodTest = await api('POST', '/integrations/cloudbeds/test', {}, O);
ok(goodTest.status === 200 && goodTest.data.ok, 'Cloudbeds connection OK', goodTest.data);
const sync = await api('POST', '/integrations/cloudbeds/sync', {}, O);
ok(sync.status === 200 && sync.data.issued === 2 && sync.data.review === 1, 'check-outs: 2 documents issued, 1 held for review', sync.data);
let resv = (await api('GET', '/integrations/cloudbeds/reservations', null, O)).data;
const R = (id) => resv.find((x) => x.reservation_id === id);
ok(R('RES1001')?.doc_type === '01', 'guest with company tax ID gets a factura electrónica', R('RES1001'));
ok(R('RES1002')?.doc_type === '04' && R('RES1002').currency === 'USD', 'foreign guest gets a tiquete in USD', R('RES1002'));
ok(R('RES1003')?.status === 'review' && /no coincide/.test(R('RES1003').message), 'total mismatch held for review', R('RES1003'));
const sync2 = await api('POST', '/integrations/cloudbeds/sync', {}, O);
ok(sync2.data.issued === 0, 'running the sync again does not duplicate documents', sync2.data);
const man = await api('POST', '/integrations/cloudbeds/reservations/RES1003/issue', {}, O);
ok(man.status === 200 && man.data.status === 'issued', 'reviewed reservation issued manually', man.data);
const cbDocs = await waitFor(() => docs(O, '&source=cloudbeds'), (x) => x.length === 3 && x.every((y) => y.status === 'accepted'));
ok(cbDocs.length === 3 && cbDocs.every((y) => y.status === 'accepted'), 'Cloudbeds documents accepted by Hacienda', cbDocs.map((x) => [x.external_ref, x.status, x.message]));
const fe1001 = cbDocs.find((x) => x.external_ref === 'RES1001');
ok(fe1001 && Math.abs(Number(fe1001.total) - 226) < 0.01 && fe1001.receptor.id_number === '3101654321', 'factura total matches Cloudbeds (US$226) with the company cédula', fe1001);
const te1002 = cbDocs.find((x) => x.external_ref === 'RES1002');
ok(te1002 && Math.abs(Number(te1002.total) - 395.5) < 0.01, 'tiquete includes room nights + additional items (US$395.50)', te1002?.total);

console.log('QuickBooks Online');
await api('PUT', '/integrations/quickbooks', { client_id: 'ABC123', client_secret: 'shh', environment: 'sandbox' }, O);
const con = (await api('GET', '/integrations/quickbooks/connect', null, O)).data;
const u = new URL(con.url);
ok(u.searchParams.get('client_id') === 'ABC123' && u.searchParams.get('scope') === 'com.intuit.quickbooks.accounting' && u.searchParams.get('redirect_uri') === con.redirect_uri, 'Intuit authorization link', con);
const badState = await api('GET', `/public/quickbooks/callback?code=qb-code&realmId=999&state=bogus.123`, null, null, true);
ok(badState.status === 302 && /qb_error/.test(badState.headers.get('location')), 'forged state refused');
const cbk = await api('GET', `/public/quickbooks/callback?code=qb-code&realmId=999&state=${encodeURIComponent(u.searchParams.get('state'))}`, null, null, true);
ok(cbk.status === 302 && /qb=connected/.test(cbk.headers.get('location')), 'OAuth callback connects the company', cbk.headers.get('location'));
const ints = (await api('GET', '/integrations', null, O)).data;
ok(ints.quickbooks.connected && ints.quickbooks.config.company_name === 'Hotel Rio Lindo (QBO)' && !JSON.stringify(ints).includes('qb-refresh'), 'connected to "Hotel Rio Lindo (QBO)", tokens never returned', ints.quickbooks);
const accounts = (await api('GET', '/integrations/quickbooks/accounts', null, O)).data;
ok(accounts.length === 7, 'chart of accounts loaded for mapping');
const noMap = await api('POST', '/integrations/quickbooks/sync', {}, O);
ok(noMap.data.days?.[0]?.status === 'error' && /cuenta/.test(noMap.data.days[0].message), 'posting refused until accounts are mapped', noMap.data);
await api('PUT', '/integrations/quickbooks', { accounts: { deposit_cash: '1', deposit_card: '2', deposit_other: '2', income: '3', tax: '4', service: '5', tips: '5', expense: '6', tax_credit: '7' } }, O);
const push = await api('POST', '/integrations/quickbooks/sync', {}, O);
ok(push.status === 200 && push.data.days.some((x) => x.status === 'posted'), 'daily sales journal posted', push.data);
ok(push.data.bills.length === 1 && push.data.bills[0].status === 'posted', 'accepted supplier invoice posted as a bill (rejected one skipped)', push.data.bills);
const qbp = await (await fetch(MOCK + '/_qb')).json();
const je = qbp.find((x) => x.entity === 'journalentry');
const lines = je?.body.Line || [];
const sum = (side) => lines.filter((l) => l.JournalEntryLineDetail.PostingType === side).reduce((s, l) => s + l.Amount, 0);
ok(je && Math.abs(sum('Debit') - sum('Credit')) < 0.001, `journal entry balanced (₡${sum('Debit').toFixed(2)})`);
const income = lines.filter((l) => l.JournalEntryLineDetail.AccountRef.value === '3').reduce((s, l) => s + l.Amount, 0);
ok(income > 0 && lines.some((l) => l.JournalEntryLineDetail.AccountRef.value === '4'), 'sales and IVA posted to the mapped accounts');
const bill = qbp.find((x) => x.entity === 'bill');
ok(bill && bill.body.Line.length === 2 && bill.body.Line[0].Amount === 10000 && bill.body.Line[1].Amount === 1300 && qbp.some((x) => x.entity === 'vendor' && x.body.DisplayName === 'Distribuidora La Costa S.A.'), 'bill split into expense + IVA credit, vendor created', bill?.body);
const push2 = await api('POST', '/integrations/quickbooks/sync', {}, O);
ok(push2.data.days.length === 0 && push2.data.bills.length === 0, 'nothing is posted twice', push2.data);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
