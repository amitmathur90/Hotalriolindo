import { useState } from 'react';
import { Plus } from 'lucide-react';
import { boApi } from '../../lib/api';
import { dateOnly, dt, money } from '../../lib/format';
import { Badge, Empty, Field, Modal, PageHeader, SearchInput, Spinner, Tabs, useAsync, useToast } from '../../components/ui';
import { ExportButtons } from '../widgets';

const SEGMENTS = [{ id: '', label: 'All' }, { id: 'new', label: 'New (30d)' }, { id: 'regular', label: 'Regular' }, { id: 'vip', label: 'VIP' }, { id: 'inactive', label: 'Inactive (60d)' }, { id: 'birthday', label: 'Birthdays this month' }];
const FIELDS = [['name', 'Name *'], ['phone', 'Phone'], ['email', 'Email'], ['tax_id', 'Cédula / Tax ID'], ['birthday', 'Birthday'], ['code', 'Loyalty card / code'], ['customer_group', 'Group'], ['tags', 'Tags'], ['address', 'Address'], ['notes', 'Notes']];

export default function Customers() {
  const [tab, setTab] = useState<'customers' | 'gift'>('customers');
  return (
    <div>
      <PageHeader title="Customers" subtitle="Customer database, loyalty and gift cards" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'customers', label: 'Customers' }, { id: 'gift', label: 'Gift cards' }]} />
      {tab === 'customers' ? <CustomerList /> : <GiftCards />}
    </div>
  );
}

function CustomerList() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [seg, setSeg] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const [view, setView] = useState<any>(null);
  const { data, loading, reload } = useAsync(() => boApi<any[]>(`/customers?q=${encodeURIComponent(q)}&segment=${seg}`), [q, seg]);
  async function save() {
    try {
      if (edit.id) await boApi(`/customers/${edit.id}`, { method: 'PUT', body: edit });
      else await boApi('/customers', { body: edit });
      setEdit(null);
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  }
  async function adjust() {
    const pts = prompt('Points to add (use negative to deduct)');
    if (!pts) return;
    const note = prompt('Reason') || 'Manual adjustment';
    try { await boApi(`/customers/${view.id}/points`, { body: { points: Number(pts), note } }); setView(await boApi(`/customers/${view.id}`)); reload(); } catch (e: any) { toast(e.message, 'err'); }
  }
  const cols = ['name', 'phone', 'email', 'code', 'points', 'total_spent', 'visits', 'last_visit_at', 'birthday', 'customer_group'].map((k) => ({ key: k, label: k }));
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Name, phone, email, card" className="w-64" />
        <select className="input w-auto" value={seg} onChange={(e) => setSeg(e.target.value)} aria-label="Segment">{SEGMENTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
        <div className="ml-auto flex gap-2"><ExportButtons name="customers" rows={data || []} cols={cols} /><button className="btn-primary" onClick={() => setEdit({ name: '' })}><Plus size={16} />Add customer</button></div>
      </div>
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !data?.length ? <Empty /> : (
          <table className="table">
            <thead><tr><th>Name</th><th>Phone</th><th className="text-right">Points</th><th className="text-right">Visits</th><th className="text-right">Total spent</th><th>Last visit</th></tr></thead>
            <tbody>{data.map((c) => (
              <tr key={c.id} className="cursor-pointer" onClick={async () => setView(await boApi(`/customers/${c.id}`))}>
                <td className="font-medium">{c.name}{Number(c.total_spent) >= 10000 && <span className="ml-2"><Badge color="amber">VIP</Badge></span>}</td>
                <td>{c.phone}</td><td className="text-right tabular-nums">{c.points}</td><td className="text-right tabular-nums">{c.visits}</td>
                <td className="text-right tabular-nums">{money(c.total_spent)}</td><td>{dateOnly(c.last_visit_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit customer' : 'New customer'} footer={<><button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button><button className="btn-primary" onClick={save}>Save</button></>}>
        {edit && <div className="grid gap-3 sm:grid-cols-2">{FIELDS.map(([k, l]) => (
          <Field key={k} label={l} className={k === 'notes' || k === 'address' ? 'sm:col-span-2' : ''}>
            <input className="input" type={k === 'birthday' ? 'date' : 'text'} value={k === 'birthday' ? edit[k]?.slice?.(0, 10) || '' : edit[k] || ''} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
          </Field>
        ))}</div>}
      </Modal>
      <Modal open={!!view} onClose={() => setView(null)} title={view?.name} size="lg"
        footer={<><button className="btn-ghost mr-auto text-rose-600" onClick={async () => { if (confirm('Delete customer?')) { await boApi(`/customers/${view.id}`, { method: 'DELETE' }); setView(null); reload(); } }}>Delete</button><button className="btn-secondary" onClick={adjust}>Adjust points</button><button className="btn-primary" onClick={() => { setEdit(view); setView(null); }}>Edit</button></>}>
        {view && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="card p-3"><div className="text-xs text-slate-500">Points</div><div className="text-lg font-semibold">{view.points}</div></div>
              <div className="card p-3"><div className="text-xs text-slate-500">Total spent</div><div className="text-lg font-semibold">{money(view.total_spent)}</div></div>
              <div className="card p-3"><div className="text-xs text-slate-500">Visits</div><div className="text-lg font-semibold">{view.visits}</div></div>
              <div className="card p-3"><div className="text-xs text-slate-500">Store credit</div><div className="text-lg font-semibold">{money(view.store_credit)}</div></div>
            </div>
            <div className="text-sm text-slate-500">{[view.phone, view.email, view.code && `Card ${view.code}`, view.birthday && `Birthday ${dateOnly(view.birthday)}`].filter(Boolean).join(' · ')}</div>
            <div className="grid gap-4 md:grid-cols-2">
              <div><div className="mb-1 text-sm font-semibold">Purchase history</div>
                {!view.sales.length ? <Empty>No purchases</Empty> : view.sales.map((s: any) => <div key={s.id} className="flex justify-between border-b border-slate-100 py-1.5 text-sm dark:border-slate-800"><span>#{s.receipt_no} · {dt(s.created_at)}</span><span className={s.type === 'refund' ? 'text-rose-600' : ''}>{s.type === 'refund' ? '-' : ''}{money(s.total)}</span></div>)}</div>
              <div><div className="mb-1 text-sm font-semibold">Loyalty history</div>
                {!view.loyalty.length ? <Empty>No points activity</Empty> : view.loyalty.map((l: any) => <div key={l.id} className="flex justify-between border-b border-slate-100 py-1.5 text-sm dark:border-slate-800"><span className="capitalize">{l.type} · {dt(l.created_at)}{l.note ? ` · ${l.note}` : ''}</span><span className={l.points < 0 ? 'text-rose-600' : 'text-emerald-600'}>{l.points > 0 ? '+' : ''}{l.points}</span></div>)}</div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function GiftCards() {
  const toast = useToast();
  const { data, reload } = useAsync(() => boApi<any[]>('/gift-cards'), []);
  const [form, setForm] = useState<any>(null);
  const [tx, setTx] = useState<any>(null);
  async function issue() {
    try { const g = await boApi('/gift-cards', { body: { ...form, value: Number(form.value) } }); toast(`Gift card ${g.code} issued`); setForm(null); reload(); } catch (e: any) { toast(e.message, 'err'); }
  }
  return (
    <div>
      <div className="mb-3 flex justify-end"><button className="btn-primary" onClick={() => setForm({ value: 500, code: '', expires_on: '' })}><Plus size={16} />Issue gift card</button></div>
      <div className="card overflow-x-auto">
        {!data?.length ? <Empty /> : (
          <table className="table">
            <thead><tr><th>Code</th><th>Customer</th><th className="text-right">Initial</th><th className="text-right">Balance</th><th>Expires</th><th>Status</th><th /></tr></thead>
            <tbody>{data.map((g) => (
              <tr key={g.id}>
                <td className="font-mono font-medium">{g.code}</td><td>{g.customer_name || '—'}</td>
                <td className="text-right tabular-nums">{money(g.initial_value)}</td><td className="text-right font-medium tabular-nums">{money(g.balance)}</td>
                <td>{g.expires_on ? dateOnly(g.expires_on) : 'Never'}</td>
                <td>{g.expires_on && new Date(g.expires_on) < new Date() ? <Badge color="red">Expired</Badge> : Number(g.balance) > 0 ? <Badge color="green">Active</Badge> : <Badge>Used</Badge>}</td>
                <td className="text-right whitespace-nowrap">
                  <button className="btn-ghost py-1 text-xs" onClick={async () => setTx({ g, rows: await boApi(`/gift-cards/${g.id}/transactions`) })}>History</button>
                  <button className="btn-secondary py-1 text-xs" onClick={async () => { const a = prompt('Add balance'); if (a) { await boApi(`/gift-cards/${g.id}/topup`, { body: { amount: Number(a) } }); reload(); } }}>Top up</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <Modal open={!!form} onClose={() => setForm(null)} title="Issue gift card" footer={<button className="btn-primary" onClick={issue}>Issue</button>}>
        {form && <div className="grid gap-3">
          <Field label="Value"><input className="input" type="number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></Field>
          <Field label="Card number" hint="Leave empty to generate a unique code"><input className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
          <Field label="Expiry date"><input className="input" type="date" value={form.expires_on} onChange={(e) => setForm({ ...form, expires_on: e.target.value })} /></Field>
        </div>}
      </Modal>
      <Modal open={!!tx} onClose={() => setTx(null)} title={`Gift card ${tx?.g.code}`}>
        {tx?.rows.map((r: any) => <div key={r.id} className="flex justify-between border-b border-slate-100 py-1.5 text-sm dark:border-slate-800"><span className="capitalize">{r.type} · {dt(r.created_at)}</span><span>{money(r.amount)}</span></div>)}
      </Modal>
    </div>
  );
}
