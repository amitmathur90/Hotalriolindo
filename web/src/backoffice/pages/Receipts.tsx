import { useState } from 'react';
import { boApi } from '../../lib/api';
import { dt, money } from '../../lib/format';
import { Badge, Empty, PageHeader, SearchInput, Spinner, useAsync, useToast } from '../../components/ui';
import { SaleDetail } from '../../components/SaleDetail';
import { useSession } from '../BackOffice';
import { ExportButtons, useRange } from '../widgets';

export default function Receipts() {
  const { storeId, business, can } = useSession();
  const toast = useToast();
  const range = useRange('today');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<any>(null);
  const { data, loading, reload } = useAsync(() => boApi<any[]>(`/sales?${range.query}${q ? `&q=${encodeURIComponent(q)}` : ''}`), [range.query, q, storeId]);
  const show = async (id: string) => {
    try { setOpen(await boApi(`/sales/${id}`)); } catch (e: any) { toast(e.message, 'err'); }
  };
  const cols = [{ key: 'receipt_no', label: 'Receipt' }, { key: 'created_at', label: 'Date' }, { key: 'type', label: 'Type' }, { key: 'employee_name', label: 'Employee' }, { key: 'customer_name', label: 'Customer' }, { key: 'methods', label: 'Payment' }, { key: 'total', label: 'Total' }];

  return (
    <div>
      <PageHeader title="Receipts" subtitle="Complete transaction history" actions={<>{range.ui}<ExportButtons name="receipts" rows={data || []} cols={cols} /></>} />
      <SearchInput value={q} onChange={setQ} placeholder="Search receipt #, customer name or phone" className="mb-3 max-w-md" />
      <div className="card overflow-x-auto">
        {loading ? <div className="flex justify-center py-10"><Spinner /></div> : !data?.length ? <Empty>No receipts in this period</Empty> : (
          <table className="table">
            <thead><tr><th>Receipt</th><th>Date</th><th>Employee</th><th>Customer</th><th>Payment</th><th>Status</th><th className="text-right">Total</th></tr></thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id} className="cursor-pointer" onClick={() => show(s.id)}>
                  <td className="font-medium">#{s.receipt_no}{s.offline && <span className="ml-1 text-xs text-amber-600">offline</span>}</td>
                  <td>{dt(s.created_at)}</td>
                  <td>{s.employee_name}</td>
                  <td>{s.customer_name || '—'}</td>
                  <td>{s.methods}</td>
                  <td>{s.type === 'refund' ? <Badge color="red">Refund</Badge> : s.status === 'completed' ? <Badge color="green">Paid</Badge> : <Badge color="amber">{s.status.replace('_', ' ')}</Badge>}</td>
                  <td className={`text-right font-medium tabular-nums ${s.type === 'refund' ? 'text-rose-600' : ''}`}>{s.type === 'refund' ? '-' : ''}{money(s.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && <SaleDetail sale={open} business={business} api={boApi} canRefund={can('pos.refund')} onChanged={(s) => { setOpen(s); reload(); }} onClose={() => setOpen(null)} />}
    </div>
  );
}
