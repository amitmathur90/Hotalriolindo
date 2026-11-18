import { useState } from 'react';
import { Plus, Pencil } from 'lucide-react';
import { boApi } from '../../lib/api';
import { dateOnly, dt } from '../../lib/format';
import { Badge, Empty, Field, Modal, PageHeader, Spinner, Tabs, Toggle, useAsync, useToast } from '../../components/ui';
import { useSession } from '../BackOffice';
import { ExportButtons, useRange } from '../widgets';

export default function Employees() {
  const [tab, setTab] = useState<'list' | 'roles' | 'time' | 'logins'>('list');
  return (
    <div>
      <PageHeader title="Employees" subtitle="Staff, access rights and attendance · pay is managed in Payroll" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'list', label: 'Employees' }, { id: 'roles', label: 'Access rights' }, { id: 'time', label: 'Timecards' }, { id: 'logins', label: 'Login history' }]} />
      {tab === 'list' && <EmployeeList />}
      {tab === 'roles' && <Roles />}
      {tab === 'time' && <Timecards />}
      {tab === 'logins' && <Logins />}
    </div>
  );
}

function EmployeeList() {
  const toast = useToast();
  const { stores } = useSession();
  const { data, loading, reload } = useAsync(() => boApi<any[]>('/employees'), []);
  const roles = useAsync(() => boApi<any[]>('/roles'), []);
  const perms = useAsync(() => boApi<Record<string, string>>('/auth/permissions'), []);
  const [e, setE] = useState<any>(null);
  const set = (k: string, v: any) => setE({ ...e, [k]: v });
  async function save() {
    try {
      if (e.id) await boApi(`/employees/${e.id}`, { method: 'PUT', body: e });
      else await boApi('/employees', { body: e });
      toast('Employee saved');
      setE(null);
      reload();
    } catch (err: any) { toast(err.message, 'err'); }
  }
  const role = roles.data?.find((r) => r.id === e?.role_id);
  const permState = (p: string) => (e.denied_permissions?.includes(p) ? 'deny' : e.extra_permissions?.includes(p) ? 'allow' : role?.permissions.includes(p) || role?.permissions.includes('*') ? 'role' : 'none');
  const cyclePerm = (p: string) => {
    const s = permState(p);
    const extra = (e.extra_permissions || []).filter((x: string) => x !== p);
    const denied = (e.denied_permissions || []).filter((x: string) => x !== p);
    if (s === 'role') denied.push(p);
    else if (s === 'none') extra.push(p);
    setE({ ...e, extra_permissions: extra, denied_permissions: denied });
  };
  return (
    <div>
      <div className="mb-3 flex justify-end"><button className="btn-primary" onClick={() => setE({ name: '', role_id: roles.data?.find((r) => r.name === 'Cashier')?.id, store_ids: [], extra_permissions: [], denied_permissions: [], active: true })}><Plus size={16} />Add employee</button></div>
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : (
          <table className="table">
            <thead><tr><th>Employee</th><th>Role</th><th>Stores</th><th>Contact</th><th>Joined</th><th>PIN</th><th>Status</th><th /></tr></thead>
            <tbody>{data?.map((u) => (
              <tr key={u.id}>
                <td><div className="font-medium">{u.name}</div><div className="text-xs text-slate-400">{u.employee_code} {u.designation}</div></td>
                <td>{u.is_owner ? <Badge color="brand">Owner</Badge> : u.role_name}</td>
                <td className="text-xs">{u.store_ids?.length ? u.store_ids.map((id: string) => stores.find((s) => s.id === id)?.name).join(', ') : 'All stores'}</td>
                <td className="text-xs">{u.email}<div>{u.phone}</div></td>
                <td>{dateOnly(u.joined_on)}</td>
                <td>{u.has_pin ? <Badge color="green">Set</Badge> : <Badge color="amber">None</Badge>}</td>
                <td>{u.active ? <Badge color="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                <td><button className="btn-ghost p-1.5" onClick={() => setE({ ...u })} aria-label="Edit"><Pencil size={15} /></button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!e} onClose={() => setE(null)} size="lg" title={e?.id ? `Edit ${e.name}` : 'New employee'} footer={<><button className="btn-secondary" onClick={() => setE(null)}>Cancel</button><button className="btn-primary" onClick={save}>Save</button></>}>
        {e && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Name *"><input className="input" value={e.name} onChange={(x) => set('name', x.target.value)} /></Field>
              <Field label="Employee ID"><input className="input" value={e.employee_code || ''} onChange={(x) => set('employee_code', x.target.value)} /></Field>
              <Field label="Designation"><input className="input" value={e.designation || ''} onChange={(x) => set('designation', x.target.value)} /></Field>
              <Field label="Phone"><input className="input" value={e.phone || ''} onChange={(x) => set('phone', x.target.value)} /></Field>
              <Field label="Email" hint="Needed for Back Office sign-in"><input className="input" type="email" value={e.email || ''} onChange={(x) => set('email', x.target.value)} /></Field>
              <Field label={e.id ? 'New password' : 'Password'} hint="Min 8 characters, optional"><input className="input" type="password" autoComplete="new-password" value={e.password || ''} onChange={(x) => set('password', x.target.value)} /></Field>
              <Field label={e.has_pin ? 'Change POS PIN' : 'POS PIN'} hint="4–6 digits, unique per employee"><input className="input" inputMode="numeric" maxLength={6} value={e.pin || ''} onChange={(x) => set('pin', x.target.value.replace(/\D/g, ''))} /></Field>
              <Field label="Joining date"><input className="input" type="date" value={e.joined_on?.slice?.(0, 10) || ''} onChange={(x) => set('joined_on', x.target.value)} /></Field>
              <Field label="Monthly salary"><input className="input" type="number" value={e.salary ?? ''} onChange={(x) => set('salary', x.target.value)} /></Field>
              <Field label="Hourly rate" hint="Used for payroll if set"><input className="input" type="number" value={e.hourly_rate ?? ''} onChange={(x) => set('hourly_rate', x.target.value)} /></Field>
              {!e.is_owner && <Field label="Role"><select className="input" value={e.role_id || ''} onChange={(x) => set('role_id', x.target.value)}>{roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>}
              <div className="flex items-end pb-2"><Toggle checked={e.active} onChange={(v) => set('active', v)} label="Active" /></div>
            </div>
            <div>
              <div className="label">Assigned stores (none selected = all stores)</div>
              <div className="flex flex-wrap gap-2">{stores.map((s) => (
                <button key={s.id} onClick={() => set('store_ids', e.store_ids.includes(s.id) ? e.store_ids.filter((x: string) => x !== s.id) : [...e.store_ids, s.id])}
                  className={`rounded-full border px-3 py-1 text-sm ${e.store_ids.includes(s.id) ? 'border-brand-600 bg-brand-50 text-brand-700 dark:bg-brand-900/30' : 'border-slate-300 dark:border-slate-700'}`}>{s.name}</button>
              ))}</div>
            </div>
            {!e.is_owner && perms.data && (
              <div>
                <div className="label">Individual permissions — click to override the role (allow / deny)</div>
                <div className="grid gap-1 sm:grid-cols-2">{Object.entries(perms.data).map(([k, label]) => {
                  const s = permState(k);
                  return (
                    <button key={k} onClick={() => cyclePerm(k)} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-1.5 text-left text-sm dark:border-slate-700">
                      <span>{label}</span>
                      {s === 'role' ? <Badge color="green">Role</Badge> : s === 'allow' ? <Badge color="blue">Allowed</Badge> : s === 'deny' ? <Badge color="red">Denied</Badge> : <Badge>Off</Badge>}
                    </button>
                  );
                })}</div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function Roles() {
  const toast = useToast();
  const { data, reload } = useAsync(() => boApi<any[]>('/roles'), []);
  const perms = useAsync(() => boApi<Record<string, string>>('/auth/permissions'), []);
  const [r, setR] = useState<any>(null);
  async function save() {
    try {
      if (r.id) await boApi(`/roles/${r.id}`, { method: 'PUT', body: r });
      else await boApi('/roles', { body: r });
      setR(null);
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  }
  return (
    <div>
      <div className="mb-3 flex justify-end"><button className="btn-primary" onClick={() => setR({ name: '', permissions: [] })}><Plus size={16} />Add role</button></div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data?.map((role) => (
          <button key={role.id} disabled={role.is_system} className="card p-4 text-left enabled:hover:border-brand-400" onClick={() => setR(JSON.parse(JSON.stringify(role)))}>
            <div className="font-semibold">{role.name}</div>
            <div className="mt-1 text-xs text-slate-500">{role.permissions.includes('*') ? 'Full access' : `${role.permissions.length} permissions`}</div>
          </button>
        ))}
      </div>
      <Modal open={!!r} onClose={() => setR(null)} title={r?.id ? `Edit ${r.name}` : 'New role'} size="lg"
        footer={<>{r?.id && <button className="btn-ghost mr-auto text-rose-600" onClick={async () => { await boApi(`/roles/${r.id}`, { method: 'DELETE' }); setR(null); reload(); }}>Delete</button>}<button className="btn-primary" onClick={save}>Save</button></>}>
        {r && perms.data && (
          <div className="space-y-3">
            <Field label="Role name"><input className="input" value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} /></Field>
            <div className="grid gap-2 sm:grid-cols-2">{Object.entries(perms.data).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={r.permissions.includes(k)} onChange={(e) => setR({ ...r, permissions: e.target.checked ? [...r.permissions, k] : r.permissions.filter((x: string) => x !== k) })} />
                {label}
              </label>
            ))}</div>
          </div>
        )}
      </Modal>
    </div>
  );
}

const hoursOf = (t: any) => Number(t.hours);
function Timecards() {
  const toast = useToast();
  const range = useRange('week');
  const { data, reload } = useAsync(() => boApi<any[]>(`/timeclock?${range.query}`), [range.query]);
  const [e, setE] = useState<any>(null);
  const local = (d: any) => (d ? new Date(new Date(d).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  async function save() {
    try {
      await boApi(`/timeclock/${e.id}`, { method: 'PUT', body: { clock_in: e.clock_in ? new Date(e.clock_in).toISOString() : null, clock_out: e.clock_out ? new Date(e.clock_out).toISOString() : null, break_minutes: Number(e.break_minutes), note: e.note } });
      setE(null);
      reload();
    } catch (err: any) { toast(err.message, 'err'); }
  }
  const cols = ['user_name', 'store_name', 'clock_in', 'clock_out', 'break_minutes', 'hours', 'note'].map((k) => ({ key: k, label: k }));
  return (
    <div>
      <div className="mb-3 flex flex-wrap justify-between gap-2">{range.ui}<ExportButtons name="timecards" rows={data || []} cols={cols} /></div>
      <div className="card overflow-x-auto">
        {!data?.length ? <Empty>No clock-ins. Employees clock in from the POS.</Empty> : (
          <table className="table">
            <thead><tr><th>Employee</th><th>Store</th><th>Clock in</th><th>Clock out</th><th className="text-right">Break</th><th className="text-right">Hours</th><th /></tr></thead>
            <tbody>{data.map((t) => (
              <tr key={t.id}>
                <td className="font-medium">{t.user_name}{t.edited_by && <span className="ml-1 text-xs text-amber-600">edited</span>}</td><td>{t.store_name}</td><td>{dt(t.clock_in)}</td>
                <td>{t.clock_out ? dt(t.clock_out) : <Badge color="green">On shift</Badge>}</td><td className="text-right">{t.break_minutes}m</td>
                <td className={`text-right tabular-nums ${hoursOf(t) > 8 ? 'font-medium text-amber-600' : ''}`}>{hoursOf(t).toFixed(2)}</td>
                <td><button className="btn-ghost p-1.5" onClick={() => setE({ ...t, clock_in: local(t.clock_in), clock_out: local(t.clock_out) })} aria-label="Correct"><Pencil size={15} /></button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!e} onClose={() => setE(null)} title="Correct time entry" footer={<button className="btn-primary" onClick={save}>Save correction</button>}>
        {e && <div className="grid gap-3">
          <Field label="Clock in"><input className="input" type="datetime-local" value={e.clock_in} onChange={(x) => setE({ ...e, clock_in: x.target.value })} /></Field>
          <Field label="Clock out"><input className="input" type="datetime-local" value={e.clock_out} onChange={(x) => setE({ ...e, clock_out: x.target.value })} /></Field>
          <Field label="Break minutes"><input className="input" type="number" value={e.break_minutes} onChange={(x) => setE({ ...e, break_minutes: x.target.value })} /></Field>
          <Field label="Reason for correction"><input className="input" value={e.note || ''} onChange={(x) => setE({ ...e, note: x.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}

function Logins() {
  const { data } = useAsync(() => boApi<any[]>('/settings/login-history'), []);
  return (
    <div className="card overflow-x-auto">
      {!data?.length ? <Empty /> : (
        <table className="table">
          <thead><tr><th>Time</th><th>Employee</th><th>Method</th><th>IP</th><th>Result</th></tr></thead>
          <tbody>{data.map((l) => <tr key={l.id}><td>{dt(l.created_at)}</td><td>{l.user_name || '—'}</td><td className="uppercase">{l.method}</td><td className="text-xs">{l.ip}</td><td>{l.success ? <Badge color="green">Success</Badge> : <Badge color="red">Failed</Badge>}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}
