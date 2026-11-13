/**
 * Local stand-in for Hacienda's IDP + "API de Recepción", for automated tests only.
 *   npx tsx scripts/hacienda-mock.ts [port] [save-dir]
 * Then start the API with HACIENDA_IDP_URL=http://localhost:<port>/token and HACIENDA_API_URL=http://localhost:<port>/recepcion/v1/
 *
 * Behaviour: user "cpj-test" / password "secret"; every received document is signature-checked and saved;
 * the first status query answers "procesando", later ones "aceptado" — or "rechazado" when the receptor is named RECHAZAR.
 */
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { verifyXml } from '../src/hacienda/sign.ts';

const port = Number(process.argv[2] || 4199);
const dir = process.argv[3];
if (dir) mkdirSync(dir, { recursive: true });
const docs = new Map<string, { xml: string; polls: number; signatureValid: boolean; body: any }>();

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

http
  .createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (req.method === 'POST' && url.pathname === '/token') {
      const f = new URLSearchParams(await read(req));
      if (f.get('username') !== 'cpj-test' || f.get('password') !== 'secret') return send(res, 401, { error: 'invalid_grant' });
      return send(res, 200, { access_token: 'mock-token-' + Date.now(), expires_in: 300, token_type: 'bearer' });
    }
    if (req.method === 'GET' && url.pathname === '/_received') {
      return send(res, 200, [...docs.entries()].map(([clave, d]) => ({ clave, signatureValid: d.signatureValid, receptor: d.body.receptor ?? null, polls: d.polls })));
    }
    if (!/^bearer mock-token-/i.test(req.headers.authorization || '')) return send(res, 401, { error: 'unauthorized' });
    if (req.method === 'POST' && url.pathname === '/recepcion/v1/recepcion') {
      const body = JSON.parse(await read(req));
      if (!/^\d{50}$/.test(body.clave) || !body.comprobanteXml || !body.emisor?.numeroIdentificacion) return send(res, 400, undefined, { 'X-Error-Cause': 'Estructura inválida' });
      if (docs.has(body.clave)) return send(res, 400, undefined, { 'X-Error-Cause': 'El comprobante ya fue recibido anteriormente' });
      const xml = Buffer.from(body.comprobanteXml, 'base64').toString('utf8');
      const signatureValid = await verifyXml(xml).catch(() => false);
      docs.set(body.clave, { xml, polls: 0, signatureValid, body });
      if (dir) {
        const kind = xml.includes('<FacturaElectronica') ? 'factura' : xml.includes('<NotaCreditoElectronica') ? 'nota-credito' : 'tiquete';
        writeFileSync(`${dir}/${kind}_${body.clave}.xml`, xml);
      }
      return send(res, 202);
    }
    const m = /^\/recepcion\/v1\/recepcion\/(\d{50})$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const d = docs.get(m[1]);
      if (!d) return send(res, 404, undefined, { 'X-Error-Cause': 'No existe' });
      d.polls++;
      if (d.polls === 1) return send(res, 200, { clave: m[1], 'ind-estado': 'procesando' });
      const reject = !d.signatureValid || d.xml.includes('<Nombre>RECHAZAR');
      const msg = !d.signatureValid ? 'La firma del comprobante electrónico no es válida' : reject ? 'Receptor de prueba rechazado' : 'Aceptado';
      return send(res, 200, { clave: m[1], 'ind-estado': reject ? 'rechazado' : 'aceptado', 'respuesta-xml': respuesta(m[1], reject ? 'rechazado' : 'aceptado', msg) });
    }
    send(res, 404, { error: 'not found' });
  })
  .listen(port, () => console.log(`[hacienda-mock] listening on http://localhost:${port}`));
