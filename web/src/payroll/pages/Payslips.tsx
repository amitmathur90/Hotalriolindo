import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Mail, RotateCw } from 'lucide-react';
import { money, dt } from '../../lib/format';
import { Empty, PageHeader, Spinner, Tabs, useAsync, useToast } from '../../components/ui';
import { useSession } from '../../backoffice/BackOffice';
import { PeriodBadge, ReqBadge, errMsg, openPdf, pr } from '../lib';

export default function Payslips() {
  const [tab, setTab] = useState<'center' | 'log'>('center');
  return (
    <div>
      <PageHeader title="Payslips & email" subtitle="Generate PDF payslips per payroll, print or download them, and email them to employees" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'center', label: 'Payslip center' }, { id: 'log', label: 'Email delivery' }]} />
      {tab === 'center' ? <Center /> : <EmailLog />}
    </div>
  );
}

function Center() {
  const toast = useToast();
  const { can } = useSession();
  const { data, loading } = useAsync(() => pr<any[]>('/periods'), []);
  const settings = useAsync(() => pr('/settings'), []);
  const pdf = (p: string) => openPdf(p).catch((e) => toast(errMsg(e), 'err'));
  async function email(id: string) {
    try { const r = await pr(`/periods/${id}/email`, { body: { only_unsent: true } }); toast(`${r.queued} email(s) queued${r.skipped.length ? ` · no email address: ${r.skipped.join(', ')}` : ''}`); } catch (e) { toast(errMsg(e), 'err'); }
  }
  return (
    <div>
      {settings.data && !settings.data.smtp_configured && <div className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">Email is not configured on the server. Set SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM in <code>server/.env</code> to email payslips. PDF download and printing work without it.</div>}
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !data?.length ? <Empty>No payroll yet</Empty> : (
          <table className="table text-sm">
            <thead><tr><th>Payroll</th><th>Status</th><th className="text-right">Employees</th><th className="text-right">Net payable</th><th /></tr></thead>
            <tbody>{data.map((p) => (
              <tr key={p.id}><td><Link className="font-medium hover:underline" to={`/backoffice/payroll/periods/${p.id}`}>{p.code}</Link> <span className="text-slate-500">{p.name}</span></td><td><PeriodBadge status={p.status} /></td>
                <td className="text-right">{p.employees}</td><td className="text-right tabular-nums">{money(p.net_payable)}</td>
                <td className="text-right whitespace-nowrap">
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => pdf(`/periods/${p.id}/payslips.pdf`)}><FileText size={14} />All payslips</button>
                  {['approved', 'partially_paid', 'paid', 'closed'].includes(p.status) && (can('payroll.process') || can('payroll.payments')) && settings.data?.smtp_configured && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => email(p.id)}><Mail size={14} />Email unsent</button>}
                  <Link className="btn-ghost px-2 py-1 text-xs" to={`/backoffice/payroll/periods/${p.id}`}>Individual…</Link>
                </td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function EmailLog() {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const { data, loading, reload } = useAsync(() => pr<any[]>(`/email-log${status ? `?status=${status}` : ''}`), [status]);
  async function resend(id: string) {
    try { await pr(`/email-log/${id}/resend`, { body: {} }); toast('Queued again'); setTimeout(reload, 2000); } catch (e) { toast(errMsg(e), 'err'); }
  }
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <select className="input w-auto py-1.5" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">All</option><option value="queued">Queued</option><option value="sent">Sent</option><option value="failed">Failed</option></select>
        <button className="btn-ghost" onClick={reload}><RotateCw size={15} />Refresh</button>
      </div>
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : !data?.length ? <Empty>No payslip emails yet</Empty> : (
          <table className="table text-sm">
            <thead><tr><th>Queued</th><th>Employee</th><th>Email</th><th>Payroll</th><th>Status</th><th>Sent</th><th>Error</th><th /></tr></thead>
            <tbody>{data.map((l) => (
              <tr key={l.id}><td className="whitespace-nowrap">{dt(l.created_at)}</td><td className="font-medium">{l.full_name}</td><td className="text-xs">{l.to_email}</td><td>{l.period_code}</td>
                <td><ReqBadge status={l.status} /></td><td className="text-xs">{dt(l.sent_at)}</td><td className="max-w-xs truncate text-xs text-rose-600" title={l.error}>{l.error}</td>
                <td>{l.status !== 'queued' && <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => resend(l.id)}>Resend</button>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
