import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import { db, json, type Q } from './db.ts';
import { emit } from './realtime.ts';

export { HttpError, bad, notFound, ah } from './errors.ts';

export function pick(obj: any, fields: string[]) {
  const out: Record<string, any> = {};
  for (const f of fields) if (obj && obj[f] !== undefined) out[f] = obj[f];
  return out;
}

export const num = (v: any, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

/** Build "col1=$2, col2=$3" for updates; jsonCols get stringified. */
export function setClause(data: Record<string, any>, start: number, jsonCols: string[] = []) {
  const keys = Object.keys(data);
  return {
    sql: keys.map((k, i) => `${k} = $${i + start}`).join(', '),
    values: keys.map((k) => (jsonCols.includes(k) ? json(data[k]) : data[k] === '' ? null : data[k])),
  };
}

export async function audit(
  req: Request | null,
  action: string,
  entity?: string,
  entity_id?: string | null,
  details?: any,
  q: Q = db,
) {
  const u = req?.auth;
  await q.query(
    `INSERT INTO audit_logs (business_id, store_id, user_id, user_name, action, entity, entity_id, details, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [u?.businessId ?? null, req?.storeId ?? null, u?.userId ?? null, u?.userName ?? null, action, entity ?? null,
     entity_id ?? null, json(details), req?.ip ?? null],
  );
}

export async function notify(businessId: string, storeId: string | null, type: string, message: string, data?: any, q: Q = db) {
  const n = await q.one(
    `INSERT INTO notifications (business_id, store_id, type, message, data) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [businessId, storeId, type, message, json(data)],
  );
  emit(`business:${businessId}`, 'notification', n);
  return n;
}

/** Date-range helper: ?from=ISO&to=ISO (defaults to today, server local time). */
export function range(req: Request) {
  const now = new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = req.query.to ? new Date(String(req.query.to)) : new Date(from.getTime() + 86400000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Signature for public digital-receipt links (/r/:id/:sig) so receipts can't be enumerated. */
export const receiptSig = (id: string) =>
  createHmac('sha256', process.env.JWT_SECRET || 'dev-only-change-me').update(`receipt:${id}`).digest('hex').slice(0, 16);
