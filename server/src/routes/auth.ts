import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, tx } from '../db.ts';
import { authenticate, hashPin, loadUserCtx, requirePerm, requireUser, sign, verifyToken } from '../auth.ts';
import { HttpError, ah, audit, bad } from '../util.ts';
import { createBusiness } from '../seed.ts';
import { PERMISSIONS } from '../../../shared/pricing.ts';

const r = Router();

async function sessionPayload(userId: string, storeId?: string | null) {
  const ctx = await loadUserCtx(userId);
  const user = await db.one(
    `SELECT u.id, u.name, u.email, u.employee_code, u.is_owner, u.is_super_admin, r.name AS role_name
       FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id=$1`,
    [userId],
  );
  const business = ctx.businessId ? await db.one(`SELECT * FROM businesses WHERE id=$1`, [ctx.businessId]) : null;
  let stores = ctx.businessId ? await db.query(`SELECT * FROM stores WHERE business_id=$1 AND active ORDER BY created_at`, [ctx.businessId]) : [];
  if (ctx.storeIds?.length && !ctx.isOwner) stores = stores.filter((s) => ctx.storeIds!.includes(s.id));
  return {
    user: { ...user, permissions: [...ctx.permissions] },
    business,
    stores,
    store: storeId ? stores.find((s) => s.id === storeId) ?? null : null,
  };
}

const loginLog = (business_id: any, user_id: any, method: string, ip: any, success: boolean, device_id: any = null) =>
  db.query(`INSERT INTO login_history (business_id, user_id, method, ip, success, device_id) VALUES ($1,$2,$3,$4,$5,$6)`, [
    business_id, user_id, method, ip, success, device_id,
  ]);

// Sign up: creates a business tenant with default store, roles, taxes and payment methods.
r.post('/register', ah(async (req, res) => {
  const { businessName, ownerName, email, password, phone, country } = req.body || {};
  if (!businessName || !ownerName || !email || !password) throw bad('All fields are required');
  if (String(password).length < 6) throw bad('Password must be at least 6 characters');
  if (await db.one(`SELECT 1 FROM users WHERE lower(email)=lower($1)`, [email])) throw bad('Email already registered');
  const { ownerId } = await tx((q) => createBusiness(q, { businessName, ownerName, email, password, phone, country }));
  res.status(201).json({ token: sign({ kind: 'user', uid: ownerId }), ...(await sessionPayload(ownerId)) });
}));

r.post('/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  const u = await db.one(`SELECT * FROM users WHERE lower(email)=lower($1)`, [email || '']);
  if (!u || !u.password_hash || !(await bcrypt.compare(String(password || ''), u.password_hash))) {
    if (u) await loginLog(u.business_id, u.id, 'password', req.ip, false);
    throw new HttpError(401, 'Invalid email or password');
  }
  if (!u.active) throw new HttpError(403, 'Account disabled');
  const ctx = await loadUserCtx(u.id);
  if (!ctx.permissions.has('backoffice.access') && !ctx.isSuperAdmin) throw new HttpError(403, 'No Back Office access');
  await db.query(`UPDATE users SET last_login_at=now() WHERE id=$1`, [u.id]);
  await loginLog(u.business_id, u.id, 'password', req.ip, true);
  res.json({ token: sign({ kind: 'user', uid: u.id }), ...(await sessionPayload(u.id)) });
}));

r.get('/me', authenticate, requireUser, ah(async (req, res) => {
  res.json(await sessionPayload(req.auth.userId!, req.storeId));
}));

r.post('/change-password', authenticate, requireUser, ah(async (req, res) => {
  const { current, next } = req.body || {};
  const u = await db.one(`SELECT password_hash FROM users WHERE id=$1`, [req.auth.userId]);
  if (!u?.password_hash || !(await bcrypt.compare(String(current || ''), u.password_hash))) throw bad('Current password is wrong');
  if (String(next || '').length < 8) throw bad('New password must be at least 8 characters');
  await db.query(`UPDATE users SET password_hash=$2 WHERE id=$1`, [req.auth.userId, await bcrypt.hash(next, 10)]);
  await audit(req, 'change_password', 'users', req.auth.userId);
  res.json({ ok: true });
}));

r.get('/permissions', (_req, res) => res.json(PERMISSIONS));

// ---- Devices (POS terminals, kitchen displays, customer displays) ----
r.post('/devices', authenticate, requireUser, requirePerm('settings.manage'), ah(async (req, res) => {
  const { store_id, name, kind = 'pos' } = req.body || {};
  const s = await db.one(`SELECT id FROM stores WHERE id=$1 AND business_id=$2`, [store_id, req.auth.businessId]);
  if (!s) throw bad('Invalid store');
  const d = await db.one(`INSERT INTO pos_devices (business_id, store_id, name, kind) VALUES ($1,$2,$3,$4) RETURNING *`, [
    req.auth.businessId, store_id, name || 'POS Terminal', kind,
  ]);
  await audit(req, 'register_device', 'pos_devices', d!.id, { name, kind, store_id });
  res.status(201).json({ device: d, token: sign({ kind: 'device', did: d!.id, bid: req.auth.businessId, sid: store_id }, '3650d') });
}));

r.get('/devices', authenticate, requireUser, requirePerm('settings.manage'), ah(async (req, res) => {
  res.json(await db.query(
    `SELECT d.*, s.name AS store_name FROM pos_devices d JOIN stores s ON s.id=d.store_id WHERE d.business_id=$1 ORDER BY d.created_at`,
    [req.auth.businessId],
  ));
}));

r.put('/devices/:id', authenticate, requireUser, requirePerm('settings.manage'), ah(async (req, res) => {
  const d = await db.one(`UPDATE pos_devices SET active=$3, name=COALESCE($4,name) WHERE id=$1 AND business_id=$2 RETURNING *`, [
    req.params.id, req.auth.businessId, req.body.active !== false, req.body.name ?? null,
  ]);
  await audit(req, 'update_device', 'pos_devices', req.params.id, req.body);
  res.json(d);
}));

r.get('/device', authenticate, ah(async (req, res) => {
  if (req.auth.kind !== 'device') throw bad('Not a device token');
  const d = await db.one(`SELECT * FROM pos_devices WHERE id=$1`, [req.auth.deviceId]);
  const store = await db.one(`SELECT * FROM stores WHERE id=$1`, [d!.store_id]);
  const business = await db.one(`SELECT id, name, logo_url, currency, currency_symbol FROM businesses WHERE id=$1`, [d!.business_id]);
  res.json({ device: d, store, business });
}));

// Customer display pairing: a display-only token (socket relay only, rejected by the REST API)
r.post('/display-token', authenticate, ah(async (req, res) => {
  const did = req.auth.deviceId;
  if (!did) throw bad('Pair the display from a registered POS terminal');
  res.json({ token: sign({ kind: 'display', did, bid: req.auth.businessId }, '30d'), device_id: did });
}));

// Employee PIN sign-in on a registered device
r.post('/pin', authenticate, ah(async (req, res) => {
  if (req.auth.kind !== 'device') throw bad('PIN login requires a registered device');
  const pin = String(req.body?.pin || '');
  const u = await db.one(`SELECT id, active, store_ids, is_owner FROM users WHERE business_id=$1 AND pin_hash=$2`, [
    req.auth.businessId, hashPin(req.auth.businessId, pin),
  ]);
  if (!u || !u.active) {
    await loginLog(req.auth.businessId, null, 'pin', req.ip, false, req.auth.deviceId);
    throw new HttpError(401, 'Wrong PIN');
  }
  if (u.store_ids?.length && !u.is_owner && !u.store_ids.includes(req.storeId)) throw new HttpError(403, 'Not assigned to this store');
  await loginLog(req.auth.businessId, u.id, 'pin', req.ip, true, req.auth.deviceId);
  await db.query(`UPDATE users SET last_login_at=now() WHERE id=$1`, [u.id]);
  const token = sign({ kind: 'user', uid: u.id, sid: req.storeId, did: req.auth.deviceId, bid: req.auth.businessId }, '16h');
  res.json({ token, ...(await sessionPayload(u.id, req.storeId)) });
}));

// Manager override: verify another employee's PIN holds a permission -> short-lived approval token
r.post('/approve', authenticate, requireUser, ah(async (req, res) => {
  const { pin, permission } = req.body || {};
  const u = await db.one(`SELECT id, name FROM users WHERE business_id=$1 AND pin_hash=$2 AND active`, [
    req.auth.businessId, hashPin(req.auth.businessId, String(pin || '')),
  ]);
  if (!u) throw new HttpError(401, 'Wrong PIN');
  const ctx = await loadUserCtx(u.id);
  if (!ctx.permissions.has(permission)) throw new HttpError(403, `${u.name} cannot approve this action`);
  await audit(req, 'manager_approval', 'users', u.id, { permission, approver: u.name });
  res.json({ approval_token: sign({ kind: 'approval', uid: u.id, perm: permission, bid: req.auth.businessId }, '5m'), approver: u.name });
}));

export { verifyToken };
export default r;
