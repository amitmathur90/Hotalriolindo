import { useMemo, useState } from 'react';
import { Upload, Clock, Send } from 'lucide-react';
import { parseCSV } from '../../lib/csv';
import { Badge, Empty, Field, Modal, PageHeader, Spinner, Tabs, Toggle, useAsync, useToast } from '../../components/ui';
import { useSession } from '../../backoffice/BackOffice';
import { ExportButtons } from '../../backoffice/widgets';
import { d10, errMsg, num, pr } from '../lib';

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const LEAVES = { '': '—', vacation: 'Vacation', sick: 'Sick', unpaid: 'Unpaid leave', permission: 'Permission', maternity: 'Maternity', other: 'Other' };

export default function Attendance() {
  const { can } = useSession();
  const toast = useToast();
  const periods = useAsync(() => (can('payroll.access') || can('payroll.process') ? pr<any[]>('/periods') : Promise.resolve([])), []);
  const t = new Date().toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: addDays(t, -13), to: t });
  const [dept, setDept] = useState('');
  const [tab, setTab] = useState<'sheet' | 'summary' | 'import'>('sheet');
  const depts = useAsync(() => pr<any[]>('/departments'), []);
  const q = `from=${range.from}&to=${range.to}${dept ? `&department_id=${dept}` : ''}`;
  const att = useAsync(() => pr<any[]>(`/attendance?${q}`), [q]);
  const emps = useAsync(() => pr<any[]>(`/employees?status=active${dept ? `&department_id=${dept}` : ''}`), [dept]);
  const sum = useAsync(() => pr(`/attendance/summary?from=${range.from}&to=${range.to}`), [range.from, range.to, att.data]);
  async function submit() {
    if (!confirm(`Submit attendance ${range.from} – ${range.to}${dept ? ' for this department' : ''} for payroll?`)) return;
    try { const r = await pr('/attendance/submit', { body: { ...range, department_id: dept || undefined } }); toast(`${r.submitted} record(s) submitted`); att.reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function fromClock() {
    try { const r = await pr('/attendance/from-timeclock', { body: range }); toast(`${r.saved} day(s) imported from the POS time clock${r.errors.length ? `, ${r.errors.length} skipped` : ''}`); att.reload(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  return (
    <div>
      <PageHeader title="Attendance & working hours" subtitle="Hours entered here are loaded into payroll periods"
        actions={<>
          {(can('payroll.process') || can('payroll.attendance')) && <button className="btn-secondary" onClick={fromClock} title="Employees linked to a POS user"><Clock size={16} />From POS time clock</button>}
          <button className="btn-primary" onClick={submit}><Send size={16} />Submit for payroll</button>
        </>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {!!periods.data?.length && <select className="input w-auto py-1.5" value="" onChange={(e) => { const p = periods.data!.find((x) => x.id === e.target.value); if (p) setRange({ from: d10(p.start_date), to: d10(p.end_date) }); }} aria-label="Use dates of payroll period">
          <option value="">Dates of payroll…</option>{periods.data.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select>}
        <input type="date" className="input w-auto py-1.5" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-label="From" />
        <input type="date" className="input w-auto py-1.5" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} aria-label="To" />
        <select className="input w-auto py-1.5" value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department"><option value="">All departments</option>{depts.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'sheet', label: 'Timesheet' }, { id: 'summary', label: 'Period summary' }, { id: 'import', label: 'Import (Excel / CSV)' }]} />
      {tab === 'sheet' && (att.loading || emps.loading ? <Spinner /> : <Timesheet range={range} emps={emps.data || []} rows={att.data || []} holidays={sum.data?.holidays || []} reload={att.reload} />)}
      {tab === 'summary' && (sum.data ? <Summary data={sum.data} dept={depts.data?.find((d) => d.id === dept)?.name} /> : <Spinner />)}
      {tab === 'import' && <ImportAttendance onDone={() => { att.reload(); setTab('sheet'); }} />}
    </div>
  );
}

function Timesheet({ range, emps, rows, holidays, reload }: { range: { from: string; to: string }; emps: any[]; rows: any[]; holidays: any[]; reload: () => void }) {
  const toast = useToast();
  const [cell, setCell] = useState<any>(null);
  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = range.from; d <= range.to && out.length < 31; d = addDays(d, 1)) out.push(d);
    return out;
  }, [range.from, range.to]);
  const map = new Map(rows.map((r) => [`${r.employee_id}|${d10(r.work_date)}`, r]));
  const hol = new Map(holidays.map((h: any) => [d10(h.holiday_date), h]));
  async function quick(emp: any, day: string, value: string) {
    const ex = map.get(`${emp.id}|${day}`);
    if ((ex ? String(Number(ex.regular_hours)) : '') === value) return;
    try {
      if (value === '' && ex) await pr(`/attendance/${ex.id}`, { method: 'DELETE' });
      else if (value !== '') await pr('/attendance', { body: { ...(ex || {}), employee_id: emp.id, work_date: day, regular_hours: Number(value), check_in: ex?.check_in, check_out: ex?.check_out } });
      reload();
    } catch (e) { toast(errMsg(e), 'err'); }
  }
  if (!emps.length) return <Empty>No active employees</Empty>;
  return (
    <div className="card overflow-x-auto">
      <table className="table text-xs">
        <thead><tr><th className="sticky left-0 bg-white dark:bg-slate-900">Employee</th>{days.map((d) => {
          const h = hol.get(d);
          const wd = new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'narrow', timeZone: 'UTC' });
          return <th key={d} className={`px-1 text-center ${h ? 'bg-amber-50 dark:bg-amber-900/20' : ''}`} title={h?.name}>{wd}<br />{d.slice(8)}</th>;
        })}<th className="text-right">Hours</th><th className="text-right">OT</th></tr></thead>
        <tbody>{emps.map((e) => {
          let tot = 0, ot = 0;
          return (
            <tr key={e.id}>
              <td className="sticky left-0 bg-white font-medium whitespace-nowrap dark:bg-slate-900">{e.full_name}<div className="text-[10px] font-normal text-slate-400">{e.department_name}</div></td>
              {days.map((d) => {
                const a = map.get(`${e.id}|${d}`);
                if (a) { tot += Number(a.regular_hours); ot += Number(a.overtime_hours); }
                return (
                  <td key={d} className={`px-0.5 ${hol.get(d) ? 'bg-amber-50/60 dark:bg-amber-900/10' : ''}`}>
                    <div className="relative">
                      <input aria-label={`${e.full_name} ${d}`} className={`w-11 rounded border px-1 py-1 text-center tabular-nums outline-none focus:border-brand-500 dark:bg-slate-900 ${a?.leave_type ? 'border-sky-300 bg-sky-50 dark:bg-sky-900/20' : a?.status === 'absent' ? 'border-rose-300 bg-rose-50 dark:bg-rose-900/20' : 'border-slate-200 dark:border-slate-700'}`}
                        defaultValue={a ? (a.leave_type ? a.leave_type.slice(0, 3) : Number(a.regular_hours) || (a.status === 'absent' ? 'A' : '0')) : ''} key={a?.updated_at || `${e.id}${d}`}
                        onBlur={(x) => { const v = x.target.value.trim(); if (/^\d*\.?\d*$/.test(v)) quick(e, d, v); }}
                        onDoubleClick={() => setCell({ ...(a || { regular_hours: '', overtime_hours: 0, holiday_hours: 0, status: 'present' }), employee_id: e.id, work_date: d, full_name: e.full_name })} />
                      {a && Number(a.overtime_hours) > 0 && <span className={`absolute -top-1 -right-0.5 h-2 w-2 rounded-full ${a.overtime_approved ? 'bg-emerald-500' : 'bg-amber-500'}`} title={`${a.overtime_hours} h overtime ${a.overtime_approved ? 'approved' : 'pending approval'}`} />}
                    </div>
                  </td>
                );
              })}
              <td className="text-right font-medium tabular-nums">{num(tot)}</td><td className="text-right tabular-nums">{ot ? num(ot) : ''}</td>
            </tr>
          );
        })}</tbody>
      </table>
      <p className="p-3 text-xs text-slate-500">Type regular hours and leave the cell to save. Double-click a cell for check-in/out, overtime, holiday hours, leave and remarks. Dot = overtime (amber pending, green approved). Shaded columns are holidays.</p>
      {cell && <DayEditor a={cell} onClose={() => setCell(null)} onSaved={() => { setCell(null); reload(); }} />}
    </div>
  );
}

function DayEditor({ a, onClose, onSaved }: { a: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { can } = useSession();
  const [x, setX] = useState<any>({ ...a, check_in: a.check_in?.slice(0, 5) || '', check_out: a.check_out?.slice(0, 5) || '', leave_type: a.leave_type || '' });
  const set = (k: string, v: any) => setX({ ...x, [k]: v });
  async function save() {
    try { await pr('/attendance', { body: { ...x, regular_hours: x.regular_hours === '' ? undefined : x.regular_hours } }); toast('Saved'); onSaved(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  async function del() {
    try { await pr(`/attendance/${a.id}`, { method: 'DELETE' }); onSaved(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  return (
    <Modal open onClose={onClose} title={`${a.full_name} · ${a.work_date}`} footer={<>{a.id && <button className="btn-ghost mr-auto text-rose-600" onClick={del}>Delete</button>}<button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={save}>Save</button></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Check-in"><input type="time" className="input" value={x.check_in} onChange={(e) => set('check_in', e.target.value)} /></Field>
        <Field label="Check-out"><input type="time" className="input" value={x.check_out} onChange={(e) => set('check_out', e.target.value)} /></Field>
        <Field label="Regular hours" hint="Blank = from check-in/out"><input type="number" step="0.25" className="input" value={x.regular_hours} onChange={(e) => set('regular_hours', e.target.value)} /></Field>
        <Field label="Overtime hours"><input type="number" step="0.25" className="input" value={x.overtime_hours} onChange={(e) => set('overtime_hours', e.target.value)} /></Field>
        <Field label="Holiday hours"><input type="number" step="0.25" className="input" value={x.holiday_hours} onChange={(e) => set('holiday_hours', e.target.value)} /></Field>
        <Field label="Status"><select className="input" value={x.status} onChange={(e) => set('status', e.target.value)}><option value="present">Present</option><option value="absent">Absent</option><option value="leave">Leave</option><option value="holiday">Holiday</option><option value="off">Day off</option></select></Field>
        <Field label="Leave type"><select className="input" value={x.leave_type} onChange={(e) => set('leave_type', e.target.value)}>{Object.entries(LEAVES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Manager remarks" className="sm:col-span-2"><input className="input" value={x.remarks || ''} onChange={(e) => set('remarks', e.target.value)} /></Field>
        {Number(x.overtime_hours) > 0 && (can('payroll.process') || can('payroll.approve')) && <div className="sm:col-span-3"><Toggle checked={!!x.overtime_approved} onChange={(v) => set('overtime_approved', v)} label="Overtime approved (paid in payroll)" /></div>}
      </div>
    </Modal>
  );
}

function Summary({ data, dept }: { data: any; dept?: string }) {
  const rows = data.rows.filter((r: any) => !dept || r.department_name === dept);
  const cols = [{ key: 'full_name', label: 'Employee' }, { key: 'department_name', label: 'Department' }, { key: 'working_days', label: 'Working days' }, { key: 'regular_hours', label: 'Regular hours' },
    { key: 'overtime_hours', label: 'Approved OT' }, { key: 'unapproved_overtime', label: 'OT pending' }, { key: 'holiday_hours', label: 'Holiday hours' }, { key: 'vacation_days', label: 'Vacation days' },
    { key: 'unpaid_leave', label: 'Unpaid leave' }, { key: 'sick_days', label: 'Sick' }, { key: 'absences', label: 'Absences' }];
  return (
    <div>
      {data.holidays.length > 0 && <div className="mb-3 flex flex-wrap gap-2 text-xs">{data.holidays.map((h: any) => <Badge key={h.holiday_date} color="amber">{d10(h.holiday_date)} {h.name}{h.paid ? '' : ' (no obligatorio)'}</Badge>)}</div>}
      <div className="mb-2 flex justify-end"><ExportButtons name="attendance-summary" rows={rows} cols={cols} /></div>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr>{cols.map((c) => <th key={c.key} className={c.key === 'full_name' || c.key === 'department_name' ? '' : 'text-right'}>{c.label}</th>)}<th>Submitted</th></tr></thead>
          <tbody>{rows.map((r: any) => (
            <tr key={r.id}>{cols.map((c) => <td key={c.key} className={c.key === 'full_name' || c.key === 'department_name' ? '' : 'text-right tabular-nums'}>{c.key === 'full_name' || c.key === 'department_name' ? r[c.key] : r.records ? num(r[c.key]) : <span className="text-slate-300">—</span>}</td>)}
              <td>{!r.records ? <Badge color="amber">No attendance</Badge> : r.all_submitted ? <Badge color="green">Yes</Badge> : <Badge>No</Badge>}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function ImportAttendance({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<any[]>([]);
  const [res, setRes] = useState<any>(null);
  async function run() {
    try { const r = await pr('/attendance/bulk', { body: { rows, source: 'import' } }); setRes(r); toast(`${r.saved} day(s) saved`); if (!r.errors.length) onDone(); } catch (e) { toast(errMsg(e), 'err'); }
  }
  return (
    <div className="card max-w-3xl p-4">
      <p className="mb-2 text-sm text-slate-500">Upload a CSV (save the Excel sheet as CSV). One row per employee per day. Employees are matched by <b>code</b>, <b>cedula</b> or <b>name</b> (full or short name).</p>
      <p className="mb-3 font-mono text-xs text-slate-500">code, cedula, name, work_date (YYYY-MM-DD), check_in, check_out, regular_hours, overtime_hours, holiday_hours, leave_type, status, remarks</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="btn-secondary cursor-pointer"><Upload size={15} />Choose file<input type="file" accept=".csv" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setRows(parseCSV(await f.text())); setRes(null); } }} /></label>
        {rows.length > 0 && <span className="text-sm">{rows.length} row(s) read</span>}
        <button className="btn-primary" disabled={!rows.length} onClick={run}>Import</button>
      </div>
      {rows.length > 0 && !res && <table className="table mt-3 text-xs"><thead><tr>{Object.keys(rows[0]).map((k) => <th key={k}>{k}</th>)}</tr></thead><tbody>{rows.slice(0, 8).map((r, i) => <tr key={i}>{Object.values(r).map((v: any, j) => <td key={j}>{v}</td>)}</tr>)}</tbody></table>}
      {res?.errors?.length > 0 && <div className="mt-3 rounded-lg bg-rose-50 p-3 text-xs text-rose-800 dark:bg-rose-900/20 dark:text-rose-200">{res.errors.map((e: any) => <div key={e.row}>Row {e.row}: {e.message}</div>)}</div>}
    </div>
  );
}
