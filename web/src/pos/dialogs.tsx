import { useEffect, useMemo, useState } from 'react';
import { Minus, Plus, Trash2, UserPlus, Check } from 'lucide-react';
import QRCode from 'qrcode';
import type { Client } from '../lib/api';
import { dt, money, qty as fq } from '../lib/format';
import { Badge, Empty, Field, Keypad, Modal, SearchInput, Spinner, useToast } from '../components/ui';
import { ReceptorForm, receptorError, receptorFromCustomer, type ReceptorInput } from '../components/EInvoice';
import { ShiftReport } from '../backoffice/pages/Cash';
import type { CartLine } from './cart';

// ---------------------------------------------------------------- Variant & modifier picker
export function ItemOptions({ product, catalog, onAdd, onClose }: { product: any; catalog: any; onAdd: (variant: any, mods: any[], qty: number) => void; onClose: () => void }) {
  const [variant, setVariant] = useState(product.variants.length === 1 ? product.variants[0] : null);
  const groups = catalog.modifierGroups.filter((g: any) => product.modifier_group_ids.includes(g.id));
  const [sel, setSel] = useState<Record<string, string[]>>(() => Object.fromEntries(groups.map((g: any) => [g.id, g.min_select === 1 && g.max_select === 1 ? [g.options[0]?.id] : []])));
  const [q, setQ] = useState(product.unit === 'kg' ? '' : '1');
  const toggle = (g: any, id: string) => {
    const cur = sel[g.id] || [];
    let next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    if (g.max_select === 1) next = cur.includes(id) && g.min_select === 0 ? [] : [id];
    else if (g.max_select > 0 && next.length > g.max_select) return;
    setSel({ ...sel, [g.id]: next });
  };
  const invalid = !variant || groups.some((g: any) => (sel[g.id] || []).length < g.min_select) || !(Number(q) > 0);
  const mods = groups.flatMap((g: any) => g.options.filter((o: any) => (sel[g.id] || []).includes(o.id)));
  const price = (variant ? Number(variant.price) : 0) + mods.reduce((s: number, m: any) => s + Number(m.price), 0);
  return (
    <Modal open onClose={onClose} title={product.name} footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary px-6" disabled={invalid} onClick={() => onAdd(variant, mods, Number(q))}>Add {money(price * (Number(q) || 0))}</button></>}>
      <div className="space-y-4">
        {product.variants.length > 1 && (
          <div>
            <div className="label">Variant</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {product.variants.map((v: any) => (
                <button key={v.id} onClick={() => setVariant(v)} className={`rounded-xl border-2 p-3 text-left ${variant?.id === v.id ? 'border-brand-600 bg-brand-50 dark:bg-brand-900/30' : 'border-slate-200 dark:border-slate-700'}`}>
                  <div className="font-medium">{v.name}</div><div className="text-sm text-slate-500">{money(v.price)}</div>
                </button>
              ))}
            </div>
          </div>
        )}
        {groups.map((g: any) => (
          <div key={g.id}>
            <div className="label">{g.name} {g.min_select > 0 ? <Badge color="amber">Required</Badge> : <span className="text-slate-400">(optional{g.max_select > 0 ? `, max ${g.max_select}` : ''})</span>}</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {g.options.map((o: any) => {
                const on = (sel[g.id] || []).includes(o.id);
                return (
                  <button key={o.id} onClick={() => toggle(g, o.id)} className={`flex items-center justify-between rounded-xl border-2 p-3 text-left text-sm ${on ? 'border-brand-600 bg-brand-50 dark:bg-brand-900/30' : 'border-slate-200 dark:border-slate-700'}`}>
                    <span>{o.name}</span><span className="text-slate-500">{Number(o.price) ? `+${money(o.price)}` : ''}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <Field label={product.unit === 'kg' ? 'Weight (kg)' : 'Quantity'}>
          <input className="input text-lg" type="number" step="any" min={0} autoFocus={product.unit === 'kg'} value={q} onChange={(e) => setQ(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Cart line editor
export function LineEditor({ line, discounts, onSave, onRemove, onClose }: { line: CartLine; discounts: any[]; onSave: (l: CartLine) => void; onRemove: () => void; onClose: () => void }) {
  const [l, setL] = useState<CartLine>({ ...line });
  const itemDiscounts = discounts.filter((d) => d.scope === 'item');
  return (
    <Modal open onClose={onClose} title={`${l.name}${l.variant_name ? ` (${l.variant_name})` : ''}`}
      footer={<><button className="btn-ghost mr-auto text-rose-600" onClick={onRemove}><Trash2 size={16} />Remove</button><button className="btn-primary px-6" onClick={() => onSave(l)}>Save</button></>}>
      <div className="space-y-4">
        <div className="flex items-center justify-center gap-4">
          <button className="btn-secondary h-12 w-12 p-0" onClick={() => setL({ ...l, qty: Math.max(0.001, +(l.qty - 1).toFixed(3)) })} aria-label="Decrease"><Minus /></button>
          <input className="input w-28 text-center text-2xl font-semibold" type="number" step="any" value={l.qty} onChange={(e) => setL({ ...l, qty: Number(e.target.value) })} aria-label="Quantity" />
          <button className="btn-secondary h-12 w-12 p-0" onClick={() => setL({ ...l, qty: +(l.qty + 1).toFixed(3) })} aria-label="Increase"><Plus /></button>
        </div>
        {l.sent && <p className="text-center text-xs text-amber-600">Already sent to kitchen — reducing needs void permission.</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Price (needs permission)"><input className="input" type="number" step="any" placeholder={String(l.base_price)} value={l.custom_price ?? ''} onChange={(e) => setL({ ...l, custom_price: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
          <Field label="Item discount">
            <div className="flex gap-1">
              <input className="input" type="number" step="any" value={l.discount?.discount_id ? '' : l.discount?.value ?? ''} placeholder="0"
                onChange={(e) => setL({ ...l, discount: e.target.value ? { type: l.discount?.type || 'percent', value: Number(e.target.value) } : undefined })} />
              <select className="input w-16 px-1" value={l.discount?.type || 'percent'} onChange={(e) => setL({ ...l, discount: { type: e.target.value as any, value: l.discount?.value || 0 } })} aria-label="Discount type">
                <option value="percent">%</option><option value="fixed">₹</option>
              </select>
            </div>
          </Field>
        </div>
        {itemDiscounts.length > 0 && (
          <div className="flex flex-wrap gap-2">{itemDiscounts.map((d) => (
            <button key={d.id} onClick={() => setL({ ...l, discount: { type: d.type, value: Number(d.value), discount_id: d.id, name: d.name } })} className={`rounded-full border px-3 py-1 text-sm ${l.discount?.discount_id === d.id ? 'border-brand-600 bg-brand-50' : 'border-slate-300 dark:border-slate-700'}`}>{d.name}</button>
          ))}</div>
        )}
        <Field label="Note / special instructions"><input className="input" value={l.note || ''} onChange={(e) => setL({ ...l, note: e.target.value })} placeholder="e.g. no onion, extra hot" /></Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Customer lookup / create
export function CustomerPicker({ api, onPick, onClose, offlineCustomers }: { api: Client; onPick: (c: any) => void; onClose: () => void; offlineCustomers: any[] }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [create, setCreate] = useState<any>(null);
  useEffect(() => {
    if (!q) return setRows([]);
    const t = setTimeout(async () => {
      try { setRows(await api(`/customers?q=${encodeURIComponent(q)}`)); } catch {
        const s = q.toLowerCase();
        setRows(offlineCustomers.filter((c) => `${c.name} ${c.phone} ${c.code}`.toLowerCase().includes(s)).slice(0, 30));
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  async function save() {
    try { onPick(await api('/customers', { body: create })); } catch (e: any) { toast(e.message, 'err'); }
  }
  return (
    <Modal open onClose={onClose} title="Customer">
      {create ? (
        <div className="space-y-3">
          <Field label="Name *"><input className="input" autoFocus value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} /></Field>
          <Field label="Phone"><input className="input" inputMode="tel" value={create.phone} onChange={(e) => setCreate({ ...create, phone: e.target.value })} /></Field>
          <Field label="Email"><input className="input" value={create.email} onChange={(e) => setCreate({ ...create, email: e.target.value })} /></Field>
          <div className="flex gap-2"><button className="btn-secondary flex-1" onClick={() => setCreate(null)}>Back</button><button className="btn-primary flex-1" disabled={!create.name} onClick={save}>Save customer</button></div>
        </div>
      ) : (
        <div className="space-y-3">
          <SearchInput value={q} onChange={setQ} placeholder="Name, phone or scan loyalty card" autoFocus />
          <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
            {rows.map((c) => (
              <button key={c.id} className="flex w-full items-center justify-between p-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800" onClick={() => onPick(c)}>
                <div><div className="font-medium">{c.name}</div><div className="text-xs text-slate-400">{c.phone} {c.code ? `· ${c.code}` : ''}</div></div>
                <div className="text-right text-xs"><div className="font-medium text-brand-700">{c.points} pts</div><div className="text-slate-400">{c.visits} visits</div></div>
              </button>
            ))}
            {q && !rows.length && <Empty>No match</Empty>}
          </div>
          <button className="btn-secondary w-full" onClick={() => setCreate({ name: /^\d+$/.test(q) ? '' : q, phone: /^\d+$/.test(q) ? q : '', email: '' })}><UserPlus size={16} />New customer</button>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- Order discount
export function DiscountPicker({ discounts, current, onPick, onClose }: { discounts: any[]; current: any; onPick: (d: any) => void; onClose: () => void }) {
  const [v, setV] = useState('');
  const [type, setType] = useState<'percent' | 'fixed'>('percent');
  const [coupon, setCoupon] = useState('');
  const toast = useToast();
  return (
    <Modal open onClose={onClose} title="Order discount">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {discounts.filter((d) => d.scope === 'order' && !d.coupon_code).map((d) => (
            <button key={d.id} onClick={() => onPick({ type: d.type, value: Number(d.value), discount_id: d.id, name: d.name })}
              className={`rounded-xl border-2 p-3 text-left ${current?.discount_id === d.id ? 'border-brand-600 bg-brand-50 dark:bg-brand-900/30' : 'border-slate-200 dark:border-slate-700'}`}>
              <div className="font-medium">{d.name}</div><div className="text-xs text-slate-500">{d.type === 'percent' ? `${d.value}%` : money(d.value)}{d.restricted ? ' · restricted' : ''}</div>
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input className="input" placeholder="Coupon code" value={coupon} onChange={(e) => setCoupon(e.target.value)} />
          <button className="btn-secondary" onClick={() => { const d = discounts.find((x) => x.coupon_code && x.coupon_code.toLowerCase() === coupon.trim().toLowerCase()); if (!d) return toast('Invalid coupon', 'err'); onPick({ type: d.type, value: Number(d.value), discount_id: d.id, name: d.name }); }}>Apply</button>
        </div>
        <div className="flex gap-2">
          <input className="input" type="number" step="any" placeholder="Custom amount" value={v} onChange={(e) => setV(e.target.value)} />
          <select className="input w-20" value={type} onChange={(e) => setType(e.target.value as any)} aria-label="Type"><option value="percent">%</option><option value="fixed">₹</option></select>
          <button className="btn-primary" disabled={!v} onClick={() => onPick({ type, value: Number(v), name: 'Custom' })}>Apply</button>
        </div>
        {current && <button className="btn-ghost w-full text-rose-600" onClick={() => onPick(null)}>Remove discount</button>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Manager approval (PIN override)
export function ApprovalModal({ perm, label, api, onDone }: { perm: string; label: string; api: Client; onDone: (token: string | null) => void }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  async function submit(p: string) {
    try {
      const r = await api('/auth/approve', { body: { pin: p, permission: perm } });
      onDone(r.approval_token);
    } catch (e: any) { setErr(e.message); setPin(''); }
  }
  const key = (k: string) => {
    if (k === 'C') return setPin('');
    if (k === '⌫') return setPin(pin.slice(0, -1));
    const p = (pin + k).slice(0, 6);
    setPin(p);
    setErr('');
    if (p.length >= 4) submit(p);
  };
  return (
    <Modal open onClose={() => onDone(null)} title="Manager approval" size="sm">
      <p className="mb-3 text-center text-sm text-slate-500">{label}<br />Ask a manager to enter their PIN.</p>
      <div className="mb-3 flex justify-center gap-2">{[0, 1, 2, 3].map((i) => <span key={i} className={`h-3 w-3 rounded-full ${pin.length > i ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-700'}`} />)}</div>
      {err && <p className="mb-2 text-center text-sm text-rose-600">{err}</p>}
      <Keypad onKey={key} />
    </Modal>
  );
}

// ---------------------------------------------------------------- Payment
export function PaymentModal({ total, methods, customer, business, offline, einvoice, onPay, onClose, onStage }: {
  total: number; methods: any[]; customer: any; business: any; offline: boolean; einvoice?: { enabled: boolean; environment: string | null };
  onPay: (payments: any[], tip: number, einvoice?: { type: 'FE'; receptor: ReceptorInput } | null) => Promise<void>; onClose: () => void; onStage: (s: any) => void;
}) {
  const [pays, setPays] = useState<any[]>([]);
  // Hacienda: factura electrónica instead of a tiquete when the customer asks for one
  const [fe, setFe] = useState(false);
  const [receptor, setReceptor] = useState<ReceptorInput>(() => receptorFromCustomer(customer));
  const feError = fe ? receptorError(receptor) : null;
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState('');
  const paid = pays.reduce((s, p) => s + p.amount, 0);
  const remaining = Math.max(0, +(total - paid).toFixed(2));
  const change = Math.max(0, +(paid - total).toFixed(2));
  const pointValue = Number(business.point_value || 1);
  const maxPoints = customer ? Math.min(Number(customer.points), Math.floor(remaining / pointValue)) : 0;
  const quick = useMemo(() => [...new Set([remaining, Math.ceil(remaining / 10) * 10, Math.ceil(remaining / 100) * 100, Math.ceil(remaining / 500) * 500, 2000])].filter((v) => v >= remaining && v > 0).slice(0, 4), [remaining]);
  useEffect(() => onStage({ stage: 'payment', paid, remaining, change }), [paid]);
  useEffect(() => {
    if (!business.upi_id || remaining <= 0) return setQr('');
    QRCode.toDataURL(`upi://pay?pa=${encodeURIComponent(business.upi_id)}&pn=${encodeURIComponent(business.name)}&am=${remaining.toFixed(2)}&cu=INR`, { margin: 1, width: 220 }).then(setQr).catch(() => setQr(''));
  }, [remaining, business.upi_id]);

  const add = (m: any, amt?: number) => {
    const a = +(amt ?? (amount ? Number(amount) : remaining)).toFixed(2);
    if (!(a > 0)) return;
    if (m.type !== 'cash' && a > remaining + 0.001) return; // only cash can exceed (change)
    if (m.type === 'gift_card' && !ref) return alert('Enter the gift card number');
    setPays([...pays, { method_id: m.id, method_type: m.type, method_name: m.name, amount: a, reference: ref || null }]);
    setAmount('');
    setRef('');
  };
  async function finish() {
    setBusy(true);
    try { await onPay(pays, 0, fe ? { type: 'FE', receptor } : null); } finally { setBusy(false); }
  }
  const usable = methods.filter((m) => !offline || ['cash', 'card', 'upi', 'bank', 'other'].includes(m.type));
  return (
    <Modal open onClose={onClose} size="lg" title={`Charge ${money(total)}`}>
      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-3">
          <div className="rounded-xl bg-slate-50 p-4 text-center dark:bg-slate-800">
            <div className="text-sm text-slate-500">{remaining > 0 ? 'Remaining' : 'Change due'}</div>
            <div className={`text-4xl font-bold tabular-nums ${remaining > 0 ? '' : 'text-emerald-600'}`}>{money(remaining > 0 ? remaining : change)}</div>
          </div>
          <Field label="Amount (empty = remaining)"><input className="input text-lg" type="number" step="any" inputMode="decimal" value={amount} placeholder={remaining.toFixed(2)} onChange={(e) => setAmount(e.target.value)} /></Field>
          <div className="flex flex-wrap gap-2">{quick.map((v) => <button key={v} className="btn-secondary" onClick={() => add(methods.find((m) => m.type === 'cash'), v)}>{money(v)}</button>)}</div>
          <Field label="Reference (card last 4 / UPI ref / gift card #)"><input className="input" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
          {offline && <p className="text-xs text-amber-600">Offline: gift cards, store credit and points need a connection.</p>}
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {usable.map((m) => (
              <button key={m.id} disabled={remaining <= 0} onClick={() => add(m)} className="h-14 rounded-xl border-2 border-slate-200 font-semibold transition hover:border-brand-500 active:scale-95 disabled:opacity-40 dark:border-slate-700">{m.name}</button>
            ))}
            {customer && maxPoints >= Number(business.min_redeem_points) && !offline && remaining > 0 && (
              <button onClick={() => setPays([...pays, { method_type: 'loyalty', method_name: `Points (${maxPoints})`, amount: +(maxPoints * pointValue).toFixed(2) }])}
                className="col-span-2 h-12 rounded-xl border-2 border-amber-300 bg-amber-50 font-semibold text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">Redeem {maxPoints} points ({money(maxPoints * pointValue)})</button>
            )}
          </div>
          {qr && <div className="flex items-center gap-3 rounded-xl border border-slate-200 p-2 dark:border-slate-700"><img src={qr} className="h-24 w-24 rounded bg-white" alt="UPI QR" /><div className="text-xs text-slate-500">Scan to pay {money(remaining)} via UPI<br />{business.upi_id}</div></div>}
          <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
            {pays.map((p, i) => (
              <div key={i} className="flex items-center justify-between px-3 py-2 text-sm">
                <span>{p.method_name}{p.reference ? ` · ${p.reference}` : ''}</span>
                <span className="flex items-center gap-2 font-medium tabular-nums">{money(p.amount)}<button className="text-rose-600" onClick={() => setPays(pays.filter((_, j) => j !== i))} aria-label="Remove payment"><Trash2 size={14} /></button></span>
              </div>
            ))}
            {!pays.length && <div className="px-3 py-4 text-center text-sm text-slate-400">Choose a payment method. Split across several methods if needed.</div>}
          </div>
          {einvoice?.enabled && (
            <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                <input type="checkbox" className="h-4 w-4" checked={fe} onChange={(e) => setFe(e.target.checked)} />
                Factura electrónica (cliente con cédula)
              </label>
              {fe && <div className="mt-2"><ReceptorForm value={receptor} onChange={setReceptor} /></div>}
              {fe && feError && <p className="mt-1 text-xs text-rose-600">{feError}</p>}
              {!fe && <p className="mt-1 text-xs text-slate-400">Sin marcar se emite tiquete electrónico.</p>}
            </div>
          )}
          <button className="btn-primary h-14 w-full text-lg" disabled={remaining > 0 || busy || !!feError} onClick={finish}>
            {busy ? <Spinner /> : <Check />}Complete sale{change > 0 ? ` · change ${money(change)}` : ''}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Shift & cash drawer
export function ShiftPanel({ api, can, onClose }: { api: Client; can: (p: string) => boolean; onClose: () => void }) {
  const toast = useToast();
  const [shift, setShift] = useState<any>(undefined);
  const [cash, setCash] = useState('');
  const [mv, setMv] = useState({ type: 'pay_out', amount: '', reason: '' });
  const load = () => api('/shifts/current').then(setShift).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  const run = async (fn: () => Promise<any>, msg: string) => { try { await fn(); toast(msg); setCash(''); load(); } catch (e: any) { toast(e.message, 'err'); } };
  return (
    <Modal open onClose={onClose} size="lg" title="Shift">
      {shift === undefined ? <Spinner /> : !shift ? (
        <div className="mx-auto max-w-sm space-y-3">
          <p className="text-sm text-slate-500">No shift is open on this terminal. Count the cash drawer and open a shift.</p>
          <Field label="Opening cash"><input className="input text-lg" type="number" step="any" autoFocus value={cash} onChange={(e) => setCash(e.target.value)} /></Field>
          <button className="btn-primary w-full" disabled={!can('shift.manage')} onClick={() => run(() => api('/shifts/open', { body: { opening_cash: Number(cash) || 0 } }), 'Shift opened')}>Open shift</button>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          <ShiftReport s={shift} />
          <div className="space-y-5">
            <div className="space-y-2 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <div className="font-semibold">Cash in / out</div>
              <select className="input" value={mv.type} onChange={(e) => setMv({ ...mv, type: e.target.value })} aria-label="Type">
                <option value="pay_in">Pay in</option><option value="pay_out">Pay out</option><option value="expense">Petty cash expense</option><option value="deposit">Deposit</option><option value="withdrawal">Bank withdrawal / drop</option><option value="supplier_payment">Supplier payment</option>
              </select>
              <input className="input" type="number" step="any" placeholder="Amount" value={mv.amount} onChange={(e) => setMv({ ...mv, amount: e.target.value })} />
              <input className="input" placeholder="Reason (required)" value={mv.reason} onChange={(e) => setMv({ ...mv, reason: e.target.value })} />
              <button className="btn-secondary w-full" disabled={!can('cash.manage') || !mv.amount || !mv.reason} onClick={() => run(async () => { await api('/cash-movements', { body: { ...mv, amount: Number(mv.amount) } }); setMv({ type: 'pay_out', amount: '', reason: '' }); }, 'Recorded')}>Record</button>
              {!can('cash.manage') && <p className="text-xs text-slate-400">You don't have cash management permission.</p>}
            </div>
            <div className="space-y-2 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <div className="font-semibold">Close shift</div>
              <Field label="Actual cash counted"><input className="input text-lg" type="number" step="any" value={cash} onChange={(e) => setCash(e.target.value)} /></Field>
              {cash !== '' && <div className={`text-sm font-medium ${Number(cash) - shift.cash.expected < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>Difference: {money(Number(cash) - shift.cash.expected)}</div>}
              <button className="btn-danger w-full" disabled={cash === '' || !can('shift.manage')} onClick={() => run(async () => { const s = await api(`/shifts/${shift.id}/close`, { body: { actual_cash: Number(cash) } }); setTimeout(() => window.print(), 50); return s; }, 'Shift closed')}>Close shift & print report</button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- Open tickets list
export function TicketsPanel({ api, onOpen, onClose, canMerge }: { api: Client; onOpen: (t: any) => void; onClose: () => void; canMerge: boolean }) {
  const toast = useToast();
  const [rows, setRows] = useState<any[] | null>(null);
  const [merge, setMerge] = useState<Set<string>>(new Set());
  const load = () => api('/tickets').then(setRows).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  async function doMerge() {
    const [target, ...rest] = [...merge];
    try { const t = await api(`/tickets/${target}/merge`, { body: { source_ids: rest } }); toast('Tickets merged'); setMerge(new Set()); onOpen(t); } catch (e: any) { toast(e.message, 'err'); }
  }
  return (
    <Modal open onClose={onClose} size="lg" title="Open tickets" footer={merge.size > 1 && canMerge ? <button className="btn-primary" onClick={doMerge}>Merge {merge.size} tickets</button> : undefined}>
      {!rows ? <Spinner /> : !rows.length ? <Empty>No open tickets</Empty> : (
        <div className="grid gap-2 sm:grid-cols-2">
          {rows.map((t) => (
            <div key={t.id} className="flex items-stretch rounded-xl border border-slate-200 dark:border-slate-700">
              <input type="checkbox" className="mx-3" checked={merge.has(t.id)} onChange={(e) => { const s = new Set(merge); e.target.checked ? s.add(t.id) : s.delete(t.id); setMerge(s); }} aria-label={`Select ${t.name}`} />
              <button className="flex-1 p-3 text-left" onClick={() => onOpen(t)}>
                <div className="flex justify-between font-semibold"><span>{t.name}</span><span>{money(t.total)}</span></div>
                <div className="text-xs text-slate-400">{(t.cart.items || []).length} items · {t.employee_name} · {dt(t.updated_at)}{t.customer_name ? ` · ${t.customer_name}` : ''}</div>
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- Floor plan
export function TablesPanel({ tables, tickets, onPick, onClose, api, onChanged }: { tables: any[]; tickets: any[]; onPick: (table: any, ticket?: any) => void; onClose: () => void; api: Client; onChanged: () => void }) {
  const areas = [...new Set(tables.map((t) => t.area || 'Main'))];
  const color = (s: string) => (s === 'occupied' ? 'border-rose-400 bg-rose-50 dark:bg-rose-950/30' : s === 'reserved' ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/30' : 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30');
  return (
    <Modal open onClose={onClose} size="xl" title="Tables">
      {!tables.length && <Empty>No tables. Add them in Back Office → Settings → Tables.</Empty>}
      {areas.map((a) => (
        <div key={a} className="mb-4">
          <div className="label">{a}</div>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {tables.filter((t) => (t.area || 'Main') === a).map((t) => {
              const tk = tickets.filter((x) => x.table_id === t.id);
              return (
                <div key={t.id} className={`relative rounded-2xl border-2 p-3 text-center ${color(t.status)}`}>
                  <button className="w-full" onClick={() => onPick(t, tk[0])}>
                    <div className="text-lg font-bold">{t.name}</div>
                    <div className="text-xs text-slate-500">{t.capacity} seats · {t.status}</div>
                    {tk.length > 0 && <div className="mt-1 text-sm font-semibold">{money(tk.reduce((s, x) => s + Number(x.total), 0))}</div>}
                  </button>
                  {t.status !== 'occupied' && (
                    <button className="mt-1 text-xs text-slate-500 underline" onClick={async () => { await api(`/settings/tables/${t.id}/status`, { body: { status: t.status === 'reserved' ? 'available' : 'reserved' } }); onChanged(); }}>
                      {t.status === 'reserved' ? 'Unreserve' : 'Reserve'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex gap-4 text-xs text-slate-500"><span>🟢 Available</span><span>🔴 Occupied</span><span>🟡 Reserved</span></div>
    </Modal>
  );
}

export { KitchenTicket } from '../components/KitchenTicket';
