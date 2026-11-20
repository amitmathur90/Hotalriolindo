import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateXML } from 'xmllint-wasm';

/**
 * Validation of comprobantes against the official Ministerio de Hacienda XSDs (bundled in ./xsd/<version>, downloaded
 * from cdn.comprobanteselectronicos.go.cr). Runs libxml2 compiled to WebAssembly (no native build).
 * New schema versions are added as a new folder and selected with SCHEMA_VERSION.
 */
export const SCHEMA_VERSION = 'v4.4';
const FILES: Record<string, string> = {
  FacturaElectronica: 'FacturaElectronica.xsd',
  TiqueteElectronico: 'TiqueteElectronico.xsd',
  NotaCreditoElectronica: 'NotaCreditoElectronica.xsd',
  NotaDebitoElectronica: 'NotaDebitoElectronica.xsd',
  MensajeReceptor: 'MensajeReceptor.xsd',
};
const dir = (v: string) => new URL(`./xsd/${v}/`, import.meta.url);
const cache = new Map<string, string>();
const load = (v: string, f: string) => {
  const k = `${v}/${f}`;
  if (!cache.has(k)) cache.set(k, readFileSync(fileURLToPath(new URL(f, dir(v))), 'utf8'));
  return cache.get(k)!;
};

/** Root element name of an XML document. */
export const rootName = (xml: string) => /<(?:\w+:)?(\w+)[\s>][\s\S]*$/.exec(xml.replace(/^<\?xml[^>]*>\s*/, ''))?.[1] || '';

/**
 * Validates a comprobante. `signed` = the XML already contains ds:Signature (required by the schemas); unsigned XML is
 * validated with the mandatory signature error ignored, so problems are caught before signing.
 */
export async function validateComprobante(xml: string, opts: { signed?: boolean; version?: string } = {}) {
  const v = opts.version || SCHEMA_VERSION;
  const root = rootName(xml);
  const file = FILES[root];
  if (!file) return { valid: false, errors: [`Tipo de documento sin esquema: ${root}`] };
  const res = await validateXML({
    xml: [{ fileName: 'comprobante.xml', contents: xml }],
    schema: [{ fileName: file, contents: load(v, file) }],
    // the schemas import the XML-DSig schema with a relative path ../../xmldsig-core-schema.xsd
    preload: [{ fileName: '../../xmldsig-core-schema.xsd', contents: load(v, 'xmldsig-core-schema.xsd') }, { fileName: 'xmldsig-core-schema.xsd', contents: load(v, 'xmldsig-core-schema.xsd') }],
  });
  let errors = res.errors.map((e) => String(e.message || e.rawMessage || e).replace(/^comprobante\.xml:\d+:\s*/, '').trim());
  if (!opts.signed) errors = errors.filter((e) => !/Signature/.test(e));
  return { valid: errors.length === 0, errors, schema: `${v}/${file}` };
}
