import { useEffect, useState } from 'react';
import { Upload, Wand2, Link2, Unlink, EyeOff, FilePlus2 } from 'lucide-react';
import { Badge, Empty, Field, Modal, Spinner, useAsync, useToast } from '../../../components/ui';
import { useSession } from '../../BackOffice';
import { AccountSelect, ac, crc, cur, d10 } from './common';

/** Bancos: statement import (CSV from BCR, BN, BAC…) and reconciliation against the books. */
export default function Banks() {
  const { can } = useSession();
  const toast = useToast();
  const banks = useAsync(() => ac<any[]>('/banks'), []);
  const accounts = useAsync(() => ac<any[]>('/accounts'), []);
  const [id, setId] = useState('');
  useEffect(() => { if (!id && banks.data?.length) setId(banks.data[0].id); }, [banks.data]);
  const rec = useAsync(() => (id ? ac(`/banks/${id}/reconciliation`) : Promise.resolve(null)), [id]);
  const [pick, setPick] = useState<any>(null);   // bank line being matched by hand
  const [entry, setEntry] = useState<any>(null); // bank line to record as a new entry
  const [busy, setBusy] = useState(false);
  const reload = () => { rec.reload(); banks.reload(); };
  const act = async (fn: () => Promise<any>, msg: (r: any) => string) => {
    setBusy(true);
    try { const r = await fn(); toast(msg(r)); reload(); } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const upload = (file?: File) => file && file.text().then((content) => act(() => ac(`/banks/${id}/import`, { body: { content } }), (r) => `${r.created} movimiento(s) importados${r.duplicates ? `, ${r.duplicates} ya existían` : ''} · ${r.matched} conciliados automáticamente`));
  const d = rec.data;
  const usd = d?.account?.currency === 'USD';
  const fmt = (n: any) => cur(n, usd ? 'USD' : 'CRC');

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(banks.data || []).map((b) => (
          <button key={b.id} onClick={() => setId(b.id)} className={`card p-4 text-left ${id === b.id ? 'ring-2 ring-brand-500' : ''}`}>
            <div className="text-xs text-slate-500">{b.code} · {b.bank_name || 'Banco'} {b.bank_account}</div>
            <div className="font-medium">{b.name}</div>
            <div className="text-lg font-bold tabular-nums">{b.currency === 'USD' ? cur(b.balance_fc, 'USD') : crc(b.balance)}</div>
            {b.currency === 'USD' && <div className="text-xs text-slate-500">{crc(b.balance)} en libros</div>}
            {b.unmatched > 0 && <Badge color="amber">{b.unmatched} sin conciliar</Badge>}
          </button>
        ))}
      </div>
      {!banks.data?.length && <Empty>Cree cuentas de clase "Banco" en el catálogo.</Empty>}
      {d && (
        <>
          <div className="card flex flex-wrap items-center gap-4 p-4">
            <div><div className="text-xs text-slate-500">Saldo en libros</div><div className="text-lg font-bold tabular-nums">{fmt(d.book_balance)}</div></div>
            <div><div className="text-xs text-slate-500">Saldo del estado de cuenta{d.statement_date ? ` (${d.statement_date})` : ''}</div><div className="text-lg font-bold tabular-nums">{d.statement_balance != null ? fmt(d.statement_balance) : '—'}</div></div>
            {d.statement_balance != null && <div><div className="text-xs text-slate-500">Diferencia</div><div className={`text-lg font-bold tabular-nums ${Math.abs(d.book_balance - d.statement_balance) < 0.01 ? 'text-emerald-600' : 'text-rose-600'}`}>{fmt(d.book_balance - d.statement_balance)}</div></div>}
            {can('accounting.manage') && (
              <div className="ml-auto flex gap-2">
                <button className="btn-secondary" disabled={busy} onClick={() => act(() => ac(`/banks/${id}/auto-match`, { body: {} }), (r) => `${r.matched} conciliados`)}><Wand2 size={16} />Conciliar automáticamente</button>
                <label className={`btn-primary cursor-pointer ${busy ? 'pointer-events-none opacity-60' : ''}`}><Upload size={16} />Importar estado de cuenta (CSV)
                  <input type="file" accept=".csv,.txt,text/csv" className="hidden" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              </div>
            )}
          </div>
          <p className="text-xs text-slate-500">Descargue el estado de cuenta del banco en formato CSV (columnas Fecha, Descripción, Referencia y Monto, o Débito y Crédito; opcional Saldo). Los movimientos con el mismo monto y fecha cercana (±5 días) se concilian solos.</p>
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="card overflow-x-auto">
              <div className="p-3 font-medium">Estado de cuenta del banco <span className="text-xs text-slate-500">({d.unmatched_bank} sin conciliar)</span></div>
              {!d.bank_lines.length ? <Empty>Importe el estado de cuenta</Empty> : (
                <table className="table text-sm">
                  <thead><tr><th>Fecha</th><th>Descripción</th><th className="text-right">Monto</th><th /></tr></thead>
                  <tbody>{d.bank_lines.map((l: any) => (
                    <tr key={l.id} className={l.status === 'ignored' ? 'opacity-50' : ''}>
                      <td className="whitespace-nowrap">{d10(l.line_date)}</td>
                      <td>{l.description}<div className="text-xs text-slate-400">{l.reference}</div></td>
                      <td className={`text-right tabular-nums ${Number(l.amount) < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{fmt(l.amount)}</td>
                      <td className="whitespace-nowrap text-right">
                        {l.status === 'matched' ? <><Badge color="green">Conciliado</Badge>{can('accounting.manage') && <button className="btn-ghost p-1" title="Deshacer" onClick={() => act(() => ac(`/bank-lines/${l.id}/unmatch`, { body: {} }), () => 'Deshecho')}><Unlink size={14} /></button>}</>
                          : l.status === 'ignored' ? <Badge>Ignorado</Badge>
                          : can('accounting.manage') && <>
                            <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setPick(l)} title="Elegir el movimiento de libros"><Link2 size={12} />Enlazar</button>
                            <button className="btn-secondary ml-1 px-2 py-1 text-xs" onClick={() => setEntry(l)} title="Registrar como nuevo asiento (comisión, interés…)"><FilePlus2 size={12} />Registrar</button>
                            <button className="btn-ghost ml-1 p-1" title="Ignorar" onClick={() => act(() => ac(`/bank-lines/${l.id}/ignore`, { body: {} }), () => 'Ignorado')}><EyeOff size={14} /></button>
                          </>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </div>
            <div className="card overflow-x-auto">
              <div className="p-3 font-medium">Movimientos en libros sin conciliar <span className="text-xs text-slate-500">({d.unmatched_book})</span></div>
              {rec.loading && !d ? <Spinner /> : (
                <table className="table text-sm">
                  <thead><tr><th>Fecha</th><th>Asiento</th><th className="text-right">Monto</th></tr></thead>
                  <tbody>{d.book_lines.filter((l: any) => !l.bank_line_id).slice(0, 300).map((l: any) => (
                    <tr key={l.id}><td className="whitespace-nowrap">{d10(l.entry_date)}</td><td>#{l.number} {l.memo}<div className="text-xs text-slate-400">{l.partner}</div></td>
                      <td className={`text-right tabular-nums ${l.amount < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{fmt(l.amount)}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
      {pick && d && (
        <Modal open onClose={() => setPick(null)} title={`Enlazar ${fmt(pick.amount)} · ${pick.description || ''}`}>
          <div className="max-h-96 overflow-y-auto">
            {d.book_lines.filter((l: any) => !l.bank_line_id).sort((a: any, b: any) => Math.abs(a.amount - pick.amount) - Math.abs(b.amount - pick.amount)).slice(0, 50).map((l: any) => (
              <button key={l.id} className="flex w-full justify-between gap-3 rounded px-2 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                onClick={() => { setPick(null); act(() => ac(`/bank-lines/${pick.id}/match`, { body: { acc_line_id: l.id } }), () => 'Conciliado'); }}>
                <span>{d10(l.entry_date)} · #{l.number} {l.memo}</span><span className={`tabular-nums ${Math.abs(l.amount - pick.amount) < 0.01 ? 'font-bold text-emerald-700' : ''}`}>{fmt(l.amount)}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {entry && <EntryFromLine line={entry} accounts={accounts.data || []} onClose={() => setEntry(null)} onDone={() => { setEntry(null); reload(); }} />}
    </div>
  );
}

function EntryFromLine({ line, accounts, onClose, onDone }: { line: any; accounts: any[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const fees = accounts.find((a) => a.key === 'bank_fees')?.id || '';
  const [account, setAccount] = useState(Number(line.amount) < 0 ? fees : '');
  const [memo, setMemo] = useState(line.description || '');
  const save = async () => {
    try { await ac(`/bank-lines/${line.id}/entry`, { body: { account_id: account, memo } }); toast('Asiento registrado y conciliado'); onDone(); } catch (e: any) { toast(e.message, 'err'); }
  };
  return (
    <Modal open onClose={onClose} title={`Registrar movimiento ${line.amount}`} footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={!account} onClick={save}>Registrar</button></>}>
      <div className="space-y-3">
        <Field label="Contrapartida" hint={Number(line.amount) < 0 ? 'Ej. gastos bancarios, préstamo, traspaso a otra cuenta' : 'Ej. intereses ganados, aporte de socios, traspaso'}><AccountSelect accounts={accounts} value={account} onChange={setAccount} filter={(a) => a.id !== line.account_id} /></Field>
        <Field label="Descripción"><input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
