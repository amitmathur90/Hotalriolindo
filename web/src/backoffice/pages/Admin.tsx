import { boApi } from '../../lib/api';
import { dateOnly, money } from '../../lib/format';
import { Badge, Empty, PageHeader, useAsync, useToast } from '../../components/ui';
import { useSession } from '../BackOffice';

export default function Admin() {
  const { user } = useSession();
  const toast = useToast();
  const { data, reload } = useAsync(() => (user.is_super_admin ? boApi<any[]>('/admin/businesses') : Promise.resolve([])), []);
  if (!user.is_super_admin) return <Empty>Platform administration is only available to super admins.</Empty>;
  const update = async (id: string, body: any) => { try { await boApi(`/admin/businesses/${id}`, { method: 'PUT', body }); toast('Updated'); reload(); } catch (e: any) { toast(e.message, 'err'); } };
  return (
    <div>
      <PageHeader title="Platform admin" subtitle="All businesses and subscriptions" />
      <div className="card overflow-x-auto">
        {!data?.length ? <Empty /> : (
          <table className="table">
            <thead><tr><th>Business</th><th>Created</th><th className="text-right">Stores</th><th className="text-right">Users</th><th className="text-right">Sales (30d)</th><th>Plan</th><th>Max stores</th><th>Status</th><th /></tr></thead>
            <tbody>{data.map((b) => (
              <tr key={b.id}>
                <td className="font-medium">{b.name}<div className="text-xs text-slate-400">{b.email}</div></td><td>{dateOnly(b.created_at)}</td>
                <td className="text-right">{b.stores}</td><td className="text-right">{b.users}</td><td className="text-right tabular-nums">{money(b.sales_30d)}</td>
                <td><select className="input w-auto py-1" value={b.plan} onChange={(e) => update(b.id, { plan: e.target.value })}>{['free', 'standard', 'pro', 'enterprise'].map((p) => <option key={p}>{p}</option>)}</select></td>
                <td><input className="input w-20 py-1" type="number" defaultValue={b.max_stores} onBlur={(e) => Number(e.target.value) !== b.max_stores && update(b.id, { max_stores: Number(e.target.value) })} aria-label="Max stores" /></td>
                <td>{b.status === 'active' ? <Badge color="green">Active</Badge> : <Badge color="red">Suspended</Badge>}</td>
                <td><button className={b.status === 'active' ? 'btn-danger py-1 text-xs' : 'btn-primary py-1 text-xs'} onClick={() => update(b.id, { status: b.status === 'active' ? 'suspended' : 'active' })}>{b.status === 'active' ? 'Suspend' : 'Activate'}</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
