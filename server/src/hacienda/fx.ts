import { db } from '../db.ts';

/**
 * US dollar exchange rate (colones per dollar) for invoices in USD.
 * Source: Ministerio de Hacienda's public indicator (BCCR reference rate, "venta"), cached per day in exchange_rates.
 * A fixed rate in Hacienda settings (usd_rate_manual) overrides it. HACIENDA_TC_URL overrides the endpoint (tests).
 */
const TC_URL = () => process.env.HACIENDA_TC_URL || 'https://api.hacienda.go.cr/indicadores/tc/dolar';
const crToday = () => new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);

export async function fetchUsdRate(): Promise<{ date: string; buy: number | null; sell: number }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(TC_URL(), { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Hacienda T/C ${res.status}`);
    const b: any = await res.json();
    const sell = Number(b?.venta?.valor);
    if (!(sell > 0)) throw new Error('Respuesta de tipo de cambio inválida');
    const date = String(b?.venta?.fecha || crToday()).slice(0, 10);
    return { date, buy: Number(b?.compra?.valor) || null, sell };
  } finally {
    clearTimeout(t);
  }
}

/** Today's rate: fixed rate from settings → cached rate of today → fresh from Hacienda → last known rate. */
export async function usdRate(businessId?: string): Promise<{ rate: number; date: string; source: string }> {
  if (businessId) {
    const s = await db.one(`SELECT usd_rate_manual FROM hacienda_settings WHERE business_id=$1`, [businessId]);
    if (Number(s?.usd_rate_manual) > 0) return { rate: Number(s!.usd_rate_manual), date: crToday(), source: 'manual' };
  }
  const today = crToday();
  const cached = await db.one(`SELECT sell, rate_date FROM exchange_rates WHERE currency='USD' AND rate_date=$1`, [today]);
  if (cached) return { rate: Number(cached.sell), date: today, source: 'hacienda' };
  try {
    const r = await fetchUsdRate();
    await db.query(
      `INSERT INTO exchange_rates (currency, rate_date, buy, sell) VALUES ('USD',$1,$2,$3) ON CONFLICT (currency, rate_date) DO UPDATE SET buy=EXCLUDED.buy, sell=EXCLUDED.sell`,
      [today, r.buy, r.sell],
    );
    return { rate: r.sell, date: today, source: 'hacienda' };
  } catch (e) {
    const last = await db.one(`SELECT sell, rate_date FROM exchange_rates WHERE currency='USD' ORDER BY rate_date DESC LIMIT 1`);
    if (last) return { rate: Number(last.sell), date: String(last.rate_date instanceof Date ? last.rate_date.toISOString() : last.rate_date).slice(0, 10), source: 'last-known' };
    throw new Error('No se pudo obtener el tipo de cambio del dólar; ingrese uno fijo en Configuración → Hacienda');
  }
}
