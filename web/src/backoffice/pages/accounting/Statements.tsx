import { useState } from 'react';
import { Empty, Field, Spinner, useAsync } from '../../../components/ui';
import { ExportButtons } from '../../widgets';
import { AccountSelect, ac, crc, cur, d10, monthStart, today, TYPE_LABEL, useDates } from './common';

type R = 'pnl' | 'bs' | 'tb' | 'gl' | 'cf' | 'iva';
const REPORTS: [R, string][] = [['pnl', 'Estado de resultados'], ['bs', 'Balance general'], ['tb', 'Balance de comprobación'], ['gl', 'Libro mayor'], ['cf', 'Flujo de efectivo'], ['iva', 'IVA (D-104)']];

/** Financial statements. */
export default function Statements() {
  const [rep, setRep] = useState<R>('pnl');
  return (
    <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
      <div className="card h-fit p-2">
        {REPORTS.map(([k, l]) => (
          <button key={k} onClick={() => setRep(k)} className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${rep === k ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-900/30' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}>{l}</button>
        ))}
      </div>
      <div>
        {rep === 'pnl' && <Pnl />}
        {rep === 'bs' && <BalanceSheet />}
        {rep === 'tb' && <TrialBalance />}
        {rep === 'gl' && <Ledger />}
        {rep === 'cf' && <CashFlow />}
        {rep === 'iva' && <Iva />}
      </div>
    </div>
  );
}

const Row = ({ label, value, bold, indent, neg }: { label: string; value: number; bold?: boolean; indent?: boolean; neg?: boolean }) => (
  <tr className={bold ? 'font-semibold' : ''}><td className={indent ? 'pl-6' : ''}>{label}</td><td className={`text-right tabular-nums ${neg && value < 0 ? 'text-rose-600' : ''}`}>{crc(value)}</td></tr>
);
const Section = ({ title, rows, total }: { title: string; rows: any[]; total: number }) => (
  <>
    <tr className="bg-slate-50 dark:bg-slate-800/50"><td colSpan={2} className="font-semibold">{title}</td></tr>
    {rows.map((r) => <Row key={r.id || r.label} label={r.code ? `${r.code} ${r.name}` : r.label} value={r.total ?? r.balance ?? r.amount} indent />)}
    <Row label={`Total ${title.toLowerCase()}`} value={total} bold />
  </>
);

function Pnl() {
  const dates = useDates();
  const { data } = useAsync(() => ac(`/reports/pnl?${dates.qs}&by_month=1`), [dates.qs]);
  const rows = data ? [...data.income, ...data.cogs, ...data.expenses].map((a: any) => ({ code: a.code, name: a.name, type: TYPE_LABEL[a.type], total: a.total })) : [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">{dates.ui}<ExportButtons name="estado-resultados" rows={rows} cols={[{ key: 'code', label: 'Código' }, { key: 'name', label: 'Cuenta' }, { key: 'type', label: 'Tipo' }, { key: 'total', label: 'Monto' }]} /></div>
      {!data ? <Spinner /> : (
        <div className="card overflow-x-auto p-4">
          <div className="mb-2 font-semibold">Estado de resultados · {dates.from} al {dates.to}</div>
          <table className="table text-sm"><tbody>
            <Section title="Ingresos" rows={data.income} total={data.totals.income} />
            {data.cogs.length > 0 && <Section title="Costo de ventas" rows={data.cogs} total={data.totals.cogs} />}
            <Row label="Utilidad bruta" value={data.totals.gross_profit} bold neg />
            <Section title="Gastos de operación" rows={data.expenses} total={data.totals.expenses} />
            <tr className="text-base font-bold"><td>Utilidad (pérdida) del período</td><td className={`text-right tabular-nums ${data.totals.net < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{crc(data.totals.net)}</td></tr>
          </tbody></table>
          {data.months?.length > 1 && (
            <table className="table mt-4 text-sm">
              <thead><tr><th>Mes</th><th className="text-right">Ingresos</th><th className="text-right">Costo</th><th className="text-right">Gastos</th><th className="text-right">Utilidad</th></tr></thead>
              <tbody>{data.months.map((m: any) => <tr key={m.month}><td>{m.month}</td><td className="text-right tabular-nums">{crc(m.income)}</td><td className="text-right tabular-nums">{crc(m.cogs)}</td><td className="text-right tabular-nums">{crc(m.expenses)}</td><td className={`text-right font-medium tabular-nums ${m.net < 0 ? 'text-rose-600' : ''}`}>{crc(m.net)}</td></tr>)}</tbody>
            </table>
          )}
          <p className="mt-3 text-xs text-slate-500">Para la declaración de renta (D-101): ingresos brutos, costos y gastos deducibles del período fiscal.</p>
        </div>
      )}
    </div>
  );
}

function BalanceSheet() {
  const [asOf, setAsOf] = useState(today());
  const { data } = useAsync(() => ac(`/reports/balance-sheet?as_of=${asOf}`), [asOf]);
  const rows = data ? [...data.assets.map((a: any) => ({ ...a, group: 'Activo' })), ...data.liabilities.map((a: any) => ({ ...a, group: 'Pasivo' })), ...data.equity.map((a: any) => ({ ...a, group: 'Patrimonio' }))] : [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2"><Field label="Al"><input type="date" className="input w-auto py-1.5" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <ExportButtons name="balance-general" rows={rows} cols={[{ key: 'group', label: 'Grupo' }, { key: 'code', label: 'Código' }, { key: 'name', label: 'Cuenta' }, { key: 'balance', label: 'Saldo' }]} /></div>
      {!data ? <Spinner /> : (
        <div className="card overflow-x-auto p-4">
          <div className="mb-2 font-semibold">Balance general al {asOf}{!data.totals.balanced && <span className="ml-2 text-rose-600">¡No cuadra!</span>}</div>
          <table className="table text-sm"><tbody>
            <Section title="Activo" rows={data.assets.map((a: any) => ({ ...a, name: a.balance_fc != null ? `${a.name} (${cur(a.balance_fc, 'USD')})` : a.name }))} total={data.totals.assets} />
            <Section title="Pasivo" rows={data.liabilities} total={data.totals.liabilities} />
            <tr className="bg-slate-50 dark:bg-slate-800/50"><td colSpan={2} className="font-semibold">Patrimonio</td></tr>
            {data.equity.map((r: any) => <Row key={r.id} label={`${r.code} ${r.name}`} value={r.balance} indent />)}
            <Row label="Utilidad (pérdida) del período" value={data.current_result} indent neg />
            <Row label="Total patrimonio" value={data.totals.equity} bold />
            <tr className="text-base font-bold"><td>Total pasivo + patrimonio</td><td className="text-right tabular-nums">{crc(data.totals.liabilities_equity)}</td></tr>
          </tbody></table>
        </div>
      )}
    </div>
  );
}

function TrialBalance() {
  const dates = useDates();
  const { data } = useAsync(() => ac(`/reports/trial-balance?${dates.qs}`), [dates.qs]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">{dates.ui}{data && <ExportButtons name="balance-comprobacion" rows={data.rows} cols={[{ key: 'code', label: 'Código' }, { key: 'name', label: 'Cuenta' }, { key: 'opening', label: 'Saldo inicial' }, { key: 'debit', label: 'Débitos' }, { key: 'credit', label: 'Créditos' }, { key: 'closing', label: 'Saldo final' }]} />}</div>
      {!data ? <Spinner /> : (
        <div className="card overflow-x-auto">
          <table className="table text-sm">
            <thead><tr><th>Cuenta</th><th className="text-right">Saldo inicial</th><th className="text-right">Débitos</th><th className="text-right">Créditos</th><th className="text-right">Saldo final</th></tr></thead>
            <tbody>
              {data.rows.map((r: any) => <tr key={r.id}><td>{r.code} {r.name}</td><td className="text-right tabular-nums">{crc(r.opening)}</td><td className="text-right tabular-nums">{crc(r.debit)}</td><td className="text-right tabular-nums">{crc(r.credit)}</td><td className="text-right tabular-nums">{crc(r.closing)}</td></tr>)}
              <tr className="font-bold"><td>Totales {data.totals.balanced ? '✓' : '¡no cuadra!'}</td><td /><td className="text-right tabular-nums">{crc(data.totals.debit)}</td><td className="text-right tabular-nums">{crc(data.totals.credit)}</td><td /></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Ledger() {
  const dates = useDates();
  const accounts = useAsync(() => ac<any[]>('/accounts'), []);
  const [id, setId] = useState('');
  const { data, loading } = useAsync(() => (id ? ac(`/reports/ledger?account_id=${id}&${dates.qs}`) : Promise.resolve(null)), [id, dates.qs]);
  const usd = data?.account?.currency === 'USD';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2"><AccountSelect accounts={accounts.data || []} value={id} onChange={setId} className="w-80" />{dates.ui}
        {data && <ExportButtons name={`mayor-${data.account.code}`} rows={data.lines.map((l: any) => ({ ...l, entry_date: d10(l.entry_date) }))} cols={[{ key: 'entry_date', label: 'Fecha' }, { key: 'number', label: '#' }, { key: 'memo', label: 'Descripción' }, { key: 'debit', label: 'Débito' }, { key: 'credit', label: 'Crédito' }, { key: 'balance', label: 'Saldo' }]} />}</div>
      {!id ? <Empty>Seleccione una cuenta</Empty> : loading || !data ? <Spinner /> : (
        <div className="card overflow-x-auto">
          <table className="table text-sm">
            <thead><tr><th>Fecha</th><th>#</th><th>Descripción</th><th className="text-right">Débito</th><th className="text-right">Crédito</th><th className="text-right">Saldo</th>{usd && <th className="text-right">US$</th>}</tr></thead>
            <tbody>
              <tr className="text-slate-500"><td colSpan={5}>Saldo inicial</td><td className="text-right tabular-nums">{crc(data.opening)}</td>{usd && <td className="text-right tabular-nums">{cur(data.opening_fc, 'USD')}</td>}</tr>
              {data.lines.map((l: any) => (
                <tr key={l.id}><td className="whitespace-nowrap">{d10(l.entry_date)}</td><td>{l.number}</td><td>{l.memo}{(l.description || l.partner) && <div className="text-xs text-slate-400">{[l.description, l.partner].filter(Boolean).join(' · ')}</div>}</td>
                  <td className="text-right tabular-nums">{Number(l.debit) ? crc(l.debit) : ''}</td><td className="text-right tabular-nums">{Number(l.credit) ? crc(l.credit) : ''}</td><td className="text-right tabular-nums">{crc(l.balance)}</td>{usd && <td className="text-right tabular-nums">{cur(l.balance_fc, 'USD')}</td>}</tr>
              ))}
              <tr className="font-bold"><td colSpan={5}>Saldo final</td><td className="text-right tabular-nums">{crc(data.closing)}</td>{usd && <td className="text-right tabular-nums">{cur(data.closing_fc, 'USD')}</td>}</tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const SECTION: Record<string, string> = { operating: 'Actividades de operación', investing: 'Actividades de inversión', financing: 'Actividades de financiamiento' };
function CashFlow() {
  const dates = useDates(monthStart(), today());
  const { data } = useAsync(() => ac(`/reports/cash-flow?${dates.qs}`), [dates.qs]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">{dates.ui}</div>
      {!data ? <Spinner /> : (
        <div className="card overflow-x-auto p-4">
          <div className="mb-2 font-semibold">Flujo de efectivo (método directo) · {dates.from} al {dates.to}</div>
          <table className="table text-sm"><tbody>
            <Row label="Efectivo y bancos al inicio" value={data.opening} bold />
            {data.sections.map((s: any) => <Section key={s.section} title={SECTION[s.section]} rows={s.lines} total={s.total} />)}
            <Row label="Variación neta del efectivo" value={data.change} bold neg />
            <tr className="text-base font-bold"><td>Efectivo y bancos al final</td><td className="text-right tabular-nums">{crc(data.closing)}</td></tr>
          </tbody></table>
        </div>
      )}
    </div>
  );
}

function Iva() {
  const [month, setMonth] = useState(today().slice(0, 7));
  const { data } = useAsync(() => ac(`/reports/iva?month=${month}`), [month]);
  return (
    <div className="space-y-3">
      <Field label="Mes"><input type="month" className="input w-auto py-1.5" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
      {!data ? <Spinner /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card overflow-x-auto p-4">
            <div className="mb-2 font-semibold">Ventas (IVA débito fiscal)</div>
            <table className="table text-sm">
              <thead><tr><th>Tarifa</th><th className="text-right">Base imponible</th><th className="text-right">IVA</th></tr></thead>
              <tbody>
                {data.sales.map((s: any) => <tr key={s.rate}><td>{s.rate}%</td><td className="text-right tabular-nums">{crc(s.base)}</td><td className="text-right tabular-nums">{crc(s.iva)}</td></tr>)}
                <tr><td>Exentas</td><td className="text-right tabular-nums">{crc(data.exempt_sales)}</td><td /></tr>
                <tr className="font-bold"><td>Total débito</td><td /><td className="text-right tabular-nums">{crc(data.iva_debit)}</td></tr>
              </tbody>
            </table>
            <div className="mt-2 text-xs text-slate-500">{data.documents} comprobantes electrónicos (tiquetes, facturas y notas de crédito). Impuesto de servicio y propinas (otros cargos, no gravados): {crc(data.other_charges)}.</div>
          </div>
          <div className="card overflow-x-auto p-4">
            <div className="mb-2 font-semibold">Compras (IVA crédito fiscal)</div>
            <table className="table text-sm">
              <thead><tr><th>Tarifa</th><th className="text-right">Base</th><th className="text-right">IVA</th><th className="text-right">Acreditable</th></tr></thead>
              <tbody>
                {data.purchases.map((s: any) => <tr key={s.rate}><td>{s.rate}%</td><td className="text-right tabular-nums">{crc(s.base)}</td><td className="text-right tabular-nums">{crc(s.iva)}</td><td className="text-right tabular-nums">{crc(s.credit)}</td></tr>)}
                <tr className="font-bold"><td>Total crédito</td><td /><td /><td className="text-right tabular-nums">{crc(data.iva_credit)}</td></tr>
              </tbody>
            </table>
            <div className="mt-2 text-xs text-slate-500">{data.supplier_documents} facturas de proveedores aceptadas.</div>
          </div>
          <div className="card p-4 lg:col-span-2">
            <div className="flex items-center justify-between text-lg font-bold"><span>{data.iva_payable >= 0 ? 'IVA a pagar' : 'Saldo a favor'} ({month})</span><span className="tabular-nums">{crc(Math.abs(data.iva_payable))}</span></div>
            <p className="mt-1 text-xs text-slate-500">Resumen de apoyo para la declaración D-104 en Tribu-CR / ATV. Revise con su contador antes de presentar (prorrata, ventas exentas autorizadas y ajustes no se calculan aquí).</p>
          </div>
        </div>
      )}
    </div>
  );
}
