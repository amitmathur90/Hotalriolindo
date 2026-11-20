// Creates a self-signed TEST "llave criptográfica" (.p12) for development with the local Hacienda simulator.
// Usage: node scripts/make-test-p12.mjs [cedula] [pin] [file]     e.g. node scripts/make-test-p12.mjs 3101123456 1234 test.p12
// Not valid for Hacienda's real sandbox or production (those need the .p12 downloaded from ATV).
import forge from 'node-forge';
import { writeFileSync } from 'node:fs';

const cedula = (process.argv[2] || '3101123456').replace(/\D/g, '');
const pin = process.argv[3] || '1234';
const file = process.argv[4] || 'test.p12';
const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date(Date.now() - 86400e3);
cert.validity.notAfter = new Date(Date.now() + 365 * 86400e3);
const attrs = [{ name: 'commonName', value: 'PRUEBA DESARROLLO' }, { type: '2.5.4.5', value: `CPJ-${cedula}` }, { name: 'countryName', value: 'CR' }];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.sign(keys.privateKey, forge.md.sha256.create());
const der = forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], pin, { algorithm: '3des' })).getBytes();
writeFileSync(file, Buffer.from(der, 'binary'));
console.log(`Created ${file} (cédula ${cedula}, PIN ${pin}) — for the local simulator only`);
