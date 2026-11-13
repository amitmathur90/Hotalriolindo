import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Menu, Search, ScanLine, Star, User, Percent, Trash2, Save, ChefHat, CreditCard, Receipt as ReceiptIcon, LayoutGrid, Wallet,
  Monitor, Moon, Lock, Wifi, WifiOff, RefreshCw, Printer, Share2, Mail, Plus, Ticket, Scissors, X, Building2,
} from 'lucide-react';
import type { Socket } from 'socket.io-client';
import { ApiError, type Client } from '../lib/api';
import { idb } from '../lib/idb';
import { dt, money, qty as fq, uuid } from '../lib/format';
import { beep, toggleTheme } from '../lib/misc';
import { Badge, Empty, Modal, SearchInput, Spinner, useToast } from '../components/ui';
import { Receipt } from '../components/Receipt';
import { ReceiptShare } from '../components/ReceiptShare';
import { SaleDetail } from '../components/SaleDetail';
import { gstSplit } from '../../../shared/pricing';
import { DINING, cartFromTicket, emptyCart, makeLine, priceCart, toPayload, type Cart, type CartLine } from './cart';
import { ApprovalModal, CustomerPicker, DiscountPicker, ItemOptions, KitchenTicket, LineEditor, PaymentModal, ShiftPanel, TablesPanel, TicketsPanel } from './dialogs';
import { PrinterSetup, hwSettings } from '../components/PrinterSetup';
import { printNow } from '../components/KitchenTicket';
import type { PosDevice, PosSession, QueuedSale } from './PosApp';

const PERM_LABEL: Record<string, string> = { 'pos.discount': 'Apply a discount', 'pos.custom_price': 'Change an item price', 'pos.void': 'Remove items already sent to the kitchen', 'pos.refund': 'Refund a sale' };
const APPROVAL_KEY: Record<string, string> = { 'pos.discount': 'discount', 'pos.custom_price': 'price', 'pos.void': 'void' };
const hw = hwSettings;

export default function Register({ api, device, session, catalog, reloadCatalog, online, queue, enqueue, syncNow, socket, onLock }: {
  api: Client; device: PosDevice; session: PosSession; catalog: any; reloadCatalog: () => void; online: boolean; queue: QueuedSale[];
  enqueue: (payload: any, local: any) => Promise<void>; syncNow: () => void; socket: Socket | null; onLock: () => void;
}) {
  const toast = useToast();
  const perms = useMemo(() => new Set<string>(session.user.permissions), [session.user]);
  const can = (p: string) => perms.has(p);
  const biz = catalog.business;
  const [cart, setCart] = useState<Cart>(() => JSON.parse(localStorage.getItem('its.pos.cart') || 'null') || emptyCart(catalog.tables.length ? 'dine_in' : 'takeaway'));
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');
  const [dlg, setDlg] = useState<string | null>(null);
  const [picking, setPicking] = useState<any>(null);
  const [editLine, setEditLine] = useState<CartLine | null>(null);
  const [done, setDone] = useState<any>(null);
  const [approval, setApproval] = useState<{ perm: string; resolve: (t: string | null) => void } | null>(null);
  const [tickets, setTickets] = useState<any[]>([]);
  const [kitchenPrint, setKitchenPrint] = useState<any>(null);
  const [menu, setMenu] = useState(false);
  const [mobileCart, setMobileCart] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const priced = useMemo(() => priceCart(cart, catalog.taxes, Number(biz.service_charge_pct)), [cart, catalog]);

  useEffect(() => localStorage.setItem('its.pos.cart', JSON.stringify(cart)), [cart]);
  const loadTickets = () => api('/tickets').then(setTickets).catch(() => {});
  useEffect(() => {
    loadTickets();
    if (!socket) return;
    const onTables = () => { reloadCatalog(); loadTickets(); };
    const onReady = (k: any) => { if (k.status === 'ready') { toast(`${k.order_label}: ${k.station} order ready`, 'info'); beep(1200); } };
    socket.on('tables:changed', onTables);
    socket.on('kitchen:update', onReady);
    return () => { socket.off('tables:changed', onTables); socket.off('kitchen:update', onReady); };
  }, [socket]);

  // ---- customer display relay
  useEffect(() => {
    socket?.emit('display:update', {
      deviceId: device.device.id,
      state: {
        stage: done ? 'thanks' : dlg === 'pay' ? 'payment' : cart.items.length ? 'cart' : 'idle',
        business: { name: biz.name, logo_url: biz.logo_url, upi_id: biz.upi_id, currency_symbol: biz.currency_symbol, locale: biz.locale },
        items: cart.items.map((l, i) => ({ name: l.name + (l.variant_name ? ` (${l.variant_name})` : ''), qty: l.qty, unit: priced.unit_prices[i], total: priced.lines[i]?.gross, mods: l.modifiers.map((m) => m.name) })),
        totals: { subtotal: priced.subtotal, discount: priced.discount_total, tax: priced.tax_total, service: priced.service_charge, total: priced.total },
        customer: cart.customer ? { name: cart.customer.name, points: cart.customer.points } : null,
        done: done ? { total: done.total, paid: done.paid, change: done.change, points: done.points_earned } : null,
      },
    });
  }, [cart, priced, dlg, done, socket]);

  // ---- approvals: ask a manager's PIN when the server says a permission is missing
  const requestApproval = (perm: string) => new Promise<string | null>((resolve) => setApproval({ perm, resolve }));
  async function withApproval<T>(fn: (approvals: any) => Promise<T>, approvals: any = {}): Promise<T> {
    try {
      return await fn(approvals);
    } catch (e: any) {
      if (e.status !== 403) throw e;
      const perm = /discount/i.test(e.message) ? 'pos.discount' : /price/i.test(e.message) ? 'pos.custom_price' : /kitchen|void/i.test(e.message) ? 'pos.void' : null;
      if (!perm || approvals[APPROVAL_KEY[perm]]) throw e;
      const tok = await requestApproval(perm);
      if (!tok) throw new Error('Approval cancelled');
      return withApproval(fn, { ...approvals, [APPROVAL_KEY[perm]]: tok });
    }
  }

  // ---- adding items
  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return catalog.products.filter((p: any) =>
      (cat === 'all' || (cat === 'fav' ? p.is_favorite : p.category_id === cat)) &&
      (!s || p.name.toLowerCase().includes(s) || p.variants.some((v: any) => v.sku?.toLowerCase().includes(s) || v.barcode === s)));
  }, [catalog, cat, q]);

  function addLine(p: any, v: any, mods: any[] = [], qty = 1) {
    setCart((c) => {
      const same = c.items.find((l) => l.variant_id === v.id && !l.sent && !l.note && !l.discount && l.custom_price == null && l.modifier_ids.join() === mods.map((m) => m.id).join());
      if (same && p.unit !== 'kg') return { ...c, items: c.items.map((l) => (l === same ? { ...l, qty: +(l.qty + qty).toFixed(3) } : l)) };
      return { ...c, items: [...c.items, makeLine(p, v, mods, qty, catalog.categories)] };
    });
  }
  function tap(p: any) {
    const needsOptions = p.variants.length > 1 || p.modifier_group_ids.length > 0 || p.unit === 'kg';
    if (needsOptions) setPicking(p);
    else addLine(p, p.variants[0]);
  }
  function scan(code: string) {
    code = code.trim();
    if (!code) return false;
    for (const p of catalog.products) for (const v of p.variants) if (v.barcode === code || v.sku === code) {
      if (p.modifier_group_ids.length) setPicking(p); else addLine(p, v);
      if (hw().beep ?? true) beep();
      return true;
    }
    // Weighted EAN-13 from scales: PP IIIII WWWWW C  (weight in grams)
    const prefix = hw().scalePrefix || '21';
    if (/^\d{13}$/.test(code) && code.startsWith(prefix)) {
      const item = code.slice(2, 7), grams = Number(code.slice(7, 12));
      for (const p of catalog.products) for (const v of p.variants) if (v.sku === item || v.barcode?.slice(2, 7) === item) { addLine(p, v, [], grams / 1000); beep(); return true; }
    }
    // Loyalty card scan -> attach customer
    idb.get(`customers:${session.business.id}`).then((cs: any[] = []) => {
      const c = cs?.find((x) => x.code === code || x.phone === code);
      if (c) { setCart((x) => ({ ...x, customer: c })); toast(`Customer: ${c.name}`); }
      else toast(`No item for barcode ${code}`, 'err');
    });
    return false;
  }
  // Hardware scanners type fast and end with Enter — capture when no input is focused
  useEffect(() => {
    let buf = '', last = 0;
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key === 'F4' && cart.items.length) { e.preventDefault(); charge(); return; }
      if (e.key === 'F8' && cart.items.length) { e.preventDefault(); saveTicket(false); return; }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || dlg || picking) return;
      const now = Date.now();
      if (now - last > 80) buf = '';
      last = now;
      if (e.key === 'Enter') { if (buf.length >= 4) scan(buf); buf = ''; }
      else if (e.key.length === 1) buf += e.key;
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  async function cameraScan() {
    const BD = (window as any).BarcodeDetector;
    if (!BD) return toast('Camera scanning is not supported in this browser — use a USB/Bluetooth scanner', 'err');
    setDlg('camera');
  }

  // ---- tickets
  async function saveTicket(send: boolean) {
    if (!cart.items.length) return;
    try {
      const unsent = cart.items.filter((l) => !l.sent && l.kitchen_station);
      const body = (approvals: any) => ({
        id: cart.ticket_id, name: cart.ticket_name, table_id: cart.table_id, customer_id: cart.customer?.id, dining_option: cart.dining_option, send_to_kitchen: send,
        cart: { items: cart.items.map((l, i) => ({ ...l, preview_total: priced.lines[i]?.total })), order_discount: cart.order_discount, customer: cart.customer, approvals },
      });
      const t = await withApproval((a) => api('/tickets', { body: body(a) }));
      toast(send ? `Sent to kitchen · ${t.name}` : `Saved · ${t.name}`);
      if (send && unsent.length && hw().kitchenPrint) printKitchen(t.name, unsent);
      setCart(emptyCart(cart.dining_option));
      loadTickets();
    } catch (e: any) {
      toast(e instanceof ApiError && e.offline ? 'Open tickets need a connection' : e.message, 'err');
    }
  }
  function printKitchen(label: string, lines: CartLine[], dining = cart.dining_option, delay = 0) {
    const stations = [...new Set(lines.map((l) => l.kitchen_station))];
    stations.forEach((st, i) => setTimeout(() => {
      setKitchenPrint({ station: st, label, dining, items: lines.filter((l) => l.kitchen_station === st).map((l) => ({ qty: l.qty, name: l.name + (l.variant_name ? ` (${l.variant_name})` : ''), modifiers: l.modifiers.map((m) => m.name), note: l.note })) });
      setTimeout(() => { printNow('kitchen'); setKitchenPrint(null); }, 80);
    }, delay + i * 700));
  }
  function openTicket(t: any) {
    setCart(cartFromTicket(t, catalog));
    setDlg(null);
  }
  async function voidTicket() {
    if (!cart.ticket_id || !confirm('Void this open ticket?')) return;
    try {
      await withApproval(async (a) => api(`/tickets/${cart.ticket_id}`, { method: 'DELETE', body: { approval_token: a.void } }));
      setCart(emptyCart(cart.dining_option));
      loadTickets();
      toast('Ticket voided');
    } catch (e: any) { toast(e.message, 'err'); }
  }

  // ---- checkout
  function charge() {
    if (!cart.items.length) return;
    setDlg('pay');
  }
  async function pay(payments: any[], _tip = 0, einvoice: any = null) {
    const client_uuid = uuid();
    const base = {
      client_uuid, items: toPayload(cart), order_discount: cart.order_discount ? { type: cart.order_discount.type, value: cart.order_discount.value, discount_id: cart.order_discount.discount_id } : null,
      customer_id: cart.customer?.id ?? null, payments: payments.map((p) => ({ method_id: p.method_id, method_type: p.method_type, amount: p.amount, reference: p.reference })),
      dining_option: cart.dining_option, table_id: cart.table_id, ticket_id: cart.ticket_id, tip: cart.tip, note: cart.note,
      ...(einvoice ? { einvoice } : {}),
    };
    const unsentKitchen = cart.items.filter((l) => !l.sent && l.kitchen_station);
    const dining = cart.dining_option;
    try {
      const sale = await withApproval((approvals) => api('/sales', { body: { ...base, approvals } }));
      finishSale(sale);
      if (hw().kitchenPrint && unsentKitchen.length) printKitchen(sale.table_name || sale.ticket_name || `#${sale.receipt_no}`, unsentKitchen, dining, 900);
    } catch (e: any) {
      if (!(e instanceof ApiError && e.offline)) { toast(e.message, 'err'); return; }
      // Offline: queue for sync and print a provisional receipt
      if (cart.ticket_id) { toast('Paying open tickets needs a connection', 'err'); return; }
      const n = Number(localStorage.getItem('its.pos.offseq') || 0) + 1;
      localStorage.setItem('its.pos.offseq', String(n));
      const created_at = new Date().toISOString();
      const paid = payments.reduce((s, p) => s + p.amount, 0);
      const local = {
        receipt_no: `OFF-${device.device.id.slice(0, 4).toUpperCase()}-${n}`, type: 'sale', offline: true, created_at, store_name: catalog.store.name, store_address: catalog.store.address,
        store_gstin: catalog.store.gstin, gst_mode: catalog.store.gst_mode, employee_name: session.user.name, customer_name: cart.customer?.name, dining_option: cart.dining_option,
        items: cart.items.map((l, i) => ({ line_id: l.line_id, product_name: l.name, variant_name: l.variant_name, qty: l.qty, unit_price: priced.unit_prices[i], gross: priced.lines[i].gross, discount: priced.lines[i].line_discount + priced.lines[i].order_discount, modifiers: l.modifiers, note: l.note })),
        subtotal: priced.subtotal, discount_total: priced.discount_total, tax_total: priced.tax_total, tax_summary: priced.tax_summary, service_charge: priced.service_charge, tip: priced.tip,
        total: priced.total, paid, change: +(paid - priced.total).toFixed(2), payments: payments.map((p) => ({ ...p, amount: p.method_type === 'cash' ? p.amount - Math.max(0, paid - priced.total) : p.amount })),
      };
      await enqueue({ ...base, offline: true, created_at }, local);
      finishSale(local);
      if (hw().kitchenPrint && unsentKitchen.length) printKitchen(local.receipt_no, unsentKitchen, dining, 900);
      toast('Offline — sale saved and will sync automatically', 'info');
    }
  }
  function finishSale(sale: any) {
    setDlg(null);
    setDone(sale);
    setCart(emptyCart(cart.dining_option));
    setMobileCart(false);
    loadTickets();
    if (hw().autoPrint ?? true) setTimeout(() => printNow('receipt'), 150);
    if (sale.id) reloadCatalog();
  }

  const lineCount = cart.items.reduce((s, l) => s + l.qty, 0);
  const table = catalog.tables.find((t: any) => t.id === cart.table_id);

  // ================================================================ render
  const cartPanel = (
    <div className="flex h-full flex-col bg-white dark:bg-slate-900">
      <div className="space-y-2 border-b border-slate-200 p-3 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <select className="input py-1.5" value={cart.dining_option} onChange={(e) => setCart({ ...cart, dining_option: e.target.value })} aria-label="Dining option">
            {DINING.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          {catalog.tables.length > 0 && <button className="btn-secondary shrink-0 py-1.5" onClick={() => setDlg('tables')}><LayoutGrid size={16} />{table?.name || 'Table'}</button>}
          <button className="btn-secondary shrink-0 py-1.5 lg:hidden" onClick={() => setMobileCart(false)} aria-label="Close cart"><X size={16} /></button>
        </div>
        <div className="flex items-center gap-2">
          <button className={`btn flex-1 justify-start border py-1.5 ${cart.customer ? 'border-brand-300 bg-brand-50 text-brand-800 dark:border-brand-700 dark:bg-brand-900/30 dark:text-brand-200' : 'border-dashed border-slate-300 text-slate-500 dark:border-slate-700'}`} onClick={() => setDlg('customer')}>
            <User size={16} />{cart.customer ? <span className="truncate">{cart.customer.name} · {cart.customer.points} pts</span> : 'Add customer'}
          </button>
          {cart.customer && <button className="btn-ghost p-1.5" onClick={() => setCart({ ...cart, customer: null })} aria-label="Remove customer"><X size={16} /></button>}
        </div>
        {cart.ticket_id && <div className="flex items-center justify-between text-sm"><Badge color="blue"><Ticket size={12} className="mr-1" />{cart.ticket_name}</Badge>
          <span className="flex gap-1"><button className="btn-ghost px-2 py-1 text-xs" onClick={() => setDlg('split')}><Scissors size={13} />Split</button><button className="btn-ghost px-2 py-1 text-xs text-rose-600" onClick={voidTicket}>Void</button></span></div>}
      </div>
      <div className="flex-1 overflow-y-auto">
        {!cart.items.length ? <Empty>Tap items or scan a barcode</Empty> : cart.items.map((l, i) => (
          <button key={l.line_id} onClick={() => setEditLine(l)} className="flex w-full items-start gap-2 border-b border-slate-100 px-3 py-2 text-left hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50">
            <span className="mt-0.5 min-w-8 rounded bg-slate-100 px-1.5 text-center text-sm font-semibold tabular-nums dark:bg-slate-800">{fq(l.qty)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{l.name}{l.variant_name ? ` (${l.variant_name})` : ''}</span>
              {l.modifiers.length > 0 && <span className="block truncate text-xs text-slate-500">{l.modifiers.map((m) => m.name).join(', ')}</span>}
              {l.note && <span className="block truncate text-xs text-amber-600 italic">“{l.note}”</span>}
              {l.discount && <span className="block text-xs text-emerald-600">{l.discount.name || 'Discount'} {l.discount.type === 'percent' ? `${l.discount.value}%` : money(l.discount.value)}</span>}
              {l.sent && <span className="text-xs text-sky-600">✓ sent to kitchen</span>}
            </span>
            <span className="text-right text-sm font-medium tabular-nums">{money(priced.lines[i]?.gross)}{l.custom_price != null && <span className="block text-xs text-amber-600">price changed</span>}</span>
          </button>
        ))}
      </div>
      <div className="space-y-1 border-t border-slate-200 p-3 text-sm dark:border-slate-800">
        <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="tabular-nums">{money(priced.subtotal)}</span></div>
        <button className="flex w-full justify-between text-left" onClick={() => setDlg('discount')}>
          <span className="flex items-center gap-1 text-brand-700 dark:text-brand-400"><Percent size={14} />{cart.order_discount ? cart.order_discount.name || 'Discount' : 'Add discount'}</span>
          <span className="tabular-nums">{priced.discount_total ? `-${money(priced.discount_total)}` : ''}</span>
        </button>
        {priced.tax_summary.flatMap((t) => gstSplit(t, catalog.store.gst_mode)).map((t, i) => <div key={i} className="flex justify-between text-slate-500"><span>{/%/.test(t.name) ? t.name : `${t.name} ${t.rate}%`}</span><span className="tabular-nums">{money(t.amount)}</span></div>)}
        {priced.service_charge > 0 && <div className="flex justify-between text-slate-500"><span>Service charge</span><span>{money(priced.service_charge)}</span></div>}
        <div className="flex justify-between pt-1 text-lg font-bold"><span>Total</span><span className="tabular-nums">{money(priced.total)}</span></div>
      </div>
      <div className="grid grid-cols-[auto_auto_1fr] gap-2 p-3 pt-0">
        <button className="btn-secondary h-14" disabled={!cart.items.length} onClick={() => { if (confirm('Clear the current order?')) setCart(emptyCart(cart.dining_option)); }} aria-label="Clear order"><Trash2 size={18} /></button>
        <button className="btn-secondary h-14 px-3" disabled={!cart.items.length} onClick={() => saveTicket(cart.items.some((l) => !l.sent && l.kitchen_station))} title="Save ticket (F8) — sends new items to kitchen">
          {cart.items.some((l) => !l.sent && l.kitchen_station) ? <><ChefHat size={18} />Send</> : <><Save size={18} />Save</>}
        </button>
        <button className="btn-primary h-14 text-lg" disabled={!cart.items.length} onClick={charge}><CreditCard size={20} />Charge {money(priced.total)}</button>
      </div>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-2 dark:border-slate-800 dark:bg-slate-900">
        <button className="btn-ghost p-2" onClick={() => setMenu(true)} aria-label="Menu"><Menu size={20} /></button>
        <div className="hidden min-w-0 sm:block"><div className="truncate text-sm font-semibold">{catalog.store.name}</div><div className="truncate text-xs text-slate-500">{session.user.name} · {device.device.name}</div></div>
        <div className="relative mx-2 flex-1">
          <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
          <input ref={searchRef} className="input pl-9" placeholder="Search or scan (F2)" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && q && scan(q)) setQ(''); }} />
        </div>
        <button className="btn-ghost p-2" onClick={cameraScan} aria-label="Scan with camera"><ScanLine size={20} /></button>
        <button className="btn-ghost relative p-2" onClick={() => setDlg('tickets')} aria-label="Open tickets"><Ticket size={20} />{tickets.length > 0 && <span className="absolute top-0.5 right-0.5 rounded-full bg-sky-600 px-1 text-[10px] font-bold text-white">{tickets.length}</span>}</button>
        <button className={`btn-ghost gap-1 p-2 ${online ? 'text-emerald-600' : 'text-rose-600'}`} onClick={() => setDlg('sync')} aria-label="Sync status">
          {online ? <Wifi size={20} /> : <WifiOff size={20} />}{queue.length > 0 && <span className="text-xs font-bold">{queue.length}</span>}
        </button>
      </header>
      {!online && <div className="bg-amber-500 px-3 py-1 text-center text-xs font-medium text-white">Offline mode — sales are stored on this device and sync automatically. Stock levels may be stale.</div>}

      <div className="flex min-h-0 flex-1">
        {/* Catalog */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-slate-200 bg-white px-2 py-2 dark:border-slate-800 dark:bg-slate-900">
            {[{ id: 'all', name: 'All items', color: '#64748b' }, { id: 'fav', name: '★ Favorites', color: '#d97706' }, ...catalog.categories].map((c: any) => (
              <button key={c.id} onClick={() => setCat(c.id)} className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium whitespace-nowrap transition ${cat === c.id ? 'text-white shadow' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}
                style={cat === c.id ? { background: c.color || '#0d9488' } : undefined}>{c.name}</button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-2 sm:p-3">
            {!visible.length ? <Empty>No items found</Empty> : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2 sm:gap-3">
                {visible.map((p: any) => {
                  const stock = p.track_stock ? p.variants.reduce((s: number, v: any) => s + Number(v.stock ?? 0), 0) : null;
                  const color = p.color || catalog.categories.find((c: any) => c.id === p.category_id)?.color || '#0d9488';
                  return (
                    <button key={p.id} onClick={() => tap(p)} className="group relative flex h-32 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-left shadow-sm transition active:scale-[0.97] dark:border-slate-800 dark:bg-slate-900">
                      {p.image_url ? <img src={p.image_url} alt="" className="h-16 w-full object-cover" /> : <div className="flex h-16 w-full items-center justify-center text-2xl font-bold text-white/90" style={{ background: color }}>{p.name.slice(0, 2).toUpperCase()}</div>}
                      <div className="flex flex-1 flex-col justify-between p-2">
                        <div className="line-clamp-2 text-sm leading-tight font-medium">{p.name}</div>
                        <div className="flex items-center justify-between text-xs"><span className="font-semibold text-slate-600 dark:text-slate-300">{money(p.variants[0].price)}{p.variants.length > 1 ? '+' : ''}{p.unit === 'kg' ? '/kg' : ''}</span>
                          {stock !== null && stock <= 5 && <span className={`rounded px-1 font-medium ${stock <= 0 ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}>{stock <= 0 ? 'Out' : stock}</span>}</div>
                      </div>
                      {p.is_favorite && <Star size={14} className="absolute top-1.5 right-1.5 fill-amber-400 text-amber-400" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {/* Cart: side panel on large screens, sheet on phones */}
        <aside className="hidden w-[380px] shrink-0 border-l border-slate-200 lg:block dark:border-slate-800">{cartPanel}</aside>
        {mobileCart && <div className="fixed inset-0 z-40 lg:hidden">{cartPanel}</div>}
      </div>
      {!mobileCart && cart.items.length > 0 && (
        <button className="btn-primary m-2 h-14 text-base lg:hidden" onClick={() => setMobileCart(true)}>View order · {fq(lineCount)} items · {money(priced.total)}</button>
      )}

      {/* Side menu */}
      {menu && (
        <div className="fixed inset-0 z-40 bg-slate-900/40" onClick={() => setMenu(false)}>
          <nav className="h-full w-72 space-y-1 bg-white p-3 dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 px-2"><div className="font-bold">{biz.name}</div><div className="text-xs text-slate-500">{catalog.store.name} · {session.user.name}</div></div>
            {[
              { icon: ReceiptIcon, label: 'Receipts & refunds', act: () => setDlg('receipts') },
              { icon: Ticket, label: 'Open tickets', act: () => setDlg('tickets') },
              ...(catalog.tables.length ? [{ icon: LayoutGrid, label: 'Tables', act: () => setDlg('tables') }] : []),
              { icon: Wallet, label: 'Shift & cash drawer', act: () => setDlg('shift') },
              { icon: Monitor, label: 'Customer display', act: () => setDlg('display') },
              { icon: Printer, label: 'Printer setup', act: () => setDlg('printer') },
              { icon: RefreshCw, label: `Sync (${queue.length} pending)`, act: () => setDlg('sync') },
              { icon: Moon, label: 'Dark / light mode', act: () => toggleTheme() },
              ...(can('backoffice.access') ? [{ icon: Building2, label: 'Back Office', act: () => window.open('/backoffice', '_blank') }] : []),
              { icon: Lock, label: 'Lock / switch employee', act: () => onLock() },
            ].map((m) => (
              <button key={m.label} onClick={() => { setMenu(false); m.act(); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-800"><m.icon size={18} />{m.label}</button>
            ))}
            <p className="px-3 pt-4 text-xs text-slate-400">Shortcuts: F2 search · F4 charge · F8 save ticket</p>
          </nav>
        </div>
      )}

      {/* Dialogs */}
      {picking && <ItemOptions product={picking} catalog={catalog} onClose={() => setPicking(null)} onAdd={(v, mods, qty) => { addLine(picking, v, mods, qty); setPicking(null); }} />}
      {editLine && (
        <LineEditor line={editLine} discounts={catalog.discounts} onClose={() => setEditLine(null)}
          onRemove={() => { setCart({ ...cart, items: cart.items.filter((l) => l.line_id !== editLine.line_id) }); setEditLine(null); }}
          onSave={(nl) => { setCart({ ...cart, items: cart.items.map((l) => (l.line_id === nl.line_id ? nl : l)) }); setEditLine(null); }} />
      )}
      {dlg === 'customer' && <CustomerPickerWrap api={api} bid={session.business.id} onPick={(c) => { setCart({ ...cart, customer: c }); setDlg(null); }} onClose={() => setDlg(null)} />}
      {dlg === 'discount' && <DiscountPicker discounts={catalog.discounts} current={cart.order_discount} onClose={() => setDlg(null)} onPick={(d) => { setCart({ ...cart, order_discount: d }); setDlg(null); }} />}
      {dlg === 'pay' && <PaymentModal total={priced.total} methods={catalog.paymentMethods} customer={cart.customer} business={biz} offline={!online} einvoice={catalog.einvoice} onPay={pay} onClose={() => setDlg(null)} onStage={() => {}} />}
      {dlg === 'shift' && <ShiftPanel api={api} can={can} onClose={() => setDlg(null)} />}
      {dlg === 'tickets' && <TicketsPanel api={api} canMerge={can('pos.sell')} onOpen={openTicket} onClose={() => setDlg(null)} />}
      {dlg === 'tables' && (
        <TablesPanel tables={catalog.tables} tickets={tickets} api={api} onChanged={reloadCatalog} onClose={() => setDlg(null)}
          onPick={(t, tk) => { if (tk) openTicket(tk); else { setCart({ ...cart, table_id: t.id, dining_option: 'dine_in', ticket_name: cart.ticket_name || t.name }); setDlg(null); } }} />
      )}
      {dlg === 'receipts' && <ReceiptsPanel api={api} business={biz} canRefund={can('pos.refund')} requestApproval={requestApproval} onClose={() => setDlg(null)} />}
      {dlg === 'sync' && <SyncPanel queue={queue} online={online} syncNow={syncNow} onClose={() => setDlg(null)} />}
      {dlg === 'display' && <DisplayPair api={api} onClose={() => setDlg(null)} />}
      {dlg === 'camera' && <CameraScanner onCode={(c) => { setDlg(null); scan(c); }} onClose={() => setDlg(null)} />}
      {dlg === 'split' && cart.ticket_id && <SplitDialog api={api} cart={cart} priced={priced} onClose={() => setDlg(null)} onDone={(t) => { loadTickets(); setDlg(null); openTicket(t); }} />}
      {approval && <ApprovalModal perm={approval.perm} label={PERM_LABEL[approval.perm] || approval.perm} api={api} onDone={(t) => { approval.resolve(t); setApproval(null); }} />}
      {done && <DoneModal sale={done} business={biz} onClose={() => setDone(null)} />}
      {kitchenPrint && <div className="hidden print:block"><KitchenTicket data={kitchenPrint} /></div>}
      {dlg === 'printer' && (
        <Modal open onClose={() => setDlg(null)} title="Impresora de recepción" size="lg">
          <PrinterSetup kind="pos" onTestPrint={() => printKitchen('PRUEBA DE IMPRESIÓN', [{ line_id: 't', name: 'Impresora conectada correctamente', qty: 1, modifiers: [], kitchen_station: 'Recepción' } as any])} />
        </Modal>
      )}
    </div>
  );
}

function CustomerPickerWrap({ api, bid, onPick, onClose }: { api: Client; bid: string; onPick: (c: any) => void; onClose: () => void }) {
  const [cached, setCached] = useState<any[]>([]);
  useEffect(() => { idb.get(`customers:${bid}`).then((c) => setCached(c || [])); }, []);
  return <CustomerPicker api={api} offlineCustomers={cached} onPick={onPick} onClose={onClose} />;
}

function DoneModal({ sale, business, onClose }: { sale: any; business: any; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <Modal open onClose={onClose} size="lg">
      <div className="flex flex-col gap-5 md:flex-row">
        <div ref={ref} className="max-h-[70vh] overflow-y-auto rounded-lg border border-slate-200 bg-white md:w-[340px]"><Receipt sale={sale} business={business} /></div>
        <div className="flex flex-1 flex-col justify-center gap-3 text-center">
          <div className="text-sm text-slate-500">{sale.offline && !sale.id ? 'Saved offline' : 'Sale complete'}</div>
          {Number(sale.change) > 0 ? <><div className="text-sm text-slate-500">Change due</div><div className="text-5xl font-bold text-emerald-600">{money(sale.change)}</div></> : <div className="text-4xl font-bold">{money(sale.total)}</div>}
          {Number(sale.points_earned) > 0 && <div className="text-sm text-amber-600">+{sale.points_earned} loyalty points</div>}
          <button className="btn-secondary mt-2" onClick={() => printNow('receipt')}><Printer size={16} />Print</button>
          <ReceiptShare sale={sale} business={business} receiptRef={ref} />
          <button className="btn-primary h-14 text-lg" onClick={onClose} autoFocus><Plus />New sale</button>
        </div>
      </div>
    </Modal>
  );
}

function ReceiptsPanel({ api, business, canRefund, requestApproval, onClose }: { api: Client; business: any; canRefund: boolean; requestApproval: (p: string) => Promise<string | null>; onClose: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[] | null>(null);
  const [open, setOpen] = useState<any>(null);
  const load = () => {
    const from = new Date(Date.now() - 7 * 86400000).toISOString();
    api(`/sales?limit=200&from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date(Date.now() + 60000).toISOString())}${q ? `&q=${encodeURIComponent(q)}` : ''}`).then(setRows).catch((e) => toast(e.message, 'err'));
  };
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [q]);
  if (open) return <SaleDetail sale={open} business={business} api={api} canRefund={true} requestApproval={canRefund ? undefined : requestApproval} onChanged={(s) => { setOpen(s); load(); }} onClose={() => setOpen(null)} />;
  return (
    <Modal open onClose={onClose} size="lg" title="Receipts (last 7 days)">
      <SearchInput value={q} onChange={setQ} placeholder="Receipt #, customer" className="mb-3" autoFocus />
      {!rows ? <Spinner /> : !rows.length ? <Empty /> : (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((s) => (
            <button key={s.id} className="flex w-full items-center justify-between p-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800" onClick={async () => setOpen(await api(`/sales/${s.id}`))}>
              <div><div className="font-medium">#{s.receipt_no} {s.type === 'refund' && <Badge color="red">Refund</Badge>}{s.status === 'refunded' && <Badge color="amber">Refunded</Badge>}</div><div className="text-xs text-slate-400">{dt(s.created_at)} · {s.employee_name} · {s.methods}</div></div>
              <div className={`font-semibold tabular-nums ${s.type === 'refund' ? 'text-rose-600' : ''}`}>{s.type === 'refund' ? '-' : ''}{money(s.total)}</div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

function SyncPanel({ queue, online, syncNow, onClose }: { queue: QueuedSale[]; online: boolean; syncNow: () => void; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Synchronization">
      <div className="space-y-3">
        <div className="flex items-center justify-between"><span>{online ? <Badge color="green">Online</Badge> : <Badge color="red">Offline</Badge>}</span><button className="btn-secondary" onClick={syncNow}><RefreshCw size={16} />Sync now</button></div>
        {!queue.length ? <Empty>All sales are synced ✓</Empty> : queue.map((s) => (
          <div key={s.payload.client_uuid} className="flex items-center justify-between rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
            <div><div className="font-medium">{s.local.receipt_no}</div><div className="text-xs text-slate-400">{dt(s.payload.created_at)}{s.tries ? ` · ${s.tries} failed attempts` : ''}</div>{s.error && <div className="text-xs text-rose-600">{s.error}</div>}</div>
            <div className="font-semibold">{money(s.local.total)}</div>
          </div>
        ))}
        <p className="text-xs text-slate-500">Each sale has a unique ID — retrying never creates duplicates. Stock conflicts from offline sales are flagged to managers.</p>
      </div>
    </Modal>
  );
}

function DisplayPair({ api, onClose }: { api: Client; onClose: () => void }) {
  const toast = useToast();
  const [link, setLink] = useState('');
  useEffect(() => { api('/auth/display-token', { body: {} }).then((r) => setLink(`${location.origin}/display#${r.token}`)).catch((e) => toast(e.message, 'err')); }, []);
  return (
    <Modal open onClose={onClose} title="Customer display">
      {!link ? <Spinner /> : (
        <div className="space-y-3 text-sm">
          <p>Open the customer-facing screen on a second monitor or a tablet. It updates live as you ring up items.</p>
          <button className="btn-primary w-full" onClick={() => window.open(link, 'its-display', 'popup,width=1024,height=700')}><Monitor size={16} />Open on second screen</button>
          <div className="label">Or open this link on a tablet</div>
          <div className="flex gap-2"><input className="input font-mono text-xs" readOnly value={link} onFocus={(e) => e.target.select()} /><button className="btn-secondary" onClick={() => { navigator.clipboard?.writeText(link); toast('Copied'); }}>Copy</button></div>
        </div>
      )}
    </Modal>
  );
}

function CameraScanner({ onCode, onClose }: { onCode: (c: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let stream: MediaStream | null = null, stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.current!.srcObject = stream;
        await video.current!.play();
        const det = new (window as any).BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'qr_code'] });
        const loop = async () => {
          if (stop) return;
          const codes = await det.detect(video.current).catch(() => []);
          if (codes[0]) { beep(); onCode(codes[0].rawValue); return; }
          requestAnimationFrame(loop);
        };
        loop();
      } catch { onClose(); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, []);
  return <Modal open onClose={onClose} title="Scan barcode"><video ref={video} className="w-full rounded-lg bg-black" muted playsInline /></Modal>;
}

function SplitDialog({ api, cart, priced, onClose, onDone }: { api: Client; cart: Cart; priced: any; onClose: () => void; onDone: (t: any) => void }) {
  const toast = useToast();
  const [sel, setSel] = useState<Record<string, number>>({});
  const amount = cart.items.reduce((s, l, i) => s + ((priced.lines[i]?.total || 0) * (sel[l.line_id] || 0)) / l.qty, 0);
  async function split() {
    try { onDone(await api(`/tickets/${cart.ticket_id}/split`, { body: { lines: sel } })); toast('Bill split — pay the new ticket now'); } catch (e: any) { toast(e.message, 'err'); }
  }
  return (
    <Modal open onClose={onClose} title="Split bill" footer={<button className="btn-primary" onClick={split}>Move {money(amount)} to new ticket</button>}>
      <p className="mb-3 text-sm text-slate-500">Choose items (and quantities) to pay separately. Save the ticket first if you added items.</p>
      {cart.items.map((l) => (
        <div key={l.line_id} className="mb-2 flex items-center gap-3 text-sm">
          <div className="flex-1">{fq(l.qty)} × {l.name}{l.variant_name ? ` (${l.variant_name})` : ''}</div>
          <input className="input w-24" type="number" min={0} max={l.qty} step="any" value={sel[l.line_id] || 0} onChange={(e) => setSel({ ...sel, [l.line_id]: Math.min(l.qty, Math.max(0, Number(e.target.value))) })} aria-label={`Split qty ${l.name}`} />
        </div>
      ))}
    </Modal>
  );
}
