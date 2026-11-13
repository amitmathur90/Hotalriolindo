import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { connectSocket } from '../lib/misc';
import { money, qty as fq } from '../lib/format';

const KEY = 'its.display.token';

/** Customer-facing screen. Paired to one POS terminal via a display-only token (in the URL hash). */
export default function CustomerDisplay() {
  const [token] = useState(() => {
    const h = location.hash.slice(1);
    if (h) { localStorage.setItem(KEY, h); history.replaceState(null, '', '/display'); return h; }
    return localStorage.getItem(KEY);
  });
  const [st, setSt] = useState<any>(null);
  const [connected, setConnected] = useState(false);
  const [qr, setQr] = useState('');

  useEffect(() => {
    if (!token) return;
    const s = connectSocket(token);
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', () => setConnected(false));
    s.on('display:update', (p) => setSt(p.state));
    return () => { s.disconnect(); };
  }, [token]);

  const sym = st?.business?.currency_symbol || '₡';
  const es = String(st?.business?.locale || 'es').startsWith('es');
  const t = (spanish: string, english: string) => (es ? spanish : english);
  const m = (n: any) => money(n, sym);
  useEffect(() => {
    if (st?.stage === 'payment' && st.business?.upi_id && st.totals?.total > 0)
      QRCode.toDataURL(`upi://pay?pa=${encodeURIComponent(st.business.upi_id)}&pn=${encodeURIComponent(st.business.name)}&am=${Number(st.totals.total).toFixed(2)}&cu=INR`, { width: 260, margin: 1 }).then(setQr);
    else setQr('');
  }, [st?.stage, st?.totals?.total]);

  if (!token) return (
    <div className="flex h-full items-center justify-center bg-slate-900 p-8 text-center text-slate-300">
      <div><div className="mb-2 text-2xl font-semibold text-white">Customer display</div>Open this screen from the POS: Menu → Customer display.</div>
    </div>
  );

  if (!st || st.stage === 'idle') return (
    <div className="flex h-full flex-col items-center justify-center bg-gradient-to-br from-brand-700 to-slate-900 text-white">
      {st?.business?.logo_url ? <img src={st.business.logo_url} className="mb-6 max-h-32" alt="" /> : <img src="/icon.svg" className="mb-6 h-24" alt="" />}
      <div className="text-5xl font-bold">{st?.business?.name || 'Welcome'}</div>
      <div className="mt-3 text-xl text-brand-100">{t('¡Bienvenido! Su orden aparecerá aquí.', 'Welcome! Your order will appear here.')}</div>
      {!connected && <div className="mt-8 text-sm text-amber-300">Connecting to the POS…</div>}
    </div>
  );

  if (st.stage === 'thanks' && st.done) return (
    <div className="flex h-full flex-col items-center justify-center bg-gradient-to-br from-emerald-600 to-brand-800 text-white">
      <div className="text-6xl font-bold">{t('¡Gracias! · Pura Vida', 'Thank you!')}</div>
      <div className="mt-6 text-2xl">{t('Pagado', 'Paid')} {m(st.done.paid)}</div>
      {Number(st.done.change) > 0 && <div className="mt-2 text-4xl font-bold">{t('Su vuelto', 'Your change')}: {m(st.done.change)}</div>}
      {Number(st.done.points) > 0 && <div className="mt-4 text-xl text-amber-200">{t(`Ganó ${st.done.points} puntos`, `You earned ${st.done.points} loyalty points`)}</div>}
      <div className="mt-10 text-lg text-white/80">{t(`Esperamos verle pronto en ${st.business.name}`, `Please visit ${st.business.name} again`)}</div>
    </div>
  );

  return (
    <div className="flex h-full bg-slate-50 text-slate-900">
      <div className="flex flex-1 flex-col">
        <div className="flex items-center gap-3 border-b bg-white px-8 py-5">
          {st.business.logo_url && <img src={st.business.logo_url} className="h-12" alt="" />}
          <div className="text-2xl font-bold">{st.business.name}</div>
          {st.customer && <div className="ml-auto text-lg">{t('Hola', 'Hello')}, <b>{st.customer.name}</b> · {st.customer.points} {t('puntos', 'points')}</div>}
        </div>
        <div className="flex-1 overflow-y-auto px-8 py-4">
          {st.items.map((it: any, i: number) => (
            <div key={i} className="flex items-baseline justify-between border-b border-slate-200 py-3 text-xl">
              <div><span className="mr-3 font-semibold text-slate-500">{fq(it.qty)}×</span>{it.name}{it.mods?.length > 0 && <div className="ml-10 text-base text-slate-500">{it.mods.join(', ')}</div>}
                <div className="ml-10 text-sm text-slate-400">{m(it.unit)} {t('c/u', 'each')}</div></div>
              <div className="font-semibold tabular-nums">{m(it.total)}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex w-[380px] flex-col justify-between bg-white p-8 shadow-xl">
        <div className="space-y-3 text-xl">
          <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span>{m(st.totals.subtotal)}</span></div>
          {st.totals.discount > 0 && <div className="flex justify-between text-emerald-600"><span>{t('Descuento', 'Discount')}</span><span>-{m(st.totals.discount)}</span></div>}
          <div className="flex justify-between"><span className="text-slate-500">{t('IVA incluido', 'Tax')}</span><span>{m(st.totals.tax)}</span></div>
          {st.totals.service > 0 && <div className="flex justify-between"><span className="text-slate-500">{t('Servicio 10%', 'Service')}</span><span>{m(st.totals.service)}</span></div>}
          <div className="flex justify-between border-t pt-4 text-4xl font-bold"><span>Total</span><span>{m(st.totals.total)}</span></div>
        </div>
        {qr ? (
          <div className="text-center"><img src={qr} className="mx-auto rounded-lg" alt="UPI payment QR" /><div className="mt-2 text-lg">Scan to pay with any UPI app</div></div>
        ) : st.stage === 'payment' ? <div className="text-center text-2xl font-semibold text-brand-700">{t('Por favor complete el pago', 'Please complete payment')}</div> : null}
      </div>
    </div>
  );
}
