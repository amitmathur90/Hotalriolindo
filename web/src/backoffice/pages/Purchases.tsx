import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { boApi } from '../../lib/api';
import { dateOnly, money } from '../../lib/format';
import { Badge, Empty, Field, Modal, PageHeader, Tabs, useAsync, useToast } from '../../components/ui';
import { useSession } from '../BackOffice';
import { CrudPage, ExportButtons } from '../widgets';
import { VariantSelect, useVariants } from './Inventory';

export default function Purchases() {
  const [tab, setTab] = useState<'po' | 'suppliers'>('po');
  return (
    <div>
      <PageHeader title="Purchases" subtitle="Purchase orders, receiving and suppliers" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'po', label: 'Purchase orders' }, { id: 'suppliers', label: 'Suppliers' }]} />
      {tab === 'po' ? <PurchaseOrders /> : <Suppliers />}
    </div>
  );
}

function Suppliers() {
  const toast = useToast();
  return (
    <CrudPage header={false} title="Suppliers" path="/suppliers" perm="purchases.manage"
      columns={[{ key: 'name', label: 'Name' }, { key: 'contact_person', label: 'Contact' }, { key: 'phone', label: 'Phone' }, { key: 'gstin', label: 'GSTIN' },
        { key: 'balance', label: 'Outstanding', render: (r) => <span className={Number(r.balance) > 0 ? 'font-medium text-rose-600' : ''}>{money(r.balance)}</span> }]}
      fields={[{ key: 'name', label: 'Name', required: true }, { key: 'contact_person', label: 'Contact person' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email', type: 'email' },
        { key: 'gstin', label: 'GSTIN' }, { key: 'address', label: 'Address' }, { key: 'notes', label: 'Notes', type: 'textarea' }]}
      extraActions={(r, reload) => Number(r.balance) > 0 && (
        <button className="btn-secondary mr-1 px-2 py-1 text-xs" onClick={async () => {
          const amt = prompt(`Record payment to ${r.name} (outstanding ${money(r.balance)})`, String(r.balance));
          if (!amt) return;
          try { await boApi(`/suppliers/${r.id}/payments`, { body: { amount: Number(amt), from_cash: confirm('Paid from the cash drawer (current shift)?') } }); toast('Payment recorded'); reload(); } catch (e: any) { toast(e.message, 'err'); }
        }}>Pay</button>
      )} />
  );
}

function PurchaseOrders() {
  const { storeId } = useSession();
  const toast = useToast();
  const variants = useVariants();
  const suppliers = useAsync(() => boApi<any[]>('/suppliers'), []);
  const { data, reload } = useAsync(() => boApi<any[]>('/purchase-orders'), [storeId]);
  const [form, setForm] = useState<any>(null);
  const [recv, setRecv] = useState<any>(null);
  const total = (items: any[]) => items.reduce((s, i) => s + Number(i.qty || 0) * Number(i.cost || 0) * (1 + Number(i.tax_pct || 0) / 100) - Number(i.discount || 0), 0);
  const setItem = (i: number, patch: any) => setForm({ ...form, items: form.items.map((x: any, j: number) => (i === j ? { ...x, ...patch } : x)) });

  async function save(status: string) {
    try {
      const body = { ...form, status, items: form.items.filter((i: any) => i.variant_id) };
      if (form.id) await boApi(`/purchase-orders/${form.id}`, { method: 'PUT', body });
      else await boApi('/purchase-orders', { body });
      setForm(null);
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  }
  async function receive(all: boolean) {
    try {
      await boApi(`/purchase-orders/${recv.id}/receive`, { body: { all, invoice_no: recv.invoice_no, items: recv.items.map((i: any) => ({ variant_id: i.variant_id, qty: Number(i._recv) })) } });
      toast('Stock received');
      setRecv(null);
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  }
  const color: Record<string, any> = { draft: 'slate', sent: 'blue', partial: 'amber', received: 'green', cancelled: 'red' };
  const lowStock = () => variants.filter((v) => v.track && Number(v.stock) <= 10).map((v) => ({ variant_id: v.id, name: v.name, qty: 20, cost: v.cost, tax_pct: 0, discount: 0 }));

  return (
    <div>
      <div className="mb-3 flex justify-end gap-2">
        <ExportButtons name="purchase-orders" rows={data || []} cols={['po_no', 'supplier_name', 'status', 'expected_date', 'total', 'invoice_no'].map((k) => ({ key: k, label: k }))} />
        <button className="btn-primary" onClick={() => setForm({ supplier_id: '', expected_date: '', notes: '', items: [{ variant_id: '', qty: 1, cost: 0, tax_pct: 0, discount: 0 }] })}><Plus size={16} />New purchase order</button>
      </div>
      <div className="card overflow-x-auto">
        {!data?.length ? <Empty>No purchase orders</Empty> : (
          <table className="table">
            <thead><tr><th>PO #</th><th>Supplier</th><th>Store</th><th>Expected</th><th>Status</th><th className="text-right">Total</th><th /></tr></thead>
            <tbody>{data.map((po) => (
              <tr key={po.id}>
                <td className="font-medium">{po.po_no}{po.invoice_no && <div className="text-xs text-slate-400">Inv {po.invoice_no}</div>}</td>
                <td>{po.supplier_name || '—'}</td><td>{po.store_name}</td><td>{dateOnly(po.expected_date)}</td>
                <td><Badge color={color[po.status]}>{po.status}</Badge></td>
                <td className="text-right tabular-nums">{money(po.total)}</td>
                <td className="text-right whitespace-nowrap">
                  {po.status === 'draft' && <button className="btn-ghost py-1 text-xs" onClick={() => setForm(JSON.parse(JSON.stringify(po)))}>Edit</button>}
                  {['draft', 'sent', 'partial'].includes(po.status) && <button className="btn-primary py-1 text-xs" onClick={() => setRecv({ ...po, items: po.items.map((i: any) => ({ ...i, _recv: i.qty - (i.received_qty || 0) })) })}>Receive</button>}
                  {['draft', 'sent'].includes(po.status) && <button className="btn-ghost py-1 text-xs text-rose-600" onClick={async () => { await boApi(`/purchase-orders/${po.id}`, { method: 'PUT', body: { status: 'cancelled' } }); reload(); }}>Cancel</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>

      <Modal open={!!form} onClose={() => setForm(null)} size="xl" title={form?.id ? `Edit ${form.po_no}` : 'New purchase order'}
        footer={<><button className="btn-secondary" onClick={() => setForm(null)}>Cancel</button><button className="btn-secondary" onClick={() => save('draft')}>Save draft</button><button className="btn-primary" onClick={() => save('sent')}>Save & mark sent</button></>}>
        {form && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Supplier"><select className="input" value={form.supplier_id || ''} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}><option value="">—</option>{suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
              <Field label="Expected delivery"><input className="input" type="date" value={form.expected_date?.slice?.(0, 10) || ''} onChange={(e) => setForm({ ...form, expected_date: e.target.value })} /></Field>
              <Field label="Notes"><input className="input" value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
            </div>
            <table className="table">
              <thead><tr><th>Item</th><th className="w-24">Qty</th><th className="w-28">Unit cost</th><th className="w-20">Tax %</th><th className="w-24">Discount</th><th className="text-right">Amount</th><th /></tr></thead>
              <tbody>{form.items.map((it: any, i: number) => (
                <tr key={i}>
                  <td><VariantSelect variants={variants} value={it.variant_id} onChange={(v) => setItem(i, { variant_id: v?.id || '', name: v?.name, cost: v?.cost ?? it.cost })} /></td>
                  <td><input className="input" type="number" step="any" value={it.qty} onChange={(e) => setItem(i, { qty: e.target.value })} aria-label="Qty" /></td>
                  <td><input className="input" type="number" step="any" value={it.cost} onChange={(e) => setItem(i, { cost: e.target.value })} aria-label="Cost" /></td>
                  <td><input className="input" type="number" step="any" value={it.tax_pct} onChange={(e) => setItem(i, { tax_pct: e.target.value })} aria-label="Tax %" /></td>
                  <td><input className="input" type="number" step="any" value={it.discount} onChange={(e) => setItem(i, { discount: e.target.value })} aria-label="Discount" /></td>
                  <td className="text-right tabular-nums">{money(total([it]))}</td>
                  <td><button className="btn-ghost p-1.5 text-rose-600" onClick={() => setForm({ ...form, items: form.items.filter((_: any, j: number) => j !== i) })} aria-label="Remove"><Trash2 size={15} /></button></td>
                </tr>
              ))}</tbody>
            </table>
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <button className="btn-ghost py-1 text-sm" onClick={() => setForm({ ...form, items: [...form.items, { variant_id: '', qty: 1, cost: 0, tax_pct: 0, discount: 0 }] })}><Plus size={14} />Add item</button>
                <button className="btn-ghost py-1 text-sm" onClick={() => setForm({ ...form, items: [...form.items.filter((i: any) => i.variant_id), ...lowStock()] })}>Add low-stock items</button>
              </div>
              <div className="text-lg font-semibold">Total {money(total(form.items))}</div>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!recv} onClose={() => setRecv(null)} title={`Receive ${recv?.po_no}`} size="lg"
        footer={<><button className="btn-secondary" onClick={() => receive(false)}>Receive entered quantities</button><button className="btn-primary" onClick={() => receive(true)}>Receive all remaining</button></>}>
        {recv && (
          <div className="space-y-2">
            <Field label="Supplier invoice #"><input className="input" value={recv.invoice_no || ''} onChange={(e) => setRecv({ ...recv, invoice_no: e.target.value })} /></Field>
            {recv.items.map((it: any, i: number) => (
              <div key={i} className="flex items-center gap-3 text-sm">
                <div className="flex-1">{it.name}<div className="text-xs text-slate-400">Ordered {it.qty} · received {it.received_qty || 0}</div></div>
                <input className="input w-28" type="number" step="any" min={0} value={it._recv} onChange={(e) => setRecv({ ...recv, items: recv.items.map((x: any, j: number) => (i === j ? { ...x, _recv: e.target.value } : x)) })} aria-label="Receive qty" />
              </div>
            ))}
            <p className="text-xs text-slate-500">Stock, item cost and the supplier balance update automatically.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
