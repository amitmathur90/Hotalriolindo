let SYMBOL = '₡';
let LOCALE = 'es-CR';
/** Set from the business settings (currency symbol + number/date locale, e.g. ₡ / es-CR). */
export const setCurrency = (s?: string, locale?: string) => {
  if (s) SYMBOL = s;
  if (locale) LOCALE = locale;
};
export const getLocale = () => LOCALE;
export const money = (n: any, sym = SYMBOL) =>
  `${Number(n) < 0 ? '-' : ''}${sym}${Math.abs(Number(n) || 0).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const qty = (n: any) => (Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(3).replace(/0+$/, ''));
export const dt = (d: any) => (d ? new Date(d).toLocaleString(LOCALE, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
export const dateOnly = (d: any) => (d ? new Date(d).toLocaleDateString(LOCALE, { day: '2-digit', month: 'short', year: 'numeric' }) : '');
export const uuid = () => crypto.randomUUID();

export type RangeKey = 'today' | 'yesterday' | 'week' | 'month' | 'last30' | 'custom';
export const RANGE_LABELS: Record<RangeKey, string> = { today: 'Today', yesterday: 'Yesterday', week: 'This week', month: 'This month', last30: 'Last 30 days', custom: 'Custom' };

export function rangeOf(key: RangeKey, custom?: { from: string; to: string }) {
  const now = new Date();
  const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = 86400000;
  switch (key) {
    case 'yesterday':
      return { from: new Date(sod.getTime() - day), to: sod };
    case 'week': {
      const d = (sod.getDay() + 6) % 7;
      return { from: new Date(sod.getTime() - d * day), to: new Date(sod.getTime() + day) };
    }
    case 'month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(sod.getTime() + day) };
    case 'last30':
      return { from: new Date(sod.getTime() - 29 * day), to: new Date(sod.getTime() + day) };
    case 'custom':
      if (custom?.from && custom?.to)
        return { from: new Date(custom.from + 'T00:00'), to: new Date(new Date(custom.to + 'T00:00').getTime() + day) };
      return { from: sod, to: new Date(sod.getTime() + day) };
    default:
      return { from: sod, to: new Date(sod.getTime() + day) };
  }
}
export const rangeQuery = (r: { from: Date; to: Date }) =>
  `from=${encodeURIComponent(r.from.toISOString())}&to=${encodeURIComponent(r.to.toISOString())}`;
