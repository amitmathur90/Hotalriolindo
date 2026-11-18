import { createHash } from 'node:crypto';
import { db, tx, type Q } from '../db.ts';
import { bad } from '../util.ts';

/** Default chart of accounts for a Costa Rican hotel / restaurant (editable; "key" accounts drive automatic postings). */
type A = [code: string, name: string, type: string, subtype: string | null, key: string | null, currency?: string, cashFlow?: string];
export const DEFAULT_CHART: A[] = [
  ['1-01-01', 'Caja general', 'asset', 'cash', 'cash'],
  ['1-01-02', 'Caja chica', 'asset', 'cash', 'petty_cash'],
  ['1-01-03', 'Banco cuenta colones', 'asset', 'bank', 'bank_crc'],
  ['1-01-04', 'Banco cuenta dólares', 'asset', 'bank', 'bank_usd', 'USD'],
  ['1-01-05', 'Tarjetas por liquidar (datáfonos)', 'asset', 'other', 'card_clearing'],
  ['1-01-10', 'Cuentas por cobrar clientes', 'asset', 'receivable', 'ar'],
  ['1-01-11', 'Adelantos a empleados (vales)', 'asset', 'other', 'advances'],
  ['1-01-20', 'Inventario de alimentos y bebidas', 'asset', 'inventory', 'inventory'],
  ['1-01-30', 'IVA soportado (crédito fiscal)', 'asset', 'tax', 'iva_credit'],
  ['1-02-01', 'Mobiliario y equipo', 'asset', 'fixed', 'fixed_assets', 'CRC', 'investing'],
  ['1-02-02', 'Edificios e instalaciones', 'asset', 'fixed', null, 'CRC', 'investing'],
  ['1-02-09', 'Depreciación acumulada', 'asset', 'fixed', 'depreciation_acc', 'CRC', 'investing'],
  ['2-01-01', 'Cuentas por pagar proveedores', 'liability', 'payable', 'ap'],
  ['2-01-02', 'IVA por pagar', 'liability', 'tax', 'iva_payable'],
  ['2-01-03', 'Impuesto de servicio 10% por pagar', 'liability', 'other', 'service_payable'],
  ['2-01-04', 'Propinas por pagar', 'liability', 'other', 'tips_payable'],
  ['2-01-05', 'Salarios por pagar', 'liability', 'other', 'salaries_payable'],
  ['2-01-06', 'CCSS por pagar', 'liability', 'other', 'ccss_payable'],
  ['2-01-07', 'Otras retenciones por pagar', 'liability', 'other', 'withholdings'],
  ['2-01-08', 'Tarjetas de regalo y anticipos de clientes', 'liability', 'other', 'gift_cards'],
  ['2-02-01', 'Préstamos bancarios', 'liability', 'other', 'loans', 'CRC', 'financing'],
  ['3-01-01', 'Capital social', 'equity', null, 'capital', 'CRC', 'financing'],
  ['3-02-01', 'Utilidades retenidas', 'equity', null, 'retained', 'CRC', 'financing'],
  ['3-03-01', 'Saldos de apertura', 'equity', null, 'opening', 'CRC', 'financing'],
  ['4-01-01', 'Ventas de alimentos y bebidas', 'income', null, 'sales_pos'],
  ['4-01-02', 'Ingresos por hospedaje', 'income', null, 'sales_lodging'],
  ['4-01-03', 'Otros ingresos por servicios', 'income', null, 'sales_other'],
  ['4-02-01', 'Diferencial cambiario (ganancia)', 'income', null, 'fx_gain'],
  ['5-01-01', 'Costo de ventas', 'expense', 'cogs', 'cogs'],
  ['6-01-01', 'Sueldos y salarios', 'expense', null, 'payroll'],
  ['6-01-02', 'Cargas sociales patronales', 'expense', null, 'payroll_employer'],
  ['6-02-01', 'Compras y suministros', 'expense', null, 'expense_default'],
  ['6-02-02', 'Insumos de cocina y bar', 'expense', null, null],
  ['6-02-03', 'Limpieza', 'expense', null, null],
  ['6-02-04', 'Mantenimiento y reparaciones', 'expense', null, null],
  ['6-02-05', 'Servicios públicos (agua, luz, internet)', 'expense', null, null],
  ['6-02-06', 'Servicios profesionales', 'expense', null, null],
  ['6-02-07', 'Gastos bancarios y comisiones', 'expense', null, 'bank_fees'],
  ['6-02-08', 'Depreciación', 'expense', null, 'depreciation'],
  ['6-02-09', 'Diferencial cambiario (pérdida)', 'expense', null, 'fx_loss'],
  ['6-02-10', 'Faltantes y sobrantes de caja', 'expense', null, 'cash_over_short'],
  ['6-02-99', 'Otros gastos', 'expense', null, null],
];

export async function ensureChart(businessId: string) {
  const n = await db.one(`SELECT count(*)::int AS n FROM acc_accounts WHERE business_id=$1`, [businessId]);
  await db.query(`INSERT INTO acc_settings (business_id) VALUES ($1) ON CONFLICT (business_id) DO NOTHING`, [businessId]);
  if (Number(n?.n) > 0) {
    // later versions may add key accounts: create the missing ones
    for (const a of DEFAULT_CHART.filter((x) => x[4])) {
      await db.query(
        `INSERT INTO acc_accounts (business_id, code, name, type, subtype, key, currency, cash_flow) SELECT $1,$2,$3,$4,$5,$6,$7,$8
         WHERE NOT EXISTS (SELECT 1 FROM acc_accounts WHERE business_id=$1 AND (key=$6 OR code=$2))`,
        [businessId, a[0], a[1], a[2], a[3], a[4], a[5] || 'CRC', a[6] || 'operating'],
      );
    }
    return;
  }
  for (const a of DEFAULT_CHART) {
    await db.query(`INSERT INTO acc_accounts (business_id, code, name, type, subtype, key, currency, cash_flow) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [businessId, a[0], a[1], a[2], a[3], a[4], a[5] || 'CRC', a[6] || 'operating']);
  }
  // Accountant role gets the accounting permissions
  await db.query(
    `UPDATE roles SET permissions = permissions || '["accounting.view","accounting.manage"]'::jsonb
      WHERE business_id=$1 AND name IN ('Accountant','Contador') AND NOT permissions ? 'accounting.view'`, [businessId]);
}

export async function accountsByKey(q: Q, businessId: string) {
  const rows = await q.query(`SELECT * FROM acc_accounts WHERE business_id=$1`, [businessId]);
  const byKey: Record<string, any> = {};
  const byId: Record<string, any> = {};
  for (const r of rows) { if (r.key) byKey[r.key] = r; byId[r.id] = r; }
  return { byKey, byId, all: rows };
}

export const r2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export type Line = { account_id: string; debit?: number; credit?: number; amount_fc?: number | null; description?: string | null; partner?: string | null };
export type EntryInput = { date: string; memo: string; source: string; source_id?: string | null; lines: Line[]; userId?: string | null; userName?: string | null };

/** Normalises lines: rounds, merges nothing, drops zero lines, nets a debit/credit pair, and balances tiny rounding differences. */
function clean(lines: Line[]) {
  const out = lines
    .map((l) => {
      let d = r2(l.debit || 0), c = r2(l.credit || 0);
      if (d < 0) { c = r2(c - d); d = 0; }
      if (c < 0) { d = r2(d - c); c = 0; }
      if (d && c) { const n = r2(d - c); d = n > 0 ? n : 0; c = n < 0 ? -n : 0; }
      return { ...l, debit: d, credit: c };
    })
    .filter((l) => l.debit || l.credit || (l.amount_fc && Math.abs(l.amount_fc) > 0.004));
  const diff = r2(out.reduce((s, l) => s + l.debit - l.credit, 0));
  if (Math.abs(diff) >= 0.005) {
    if (Math.abs(diff) > 1) throw bad(`El asiento no cuadra (diferencia ${diff})`);
    // rounding (≤ ₡1): adjust the largest line on the side that is short
    const side = diff > 0 ? 'credit' : 'debit';
    const target = out.filter((l) => l[side] > 0).sort((a, b) => b[side] - a[side])[0];
    if (target) target[side] = r2(target[side] + Math.abs(diff));
  }
  return out;
}

export const hashOf = (v: any) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 20);

async function settings(q: Q, businessId: string) {
  return (await q.one(`SELECT * FROM acc_settings WHERE business_id=$1`, [businessId])) || {};
}
const isoDate = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const addDay = (d: string) => new Date(new Date(d + 'T12:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);

/** Inserts a balanced entry. Automatic entries dated inside a closed period move to the first open day. */
export async function postEntry(q: Q, businessId: string, e: EntryInput, opts: { hash?: string; allowLocked?: boolean } = {}) {
  const lines = clean(e.lines);
  if (lines.length < 2 && !lines.some((l) => l.amount_fc)) return null;
  const st = await settings(q, businessId);
  let date = isoDate(e.date);
  const locked = st.locked_until ? isoDate(st.locked_until) : null;
  let memo = e.memo;
  if (locked && date <= locked && !opts.allowLocked) {
    if (e.source === 'manual') throw bad(`El período está cerrado hasta ${locked}`);
    memo = `${memo} (fecha original ${date}; período cerrado)`;
    date = addDay(locked);
  }
  const num = await q.one(`SELECT COALESCE(max(number),0)+1 AS n FROM acc_entries WHERE business_id=$1`, [businessId]);
  const entry = await q.one(
    `INSERT INTO acc_entries (business_id, number, entry_date, memo, source, source_id, hash, created_by, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [businessId, num!.n, date, memo.slice(0, 500), e.source, e.source_id ?? null, opts.hash ?? null, e.userId ?? null, e.userName ?? null],
  );
  for (const l of lines) {
    await q.query(`INSERT INTO acc_lines (entry_id, business_id, account_id, debit, credit, amount_fc, description, partner) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [entry!.id, businessId, l.account_id, l.debit, l.credit, l.amount_fc ?? null, l.description ?? null, l.partner ?? null]);
  }
  return entry!;
}

/** Reverses an entry (mirror lines) dated today or a given date; the original stays in the ledger, marked inactive. */
export async function reverseEntry(q: Q, businessId: string, entryId: string, o: { date?: string; memo?: string; userId?: string | null; userName?: string | null } = {}) {
  const e = await q.one(`SELECT * FROM acc_entries WHERE id=$1 AND business_id=$2`, [entryId, businessId]);
  if (!e) throw bad('Asiento no encontrado');
  if (!e.active) throw bad('El asiento ya fue reversado');
  const lines = await q.query(`SELECT * FROM acc_lines WHERE entry_id=$1`, [entryId]);
  const rev = await postEntry(q, businessId, {
    date: o.date || isoDate(e.entry_date), memo: o.memo || `Reversión del asiento #${e.number}: ${e.memo || ''}`, source: e.source === 'manual' ? 'manual' : 'reversal', source_id: e.source_id,
    userId: o.userId, userName: o.userName,
    lines: lines.map((l) => ({ account_id: l.account_id, debit: Number(l.credit), credit: Number(l.debit), amount_fc: l.amount_fc != null ? -Number(l.amount_fc) : null, description: l.description, partner: l.partner })),
  });
  await q.query(`UPDATE acc_entries SET active=false, reversed_by=$2 WHERE id=$1`, [entryId, rev?.id ?? null]);
  if (rev) await q.query(`UPDATE acc_entries SET active=false, reverses=$2 WHERE id=$1`, [rev.id, entryId]);
  return rev;
}

/**
 * Keeps the automatic entry of a source in step with it: posts it the first time, does nothing when unchanged,
 * and reverses + re-posts when the source changed (or reverses only, when the source no longer produces an entry).
 */
export async function upsertAuto(businessId: string, source: string, sourceId: string, build: (() => EntryInput | null) | EntryInput | null) {
  const e = typeof build === 'function' ? build() : build;
  const hash = e ? hashOf({ d: e.date, l: clean(e.lines).map((l) => [l.account_id, l.debit, l.credit, l.amount_fc ?? null]) }) : null;
  return tx(async (q) => {
    const cur = await q.one(`SELECT * FROM acc_entries WHERE business_id=$1 AND source=$2 AND source_id=$3 AND active ORDER BY created_at DESC LIMIT 1`, [businessId, source, sourceId]);
    if (cur && cur.hash === hash) return 'same';
    if (cur) await reverseEntry(q, businessId, cur.id, { date: e?.date && isoDate(e.date) > isoDate(cur.entry_date) ? e.date : undefined, memo: `Corrección: reversa asiento #${cur.number} (${cur.memo || ''})` });
    if (!e) return cur ? 'reversed' : 'none';
    await postEntry(q, businessId, e, { hash: hash! });
    return cur ? 'updated' : 'posted';
  });
}
