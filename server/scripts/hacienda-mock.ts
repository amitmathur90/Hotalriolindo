/**
 * Local stand-in for the external services, for automated tests only.
 *   npx tsx scripts/hacienda-mock.ts [port] [save-dir]
 * Start the API with:
 *   HACIENDA_IDP_URL=http://localhost:<port>/token  HACIENDA_API_URL=http://localhost:<port>/recepcion/v1/
 *   HACIENDA_TC_URL=http://localhost:<port>/tc  HACIENDA_CABYS_URL=http://localhost:<port>/cabys
 *   CLOUDBEDS_API_URL=http://localhost:<port>/cloudbeds
 *   QB_AUTH_URL=http://localhost:<port>/qb/auth  QB_TOKEN_URL=http://localhost:<port>/qb/token  QB_API_URL=http://localhost:<port>/qb
 *
 * Hacienda: user "cpj-test" / password "secret"; every received document (and Mensaje Receptor) is signature-checked
 * and saved; the first status query answers "procesando", later ones "aceptado" — or "rechazado" when the receptor is
 * named RECHAZAR. Cloudbeds: API key "cbat_test", three checked-out reservations. QuickBooks: code "qb-code".
 */
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { verifyXml } from '../src/hacienda/sign.ts';

const port = Number(process.argv[2] || 4199);
const dir = process.argv[3];
if (dir) mkdirSync(dir, { recursive: true });
const docs = new Map<string, { xml: string; polls: number; signatureValid: boolean; body: any }>();
const qbPosts: any[] = [];
const lost = new Set<string>();
const slow = new Set<string>();

const read = (req: http.IncomingMessage) => new Promise<string>((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); });
const send = (res: http.ServerResponse, status: number, body?: any, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const respuesta = (clave: string, estado: 'aceptado' | 'rechazado', detalle: string) =>
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><MensajeHacienda xmlns="https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/mensajeHacienda">` +
      `<Clave>${clave}</Clave><Mensaje>${estado === 'aceptado' ? 1 : 3}</Mensaje><DetalleMensaje>${detalle}</DetalleMensaje></MensajeHacienda>`,
  ).toString('base64');

const today = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.now() - 6 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
// Cloudbeds reservations checked out today
const reservations: Record<string, any> = {
  RES1001: {
    reservationID: 'RES1001', guestName: 'Comercial Pacífico S.A. (Ana Mora)', guestEmail: 'ana@pacifico.test', status: 'checked_out', startDate: day(-2), endDate: today(),
    total: 226, balance: 0, balanceDetailed: { subTotal: 200, additionalItems: 0, taxesFees: 26, grandTotal: 226, paid: 226 },
    assigned: [{ roomTypeName: 'Habitación Estándar', roomName: '101', startDate: day(-2), endDate: today(), dailyRates: [{ date: day(-2), rate: 100 }, { date: day(-1), rate: 100 }], roomTotal: '200' }],
    unassigned: [], guestList: { G1: { guestFirstName: 'Ana', guestLastName: 'Mora', guestEmail: 'ana@pacifico.test', taxID: '', companyTaxID: '3-101-654321', companyName: 'Comercial Pacífico S.A.', isMainGuest: true } },
  },
  RES1002: {
    reservationID: 'RES1002', guestName: 'John Smith', guestEmail: 'john@example.com', status: 'checked_out', startDate: day(-3), endDate: today(),
    total: 395.5, balance: 0, balanceDetailed: { subTotal: 300, additionalItems: 50, taxesFees: 45.5, grandTotal: 395.5, paid: 395.5 },
    assigned: [{ roomTypeName: 'Suite Río', roomName: '201', startDate: day(-3), endDate: today(), dailyRates: [{ date: day(-3), rate: 100 }, { date: day(-2), rate: 100 }, { date: day(-1), rate: 100 }], roomTotal: '300' }],
    unassigned: [], guestList: { G2: { guestFirstName: 'John', guestLastName: 'Smith', guestEmail: 'john@example.com', taxID: 'P1234567', isMainGuest: true } },
  },
  RES1003: {
    reservationID: 'RES1003', guestName: 'María López', guestEmail: '', status: 'checked_out', startDate: day(-1), endDate: today(),
    total: 500, balance: 0, balanceDetailed: { subTotal: 100, additionalItems: 0, taxesFees: 13, grandTotal: 500, paid: 500 },
    assigned: [{ roomTypeName: 'Habitación Estándar', roomName: '102', startDate: day(-1), endDate: today(), dailyRates: [{ date: day(-1), rate: 100 }], roomTotal: '100' }],
    unassigned: [], guestList: { G3: { guestFirstName: 'María', guestLastName: 'López', isMainGuest: true } },
  },
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const p = url.pathname;
    // ---------------- exchange rate & CABYS (public APIs)
    if (p === '/tc') return send(res, 200, { venta: { fecha: today() + ' 00:00:00', valor: 505.5 }, compra: { fecha: today(), valor: 498.25 } });
    if (p === '/cabys') {
      const q = (url.searchParams.get('q') || url.searchParams.get('codigo') || '').toLowerCase();
      const all = [
        { codigo: '6331100000100', descripcion: 'Servicios de alojamiento en hoteles', impuesto: 13 },
        { codigo: '2213000000000', descripcion: 'Cerveza de malta', impuesto: 13 },
        { codigo: '6331000000100', descripcion: 'Servicios de suministro de comidas', impuesto: 13 },
      ];
      return send(res, 200, { cabys: all.filter((c) => c.descripcion.toLowerCase().includes(q) || c.codigo === q), total: 3 });
    }
    // ---------------- Cloudbeds
    if (p.startsWith('/cloudbeds/')) {
      if (req.headers['x-api-key'] !== 'cbat_test') return send(res, 401, { success: false, message: 'Invalid API key' });
      if (p === '/cloudbeds/getReservations') {
        const data = Object.values(reservations).map((r) => ({ reservationID: r.reservationID, guestName: r.guestName, status: r.status, startDate: r.startDate, endDate: r.endDate, balance: 0 }));
        const size = Number(url.searchParams.get('pageSize') || 100);
        return send(res, 200, { success: true, data: data.slice(0, size), count: Math.min(size, data.length), total: data.length });
      }
      if (p === '/cloudbeds/getReservation') {
        const r = reservations[url.searchParams.get('reservationID') || ''];
        return r ? send(res, 200, { success: true, data: r }) : send(res, 200, { success: false, message: 'Not found' });
      }
      return send(res, 404, { success: false });
    }
    // ---------------- QuickBooks
    if (p === '/qb/token') {
      const f = new URLSearchParams(await read(req));
      if (!/^Basic /.test(req.headers.authorization || '')) return send(res, 401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'authorization_code' && f.get('code') !== 'qb-code') return send(res, 400, { error: 'invalid_grant' });
      return send(res, 200, { access_token: 'qb-access-' + Date.now(), refresh_token: 'qb-refresh-' + Date.now(), expires_in: 3600, x_refresh_token_expires_in: 8726400 });
    }
    if (p === '/_qb') return send(res, 200, qbPosts);
    const qm = /^\/qb\/v3\/company\/([^/]+)\/(.+)$/.exec(p);
    if (qm) {
      if (!/^Bearer qb-access-/.test(req.headers.authorization || '')) return send(res, 401, { Fault: { Error: [{ Message: 'AuthenticationFailed' }] } });
      const [, , rest] = qm;
      if (rest.startsWith('companyinfo')) return send(res, 200, { CompanyInfo: { CompanyName: 'Hotel Rio Lindo (QBO)', Country: 'CR' } });
      if (rest === 'query') {
        const q = url.searchParams.get('query') || '';
        if (/from Account/i.test(q)) return send(res, 200, { QueryResponse: { Account: [
          { Id: '1', Name: 'Caja', AccountType: 'Bank' }, { Id: '2', Name: 'Banco tarjetas', AccountType: 'Bank' }, { Id: '3', Name: 'Ventas', AccountType: 'Income' },
          { Id: '4', Name: 'IVA por pagar', AccountType: 'Other Current Liability' }, { Id: '5', Name: 'Servicio 10%', AccountType: 'Other Current Liability' },
          { Id: '6', Name: 'Compras y gastos', AccountType: 'Expense' }, { Id: '7', Name: 'IVA soportado', AccountType: 'Other Current Asset' },
        ] } });
        if (/from Vendor/i.test(q)) return send(res, 200, { QueryResponse: {} });
        return send(res, 200, { QueryResponse: {} });
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await read(req));
        const entity = rest.split('?')[0];
        const id = String(qbPosts.length + 100);
        qbPosts.push({ entity, id, body });
        if (entity === 'journalentry') {
          const dr = body.Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === 'Debit').reduce((s: number, l: any) => s + l.Amount, 0);
          const cr = body.Line.filter((l: any) => l.JournalEntryLineDetail.PostingType === 'Credit').reduce((s: number, l: any) => s + l.Amount, 0);
          if (Math.abs(dr - cr) > 0.001) return send(res, 400, { Fault: { Error: [{ Message: 'Journal Entry must be balanced', Detail: `${dr} vs ${cr}` }] } });
          return send(res, 200, { JournalEntry: { Id: id } });
        }
        if (entity === 'vendor') return send(res, 200, { Vendor: { Id: id, DisplayName: body.DisplayName } });
        if (entity === 'bill') return send(res, 200, { Bill: { Id: id } });
        if (entity === 'vendorcredit') return send(res, 200, { VendorCredit: { Id: id } });
      }
      return send(res, 404, {});
    }
    // ---------------- Hacienda IDP + recepción
    if (req.method === 'POST' && p === '/token') {
      const f = new URLSearchParams(await read(req));
      if (f.get('username') !== 'cpj-test' || f.get('password') !== 'secret') return send(res, 401, { error: 'invalid_grant' });
      return send(res, 200, { access_token: 'mock-token-' + Date.now(), expires_in: 300, token_type: 'bearer' });
    }
    if (req.method === 'GET' && p === '/_received') {
      return send(res, 200, [...docs.entries()].map(([clave, d]) => ({ clave, signatureValid: d.signatureValid, receptor: d.body.receptor ?? null, consecutivoReceptor: d.body.consecutivoReceptor ?? null, polls: d.polls })));
    }
    if (!/^bearer mock-token-/i.test(req.headers.authorization || '')) return send(res, 401, { error: 'unauthorized' });
    if (req.method === 'POST' && p === '/recepcion/v1/recepcion') {
      const body = JSON.parse(await read(req));
      if (!/^\d{50}$/.test(body.clave) || !body.comprobanteXml || !body.emisor?.numeroIdentificacion) return send(res, 400, undefined, { 'X-Error-Cause': 'Estructura inválida' });
      if (body.consecutivoReceptor && !/^\d{20}$/.test(body.consecutivoReceptor)) return send(res, 400, undefined, { 'X-Error-Cause': 'consecutivoReceptor inválido' });
      const key = body.consecutivoReceptor ? `${body.clave}-${body.consecutivoReceptor}` : body.clave;
      if (docs.has(key)) return send(res, 400, undefined, { 'X-Error-Cause': 'El comprobante ya fue recibido anteriormente' });
      const xml = Buffer.from(body.comprobanteXml, 'base64').toString('utf8');
      // Test hooks: TIMEOUT = received but the answer comes too late; PERDIDO = first attempt is lost (not received) and times out
      if (xml.includes('<Nombre>PERDIDO') && !lost.has(key)) { lost.add(key); await new Promise((r) => setTimeout(r, 4000)); return send(res, 504); }
      if (xml.includes('<Nombre>TIMEOUT') && !slow.has(key)) { slow.add(key); setTimeout(() => send(res, 202), 4000); }
      const signatureValid = await verifyXml(xml).catch(() => false);
      docs.set(key, { xml, polls: 0, signatureValid, body });
      if (dir) {
        const kind = xml.includes('<FacturaElectronica') ? 'factura' : xml.includes('<NotaCreditoElectronica') ? 'nota-credito' : xml.includes('<MensajeReceptor') ? 'mensaje-receptor' : 'tiquete';
        writeFileSync(`${dir}/${kind}_${key}.xml`, xml);
      }
      if (slow.has(key) && !res.headersSent && xml.includes('<Nombre>TIMEOUT')) return;
      return send(res, 202);
    }
    const m = /^\/recepcion\/v1\/recepcion\/(\d{50}(?:-\d{20})?)$/.exec(p);
    if (req.method === 'GET' && m) {
      const d = docs.get(m[1]);
      if (!d) return send(res, 404, undefined, { 'X-Error-Cause': 'No existe' });
      d.polls++;
      if (d.polls === 1) return send(res, 200, { clave: m[1], 'ind-estado': 'procesando' });
      const reject = !d.signatureValid || d.xml.includes('<Nombre>RECHAZAR');
      const msg = !d.signatureValid ? 'La firma del comprobante electrónico no es válida' : reject ? 'Receptor de prueba rechazado' : 'Aceptado';
      return send(res, 200, { clave: m[1], 'ind-estado': reject ? 'rechazado' : 'aceptado', 'respuesta-xml': respuesta(m[1].slice(0, 50), reject ? 'rechazado' : 'aceptado', msg) });
    }
    send(res, 404, { error: 'not found' });
  })
  .listen(port, () => console.log(`[hacienda-mock] listening on http://localhost:${port}`));
