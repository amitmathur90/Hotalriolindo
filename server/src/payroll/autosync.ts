/**
 * Automatic POS ↔ Payroll link.
 *  - Staff: every active POS employee (except the generic owner login) is in payroll — linked to an existing payroll
 *    employee when one matches (e-mail, code or name), otherwise created from the POS record. Deactivating someone in the
 *    POS deactivates them in payroll; missing e-mail / phone are filled from the POS. Salary, bank and HR details are
 *    owned by payroll and never overwritten.
 *  - Attendance: POS time-clock days are copied into payroll attendance (manual entries and closed periods untouched).
 *  - Revenue: monthly POS sales feed the payroll-vs-revenue figures (manually entered months are kept).
 * Runs at start-up, every 10 minutes, shortly after POS staff are saved or clock out, and before payroll pages load.
 */
import { db, tx } from '../db.ts';
import { ensurePayrollSetup } from './setup.ts';
import { createFromPosUser } from './pos.ts';
import { importTimeclock } from './attendance.ts';
import { revenueFromPos } from './reports.ts';

const norm = (s: any) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Default department from the POS role / position (payroll users can change it later). */
function guessDepartment(depts: any[], ...texts: (string | null | undefined)[]): string | null {
  const t = texts.filter(Boolean).join(' ').toLowerCase();
  const code = /kitchen|cocin|chef|cook|pizz/.test(t) ? 'KIT'
    : /bar|barist|cajer|cashier|salon|meser|waiter|server/.test(t) ? 'BAR'
    : /housekeep|mucam|limpi|clean/.test(t) ? 'HKP'
    : /mainten|manten/.test(t) ? 'MNT'
    : /secur|segur|guard/.test(t) ? 'SEC'
    : 'OPS';
  return depts.find((d) => d.code === code)?.id ?? null;
}

export async function syncPosStaff(businessId: string) {
  await tx((q) => ensurePayrollSetup(q, businessId));
  const users = await db.query(
    `SELECT u.id, u.name, u.email, u.phone, u.employee_code, u.designation, u.active, u.is_owner, r.name AS role_name
       FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.business_id=$1 AND NOT u.is_super_admin ORDER BY u.created_at`, [businessId]);
  const emps = await db.query(`SELECT id, code, full_name, short_name, email, phone, status, user_id FROM pr_employees WHERE business_id=$1`, [businessId]);
  const depts = await db.query(`SELECT id, code FROM pr_departments WHERE business_id=$1`, [businessId]);
  const out = { created: [] as string[], linked: [] as string[], updated: 0, errors: [] as string[] };

  for (const u of users) {
    let e = emps.find((x) => x.user_id === u.id);
    if (!e) {
      if (u.is_owner || !u.active) continue; // the shared owner login and inactive POS users are not employees to pay
      const free = emps.filter((x) => !x.user_id);
      const m =
        (u.email && free.find((x) => x.email && norm(x.email) === norm(u.email))) ||
        (u.employee_code && free.find((x) => norm(x.code) === norm(u.employee_code))) ||
        free.find((x) => norm(x.full_name) === norm(u.name) || (x.short_name && norm(x.short_name) === norm(u.name)));
      if (m) {
        await db.query(`UPDATE pr_employees SET user_id=$2, updated_at=now() WHERE id=$1 AND user_id IS NULL`, [m.id, u.id]);
        m.user_id = u.id;
        out.linked.push(u.name);
        e = m;
      } else {
        try {
          const row = await tx((q) => createFromPosUser(q, businessId, { user_id: u.id, department_id: guessDepartment(depts, u.role_name, u.designation), payment_method: 'transfer' },
            { id: null, name: 'POS sync' }, true));
          emps.push(row);
          out.created.push(u.name);
        } catch (err: any) {
          out.errors.push(`${u.name}: ${err.message}`);
        }
        continue;
      }
    }
    // Keep a linked employee in step with the POS record
    const patch: Record<string, any> = {};
    if (!u.active && e!.status === 'active') patch.status = 'inactive';
    if (!e!.email && u.email) patch.email = u.email;
    if (!e!.phone && u.phone) patch.phone = u.phone;
    const keys = Object.keys(patch);
    if (keys.length) {
      await db.query(`UPDATE pr_employees SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [e!.id, ...keys.map((k) => patch[k])]);
      Object.assign(e!, patch);
      out.updated++;
    }
  }
  return out;
}

/** A system "request" for the shared attendance helper: no user, no approval rights (overtime still needs approval). */
const systemReq = (businessId: string) => ({ auth: { businessId, userId: null, userName: 'POS time clock', permissions: new Set<string>() } }) as any;

async function localToday(businessId: string) {
  const tz = (await db.one(`SELECT timezone FROM businesses WHERE id=$1`, [businessId]))?.timezone || 'America/Costa_Rica';
  return new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
}

export async function syncPayroll(businessId: string) {
  const staff = await syncPosStaff(businessId);
  const today = await localToday(businessId);
  const [y, m] = today.split('-').map(Number);
  const prevMonthStart = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10); // attendance: last month + this month
  const attendance = await importTimeclock(systemReq(businessId), prevMonthStart, today);
  await revenueFromPos(businessId, y);
  if (m === 1) await revenueFromPos(businessId, y - 1);
  return { staff, attendance };
}

// ---------------------------------------------------------------- scheduling
const running = new Map<string, Promise<any>>();
const lastRun = new Map<string, number>();
const timers = new Map<string, NodeJS.Timeout>();

function run(businessId: string) {
  const cur = running.get(businessId);
  if (cur) return cur;
  const p = syncPayroll(businessId)
    .then((r) => {
      lastRun.set(businessId, Date.now());
      const s = r.staff;
      if (s.created.length || s.linked.length || r.attendance.saved)
        console.log(`[payroll] POS sync: +${s.created.length} employees, ${s.linked.length} linked, ${r.attendance.saved} attendance days`);
      if (s.errors.length) console.warn('[payroll] POS sync issues:', s.errors.join('; '));
      return r;
    })
    .catch((e) => console.error('[payroll] POS sync failed', e))
    .finally(() => running.delete(businessId));
  running.set(businessId, p);
  return p;
}

/** Called by payroll pages: makes sure data is at most `maxAgeMs` old before answering. */
export async function ensureFresh(businessId: string, maxAgeMs = 60_000) {
  if (Date.now() - (lastRun.get(businessId) || 0) > maxAgeMs) await run(businessId);
}

/** Called after POS staff are saved or clock in/out: sync a few seconds later (debounced). */
export function kickPayrollSync(businessId: string) {
  clearTimeout(timers.get(businessId));
  timers.set(businessId, setTimeout(() => { timers.delete(businessId); run(businessId); }, 3000));
}

export function startPayrollAutoSync() {
  const all = async () => {
    for (const b of await db.query(`SELECT id FROM businesses WHERE status='active'`)) await run(b.id);
  };
  setTimeout(() => all().catch(console.error), 5000);
  setInterval(() => all().catch(console.error), 10 * 60 * 1000);
}
