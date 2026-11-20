import type { Request, Response, NextFunction } from 'express';

/** Simple in-memory rate limit per user (or IP): at most `perMinute` requests in a sliding minute. */
export function rateLimit(perMinute: number) {
  const hits = new Map<string, number[]>();
  setInterval(() => { const cut = Date.now() - 60000; for (const [k, v] of hits) { const n = v.filter((t) => t > cut); n.length ? hits.set(k, n) : hits.delete(k); } }, 60000).unref();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = (req as any).auth?.userId || (req as any).auth?.deviceId || req.ip || 'anon';
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => t > now - 60000);
    if (list.length >= perMinute) {
      res.setHeader('Retry-After', '30');
      return res.status(429).json({ error: 'Demasiadas solicitudes; intente de nuevo en unos segundos' });
    }
    list.push(now);
    hits.set(key, list);
    next();
  };
}
