import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize, Undo2, Flame, Check, Settings, Volume2, Printer } from 'lucide-react';
import { makeClient } from '../lib/api';
import { connectSocket, beep } from '../lib/misc';
import { Field, Modal, useToast } from '../components/ui';
import { KitchenTicket, printNow, type KitchenTicketData } from '../components/KitchenTicket';
import { PrinterSetup, applyAutoprintParam } from '../components/PrinterSetup';

applyAutoprintParam('kds'); // launcher opens /kds?autoprint=1

// Automatic kitchen printing: each new order is printed once on this display's printer.
const PRINTED_KEY = 'its.kds.printed';
const autoPrintOn = () => localStorage.getItem('its.kds.autoprint') === '1';
const printedIds = (): string[] => JSON.parse(localStorage.getItem(PRINTED_KEY) || '[]');
const markPrinted = (id: string) => localStorage.setItem(PRINTED_KEY, JSON.stringify([...printedIds().filter((x) => x !== id), id].slice(-500)));
const ticketData = (o: any): KitchenTicketData => ({
  station: o.station, label: o.table_name && o.table_name !== o.order_label ? `${o.order_label} · ${o.table_name}` : o.order_label,
  dining: o.dining_option, time: o.created_at, priority: o.priority, items: o.items || [],
});

const KEY = 'its.kds.device';
const DELAY_MIN = 15;
const WARN_MIN = 8;

export default function Kds() {
  const [dev, setDev] = useState<any>(() => JSON.parse(localStorage.getItem(KEY) || 'null'));
  if (!dev) return <KdsSetup onDone={(d) => { localStorage.setItem(KEY, JSON.stringify(d)); setDev(d); }} />;
  return <KdsBoard dev={dev} onReset={() => { localStorage.removeItem(KEY); setDev(null); }} />;
}

function KdsBoard({ dev, onReset }: { dev: any; onReset: () => void }) {
  const toast = useToast();
  const api = useMemo(() => makeClient(() => dev.token, () => null, onReset), [dev.token]);
  const [orders, setOrders] = useState<any[]>([]);
  const [station, setStation] = useState(localStorage.getItem('its.kds.station') || '');
  const [now, setNow] = useState(Date.now());
  const [showDone, setShowDone] = useState(false);
  const [online, setOnline] = useState(true);
  const [settings, setSettings] = useState(false);
  const [printing, setPrinting] = useState<KitchenTicketData | null>(null);
  const queue = useRef<KitchenTicketData[]>([]);
  const busy = useRef(false);
  const stationRef = useRef(station);
  stationRef.current = station;

  // Print queue: one ticket at a time
  const pump = () => {
    if (busy.current || !queue.current.length) return;
    busy.current = true;
    setPrinting(queue.current.shift()!);
    setTimeout(() => {
      printNow('kitchen');
      setPrinting(null);
      setTimeout(() => { busy.current = false; pump(); }, 400);
    }, 120);
  };
  const enqueuePrint = (o: any) => {
    if (!autoPrintOn() || o.status !== 'new' || printedIds().includes(o.id)) return;
    if (stationRef.current && o.station !== stationRef.current) return;
    // Orders older than when auto-print was turned on are not printed retroactively
    const since = Number(localStorage.getItem('its.kds.autoprint_since') || 0);
    if (+new Date(o.created_at) < since) return;
    markPrinted(o.id);
    queue.current.push(ticketData(o));
    pump();
  };
  const load = () => api('/kitchen/orders').then((o: any[]) => {
    setOrders(o);
    setOnline(true);
    o.forEach(enqueuePrint); // catches orders that arrived while the connection was down
  }).catch(() => setOnline(false));

  useEffect(() => {
    load();
    const s = connectSocket(dev.token);
    s.on('connect', () => { setOnline(true); load(); });
    s.on('disconnect', () => setOnline(false));
    s.on('kitchen:new', (o) => {
      setOrders((x) => [...x.filter((y) => y.id !== o.id), o]);
      if (!station || o.station === station) { beep(880); setTimeout(() => beep(1100), 180); }
      enqueuePrint(o);
    });
    s.on('kitchen:update', (o) => setOrders((x) => x.map((y) => (y.id === o.id ? o : y))));
    s.on('kitchen:refresh', load);
    const t = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(load, 30000);
    return () => { s.disconnect(); clearInterval(t); clearInterval(poll); };
  }, [station]);

  const stations = [...new Set(orders.map((o) => o.station))];
  const shown = orders
    .filter((o) => (!station || o.station === station) && (showDone ? o.status === 'served' || o.status === 'ready' : ['new', 'preparing', 'ready'].includes(o.status)))
    .sort((a, b) => (a.priority === 'rush' ? -1 : 0) - (b.priority === 'rush' ? -1 : 0) || +new Date(a.created_at) - +new Date(b.created_at));
  const update = async (o: any, body: any) => {
    try { const r = await api(`/kitchen/orders/${o.id}`, { method: 'PUT', body }); setOrders((x) => x.map((y) => (y.id === r.id ? r : y))); } catch (e: any) { toast(e.message, 'err'); }
  };
  const delayed = shown.filter((o) => o.status !== 'ready' && (now - +new Date(o.created_at)) / 60000 > DELAY_MIN).length;

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center gap-3 border-b border-slate-800 px-4 py-2">
        <div className="text-lg font-bold">Kitchen Display</div>
        <div className="flex gap-1">
          {['', ...stations].map((s) => (
            <button key={s || 'all'} onClick={() => { setStation(s); localStorage.setItem('its.kds.station', s); }} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${station === s ? 'bg-brand-600' : 'bg-slate-800'}`}>{s || 'All stations'}</button>
          ))}
        </div>
        {delayed > 0 && <span className="animate-pulse rounded-lg bg-rose-600 px-3 py-1 text-sm font-bold">{delayed} delayed</span>}
        <div className="ml-auto flex items-center gap-2 text-sm">
          <span className={`h-2.5 w-2.5 rounded-full ${online ? 'bg-emerald-500' : 'bg-rose-500'}`} aria-label={online ? 'Online' : 'Offline'} />
          <button className={`rounded-lg px-3 py-1.5 ${showDone ? 'bg-slate-600' : 'bg-slate-800'}`} onClick={() => setShowDone(!showDone)}><Undo2 size={16} className="mr-1 inline" />Recall</button>
          <button className="rounded-lg bg-slate-800 p-2" onClick={() => beep()} aria-label="Test sound"><Volume2 size={16} /></button>
          <button className="rounded-lg bg-slate-800 p-2" onClick={() => document.documentElement.requestFullscreen?.()} aria-label="Full screen"><Maximize size={16} /></button>
          <button className={`rounded-lg p-2 ${autoPrintOn() ? 'bg-emerald-700' : 'bg-slate-800'}`} onClick={() => setSettings(true)} aria-label="Printer"><Printer size={16} /></button>
          <button className="rounded-lg bg-slate-800 p-2" onClick={() => setSettings(true)} aria-label="Settings"><Settings size={16} /></button>
        </div>
      </header>
      <div className="flex-1 overflow-x-auto p-3">
        {!shown.length ? <div className="flex h-full items-center justify-center text-2xl text-slate-600">{showDone ? 'No recently completed orders' : 'No open orders'}</div> : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {shown.map((o) => {
              const mins = Math.floor((now - +new Date(o.created_at)) / 60000);
              const secs = Math.floor(((now - +new Date(o.created_at)) / 1000) % 60);
              const tone = o.status === 'ready' ? 'border-emerald-500 bg-emerald-950' : mins >= DELAY_MIN ? 'border-rose-500 bg-rose-950' : mins >= WARN_MIN ? 'border-amber-500 bg-amber-950' : 'border-slate-700 bg-slate-900';
              return (
                <div key={o.id} className={`flex flex-col rounded-xl border-2 ${tone}`}>
                  <div className="flex items-start justify-between border-b border-white/10 p-3">
                    <div>
                      <div className="text-xl font-bold">{o.order_label}</div>
                      <div className="text-xs text-slate-400 uppercase">{[o.station, o.dining_option?.replace('_', ' ')].filter(Boolean).join(' · ')}</div>
                    </div>
                    <div className="text-right">
                      <div className={`font-mono text-xl font-bold tabular-nums ${mins >= DELAY_MIN ? 'text-rose-400' : mins >= WARN_MIN ? 'text-amber-400' : ''}`}>{mins}:{String(secs).padStart(2, '0')}</div>
                      {o.priority === 'rush' && <span className="inline-flex items-center gap-1 rounded bg-rose-600 px-1.5 text-xs font-bold"><Flame size={12} />RUSH</span>}
                    </div>
                  </div>
                  <ul className="flex-1 space-y-1 p-3">
                    {o.items.map((it: any, i: number) => (
                      <li key={i}>
                        <button className={`w-full text-left text-lg ${it.done ? 'text-slate-500 line-through' : ''}`} onClick={() => update(o, { items: o.items.map((x: any, j: number) => (i === j ? { ...x, done: !x.done } : x)) })}>
                          <b>{it.qty}×</b> {it.name}
                        </button>
                        {it.modifiers?.length > 0 && <div className="pl-6 text-sm text-slate-300">{it.modifiers.join(', ')}</div>}
                        {it.note && <div className="pl-6 text-sm font-semibold text-amber-300">⚠ {it.note}</div>}
                      </li>
                    ))}
                  </ul>
                  <div className="grid grid-cols-[auto_1fr] gap-2 p-3 pt-0">
                    <button className="rounded-lg bg-white/10 px-3 py-3" onClick={() => update(o, { priority: o.priority === 'rush' ? 'normal' : 'rush' })} aria-label="Toggle rush"><Flame size={18} /></button>
                    {o.status === 'new' && <button className="rounded-lg bg-sky-600 py-3 text-lg font-bold" onClick={() => update(o, { status: 'preparing' })}>Start</button>}
                    {o.status === 'preparing' && <button className="rounded-lg bg-emerald-600 py-3 text-lg font-bold" onClick={() => update(o, { status: 'ready' })}><Check className="mr-1 inline" />Ready</button>}
                    {o.status === 'ready' && <button className="rounded-lg bg-slate-600 py-3 text-lg font-bold" onClick={() => update(o, { status: 'served' })}>Served</button>}
                    {o.status === 'served' && <button className="rounded-lg bg-slate-700 py-3 text-lg font-bold" onClick={() => update(o, { status: 'ready' })}>Recall</button>}
                  </div>
                  <button className="mx-3 mb-2 flex items-center justify-center gap-1 rounded-lg py-1 text-xs text-slate-400 hover:bg-white/5" onClick={() => { queue.current.push(ticketData(o)); pump(); }}><Printer size={12} />Reimprimir</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {printing && <div className="hidden print:block"><KitchenTicket data={printing} /></div>}
      {settings && (
        <Modal open onClose={() => setSettings(false)} title="Impresora de cocina" size="lg">
          <div className="text-slate-900 dark:text-slate-100">
            <PrinterSetup kind="kds" onTestPrint={() => { queue.current.push({ station: station || 'Cocina', label: 'PRUEBA DE IMPRESIÓN', items: [{ qty: 1, name: 'Impresora conectada correctamente' }] }); pump(); }} />
            <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-700">
              <button className="btn-danger" onClick={() => confirm('¿Desvincular esta pantalla de cocina?') && onReset()}>Desvincular pantalla</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function KdsSetup({ onDone }: { onDone: (d: any) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ email: '', password: '', store_id: '', name: 'Kitchen Display' });
  const [auth, setAuth] = useState<any>(null);
  async function next(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (!auth) {
        const r = await makeClient(() => null)('/auth/login', { body: { email: f.email, password: f.password } });
        setAuth(r);
        setF({ ...f, store_id: r.stores[0]?.id });
        return;
      }
      const r = await makeClient(() => auth.token)('/auth/devices', { body: { store_id: f.store_id, name: f.name, kind: 'kds' } });
      onDone({ token: r.token, device: r.device });
    } catch (err: any) { toast(err.message, 'err'); }
  }
  return (
    <div className="flex h-full items-center justify-center bg-slate-950 p-4">
      <form onSubmit={next} className="card w-full max-w-sm space-y-3 p-6">
        <div className="font-bold">Set up Kitchen Display</div>
        {!auth ? (
          <>
            <Field label="Owner / manager email"><input className="input" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Password"><input className="input" type="password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          </>
        ) : (
          <>
            <Field label="Store"><select className="input" value={f.store_id} onChange={(e) => setF({ ...f, store_id: e.target.value })}>{auth.stores.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="Display name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          </>
        )}
        <button className="btn-primary w-full">{auth ? 'Register display' : 'Continue'}</button>
      </form>
    </div>
  );
}
