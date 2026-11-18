import { useEffect, useState } from 'react';
import { Banknote, Plus, Ban } from 'lucide-react';
import { boApi } from '../../../lib/api';
import { Badge, Empty, Field, Modal, SearchInput, Spinner, Tabs, useAsync, useToast } from '../../../components/ui';
import { useSession } from '../../BackOffice';
import { ExportButtons } from '../../widgets';
import { AccountSelect, ac, crc, cur, d10, today } from './common';

const BUCKETS: [string, string][] = [['current', 'Al día'], ['d1_30', '1–30 días'], ['d31_60', '31–60'], ['d61_90', '61–90'], ['d90', '+90 días']];

/** Cuentas por cobrar (kind ar) / por pagar (kind ap): open invoices, payments and ageing. */
export default function OpenItems({ kind }: { kind: 'ar' | 'ap' }) {
  const { can } = useSession();
  const toast = useToast();
  const [view, setView] = useState<'items' | 'ageing' | 'payments'>('items');
  const [status, setStatus] = useState('open');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [paying, setPaying] = useState<any[] | null>(null);
  const [adding, setAdding] = useState(false);
  const qs = `kind=${kind}${status ? `&status=${status}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const items = useAsync(() => ac<any[]>(`/open-items?${qs}`), [qs]);
  const ageing = useAsync(() => (view === 'ageing' ? ac(`/reports/ageing?kind=${kind}&as_of=${today()}`) : Promise.resolve(null)), [view, kind]);
  const pays = useAsync(() => (view === 'payments' ? ac<any[]>(`/payments?kind=${kind === 'ar' ? 'receipt' : 'payment'}`) : Promise.resolve([])), [view, kind]);
  useEffect(() => setSel({}), [kind, status]);
  const rows = items.data || [];
  const chosen = rows.filter((r) => sel[r.id]);
  const L = kind === 'ar' ? { who: 'Cliente', pay: 'Registrar cobro', title: 'cobro' } : { who: 'Proveedor', pay: 'Registrar pago', title: 'pago' };
  const startPay = () => {
    if (!chosen.length) return toast('Seleccione una o más facturas', 'err');
    if (new Set(chosen.map((c) => c.currency)).size > 1) return toast('Seleccione facturas de una sola moneda', 'err');
    setPaying(chosen);
  };
  const voidPay = async (p: any) => {
    if (!confirm('¿Anular este registro? Las facturas vuelven a quedar pendientes.')) return;
    try { await ac(`/payments/${p.id}/void`, { body: {} }); toast('Anulado'); pays.reload(); items.reload(); } catch (e: any) { toast(e.message, 'err'); }
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Tabs tabs={[{ id: 'items', label: 'Facturas' }, { id: 'ageing', label: 'Antigüedad de saldos' }, { id: 'payments', label: kind === 'ar' ? 'Cobros' : 'Pagos' }]} value={view} onChange={setView} />
        {view === 'items' && <>
          <select className="input w-auto py-1.5" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado"><option value="open">Pendientes</option><option value="paid">Pagadas</option><option value="">Todas</option></select>
          <SearchInput value={q} onChange={setQ} placeholder={`${L.who}, cédula o número`} className="max-w-xs flex-1" />
          {can('accounting.manage') && <>
            <button className="btn-primary ml-auto" onClick={startPay}><Banknote size={16} />{L.pay}{chosen.length ? ` (${chosen.length})` : ''}</button>
            <button className="btn-secondary" onClick={() => setAdding(true)}><Plus size={16} />Saldo inicial</button>
          </>}
        </>}
      </div>
      {view === 'items' && (
        <div className="card overflow-x-auto">
          {items.loading && !items.data ? <div className="flex justify-center py-10"><Spinner /></div> : !rows.length ? <Empty>{kind === 'ar' ? 'No hay facturas a crédito pendientes. Las facturas manuales "a crédito" aparecen aquí.' : 'No hay facturas de proveedores pendientes. Las aceptadas en Hacienda → Recibidos aparecen aquí.'}</Empty> : (
            <table className="table text-sm">
              <thead><tr><th className="w-8" /><th>{L.who}</th><th>Documento</th><th>Emisión</th><th>Vence</th><th className="text-right">Total</th><th className="text-right">Saldo</th><th>Estado</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const overdue = r.status === 'open' && r.due_date && d10(r.due_date) < today();
                  return (
                    <tr key={r.id}>
                      <td>{r.status === 'open' && <input type="checkbox" checked={!!sel[r.id]} onChange={(e) => setSel({ ...sel, [r.id]: e.target.checked })} aria-label="Seleccionar" />}</td>
                      <td>{r.partner_name}<div className="text-xs text-slate-500">{r.partner_id}</div></td>
                      <td className="font-mono text-xs">{r.number || '—'}<div className="font-sans text-slate-400">{r.source === 'manual' ? 'saldo inicial' : r.source === 'edoc' ? 'factura emitida' : 'factura recibida'}</div></td>
                      <td className="whitespace-nowrap">{d10(r.issue_date)}</td>
                      <td className={`whitespace-nowrap ${overdue ? 'font-medium text-rose-600' : ''}`}>{d10(r.due_date) || '—'}</td>
                      <td className="text-right tabular-nums">{cur(r.total, r.currency)}{Number(r.credited) > 0 && <div className="text-xs text-slate-500">NC −{cur(r.credited, r.currency)}</div>}</td>
                      <td className="text-right font-medium tabular-nums">{cur(r.balance, r.currency)}{r.currency === 'USD' && <div className="text-xs font-normal text-slate-400">T/C {Number(r.exchange_rate).toFixed(2)}</div>}</td>
                      <td>{r.status === 'paid' ? <Badge color="green">Pagada</Badge> : r.status === 'void' ? <Badge>Anulada</Badge> : overdue ? <Badge color="red">Vencida</Badge> : <Badge color="amber">Pendiente</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
      {view === 'ageing' && (
        <div className="card overflow-x-auto">
          {!ageing.data ? <div className="flex justify-center py-10"><Spinner /></div> : !ageing.data.rows.length ? <Empty>Sin saldos pendientes</Empty> : (
            <>
              <ExportButtons name={`antiguedad-${kind}`} rows={ageing.data.rows} cols={[{ key: 'partner_name', label: L.who }, { key: 'number', label: 'Documento' }, { key: 'due_date', label: 'Vence' }, { key: 'days_overdue', label: 'Días vencido' }, { key: 'currency', label: 'Moneda' }, { key: 'balance', label: 'Saldo' }, { key: 'balance_crc', label: 'Saldo ₡' }]} />
              <table className="table mt-2 text-sm">
                <thead><tr><th>{L.who}</th><th>Documento</th><th>Vence</th>{BUCKETS.map(([, l]) => <th key={l} className="text-right">{l}</th>)}</tr></thead>
                <tbody>
                  {ageing.data.rows.map((r: any) => (
                    <tr key={r.id}><td>{r.partner_name}</td><td className="font-mono text-xs">{r.number}</td><td>{d10(r.due_date)}</td>
                      {BUCKETS.map(([k]) => <td key={k} className={`text-right tabular-nums ${k !== 'current' && r.bucket === k ? 'text-rose-600' : ''}`}>{r.bucket === k ? cur(r.balance, r.currency) : ''}</td>)}</tr>
                  ))}
                  {Object.entries(ageing.data.totals).map(([c, t]: any) => (
                    <tr key={c} className="font-semibold"><td colSpan={3}>Total {c}</td>{BUCKETS.map(([k]) => <td key={k} className="text-right tabular-nums">{cur(t[k], c)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
      {view === 'payments' && (
        <div className="card overflow-x-auto">
          {!pays.data?.length ? <Empty>Sin registros</Empty> : (
            <table className="table text-sm">
              <thead><tr><th>Fecha</th><th>{L.who}</th><th>Cuenta</th><th>Referencia</th><th className="text-right">Monto</th><th /></tr></thead>
              <tbody>
                {pays.data.map((p) => (
                  <tr key={p.id} className={p.voided ? 'opacity-50' : ''}>
                    <td>{d10(p.payment_date)}</td><td>{p.partner_name}</td><td>{p.account_name}</td><td>{p.reference}{p.voided && <Badge>Anulado</Badge>}</td>
                    <td className="text-right tabular-nums">{cur(p.amount, p.currency)}{p.currency === 'USD' && <div className="text-xs text-slate-400">T/C {Number(p.exchange_rate).toFixed(2)}</div>}</td>
                    <td className="text-right">{!p.voided && can('accounting.manage') && <button className="btn-secondary px-2 py-1 text-xs text-rose-600" onClick={() => voidPay(p)}><Ban size={12} />Anular</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {paying && <PayModal kind={kind} items={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); setSel({}); items.reload(); }} />}
      {adding && <OpeningModal kind={kind} onClose={() => setAdding(false)} onDone={() => { setAdding(false); items.reload(); }} />}
    </>
  );
}

function PayModal({ kind, items, onClose, onDone }: { kind: 'ar' | 'ap'; items: any[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const currency = items[0].currency;
  const accounts = useAsync(() => ac<any[]>('/accounts'), []);
  const [account, setAccount] = useState('');
  const [date, setDate] = useState(today());
  const [rate, setRate] = useState('');
  const [reference, setReference] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>(Object.fromEntries(items.map((i) => [i.id, String(Number(i.balance))])));
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (currency === 'USD') boApi('/hacienda/fx').then((r) => r.rate && setRate(String(r.rate))).catch(() => {}); }, []);
  const total = Object.values(amounts).reduce((s, v) => s + (Number(v) || 0), 0);
  const save = async () => {
    setBusy(true);
    try {
      await ac('/payments', { body: { kind: kind === 'ar' ? 'receipt' : 'payment', date, account_id: account, currency, exchange_rate: currency === 'USD' ? Number(rate) : undefined, reference, allocations: items.map((i) => ({ item_id: i.id, amount: Number(amounts[i.id]) || 0 })) } });
      toast(kind === 'ar' ? 'Cobro registrado' : 'Pago registrado');
      onDone();
    } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={kind === 'ar' ? 'Registrar cobro' : 'Registrar pago'}
      footer={<><span className="mr-auto font-semibold">{cur(total, currency)}</span><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={busy || !account || !total} onClick={save}>Guardar</button></>}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fecha"><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label={kind === 'ar' ? 'Depositado en' : 'Pagado desde'}>
            <AccountSelect accounts={accounts.data || []} value={account} onChange={setAccount} filter={(a) => (a.subtype === 'bank' || a.subtype === 'cash') && (currency === 'USD' || a.currency === 'CRC')} />
          </Field>
          {currency === 'USD' && <Field label="Tipo de cambio del día" hint="La diferencia con el T/C de la factura se registra como diferencial cambiario"><input className="input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>}
          <Field label="Referencia"><input className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Transferencia, cheque, SINPE…" /></Field>
        </div>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-slate-500"><th>Factura</th><th className="text-right">Saldo</th><th className="w-36 text-right">Aplicar</th></tr></thead>
          <tbody>{items.map((i) => (
            <tr key={i.id}><td className="py-1">{i.partner_name}<div className="font-mono text-xs text-slate-500">{i.number}</div></td><td className="text-right tabular-nums">{cur(i.balance, currency)}</td>
              <td className="pl-2"><input className="input text-right" inputMode="decimal" value={amounts[i.id]} onChange={(e) => setAmounts({ ...amounts, [i.id]: e.target.value })} /></td></tr>
          ))}</tbody>
        </table>
      </div>
    </Modal>
  );
}

function OpeningModal({ kind, onClose, onDone }: { kind: 'ar' | 'ap'; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<any>({ kind, currency: 'CRC', issue_date: today(), due_date: '', partner_name: '', partner_id: '', number: '', total: '', exchange_rate: '' });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try { await ac('/open-items', { body: f }); toast('Saldo registrado'); onDone(); } catch (e: any) { toast(e.message, 'err'); }
  };
  return (
    <Modal open onClose={onClose} title={kind === 'ar' ? 'Saldo inicial por cobrar' : 'Saldo inicial por pagar'} footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save}>Guardar</button></>}>
      <p className="mb-3 text-xs text-slate-500">Para facturas pendientes que vienen de QuickBooks o de Cubo. Se registra contra "Saldos de apertura".</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={kind === 'ar' ? 'Cliente' : 'Proveedor'}><input className="input" value={f.partner_name} onChange={set('partner_name')} /></Field>
        <Field label="Cédula"><input className="input" value={f.partner_id} onChange={set('partner_id')} /></Field>
        <Field label="N° de factura"><input className="input" value={f.number} onChange={set('number')} /></Field>
        <Field label="Moneda"><select className="input" value={f.currency} onChange={set('currency')}><option value="CRC">Colones</option><option value="USD">Dólares</option></select></Field>
        <Field label="Saldo pendiente"><input className="input" inputMode="decimal" value={f.total} onChange={set('total')} /></Field>
        {f.currency === 'USD' && <Field label="T/C de la factura"><input className="input" inputMode="decimal" value={f.exchange_rate} onChange={set('exchange_rate')} /></Field>}
        <Field label="Fecha"><input type="date" className="input" value={f.issue_date} onChange={set('issue_date')} /></Field>
        <Field label="Vence"><input type="date" className="input" value={f.due_date} onChange={set('due_date')} /></Field>
      </div>
    </Modal>
  );
}
