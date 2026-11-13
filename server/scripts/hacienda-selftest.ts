/**
 * Offline self-test for Hacienda documents: builds a tiquete, factura and nota de crédito, signs them with a throwaway
 * self-signed .p12 and verifies the signatures. Writes the XML files to the folder given as the first argument so they
 * can be validated against the official v4.4 XSDs.
 *
 *   npx tsx scripts/hacienda-selftest.ts <out-dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import forge from 'node-forge';
import { clave, consecutivo, securityCode } from '../src/hacienda/codes.ts';
import { loadP12, signXml, verifyXml } from '../src/hacienda/sign.ts';
import { buildXml, type BuildInput } from '../src/hacienda/xml.ts';

const out = process.argv[2] || 'hacienda-selftest';
mkdirSync(out, { recursive: true });

export function makeTestP12(pin: string) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400e3);
  const attrs = [{ name: 'commonName', value: 'HOTEL RIO LINDO PRUEBA' }, { type: '2.5.4.5', value: 'CPJ-3-101-000000' }, { name: 'countryName', value: 'CR' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], pin, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

const emisor = {
  nombre: 'Hotel Rio Lindo Sociedad Anonima', id_type: '02', id_number: '3-101-000000', nombre_comercial: 'Hotel Rio Lindo',
  provincia: '6', canton: '01', distrito: '01', barrio: null, otras_senas: 'Frente al río, Puntarenas', phone: '+506 2222-3333', email: 'facturacion@example.com',
};
const lines: BuildInput['lines'] = [
  // Casado con pollo ₡5 500 IVA incl., 10% line discount
  { qty: 1, name: 'Casado con pollo', cabys: '6331000000100', gross: 5500, discount: 550, total: 4950, taxes: [{ rate: 13, inclusive: true }] },
  // 2 × Empanada ₡1 200
  { qty: 2, name: 'Empanada de queso', cabys: '6331000000100', gross: 2400, discount: 0, total: 2400, taxes: [{ rate: 13, inclusive: true }] },
  // Exempt item
  { qty: 1, name: 'Agua Pura (exento)', cabys: '2441100000000', gross: 800, discount: 0, total: 800, taxes: [{ rate: 0, inclusive: true }] },
];
const now = new Date();
const docs: { name: string; input: BuildInput }[] = [];
const base = (type: '01' | '03' | '04', n: number) => {
  const cons = consecutivo('001', '00001', type, n);
  return { docType: type, consecutivo: cons, clave: clave(now, emisor.id_number, cons, '1', securityCode()), fecha: now, providerId: '3101000000', activityCode: '551001', emisor };
};
const te = base('04', 1);
docs.push({ name: 'tiquete', input: { ...te, lines, serviceCharge: 691.15, servicePct: 10, tip: 500, payments: [{ type: 'cash', name: 'Efectivo', amount: 5000 }, { type: 'bank', name: 'SINPE Móvil', amount: 4341.15 }] } });
docs.push({ name: 'factura', input: { ...base('01', 1), receptor: { nombre: 'Juan Pérez Mora', id_type: '01', id_number: '1-1111-1111', email: 'cliente@example.com', activity_code: '620100' }, lines, serviceCharge: 691.15, servicePct: 10, tip: 0, payments: [{ type: 'card', name: 'Tarjeta', amount: 8841.15 }] } });
docs.push({ name: 'nota-credito', input: { ...base('03', 1), lines: [lines[1]], serviceCharge: 0, servicePct: 10, tip: 0, payments: [{ type: 'cash', name: 'Efectivo', amount: 2400 }], references: [{ doc_type: '04', clave: te.clave, issued_at: now, code: '06', reason: 'Devolución: producto equivocado' }] } });

const cert = await loadP12(makeTestP12('1234'), '1234');
console.log('certificate:', cert.subject, '| serialName', cert.serialName);
for (const d of docs) {
  const { xml, total } = buildXml(d.input);
  const signed = await signXml(xml, cert);
  const ok = await verifyXml(signed);
  writeFileSync(`${out}/${d.name}.xml`, signed);
  console.log(`${d.name.padEnd(13)} total ₡${total.toFixed(5)}  signature ${ok ? 'VALID' : 'INVALID'}  ${signed.length} bytes`);
  const sigId = /<ds:Signature Id="([^"]+)"/.exec(signed)?.[1];
  const target = /QualifyingProperties Target="#([^"]+)"/.exec(signed)?.[1];
  if (!sigId || sigId !== target) console.log(`  ✗ QualifyingProperties Target #${target} does not match Signature Id ${sigId}`);
  if (!ok || sigId !== target) process.exitCode = 1;
}
