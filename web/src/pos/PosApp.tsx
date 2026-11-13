import { useCallback, useEffect, useRef, useState } from 'react';
import { applyAutoprintParam } from '../components/PrinterSetup';
import { Link } from 'react-router-dom';
import { Clock } from 'lucide-react';
import type { Socket } from 'socket.io-client';
import { ApiError, makeClient, type Client } from '../lib/api';
import { idb } from '../lib/idb';
import { setCurrency } from '../lib/format';
import { connectSocket } from '../lib/misc';
import { Field, Keypad, Spinner, useToast } from '../components/ui';
import Register from './Register';

export interface PosDevice { token: string; device: any }
export interface PosSession { token: string; user: any; business: any; store: any }
export interface QueuedSale { payload: any; token: string; local: any; error?: string; tries: number }

const DEVICE_KEY = 'its.pos.device';
const SESSION_KEY = 'its.pos.session';

applyAutoprintParam('pos'); // launcher opens /pos?autoprint=1

export default function PosApp() {
  const [device, setDevice] = useState<PosDevice | null>(() => JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null'));
  const [session, setSession] = useState<PosSession | null>(() => JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'));
  const deviceApi = makeClient(() => device?.token ?? null, () => null, () => { localStorage.removeItem(DEVICE_KEY); setDevice(null); });

  if (!device) return <DeviceSetup onDone={(d) => { localStorage.setItem(DEVICE_KEY, JSON.stringify(d)); setDevice(d); }} />;
  if (!session) return <PinScreen api={deviceApi} device={device} onSession={(s) => { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); setSession(s); }} />;
  return <PosRuntime device={device} session={session} onLock={() => { sessionStorage.removeItem(SESSION_KEY); setSession(null); }} />;
}

// ---------------------------------------------------------------- Runtime: catalog, sockets, offline queue
function PosRuntime({ device, session, onLock }: { device: PosDevice; session: PosSession; onLock: () => void }) {
  const toast = useToast();
  const [catalog, setCatalog] = useState<any>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [queue, setQueue] = useState<QueuedSale[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const syncing = useRef(false);
  const api: Client = useCallback(makeClient(() => session.token, () => null, () => { toast('Session expired — sign in again', 'err'); onLock(); }), [session.token]);
  const storeKey = `catalog:${session.store.id}`;

  const loadCatalog = useCallback(async () => {
    try {
      const c = await api('/pos/catalog');
      setCatalog(c);
      setCurrency(c.business.currency_symbol, c.business.locale);
      await idb.set(storeKey, c);
      setOnline(true);
      api('/customers').then((cs) => idb.set(`customers:${session.business.id}`, cs)).catch(() => {});
    } catch (e: any) {
      const cached = await idb.get(storeKey);
      if (cached) {
        setCatalog(cached);
        setCurrency(cached.business.currency_symbol, cached.business.locale);
        if (e instanceof ApiError && e.offline) { setOnline(false); toast('Offline — using cached catalog', 'info'); }
      } else toast(e.message, 'err');
    }
  }, [api]);

  // Offline queue: sales carry a client_uuid so retries never create duplicates on the server
  const syncNow = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      let q: QueuedSale[] = (await idb.get('queue')) || [];
      for (const item of [...q]) {
        try {
          await makeClient(() => item.token || session.token)('/sales', { body: item.payload });
          q = q.filter((x) => x.payload.client_uuid !== item.payload.client_uuid);
          setOnline(true);
        } catch (e: any) {
          if (e instanceof ApiError && e.offline) { setOnline(false); break; }
          item.error = e.message;
          item.tries++;
          if (e.status === 401) item.token = session.token; // re-sign with current employee session
        }
        await idb.set('queue', q);
      }
      setQueue(q);
      if (!q.length) loadCatalog();
    } finally {
      syncing.current = false;
    }
  }, [session.token]);

  useEffect(() => {
    loadCatalog();
    idb.get('queue').then((q) => setQueue(q || []));
    const s = connectSocket(session.token);
    s.on('connect', () => { setOnline(true); syncNow(); });
    s.on('disconnect', () => setOnline(false));
    setSocket(s);
    const onOnline = () => syncNow();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', () => setOnline(false));
    const t = setInterval(syncNow, 15000);
    return () => { s.disconnect(); clearInterval(t); window.removeEventListener('online', onOnline); };
  }, []);

  const enqueue = async (payload: any, local: any) => {
    const q: QueuedSale[] = (await idb.get('queue')) || [];
    q.push({ payload, token: session.token, local, tries: 0 });
    await idb.set('queue', q);
    setQueue(q);
    // Update the local stock cache so cashiers see approximate levels while offline
    const c = { ...catalog };
    for (const it of payload.items) for (const p of c.products) for (const v of p.variants) if (v.id === it.variant_id && v.stock != null) v.stock = Number(v.stock) - it.qty;
    setCatalog(c);
    idb.set(storeKey, c);
  };

  if (!catalog) return <div className="flex h-full items-center justify-center"><Spinner size={28} /></div>;
  return <Register api={api} device={device} session={session} catalog={catalog} reloadCatalog={loadCatalog} online={online} queue={queue} enqueue={enqueue} syncNow={syncNow} socket={socket} onLock={onLock} />;
}

// ---------------------------------------------------------------- First-run device registration
function DeviceSetup({ onDone }: { onDone: (d: PosDevice) => void }) {
  const toast = useToast();
  const [step, setStep] = useState<'login' | 'store'>('login');
  const [f, setF] = useState({ email: '', password: '', name: 'Counter 1', store_id: '' });
  const [auth, setAuth] = useState<any>(null);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await makeClient(() => null)('/auth/login', { body: { email: f.email, password: f.password } });
      setAuth(r);
      setF({ ...f, store_id: r.stores[0]?.id });
      setStep('store');
    } catch (err: any) { toast(err.message, 'err'); }
  }
  async function register() {
    try {
      const r = await makeClient(() => auth.token)('/auth/devices', { body: { store_id: f.store_id, name: f.name, kind: 'pos' } });
      onDone({ token: r.token, device: r.device });
    } catch (err: any) { toast(err.message, 'err'); }
  }
  return (
    <div className="flex min-h-full items-center justify-center bg-slate-900 p-4">
      <div className="card w-full max-w-sm space-y-4 p-6">
        <div className="flex items-center gap-2"><img src="/icon.svg" className="h-8 w-8" alt="" /><div className="font-bold">Rio Lindo POS · Set up this terminal</div></div>
        {step === 'login' ? (
          <form onSubmit={login} className="space-y-3">
            <p className="text-sm text-slate-500">An owner or manager signs in once to register this device.</p>
            <Field label="Email"><input className="input" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Password"><input className="input" type="password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
            <button className="btn-primary w-full">Continue</button>
            <p className="text-center text-xs text-slate-400">Demo: owner@demo.com / demo123</p>
          </form>
        ) : (
          <div className="space-y-3">
            <Field label="Store"><select className="input" value={f.store_id} onChange={(e) => setF({ ...f, store_id: e.target.value })}>{auth.stores.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="Terminal name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <button className="btn-primary w-full" onClick={register}>Register terminal</button>
          </div>
        )}
        <Link to="/login" className="block text-center text-sm text-brand-700">Back Office</Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- PIN lock screen (+ time clock)
function PinScreen({ api, device, onSession }: { api: Client; device: PosDevice; onSession: (s: PosSession) => void }) {
  const toast = useToast();
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'login' | 'clock'>('login');
  const [info, setInfo] = useState<any>(null);
  const [now, setNow] = useState(new Date());
  useEffect(() => { api('/auth/device').then(setInfo).catch(() => {}); const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

  async function submit(p: string) {
    try {
      const r = await api('/auth/pin', { body: { pin: p } });
      if (mode === 'clock') {
        const userApi = makeClient(() => r.token);
        const open = await userApi('/timeclock/status');
        await userApi(`/timeclock/${open ? 'out' : 'in'}`, { body: {} });
        toast(`${r.user.name} clocked ${open ? 'out' : 'in'} at ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`);
        setMode('login');
        setPin('');
        return;
      }
      if (!r.user.permissions.includes('pos.sell')) {
        setErr(r.user.permissions.includes('kitchen.view') ? 'Kitchen staff: use the Kitchen Display (/kds)' : 'You do not have POS access');
        setPin('');
        return;
      }
      onSession({ token: r.token, user: r.user, business: r.business, store: r.store });
    } catch (e: any) {
      setErr(e instanceof ApiError && e.offline ? 'Offline: PIN sign-in needs a connection. Signed-in sessions keep working offline.' : e.message);
      setPin('');
    }
  }
  const key = (k: string) => {
    setErr('');
    if (k === 'C') return setPin('');
    if (k === '⌫') return setPin(pin.slice(0, -1));
    const p = (pin + k).slice(0, 6);
    setPin(p);
    if (p.length === 4) setTimeout(() => submit(p), 60);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (/^\d$/.test(e.key)) key(e.key); if (e.key === 'Backspace') key('⌫'); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-gradient-to-br from-slate-900 to-brand-900 p-4 text-white">
      <div className="mb-6 text-center">
        <div className="text-5xl font-light tabular-nums">{now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</div>
        <div className="mt-1 text-sm text-slate-300">{info?.business?.name} · {info?.store?.name} · {device.device.name}</div>
      </div>
      <div className="w-full max-w-xs rounded-2xl bg-white p-5 text-slate-800 shadow-2xl dark:bg-slate-900 dark:text-slate-100">
        <div className="mb-1 text-center font-semibold">{mode === 'clock' ? 'Clock in / out — enter PIN' : 'Enter your PIN'}</div>
        <div className="mb-3 flex justify-center gap-3 py-2">{[0, 1, 2, 3].map((i) => <span key={i} className={`h-4 w-4 rounded-full ${pin.length > i ? 'bg-brand-600' : 'bg-slate-200 dark:bg-slate-700'}`} />)}</div>
        {err && <p className="mb-2 text-center text-sm text-rose-600">{err}</p>}
        <Keypad onKey={key} />
        <button className="btn-ghost mt-3 w-full" onClick={() => setMode(mode === 'clock' ? 'login' : 'clock')}><Clock size={16} />{mode === 'clock' ? 'Back to sign in' : 'Clock in / out'}</button>
      </div>
      <p className="mt-4 text-xs text-slate-400">Demo PINs: 1111 owner · 2222 manager · 3333 cashier</p>
    </div>
  );
}
