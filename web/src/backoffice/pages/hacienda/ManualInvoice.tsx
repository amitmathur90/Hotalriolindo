import { useEffect, useState } from 'react';
import { Plus, Trash2, FileText, Send } from 'lucide-react';
import { boApi, openFile } from '../../../lib/api';
import { Field, useToast } from '../../../components/ui';
import { ReceptorForm, receptorError, receptorFromCustomer, type ReceptorInput } from '../../../components/EInvoice';
import { CabysPicker } from '../../../components/CabysPicker';

/** Manual comprobante (factura / tiquete) for sales outside the POS: rooms, events, tours, services. */
type Line = { cabys: string; name: string; qty: string; unit: string; price: string; discount: string; tax_rate: string };
const emptyLine = (): Line => ({ cabys: '', name: '', qty: '1', unit: 'Unid', price: '', discount: '', tax_rate: '13' });
const UNITS: [string, string][] = [['Unid', 'Unidad'], ['Sp', 'Servicio'], ['d', 'Día / noche'], ['h', 'Hora'], ['kg', 'Kilogramo'], ['L', 'Litro'], ['Os', 'Otro servicio']];
const RATES = ['13', '8', '4', '2', '1', '0.5', '0'];
const PAYMENTS: [string, string][] = [['cash', 'Efectivo'], ['card', 'Tarjeta'], ['sinpe', 'SINPE Móvil'], ['bank', 'Transferencia'], ['other', 'Otro']];
export const fmtCur = (n: number, cur: string) => `${cur === 'USD' ? 'US$' : '₡'}${(Number(n) || 0).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function ManualInvoice({ onIssued }: { onIssued?: () => void }) {
  const toast = useToast();
  const [docType, setDocType] = useState<'01' | '04'>('01');
  const [currency, setCurrency] = useState<'CRC' | 'USD'>('CRC');
  const [rate, setRate] = useState('');
  const [rateInfo, setRateInfo] = useState<any>(null);
  const [receptor, setReceptor] = useState<ReceptorInput>(receptorFromCustomer(null));
  const [customers, setCustomers] = useState<any[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [condition, setCondition] = useState('01');
  const [creditDays, setCreditDays] = useState('30');
  const [payment, setPayment] = useState('cash');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<any>(null);

  useEffect(() => {
    boApi('/hacienda/fx').then((r) => { setRateInfo(r); if (r.rate) setRate(String(r.rate)); }).catch(() => {});
    boApi('/customers').then((r: any) => setCustomers(Array.isArray(r) ? r : r.rows || [])).catch(() => {});
  }, []);

  const set = (i: number, k: keyof Line, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const calc = lines.map((l) => {
    const sub = Math.max(0, (Number(l.qty) || 0) * (Number(l.price) || 0) - (Number(l.discount) || 0));
    const tax = sub * (Number(l.tax_rate) || 0) / 100;
    return { sub, tax, total: sub + tax };
  });
  const totals = calc.reduce((a, c) => ({ sub: a.sub + c.sub, tax: a.tax + c.tax, total: a.total + c.total }), { sub: 0, tax: 0, total: 0 });

  const pickCustomer = (id: string) => {
    setCustomerId(id);
    const c = customers.find((x) => x.id === id);
    if (c) setReceptor(receptorFromCustomer(c));
  };

  async function issue() {
    const withReceptor = docType === '01' || receptor.nombre.trim();
    if (withReceptor && docType === '01') {
      const err = receptorError(receptor);
      if (err) return toast(err, 'err');
    }
    for (const [i, l] of lines.entries()) {
      if (l.name.trim().length < 3) return toast(`Línea ${i + 1}: escriba la descripción`, 'err');
      if (!(Number(l.qty) > 0) || !(Number(l.price) >= 0) || l.price === '') return toast(`Línea ${i + 1}: cantidad y precio`, 'err');
    }
    if (currency === 'USD' && !(Number(rate) > 0)) return toast('Ingrese el tipo de cambio', 'err');
    if (!confirm(`Se emitirá ${docType === '01' ? 'una factura electrónica' : 'un tiquete electrónico'} por ${fmtCur(totals.total, currency)} y se enviará a Hacienda. ¿Continuar?`)) return;
    setBusy(true);
    try {
      const d = await boApi('/hacienda/invoices', {
        body: {
          doc_type: docType, currency, exchange_rate: currency === 'USD' ? Number(rate) : undefined, condition, credit_days: Number(creditDays) || 30, notes,
          receptor: withReceptor ? receptor : null, customer_id: customerId || undefined,
          lines: lines.map((l) => ({ cabys: l.cabys, name: l.name, qty: Number(l.qty), unit: l.unit, price: Number(l.price), discount: Number(l.discount) || 0, tax_rate: Number(l.tax_rate) })),
          payments: [{ type: payment, amount: totals.total }],
        },
      });
      setLast(d);
      toast(`${docType === '01' ? 'Factura' : 'Tiquete'} N° ${d.consecutivo} emitido · enviando a Hacienda`);
      setLines([emptyLine()]);
      setNotes('');
      onIssued?.();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {last && (
        <div className="card flex flex-wrap items-center justify-between gap-2 border-emerald-300 bg-emerald-50 p-3 text-sm dark:bg-emerald-900/20">
          <span>Emitido N° <b className="font-mono">{last.consecutivo}</b> — el estado de Hacienda se ve en "Emitidos".</span>
          <button className="btn-secondary px-2 py-1 text-xs" onClick={() => openFile(boApi, `/hacienda/documents/${last.id}/pdf`).catch((e) => toast(e.message, 'err'))}><FileText size={14} />Ver PDF</button>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card space-y-3 p-5">
          <div className="font-semibold">Documento</div>
          <Field label="Tipo">
            <select className="input" value={docType} onChange={(e) => setDocType(e.target.value as any)}>
              <option value="01">Factura electrónica (cliente con cédula)</option>
              <option value="04">Tiquete electrónico (consumidor final)</option>
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Moneda">
              <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value as any)}>
                <option value="CRC">Colones (₡)</option>
                <option value="USD">Dólares (US$)</option>
              </select>
            </Field>
            {currency === 'USD' && (
              <Field label="Tipo de cambio" hint={rateInfo?.rate ? `Hacienda/BCCR ${rateInfo.date}${rateInfo.source === 'manual' ? ' (fijo)' : ''}` : rateInfo?.error}>
                <input className="input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
              </Field>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Condición">
              <select className="input" value={condition} onChange={(e) => setCondition(e.target.value)}>
                <option value="01">Contado</option>
                <option value="02">Crédito</option>
              </select>
            </Field>
            {condition === '02' ? (
              <Field label="Plazo (días)"><input className="input" inputMode="numeric" value={creditDays} onChange={(e) => setCreditDays(e.target.value)} /></Field>
            ) : (
              <Field label="Medio de pago">
                <select className="input" value={payment} onChange={(e) => setPayment(e.target.value)}>{PAYMENTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              </Field>
            )}
          </div>
          <Field label="Notas (se imprimen en el comprobante)"><textarea className="input" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ej. Reserva 1234, orden de compra…" /></Field>
        </div>
        <div className="card space-y-3 p-5 lg:col-span-2">
          <div className="flex items-center justify-between gap-2">
            <div className="font-semibold">Cliente (receptor){docType === '04' && <span className="ml-1 text-xs font-normal text-slate-500">opcional</span>}</div>
            <select className="input w-64" value={customerId} onChange={(e) => pickCustomer(e.target.value)} aria-label="Cliente guardado">
              <option value="">— Cliente guardado —</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.tax_id ? ` · ${c.tax_id}` : ''}</option>)}
            </select>
          </div>
          <ReceptorForm value={receptor} onChange={setReceptor} />
        </div>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="table text-sm">
          <thead>
            <tr><th className="w-56">CABYS</th><th>Descripción</th><th className="w-20">Cant.</th><th className="w-32">Unidad</th><th className="w-32">Precio sin IVA</th><th className="w-28">Descuento</th><th className="w-24">IVA</th><th className="w-32 text-right">Total</th><th /></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td><CabysPicker value={l.cabys} onChange={(v) => set(i, 'cabys', v)} placeholder="Predeterminado" onPick={(it) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, cabys: it.codigo, tax_rate: RATES.includes(String(it.impuesto)) ? String(it.impuesto) : x.tax_rate, name: x.name || it.descripcion.slice(0, 120) } : x)))} /></td>
                <td><input className="input" value={l.name} onChange={(e) => set(i, 'name', e.target.value)} placeholder="Hospedaje, evento, tour…" /></td>
                <td><input className="input" inputMode="decimal" value={l.qty} onChange={(e) => set(i, 'qty', e.target.value)} /></td>
                <td><select className="input" value={l.unit} onChange={(e) => set(i, 'unit', e.target.value)}>{UNITS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></td>
                <td><input className="input" inputMode="decimal" value={l.price} onChange={(e) => set(i, 'price', e.target.value)} /></td>
                <td><input className="input" inputMode="decimal" value={l.discount} onChange={(e) => set(i, 'discount', e.target.value)} placeholder="0" /></td>
                <td><select className="input" value={l.tax_rate} onChange={(e) => set(i, 'tax_rate', e.target.value)}>{RATES.map((r) => <option key={r} value={r}>{r}%</option>)}</select></td>
                <td className="text-right tabular-nums">{fmtCur(calc[i].total, currency)}</td>
                <td>{lines.length > 1 && <button className="btn-ghost p-1.5 text-rose-600" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Quitar línea"><Trash2 size={16} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap items-end justify-between gap-4 border-t border-slate-200 p-4 dark:border-slate-800">
          <button className="btn-secondary" onClick={() => setLines([...lines, emptyLine()])}><Plus size={16} />Agregar línea</button>
          <div className="min-w-64 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="tabular-nums">{fmtCur(totals.sub, currency)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">IVA</span><span className="tabular-nums">{fmtCur(totals.tax, currency)}</span></div>
            <div className="flex justify-between text-lg font-bold"><span>Total</span><span className="tabular-nums">{fmtCur(totals.total, currency)}</span></div>
            {currency === 'USD' && Number(rate) > 0 && <div className="text-right text-xs text-slate-500">≈ {fmtCur(totals.total * Number(rate), 'CRC')}</div>}
          </div>
        </div>
      </div>
      <div className="flex justify-end">
        <button className="btn-primary" disabled={busy} onClick={issue}><Send size={16} />Emitir y enviar a Hacienda</button>
      </div>
    </div>
  );
}
