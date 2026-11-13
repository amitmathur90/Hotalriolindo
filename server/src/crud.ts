import { Router } from 'express';
import { db } from './db.ts';
import { requirePerm } from './auth.ts';
import { ah, audit, bad, notFound, pick, setClause } from './util.ts';

interface CrudOpts {
  table: string;
  fields: string[];
  jsonFields?: string[];
  required?: string[];
  perm: string; // write permission
  readPerm?: string | null; // null = any authenticated user
  storeScoped?: boolean; // filter & stamp store_id from request
  orderBy?: string;
  search?: string[]; // columns searched by ?q=
  softDelete?: boolean; // set active=false instead of DELETE
}

/** Tenant-isolated CRUD endpoints: every query is constrained by business_id (and store_id when scoped). */
export function crud(o: CrudOpts) {
  const r = Router();
  const scope = (req: any, params: any[]) => {
    let w = `business_id = $${params.push(req.auth.businessId)}`;
    if (o.storeScoped && req.storeId) w += ` AND store_id = $${params.push(req.storeId)}`;
    return w;
  };
  const read = o.readPerm ? [requirePerm(o.readPerm)] : [];

  r.get('/', ...read, ah(async (req, res) => {
    const params: any[] = [];
    let where = scope(req, params);
    if (req.query.q && o.search?.length) {
      const i = params.push(`%${req.query.q}%`);
      where += ` AND (${o.search.map((c) => `${c} ILIKE $${i}`).join(' OR ')})`;
    }
    res.json(await db.query(`SELECT * FROM ${o.table} WHERE ${where} ORDER BY ${o.orderBy || 'name'} LIMIT 2000`, params));
  }));

  r.get('/:id', ...read, ah(async (req, res) => {
    const params: any[] = [req.params.id];
    const row = await db.one(`SELECT * FROM ${o.table} WHERE id = $1 AND ${scope(req, params)}`, params);
    if (!row) throw notFound();
    res.json(row);
  }));

  r.post('/', requirePerm(o.perm), ah(async (req, res) => {
    const data = pick(req.body, o.fields);
    for (const f of o.required || []) if (data[f] === undefined || data[f] === '') throw bad(`${f} is required`);
    data.business_id = req.auth.businessId;
    if (o.storeScoped) {
      if (!req.storeId) throw bad('Select a store first');
      data.store_id = req.storeId;
    }
    const keys = Object.keys(data);
    const { values } = setClause(data, 1, o.jsonFields);
    const row = await db.one(
      `INSERT INTO ${o.table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      values,
    );
    await audit(req, 'create', o.table, row!.id, data);
    res.status(201).json(row);
  }));

  r.put('/:id', requirePerm(o.perm), ah(async (req, res) => {
    const data = pick(req.body, o.fields);
    if (!Object.keys(data).length) throw bad('Nothing to update');
    const { sql, values } = setClause(data, 2, o.jsonFields);
    const params = [req.params.id, ...values];
    const row = await db.one(`UPDATE ${o.table} SET ${sql} WHERE id = $1 AND ${scope(req, params)} RETURNING *`, params);
    if (!row) throw notFound();
    await audit(req, 'update', o.table, row.id, data);
    res.json(row);
  }));

  r.delete('/:id', requirePerm(o.perm), ah(async (req, res) => {
    const params: any[] = [req.params.id];
    const sql = o.softDelete
      ? `UPDATE ${o.table} SET active = false WHERE id = $1 AND ${scope(req, params)} RETURNING id`
      : `DELETE FROM ${o.table} WHERE id = $1 AND ${scope(req, params)} RETURNING id`;
    const row = await db.one(sql, params);
    if (!row) throw notFound();
    await audit(req, 'delete', o.table, req.params.id);
    res.json({ ok: true });
  }));
  return r;
}
