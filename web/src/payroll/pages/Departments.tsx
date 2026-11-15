import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { money } from '../../lib/format';
import { Badge, Empty, Field, Modal, PageHeader, Spinner, Tabs, Toggle, useAsync, useToast } from '../../components/ui';
import { useSession } from '../../backoffice/BackOffice';
import { errMsg, pr } from '../lib';

export default function Departments() {
  const [tab, setTab] = useState<'d' | 'p'>('d');
  return (
    <div>
      <PageHeader title="Departments & positions" subtitle="Department names, payroll expense accounts and managers are configurable" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'd', label: 'Departments' }, { id: 'p', label: 'Job positions' }]} />
      {tab === 'd' ? <DepartmentList /> : <PositionList />}
    </div>
  );
}

function DepartmentList() {
  const { can } = useSession();
  const toast = useToast();
  const { data, loading, reload } = useAsync(() => pr<any[]>('/departments'), []);
  const users = useAsync(() => pr<any[]>('/users'), []);
  const [e, setE] = useState<any>(null);
  const edit = can('payroll.settings');
  async function save() {
    try {
      const body = { ...e, accounts_deduction_pct: e.accounts_deduction_pct === '' ? null : e.accounts_deduction_pct, sort: Number(e.sort) || 0 };
      if (e.id) await pr(`/departments/${e.id}`, { method: 'PUT', body }); else await pr('/departments', { body });
      setE(null); reload(); toast('Saved');
    } catch (err) { toast(errMsg(err), 'err'); }
  }
  async function del(d: any) {
    if (!confirm(`Delete ${d.name}?`)) return;
    try { await pr(`/departments/${d.id}`, { method: 'DELETE' }); reload(); } catch (err) { toast(errMsg(err), 'err'); }
  }
  return (
    <div>
      {edit && <div className="mb-3 flex justify-end"><button className="btn-primary" onClick={() => setE({ name: '', code: '', expense_account: '', active: true, sort: (data?.length || 0) })}><Plus size={16} />Add department</button></div>}
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !data?.length ? <Empty /> : (
          <table className="table">
            <thead><tr><th>Department</th><th>Code</th><th>Expense account</th><th>Manager</th><th className="text-right">Accounts deduction</th><th className="text-right">Active employees</th><th>Status</th><th /></tr></thead>
            <tbody>{data.map((d) => (
              <tr key={d.id}>
                <td className="font-medium">{d.name}</td><td>{d.code}</td><td className="font-mono text-xs">{d.expense_account}</td><td>{d.manager_name || '—'}</td>
                <td className="text-right">{d.accounts_deduction_pct !== null ? `${d.accounts_deduction_pct}%` : <span className="text-slate-400">rule default</span>}</td>
                <td className="text-right">{d.active_employees}</td><td>{d.active ? <Badge color="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                <td className="text-right whitespace-nowrap">{edit && <><button className="btn-ghost p-1.5" onClick={() => setE({ ...d, accounts_deduction_pct: d.accounts_deduction_pct ?? '' })} aria-label="Edit"><Pencil size={15} /></button><button className="btn-ghost p-1.5 text-rose-600" onClick={() => del(d)} aria-label="Delete"><Trash2 size={15} /></button></>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!e} onClose={() => setE(null)} title={e?.id ? `Edit ${e.name}` : 'New department'} footer={<><button className="btn-secondary" onClick={() => setE(null)}>Cancel</button><button className="btn-primary" onClick={save}>Save</button></>}>
        {e && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name *"><input className="input" value={e.name} onChange={(x) => setE({ ...e, name: x.target.value })} /></Field>
          <Field label="Code" hint="BAR and KIT drive the bar/kitchen labour %"><input className="input" value={e.code || ''} onChange={(x) => setE({ ...e, code: x.target.value.toUpperCase() })} /></Field>
          <Field label="Payroll expense account" className="sm:col-span-2"><input className="input" value={e.expense_account || ''} onChange={(x) => setE({ ...e, expense_account: x.target.value })} placeholder="6010-BAR STAFF SALARY" /></Field>
          <Field label="Department manager" hint="Can enter & submit attendance for this department"><select className="input" value={e.manager_user_id || ''} onChange={(x) => setE({ ...e, manager_user_id: x.target.value || null })}><option value="">—</option>{users.data?.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role_name || 'no role'})</option>)}</select></Field>
          <Field label="Accounts deduction %" hint="Blank = payroll rule default"><input className="input" type="number" value={e.accounts_deduction_pct} onChange={(x) => setE({ ...e, accounts_deduction_pct: x.target.value })} /></Field>
          <Field label="Sort order"><input className="input" type="number" value={e.sort ?? 0} onChange={(x) => setE({ ...e, sort: x.target.value })} /></Field>
          <div className="flex items-end pb-2"><Toggle checked={e.active !== false} onChange={(v) => setE({ ...e, active: v })} label="Active" /></div>
        </div>}
      </Modal>
    </div>
  );
}

function PositionList() {
  const { can } = useSession();
  const toast = useToast();
  const { data, loading, reload } = useAsync(() => pr<any[]>('/positions'), []);
  const depts = useAsync(() => pr<any[]>('/departments'), []);
  const [e, setE] = useState<any>(null);
  const edit = can('payroll.settings');
  async function save() {
    try {
      const body = { ...e, minimum_salary: e.minimum_salary === '' ? null : e.minimum_salary };
      if (e.id) await pr(`/positions/${e.id}`, { method: 'PUT', body }); else await pr('/positions', { body });
      setE(null); reload(); toast('Saved');
    } catch (err) { toast(errMsg(err), 'err'); }
  }
  async function del(p: any) {
    if (!confirm(`Delete ${p.name}?`)) return;
    try { await pr(`/positions/${p.id}`, { method: 'DELETE' }); reload(); } catch (err) { toast(errMsg(err), 'err'); }
  }
  return (
    <div>
      {edit && <div className="mb-3 flex justify-end"><button className="btn-primary" onClick={() => setE({ name: '', department_id: '', minimum_salary: '', active: true })}><Plus size={16} />Add position</button></div>}
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !data?.length ? <Empty /> : (
          <table className="table">
            <thead><tr><th>Position</th><th>Department</th><th className="text-right">Minimum salary (reference)</th><th className="text-right">Employees</th><th /></tr></thead>
            <tbody>{data.map((p) => (
              <tr key={p.id}><td className="font-medium">{p.name}</td><td>{p.department_name || '—'}</td><td className="text-right">{p.minimum_salary ? money(p.minimum_salary) : '—'}</td><td className="text-right">{p.employees}</td>
                <td className="text-right whitespace-nowrap">{edit && <><button className="btn-ghost p-1.5" onClick={() => setE({ ...p, minimum_salary: p.minimum_salary ?? '' })} aria-label="Edit"><Pencil size={15} /></button><button className="btn-ghost p-1.5 text-rose-600" onClick={() => del(p)} aria-label="Delete"><Trash2 size={15} /></button></>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!e} onClose={() => setE(null)} title={e?.id ? `Edit ${e.name}` : 'New position'} footer={<><button className="btn-secondary" onClick={() => setE(null)}>Cancel</button><button className="btn-primary" onClick={save}>Save</button></>}>
        {e && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name *"><input className="input" value={e.name} onChange={(x) => setE({ ...e, name: x.target.value })} /></Field>
          <Field label="Department"><select className="input" value={e.department_id || ''} onChange={(x) => setE({ ...e, department_id: x.target.value || null })}><option value="">Any</option>{depts.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <Field label="Minimum monthly salary" hint="Legal minimum reference for the position"><input className="input" type="number" value={e.minimum_salary} onChange={(x) => setE({ ...e, minimum_salary: x.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}
