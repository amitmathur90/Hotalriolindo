import ExcelJS from 'exceljs';
import { db, tx } from '../db.ts';
import { bad } from '../util.ts';
import { digits } from './codes.ts';

/**
 * CABYS catalogue (Catálogo de Bienes y Servicios, BCCR / Ministerio de Hacienda).
 * The official file is imported (Excel or CSV) and kept versioned in cabys_codes; searches use the local catalogue and
 * fall back to Hacienda's public CABYS API when no catalogue has been imported. Codes are never inferred from product
 * names: every product is mapped explicitly by an authorised user (product_cabys_history keeps the changes).
 */
const norm = (s: any) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** Extracts {code, description, tax} rows from a sheet: the code is the last 13-digit cell, the description the cell after it. */
function rowsFrom(table: string[][]) {
  let taxCol = -1;
  const out = new Map<string, { code: string; description: string; tax: number | null }>();
  for (const row of table) {
    const cells = row.map((c) => String(c ?? '').trim());
    const hi = cells.findIndex((c) => /impuesto|iva|tarifa/.test(norm(c)));
    const hasCode = cells.some((c) => /^\d{13}$/.test(c.replace(/[\s-]/g, '')));
    if (hi >= 0 && !hasCode) { taxCol = hi; continue; }
    let ci = -1;
    for (let i = cells.length - 1; i >= 0; i--) if (/^\d{13}$/.test(cells[i].replace(/[\s-]/g, ''))) { ci = i; break; }
    if (ci < 0) continue;
    const code = cells[ci].replace(/[\s-]/g, '');
    const description = cells[ci + 1] || '';
    if (!description || /^\d+([.,]\d+)?%?$/.test(description)) continue;
    let tax: number | null = null;
    const raw = taxCol >= 0 ? cells[taxCol] : cells.slice(ci + 2).find((c) => /^\d{1,2}([.,]\d+)?\s*%?$/.test(c));
    if (raw != null && raw !== '') {
      const n = Number(String(raw).replace('%', '').replace(',', '.'));
      if (Number.isFinite(n)) tax = n > 0 && n < 1 ? Math.round(n * 10000) / 100 : n; // 0.13 → 13
    }
    out.set(code, { code, description: description.slice(0, 500), tax });
  }
  return [...out.values()];
}

async function parseFile(name: string, base64: string) {
  const buf = Buffer.from(base64.replace(/^data:[^,]*,/, ''), 'base64');
  if (/\.xlsx$/i.test(name) || buf.subarray(0, 2).toString() === 'PK') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const table: string[][] = [];
    wb.eachSheet((ws) => ws.eachRow((r) => table.push((r.values as any[]).slice(1).map((v) => (v && typeof v === 'object' && 'text' in v ? v.text : v && typeof v === 'object' && 'result' in v ? v.result : v)))));
    return rowsFrom(table);
  }
  const text = buf.toString('utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const sep = [';', '\t', ','].map((s) => [s, (lines[0] || '').split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  return rowsFrom(lines.map((l) => l.split(sep).map((c) => c.replace(/^"|"$/g, ''))));
}

export async function importCabys(file: { name: string; content: string }, version: string, userId: string | null) {
  const rows = await parseFile(file.name || 'cabys.csv', file.content);
  if (rows.length < 10) throw bad('No se encontraron códigos CABYS en el archivo (se esperan columnas con el código de 13 dígitos y su descripción)');
  const v = String(version || '').trim() || new Date().toISOString().slice(0, 10);
  await tx(async (q) => {
    await q.query(`UPDATE cabys_codes SET active=false`);
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const params: any[] = [];
      const values = chunk.map((r) => `($${params.push(r.code)}, $${params.push(r.description)}, $${params.push(r.tax)}, $${params.push(v)}, true, now())`).join(',');
      await q.query(
        `INSERT INTO cabys_codes (code, description, tax_rate, version, active, updated_at) VALUES ${values}
         ON CONFLICT (code) DO UPDATE SET description=EXCLUDED.description, tax_rate=EXCLUDED.tax_rate, version=EXCLUDED.version, active=true, updated_at=now()`, params);
    }
    await q.query(`UPDATE cabys_versions SET active=false`);
    await q.query(`INSERT INTO cabys_versions (version, source, codes, active, imported_by) VALUES ($1,$2,$3,true,$4)`, [v, file.name || null, rows.length, userId]);
  });
  return { version: v, codes: rows.length };
}

export async function catalogueInfo() {
  const v = await db.one(`SELECT * FROM cabys_versions WHERE active ORDER BY imported_at DESC LIMIT 1`);
  const n = await db.one(`SELECT count(*)::int AS n FROM cabys_codes WHERE active`);
  return { version: v?.version || null, imported_at: v?.imported_at || null, source: v?.source || null, codes: Number(n?.n || 0) };
}

/** Local search (code prefix or words in the description). Null when no catalogue is imported. */
export async function searchLocal(q: string, codigo?: string) {
  const info = await catalogueInfo();
  if (!info.codes) return null;
  if (codigo) return db.query(`SELECT code AS codigo, description AS descripcion, tax_rate AS impuesto, active FROM cabys_codes WHERE code=$1`, [codigo]);
  const words = norm(q).split(/\s+/).filter((w) => w.length > 1).slice(0, 5);
  if (!words.length) return [];
  if (/^\d{4,13}$/.test(q.trim())) return db.query(`SELECT code AS codigo, description AS descripcion, tax_rate AS impuesto FROM cabys_codes WHERE active AND code LIKE $1 ORDER BY code LIMIT 30`, [q.trim() + '%']);
  const params = words.map((w) => `%${w}%`);
  return db.query(
    `SELECT code AS codigo, description AS descripcion, tax_rate AS impuesto FROM cabys_codes
      WHERE active AND ${words.map((_, i) => `translate(lower(description),'áéíóúüñ','aeiouun') LIKE $${i + 1}`).join(' AND ')} ORDER BY length(description) LIMIT 30`, params);
}

/** Codes of a document that are not in the active catalogue (empty when no catalogue is imported). */
export async function unknownCodes(codes: string[]) {
  const info = await catalogueInfo();
  if (!info.codes || !codes.length) return [];
  const found = await db.query(`SELECT code FROM cabys_codes WHERE active AND code = ANY($1::text[])`, [[...new Set(codes)]]);
  const ok = new Set(found.map((r) => r.code));
  return [...new Set(codes)].filter((c) => !ok.has(c));
}

/** Products without a CABYS code, using only the category / default code, or with a code missing from the catalogue. */
export async function mappingReport(businessId: string) {
  const info = await catalogueInfo();
  const s = await db.one(`SELECT default_cabys FROM hacienda_settings WHERE business_id=$1`, [businessId]);
  const rows = await db.query(
    `SELECT p.id, p.name, p.cabys, p.hacienda_unit, p.type, c.name AS category, c.cabys AS category_cabys,
        cc.description AS cabys_description, cc.tax_rate AS cabys_tax, (cc.code IS NOT NULL AND cc.active) AS in_catalogue
       FROM products p LEFT JOIN categories c ON c.id=p.category_id
       LEFT JOIN cabys_codes cc ON cc.code = COALESCE(NULLIF(p.cabys,''), NULLIF(c.cabys,''))
      WHERE p.business_id=$1 AND COALESCE(p.active, true) ORDER BY p.name`, [businessId]);
  return {
    catalogue: info,
    default_cabys: s?.default_cabys || null,
    products: rows.map((r) => {
      const code = r.cabys || r.category_cabys || null;
      const status = !code ? (s?.default_cabys ? 'default' : 'missing') : !r.cabys ? 'category' : info.codes && !r.in_catalogue ? 'not_in_catalogue' : 'ok';
      return { ...r, effective_cabys: code || s?.default_cabys || null, status };
    }),
  };
}

export async function assignProductCabys(businessId: string, productId: string, code: string | null, unit: string | null, user: { id: string | null; name: string | null }) {
  const p = await db.one(`SELECT id, cabys, hacienda_unit FROM products WHERE id=$1 AND business_id=$2`, [productId, businessId]);
  if (!p) throw bad('Producto no encontrado');
  const c = code ? digits(code) : null;
  if (c && c.length !== 13) throw bad('El código CABYS debe tener 13 dígitos');
  if (c) {
    const info = await catalogueInfo();
    if (info.codes) {
      const hit = await db.one(`SELECT active FROM cabys_codes WHERE code=$1`, [c]);
      if (!hit) throw bad(`El código ${c} no existe en el catálogo CABYS ${info.version}`);
      if (!hit.active) throw bad(`El código ${c} no está vigente en el catálogo CABYS ${info.version}`);
    }
  }
  const u = unit ? String(unit).slice(0, 10) : null;
  await db.query(`UPDATE products SET cabys=$2, hacienda_unit=$3 WHERE id=$1`, [p.id, c, u]);
  if (c !== (p.cabys || null) || u !== (p.hacienda_unit || null)) {
    await db.query(`INSERT INTO product_cabys_history (business_id, product_id, old_code, new_code, old_unit, new_unit, user_id, user_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [businessId, p.id, p.cabys || null, c, p.hacienda_unit || null, u, user.id, user.name]);
  }
  return { id: p.id, cabys: c, hacienda_unit: u };
}
