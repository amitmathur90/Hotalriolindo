import { db, json, tx } from '../db.ts';
import { bad } from '../util.ts';
import { digits } from '../hacienda/codes.ts';
import { getSettings, issueDocument, kickQueue, type DocPayload } from '../hacienda/service.ts';
import { usdRate } from '../hacienda/fx.ts';
import type { Receptor } from '../hacienda/xml.ts';
import { getIntegration, saveIntegration, secret } from './store.ts';

/**
 * Cloudbeds (hotel PMS) → Hacienda. Every reservation that is checked out in Cloudbeds becomes an electronic document:
 * a factura when the guest / company has a Costa Rican tax ID in Cloudbeds, otherwise a tiquete. Room nights and
 * additional items come from the reservation; IVA (13 % by default) is applied here.
 * Uses the Cloudbeds REST API with a property API key (header x-api-key). CLOUDBEDS_API_URL overrides the base (tests).
 */
const base = () => (process.env.CLOUDBEDS_API_URL || 'https://api.cloudbeds.com/api/v1.3').replace(/\/$/, '');

async function cb(cfg: any, method: string, params: Record<string, any>) {
  const key = secret(cfg, 'api_key');
  if (!key) throw bad('Falta la API key de Cloudbeds');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...(cfg.property_id ? { propertyID: cfg.property_id } : {}), ...params })) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  try {
    const res = await fetch(`${base()}/${method}?${qs}`, { headers: { 'x-api-key': key, Accept: 'application/json' }, signal: ac.signal });
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw bad('Cloudbeds rechazó la API key (revise la llave y sus permisos)');
    if (!res.ok || body.success === false) throw bad(`Cloudbeds ${method}: ${body.message || res.status}`);
    return body;
  } catch (e: any) {
    if (e.status) throw e;
    throw bad(`Sin conexión con Cloudbeds (${e.name === 'AbortError' ? 'tiempo agotado' : e.message})`);
  } finally {
    clearTimeout(t);
  }
}

const crToday = () => new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(new Date(d + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const nightsBetween = (a: string, b: string) => Math.max(1, Math.round((new Date(b + 'T12:00:00Z').getTime() - new Date(a + 'T12:00:00Z').getTime()) / 86400000));

export async function testCloudbeds(businessId: string) {
  const it = await getIntegration(businessId, 'cloudbeds');
  const r = await cb(it.config, 'getReservations', { status: 'checked_out', checkOutFrom: addDays(crToday(), -30), checkOutTo: crToday(), pageSize: 1 });
  return { ok: true, message: `Conexión correcta con Cloudbeds · ${r.total ?? r.count ?? 0} salida(s) en los últimos 30 días` };
}

/** Receptor from the guest's tax details in Cloudbeds (company tax ID first). */
function receptorOf(data: any): { receptor: Receptor | null; docType: '01' | '04' } {
  const guests: any[] = Object.values(data.guestList || {});
  const g: any = guests.find((x: any) => x.isMainGuest) || guests[0] || {};
  const email = String(g.guestEmail || data.guestEmail || '').trim() || null;
  const company = digits(g.companyTaxID);
  if (company.length === 10 && String(g.companyName || '').trim().length >= 3) {
    return { docType: '01', receptor: { nombre: String(g.companyName).trim().slice(0, 100), id_type: company.startsWith('3') ? '02' : '04', id_number: company, email } };
  }
  const tax = digits(g.taxID);
  const name = String(data.guestName || [g.guestFirstName, g.guestLastName].filter(Boolean).join(' ')).trim();
  if ((tax.length === 9 || tax.length === 11 || tax.length === 12) && name.length >= 3) {
    return { docType: '01', receptor: { nombre: name.slice(0, 100), id_type: tax.length === 9 ? '01' : '03', id_number: tax, email } };
  }
  return { docType: '04', receptor: name.length >= 3 ? { nombre: name.slice(0, 100), id_type: null, id_number: null, email } : null };
}

/** Invoice lines for a checked-out reservation (prices without IVA, in the property currency). */
export function reservationLines(data: any, cfg: any) {
  const rate = Number(cfg.tax_rate ?? 13);
  const cabys = digits(cfg.cabys);
  const lines: DocPayload['lines'] = [];
  for (const room of [...(data.assigned || []), ...(data.unassigned || [])]) {
    const daily: any[] = Array.isArray(room.dailyRates) ? room.dailyRates : [];
    const nights = daily.length || nightsBetween(room.startDate || data.startDate, room.endDate || data.endDate);
    const total = Number(room.roomTotal) || daily.reduce((s, d) => s + Number(d.rate || 0), 0);
    if (!(total > 0)) continue;
    lines.push({
      qty: nights, unit: 'Sp', cabys, tax_rate: rate, price: Math.round((total / nights) * 1e5) / 1e5,
      name: `Hospedaje ${room.roomTypeName || 'habitación'}${room.roomName ? ' ' + room.roomName : ''} · ${room.startDate || data.startDate} al ${room.endDate || data.endDate} (${nights} noche${nights === 1 ? '' : 's'})`,
    });
  }
  const bd = Array.isArray(data.balanceDetailed) ? data.balanceDetailed[0] : data.balanceDetailed;
  const extras = Number(bd?.additionalItems) || 0;
  if (extras > 0) lines.push({ qty: 1, unit: 'Sp', cabys: digits(cfg.extras_cabys) || cabys, tax_rate: rate, price: extras, name: 'Cargos adicionales de la estadía' });
  const ours = lines.reduce((s, l) => s + l.price * l.qty, 0) * (1 + rate / 100);
  const theirs = Number(bd?.grandTotal) || Number(data.total) || 0;
  return { lines, ours: Math.round(ours * 100) / 100, theirs };
}

async function issueFor(businessId: string, cfg: any, data: any, force = false) {
  const s = await getSettings(db, businessId);
  if (!s?.enabled) throw bad('La facturación electrónica no está activada');
  if (!/^\d{13}$/.test(digits(cfg.cabys))) throw bad('Configure el CABYS de hospedaje en Integraciones → Cloudbeds');
  const { lines, ours, theirs } = reservationLines(data, cfg);
  if (!lines.length) return { status: 'skipped', message: 'La reservación no tiene cargos de habitación' };
  if (!force && theirs > 0 && Math.abs(ours - theirs) > Math.max(1, theirs * 0.02)) {
    return { status: 'review', message: `El total calculado (${ours.toFixed(2)}) no coincide con Cloudbeds (${theirs.toFixed(2)}): revise y emita manualmente` };
  }
  const { receptor, docType } = receptorOf(data);
  const currency = cfg.currency === 'CRC' ? 'CRC' : 'USD';
  const fx = currency === 'USD' ? (await usdRate(businessId)).rate : 1;
  const store = cfg.store_id ? { id: cfg.store_id } : await db.one(`SELECT id FROM stores WHERE business_id=$1 ORDER BY created_at LIMIT 1`, [businessId]);
  const doc = await tx((q) => issueDocument(q, {
    businessId, storeId: store!.id, docType, issuedAt: new Date(), source: 'cloudbeds', receptor, currency, exchangeRate: fx,
    externalRef: String(data.reservationID), notes: `Cloudbeds reservación ${data.reservationID} · ${data.guestName || ''}`.trim(),
    payload: { lines, payments: [{ type: cfg.payment_type || 'card', amount: ours }], condition: '01' },
  }));
  kickQueue();
  return { status: 'issued', document: doc };
}

async function record(businessId: string, data: any, out: any) {
  await db.query(
    `INSERT INTO cloudbeds_reservations (business_id, reservation_id, guest_name, check_in, check_out, total, currency, status, e_document_id, message, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (business_id, reservation_id) DO UPDATE SET status=EXCLUDED.status, e_document_id=COALESCE(EXCLUDED.e_document_id, cloudbeds_reservations.e_document_id),
       message=EXCLUDED.message, data=EXCLUDED.data, total=EXCLUDED.total, updated_at=now()`,
    [businessId, String(data.reservationID), data.guestName || null, data.startDate || null, data.endDate || null, Number(data.total) || null, null, out.status, out.document?.id || null, out.message || null, json(data)],
  );
}

/** Pulls recent check-outs and issues their documents. */
export async function syncCloudbeds(businessId: string) {
  const it = await getIntegration(businessId, 'cloudbeds');
  if (!it.enabled) return { checked: 0, issued: 0, review: 0, errors: 0 };
  const cfg = it.config;
  const today = crToday();
  const from = [addDays(today, -Number(cfg.lookback_days || 7)), cfg.start_date].filter(Boolean).sort().pop()!;
  const out = { checked: 0, issued: 0, review: 0, errors: 0 };
  try {
    for (let page = 1; page <= 20; page++) {
      const list = await cb(cfg, 'getReservations', { status: 'checked_out', checkOutFrom: from, checkOutTo: today, pageNumber: page, pageSize: 100 });
      const rows: any[] = list.data || [];
      for (const r of rows) {
        out.checked++;
        const known = await db.one(`SELECT status FROM cloudbeds_reservations WHERE business_id=$1 AND reservation_id=$2`, [businessId, String(r.reservationID)]);
        if (known && known.status !== 'error') continue;
        try {
          const full = (await cb(cfg, 'getReservation', { reservationID: r.reservationID })).data;
          const res = cfg.auto_issue === false ? { status: 'review', message: 'Pendiente de emitir (emisión automática desactivada)' } : await issueFor(businessId, cfg, full);
          await record(businessId, full, res);
          if (res.status === 'issued') out.issued++;
          if (res.status === 'review') out.review++;
        } catch (e: any) {
          out.errors++;
          await record(businessId, r, { status: 'error', message: String(e.message || e) });
        }
      }
      if (rows.length < 100) break;
    }
    await saveIntegration(businessId, 'cloudbeds', { last_sync_at: new Date(), last_error: null });
  } catch (e: any) {
    await saveIntegration(businessId, 'cloudbeds', { last_sync_at: new Date(), last_error: String(e.message || e) });
    throw e;
  }
  return out;
}

/** Issue (or re-try) the document of one reservation from the review list. */
export async function issueReservation(businessId: string, reservationId: string) {
  const it = await getIntegration(businessId, 'cloudbeds');
  const row = await db.one(`SELECT * FROM cloudbeds_reservations WHERE business_id=$1 AND reservation_id=$2`, [businessId, reservationId]);
  if (!row) throw bad('Reservación no encontrada');
  if (row.status === 'issued') throw bad('Esta reservación ya tiene comprobante');
  const full = (await cb(it.config, 'getReservation', { reservationID: reservationId })).data;
  const res = await issueFor(businessId, it.config, full, true);
  await record(businessId, full, res);
  return res;
}
