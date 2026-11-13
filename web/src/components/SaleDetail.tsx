import { useRef, useState } from 'react';
import { Printer, FileText, Undo2, Copy } from 'lucide-react';
import type { Client } from '../lib/api';
import { money, qty as fq, uuid } from '../lib/format';
import { Receipt } from './Receipt';
import { ReceiptShare } from './ReceiptShare';
import { Badge, Field, Modal, Toggle, useToast } from './ui';

const REASONS = ['Customer returned', 'Wrong item', 'Damaged / defective', 'Order cancelled', 'Pricing error', 'Other'];

/** Receipt viewer with reprint, A4 invoice, WhatsApp/email share, and full/partial/item-level refunds. */
export function SaleDetail({ sale, business, api, canRefund, requestApproval, onChanged, onClose }: {
  sale: any; business: any; api: Client; canRefund: boolean;
  requestApproval?: (perm: string) => Promise<string | null>; // POS manager override
  onChanged: (s: any) => void; onClose: () => void;
}) {
  const toast = useToast();
  const [format, setFormat] = useState<'thermal' | 'a4'>('thermal');
  const [refund, setRefund] = useState<Record<string, number> | null>(null);
  const [reason, setReason] = useState(REASONS[0]);
  const [restock, setRestock] = useState(true);
  const [busy, setBusy] = useState(false);
  const receiptRef = useRef<HTMLDivElement>(null);
  const link = `${location.origin}/r/${sale.id}/${sale.share_sig}`;
  const refundable = sale.type === 'sale' && sale.status !== 'refunded';

  const print = (f: 'thermal' | 'a4', reprint = false) => {
    setFormat(f);
    if (reprint) onChanged({ ...sale, _reprint: true });
    setTimeout(() => { window.print(); if (reprint) onChanged({ ...sale, _reprint: false }); }, 80);
  };

  async function doRefund() {
    const items = Object.entries(refund || {}).filter(([, q]) => q > 0).map(([sale_item_id, qty]) => ({ sale_item_id, qty }));
    if (!items.length) return toast('Choose items to refund', 'err');
    setBusy(true);
    try {
      const body: any = { items, reason, restock, client_uuid: uuid() };
      let res;
      try {
        res = await api(`/sales/${sale.id}/refund`, { body });
      } catch (e: any) {
        if (e.status !== 403 || !requestApproval) throw e;
        const tok = await requestApproval('pos.refund');
        if (!tok) return;
        res = await api(`/sales/${sale.id}/refund`, { body: { ...body, approval_token: tok } });
      }
      toast(`Refunded ${money(res.total)}`);
      setRefund(null);
      onChanged(res); // show the refund receipt so it can be printed
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="lg" title={<span className="flex items-center gap-2">Receipt #{sale.receipt_no} {sale.type === 'refund' ? <Badge color="red">Refund</Badge> : sale.status !== 'completed' ? <Badge color="amber">{sale.status.replace('_', ' ')}</Badge> : null}</span>}>
      <div className="flex flex-col gap-5 md:flex-row">
        <div ref={receiptRef} className="max-h-[65vh] overflow-y-auto rounded-lg border border-slate-200 bg-white md:w-[340px] dark:border-slate-700">
          <Receipt sale={sale} business={business} format={format} />
        </div>
        <div className="flex-1 space-y-3">
          {!refund ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <button className="btn-secondary" onClick={() => print('thermal', true)}><Printer size={16} />Reprint</button>
                <button className="btn-secondary" onClick={() => print('a4')}><FileText size={16} />A4 invoice</button>
              </div>
              <ReceiptShare sale={sale} business={business} receiptRef={receiptRef} />
              <div className="grid grid-cols-2 gap-2">
                <button className="btn-secondary col-span-2" onClick={() => { navigator.clipboard?.writeText(link); toast('Digital receipt link copied'); }}><Copy size={16} />Copy digital receipt link</button>
              </div>
              {sale.refunds?.length > 0 && (
                <div className="rounded-lg bg-rose-50 p-3 text-sm dark:bg-rose-950/30">
                  <div className="font-medium">Refunds</div>
                  {sale.refunds.map((r: any) => <div key={r.id} className="flex justify-between"><span>#{r.receipt_no} · {r.refund_reason}</span><span>{money(r.total)}</span></div>)}
                </div>
              )}
              {refundable && canRefund && (
                <button className="btn-danger w-full" onClick={() => setRefund(Object.fromEntries(sale.items.map((i: any) => [i.id, 0])))}><Undo2 size={16} />Refund…</button>
              )}
            </>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="font-semibold">Select items to refund</div>
                <button className="text-sm text-brand-700" onClick={() => setRefund(Object.fromEntries(sale.items.map((i: any) => [i.id, Number(i.qty) - Number(i.refunded_qty)])))}>Refund all</button>
              </div>
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                {sale.items.map((it: any) => {
                  const max = Number(it.qty) - Number(it.refunded_qty);
                  return (
                    <div key={it.id} className="flex items-center gap-3 p-2 text-sm">
                      <div className="min-w-0 flex-1"><div className="truncate">{it.product_name}{it.variant_name ? ` (${it.variant_name})` : ''}</div><div className="text-xs text-slate-400">{fq(max)} refundable · {money(it.total / it.qty)} each</div></div>
                      <input type="number" min={0} max={max} step="any" disabled={max <= 0} className="input w-20" value={refund[it.id]}
                        onChange={(e) => setRefund({ ...refund, [it.id]: Math.min(max, Math.max(0, Number(e.target.value))) })} aria-label={`Refund qty ${it.product_name}`} />
                    </div>
                  );
                })}
              </div>
              <Field label="Reason">
                <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map((r) => <option key={r}>{r}</option>)}</select>
              </Field>
              <Toggle checked={restock} onChange={setRestock} label="Return items to inventory" />
              <div className="text-sm text-slate-500">Money is returned to the original payment method(s).</div>
              <div className="flex gap-2">
                <button className="btn-secondary flex-1" onClick={() => setRefund(null)}>Cancel</button>
                <button className="btn-danger flex-1" disabled={busy} onClick={doRefund}>
                  Refund {money(sale.items.reduce((s: number, i: any) => s + (Number(i.total) / Number(i.qty)) * (refund[i.id] || 0), 0))}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
