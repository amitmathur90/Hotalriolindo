import { useState } from 'react';
import { Plus, Pencil } from 'lucide-react';
import { Badge, Field, Modal, SearchInput, Spinner, Toggle, useAsync, useToast } from '../../../components/ui';
import { useSession } from '../../BackOffice';
import { ExportButtons } from '../../widgets';
import { ac, crc, cur, TYPE_LABEL } from './common';

const SUBTYPES: [string, string][] = [['', '—'], ['cash', 'Caja'], ['bank', 'Banco'], ['receivable', 'Por cobrar'], ['payable', 'Por pagar'], ['inventory', 'Inventario'], ['fixed', 'Activo fijo'], ['tax', 'Impuestos'], ['cogs', 'Costo de ventas'], ['other', 'Otro']];

/** Catálogo de cuentas with current balances. */
export default function Chart() {
  const { can } = useSession();
  const { data, loading, reload } = useAsync(() => ac<any[]>('/accounts'), []);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const list = (data || []).filter((a) => !q || `${a.code} ${a.name}`.toLowerCase().includes(q.toLowerCase()));
  const sign = (a: any) => (a.type === 'asset' || a.type === 'expense' ? 1 : -1);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Código o nombre" className="max-w-xs flex-1" />
        <ExportButtons name="catalogo-cuentas" rows={list.map((a) => ({ ...a, type: TYPE_LABEL[a.type], balance: Number(a.balance) * sign(a) }))} cols={[{ key: 'code', label: 'Código' }, { key: 'name', label: 'Cuenta' }, { key: 'type', label: 'Tipo' }, { key: 'currency', label: 'Moneda' }, { key: 'balance', label: 'Saldo ₡' }]} />
        {can('accounting.manage') && <button className="btn-primary ml-auto" onClick={() => setEdit({ type: 'expense', currency: 'CRC', subtype: '', cash_flow: 'operating', active: true })}><Plus size={16} />Nueva cuenta</button>}
      </div>
      <div className="card overflow-x-auto">
        {loading && !data ? <div className="flex justify-center py-10"><Spinner /></div> : (
          <table className="table text-sm">
            <thead><tr><th>Código</th><th>Cuenta</th><th>Tipo</th><th className="text-right">Saldo</th><th /></tr></thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id} className={!a.active ? 'opacity-50' : ''}>
                  <td className="font-mono text-xs">{a.code}</td>
                  <td>{a.name}{a.key && <span className="ml-2 text-xs text-slate-400">automática</span>}{a.bank_name && <div className="text-xs text-slate-500">{a.bank_name} {a.bank_account}</div>}</td>
                  <td><Badge>{TYPE_LABEL[a.type]}</Badge>{a.currency === 'USD' && <Badge color="blue">US$</Badge>}</td>
                  <td className="text-right tabular-nums">{crc(Number(a.balance) * sign(a))}{a.currency === 'USD' && <div className="text-xs text-slate-500">{cur(a.balance_fc, 'USD')}</div>}</td>
                  <td className="text-right">{can('accounting.manage') && <button className="btn-ghost p-1.5" onClick={() => setEdit(a)} aria-label="Editar"><Pencil size={14} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && <AccountModal acc={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function AccountModal({ acc, onClose, onSaved }: { acc: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [a, setA] = useState<any>({ ...acc, subtype: acc.subtype || '' });
  const set = (k: string) => (e: any) => setA({ ...a, [k]: e.target.value });
  const save = async () => {
    try {
      const body = { code: a.code, name: a.name, type: a.type, subtype: a.subtype, currency: a.currency, cash_flow: a.cash_flow, bank_name: a.bank_name, bank_account: a.bank_account, active: a.active };
      if (a.id) await ac(`/accounts/${a.id}`, { method: 'PUT', body }); else await ac('/accounts', { body });
      toast('Cuenta guardada');
      onSaved();
    } catch (e: any) { toast(e.message, 'err'); }
  };
  return (
    <Modal open onClose={onClose} title={a.id ? `Cuenta ${a.code}` : 'Nueva cuenta'} footer={<><button className="btn-secondary" onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save}>Guardar</button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Código"><input className="input" value={a.code || ''} onChange={set('code')} placeholder="6-02-11" /></Field>
        <Field label="Nombre"><input className="input" value={a.name || ''} onChange={set('name')} /></Field>
        <Field label="Tipo"><select className="input" value={a.type} onChange={set('type')}>{Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Clase"><select className="input" value={a.subtype} onChange={set('subtype')}>{SUBTYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Moneda"><select className="input" value={a.currency} onChange={set('currency')}><option value="CRC">Colones</option><option value="USD">Dólares</option></select></Field>
        <Field label="Flujo de efectivo"><select className="input" value={a.cash_flow || 'operating'} onChange={set('cash_flow')}><option value="operating">Operación</option><option value="investing">Inversión</option><option value="financing">Financiamiento</option></select></Field>
        {a.subtype === 'bank' && <>
          <Field label="Banco"><input className="input" value={a.bank_name || ''} onChange={set('bank_name')} placeholder="BCR, BN, BAC…" /></Field>
          <Field label="N° de cuenta / IBAN"><input className="input" value={a.bank_account || ''} onChange={set('bank_account')} /></Field>
        </>}
        <div className="col-span-2"><Toggle checked={a.active !== false} onChange={(v) => setA({ ...a, active: v })} label="Activa" /></div>
      </div>
    </Modal>
  );
}
