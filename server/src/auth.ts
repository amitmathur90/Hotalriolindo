import jwt from 'jsonwebtoken';
import { createHmac } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { db } from './db.ts';
import { HttpError, ah } from './errors.ts';
import { PERMISSIONS } from '../../shared/pricing.ts';

const SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}

export interface AuthCtx {
  kind: 'user' | 'device';
  businessId: string;
  userId?: string;
  userName?: string;
  deviceId?: string;
  isOwner?: boolean;
  isSuperAdmin?: boolean;
  storeIds?: string[]; // empty = all
  permissions: Set<string>;
}

declare global {
  namespace Express {
    interface Request {
      auth: AuthCtx;
      storeId: string | null;
    }
  }
}

export const sign = (payload: object, expiresIn: string | number = '12h') =>
  jwt.sign(payload, SECRET, { expiresIn } as any);
export const verifyToken = (t: string) => jwt.verify(t, SECRET) as any;

export const hashPin = (businessId: string, pin: string) =>
  createHmac('sha256', SECRET).update(`${businessId}:${pin}`).digest('hex');

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS);

export function effectivePermissions(user: any, rolePerms: string[] = []) {
  if (user.is_owner || user.is_super_admin || rolePerms.includes('*')) return new Set(ALL_PERMISSIONS);
  const s = new Set<string>([...rolePerms, ...(user.extra_permissions || [])]);
  for (const d of user.denied_permissions || []) s.delete(d);
  return s;
}

export async function loadUserCtx(userId: string): Promise<AuthCtx> {
  const u = await db.one(
    `SELECT u.*, r.permissions AS role_permissions, b.status AS business_status
       FROM users u LEFT JOIN roles r ON r.id = u.role_id LEFT JOIN businesses b ON b.id = u.business_id
      WHERE u.id = $1`,
    [userId],
  );
  if (!u || !u.active) throw new HttpError(401, 'User inactive or not found');
  if (u.business_status === 'suspended' && !u.is_super_admin) throw new HttpError(403, 'Business account is suspended');
  return {
    kind: 'user',
    businessId: u.business_id,
    userId: u.id,
    userName: u.name,
    isOwner: u.is_owner,
    isSuperAdmin: u.is_super_admin,
    storeIds: u.store_ids || [],
    permissions: effectivePermissions(u, u.role_permissions || []),
  };
}

/** Accepts user tokens (back office / POS after PIN) and device tokens (KDS / customer display). */
export const authenticate = ah(async (req: Request, _res: Response, next: NextFunction) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : String(req.query.token || '');
  if (!token) throw new HttpError(401, 'Authentication required');
  let p: any;
  try {
    p = verifyToken(token);
  } catch {
    throw new HttpError(401, 'Session expired, please sign in again');
  }
  if (p.kind === 'device') {
    const d = await db.one(`SELECT * FROM pos_devices WHERE id=$1 AND active`, [p.did]);
    if (!d) throw new HttpError(401, 'Device is not registered or was deactivated');
    await db.query(`UPDATE pos_devices SET last_seen_at=now() WHERE id=$1`, [d.id]);
    req.auth = { kind: 'device', businessId: d.business_id, deviceId: d.id, permissions: new Set(['kitchen.view']) };
    req.storeId = d.store_id;
  } else if (p.kind === 'user') {
    req.auth = await loadUserCtx(p.uid);
    if (p.did) req.auth.deviceId = p.did;
    req.storeId = (req.headers['x-store-id'] as string) || p.sid || null;
  } else throw new HttpError(401, 'Invalid token');

  if (req.storeId) {
    const s = await db.one(`SELECT id FROM stores WHERE id=$1 AND business_id=$2`, [req.storeId, req.auth.businessId]);
    if (!s) throw new HttpError(403, 'Store does not belong to this business');
    const allowed = req.auth.storeIds;
    if (req.auth.kind === 'user' && allowed?.length && !allowed.includes(req.storeId) && !req.auth.isOwner)
      throw new HttpError(403, 'You are not assigned to this store');
  }
  next();
});

export const requireUser = (req: Request, _res: Response, next: NextFunction) =>
  req.auth?.kind === 'user' ? next() : next(new HttpError(403, 'Employee sign-in required'));

export const requirePerm =
  (...perms: string[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(new HttpError(401, 'Authentication required'));
    if (perms.some((p) => req.auth.permissions.has(p))) return next();
    next(new HttpError(403, `Permission required: ${perms.map((p) => PERMISSIONS[p] || p).join(' / ')}`));
  };

export const requireStore = (req: Request, _res: Response, next: NextFunction) =>
  req.storeId ? next() : next(new HttpError(400, 'Select a store first'));

export const requireSuperAdmin = (req: Request, _res: Response, next: NextFunction) =>
  req.auth?.isSuperAdmin ? next() : next(new HttpError(403, 'Super admin only'));

/** Manager override: a short-lived token proving another employee approved a permission. */
export function hasPermOrApproval(req: Request, perm: string, approvalToken?: string) {
  if (req.auth.permissions.has(perm)) return { ok: true, approver: req.auth.userId };
  if (!approvalToken) return { ok: false };
  try {
    const p = verifyToken(approvalToken);
    if (p.kind === 'approval' && p.perm === perm && p.bid === req.auth.businessId) return { ok: true, approver: p.uid };
  } catch {}
  return { ok: false };
}
