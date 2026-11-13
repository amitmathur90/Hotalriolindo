import type { Q } from './db.ts';
import { HttpError } from './errors.ts';

export interface StockCtx {
  businessId: string;
  storeId: string;
  userId?: string | null;
  allowNegative: boolean;
  lowStock: { variant_id: string; name: string; qty: number; reorder: number }[];
  conflicts: { variant_id: string; name: string; qty: number }[];
}

/**
 * Apply a stock change to one variant. Composite/recipe variants consume their components instead.
 * Records a stock movement for every change so stock history is always reconstructable.
 */
export async function applyStock(
  q: Q, ctx: StockCtx, variantId: string, change: number, reason: string,
  ref?: { type: string; id: string }, note?: string, depth = 0,
): Promise<void> {
  if (!change || depth > 4) return;
  const v = await q.one(
    `SELECT v.id, v.reorder_level, p.track_stock, p.type, p.name || CASE WHEN v.name <> '' THEN ' (' || v.name || ')' ELSE '' END AS label
       FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND v.business_id=$2`,
    [variantId, ctx.businessId],
  );
  if (!v) return;
  const components = await q.query(`SELECT component_variant_id, qty FROM product_components WHERE variant_id=$1`, [variantId]);
  if (components.length && (v.type === 'composite' || !v.track_stock)) {
    for (const c of components) await applyStock(q, ctx, c.component_variant_id, change * Number(c.qty), reason, ref, note ?? `via ${v.label}`, depth + 1);
    return;
  }
  if (!v.track_stock) return;
  const row = await q.one(
    `INSERT INTO inventory (store_id, variant_id, qty) VALUES ($1,$2,$3)
     ON CONFLICT (store_id, variant_id) DO UPDATE SET qty = inventory.qty + EXCLUDED.qty RETURNING qty`,
    [ctx.storeId, variantId, change],
  );
  const after = Number(row!.qty);
  if (after < 0 && change < 0) {
    if (!ctx.allowNegative) throw new HttpError(409, `Not enough stock for ${v.label} (would be ${after})`);
    ctx.conflicts.push({ variant_id: variantId, name: v.label, qty: after });
  }
  if (change < 0 && after <= Number(v.reorder_level)) ctx.lowStock.push({ variant_id: variantId, name: v.label, qty: after, reorder: Number(v.reorder_level) });
  await q.query(
    `INSERT INTO stock_movements (business_id, store_id, variant_id, qty_change, qty_after, reason, ref_type, ref_id, user_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ctx.businessId, ctx.storeId, variantId, change, after, reason, ref?.type ?? null, ref?.id ?? null, ctx.userId ?? null, note ?? null],
  );
}
