import { useState } from 'react';
import { boApi } from '../../lib/api';
import { dt } from '../../lib/format';
import { Empty, PageHeader, SearchInput, useAsync } from '../../components/ui';
import { ExportButtons } from '../widgets';

export default function Audit() {
  const { data } = useAsync(() => boApi<any[]>('/settings/audit'), []);
  const [q, setQ] = useState('');
  const rows = (data || []).filter((r) => !q || `${r.action} ${r.entity} ${r.user_name} ${JSON.stringify(r.details)}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <PageHeader title="Audit log" subtitle="Every sensitive action with who, when and what" actions={<ExportButtons name="audit" rows={rows.map((r) => ({ ...r, details: JSON.stringify(r.details) }))} cols={['created_at', 'user_name', 'action', 'entity', 'entity_id', 'details', 'ip'].map((k) => ({ key: k, label: k }))} />} />
      <SearchInput value={q} onChange={setQ} className="mb-3 max-w-md" placeholder="Filter by action, user, details" />
      <div className="card overflow-x-auto">
        {!rows.length ? <Empty /> : (
          <table className="table">
            <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">{dt(r.created_at)}</td><td>{r.user_name || 'System'}</td>
                <td className="font-medium">{r.action.replace(/_/g, ' ')}</td><td className="text-xs">{r.entity}</td>
                <td className="max-w-md truncate font-mono text-xs text-slate-500" title={JSON.stringify(r.details)}>{r.details ? JSON.stringify(r.details) : ''}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
