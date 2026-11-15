import { FileText } from 'lucide-react';
import { money, dateOnly } from '../../lib/format';
import { Empty, PageHeader, Spinner, useAsync, useToast } from '../../components/ui';
import { PayBadge, d10, errMsg, num, openPdf, pr } from '../lib';

/** Employee self-service: own payslips, salary history and personal details. */
export default function MyPayslips() {
  const toast = useToast();
  const { data, loading, error } = useAsync(() => pr('/me'), []);
  if (loading) return <Spinner />;
  if (error || !data) return <Empty>{error || 'Not available'}</Empty>;
  const e = data.employee;
  return (
    <div>
      <PageHeader title="My payslips" subtitle={`${e.full_name} · ${e.code} · ${e.department || ''}`} />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="card overflow-x-auto lg:col-span-2">
          {!data.records.length ? <Empty>No approved payslips yet</Empty> : (
            <table className="table text-sm">
              <thead><tr><th>Period</th><th className="text-right">Hours</th><th className="text-right">Gross</th><th className="text-right">Deductions</th><th className="text-right">Net</th><th>Payment</th><th /></tr></thead>
              <tbody>{data.records.map((r: any) => (
                <tr key={r.id}><td>{r.period_name}<div className="text-xs text-slate-400">{r.code}</div></td><td className="text-right">{num(r.hours)}</td><td className="text-right tabular-nums">{money(r.gross)}</td><td className="text-right tabular-nums">{money(r.total_deductions)}</td>
                  <td className="text-right font-medium tabular-nums">{money(r.net_payable)}</td><td><PayBadge status={r.payment_status} /></td>
                  <td><button className="btn-ghost p-1.5" onClick={() => openPdf(`/me/payslips/${r.id}.pdf`).catch((x) => toast(errMsg(x), 'err'))} aria-label="Payslip PDF"><FileText size={15} /></button></td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
        <div className="space-y-4">
          <div className="card space-y-1 p-4 text-sm">
            <div className="mb-1 font-semibold">My details</div>
            <div>Cédula: {e.cedula || '—'}</div><div>Email: {e.email || '—'}</div><div>Phone: {e.phone || '—'}</div><div>Joined: {dateOnly(e.joining_date)}</div><div>Bank account: {e.bank_account || '—'}</div>
            <p className="pt-2 text-xs text-slate-400">To change your details, contact HR.</p>
          </div>
          <div className="card p-4 text-sm">
            <div className="mb-2 font-semibold">Salary history</div>
            {data.salaries.map((s: any) => <div key={s.effective_from} className="flex justify-between border-b border-slate-100 py-1 dark:border-slate-800"><span>{d10(s.effective_from)}</span><span className="tabular-nums">{s.salary_type === 'hourly' ? `${money(s.hourly_rate)}/h` : `${money(s.monthly_salary)}/month`}</span></div>)}
          </div>
        </div>
      </div>
    </div>
  );
}
