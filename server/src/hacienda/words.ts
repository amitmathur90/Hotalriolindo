/** Amount in Spanish words, as printed on Costa Rican invoices: "Mil ochocientos colones exactos". */
const U = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
  'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco',
  'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const T = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const H = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

function upTo999(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  const h = Math.floor(n / 100), r = n % 100;
  let s = H[h];
  if (r) {
    const rs = r < 30 ? U[r] : T[Math.floor(r / 10)] + (r % 10 ? ' y ' + U[r % 10] : '');
    s = (s ? s + ' ' : '') + rs;
  }
  return s;
}

export function numberToWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'cero';
  const parts: string[] = [];
  const millions = Math.floor(n / 1e6), thousands = Math.floor((n % 1e6) / 1000), rest = n % 1000;
  if (millions) parts.push(millions === 1 ? 'un millón' : numberToWords(millions).replace(/uno$/, 'un') + ' millones');
  if (thousands) parts.push(thousands === 1 ? 'mil' : upTo999(thousands).replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un') + ' mil');
  if (rest) parts.push(upTo999(rest));
  return parts.join(' ');
}

export function amountInWords(amount: number, currency: string) {
  const cents = Math.round(Math.abs(amount) * 100) % 100;
  const whole = Math.floor(Math.round(Math.abs(amount) * 100) / 100);
  let w = numberToWords(whole) + (whole >= 1e6 && whole % 1e6 === 0 ? ' de' : '');
  if (currency === 'USD') w += whole === 1 ? ' dólar' : ' dólares';
  else w = w.replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un') + (whole === 1 ? ' colón' : ' colones');
  w += cents ? ` con ${String(cents).padStart(2, '0')}/100` : ' exactos';
  return w.charAt(0).toUpperCase() + w.slice(1);
}
