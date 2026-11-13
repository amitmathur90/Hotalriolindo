import { useEffect, useState } from 'react';
import { Download, ImagePlus, MonitorSmartphone } from 'lucide-react';
import { bo, boApi } from '../../lib/api';
import { dt } from '../../lib/format';
import { imageToDataUrl } from '../../lib/misc';
import { Badge, Empty, Field, PageHeader, Tabs, Toggle, useAsync, useToast } from '../../components/ui';
import { downloadLauncher } from '../../components/PrinterSetup';
import { useSession } from '../BackOffice';
import { CrudPage } from '../widgets';

type Tab = 'business' | 'loyalty' | 'stores' | 'taxes' | 'payments' | 'discounts' | 'tables' | 'devices' | 'hardware' | 'security';

export default function Settings() {
  const [tab, setTab] = useState<Tab>('business');
  return (
    <div>
      <PageHeader title="Settings" />
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'business', label: 'Business & receipt' }, { id: 'loyalty', label: 'Loyalty & POS' }, { id: 'stores', label: 'Stores' }, { id: 'taxes', label: 'Taxes' },
        { id: 'payments', label: 'Payment types' }, { id: 'discounts', label: 'Discounts' }, { id: 'tables', label: 'Tables' }, { id: 'devices', label: 'Devices' },
        { id: 'hardware', label: 'Hardware' }, { id: 'security', label: 'Security & backup' },
      ]} />
      {tab === 'business' && <Business />}
      {tab === 'loyalty' && <Loyalty />}
      {tab === 'stores' && <CrudPage header={false} title="Stores" path="/settings/stores" perm="settings.manage" defaults={{ gst_mode: 'intra', active: true }}
        subtitle="Each store keeps its own stock, prices, receipts numbering and staff assignment."
        columns={[{ key: 'name', label: 'Name' }, { key: 'address', label: 'Address' }, { key: 'gstin', label: 'Tax ID' }, { key: 'active', label: 'Active' }]}
        fields={[{ key: 'name', label: 'Name', required: true }, { key: 'phone', label: 'Phone' }, { key: 'address', label: 'Address', type: 'textarea' }, { key: 'state', label: 'State' }, { key: 'gstin', label: 'Tax ID (cédula jurídica)' },
          { key: 'gst_mode', label: 'India GST mode (ignore outside India)', type: 'select', options: [{ value: 'intra', label: 'Intra-state (CGST + SGST)' }, { value: 'inter', label: 'Inter-state (IGST)' }] }, { key: 'receipt_header', label: 'Receipt header text' }, { key: 'active', label: 'Active', type: 'toggle' }]} />}
      {tab === 'taxes' && <CrudPage header={false} title="Taxes" path="/taxes" perm="settings.manage" defaults={{ inclusive: false, is_gst: true, active: true }}
        subtitle="Costa Rica: IVA 13% general, 4% / 2% / 1% reduced, Exento 0% (Ley 9635). Mark “Included in price” when menu prices already include IVA. The India GST split option only applies to Indian businesses."
        columns={[{ key: 'name', label: 'Name' }, { key: 'rate', label: 'Rate %' }, { key: 'inclusive', label: 'Included in price' }, { key: 'is_gst', label: 'India GST split' }, { key: 'active', label: 'Active' }]}
        fields={[{ key: 'name', label: 'Name', required: true }, { key: 'rate', label: 'Rate %', type: 'number', required: true }, { key: 'inclusive', label: 'Included in item price', type: 'toggle' }, { key: 'is_gst', label: 'India GST (split CGST/SGST/IGST)', type: 'toggle' }, { key: 'active', label: 'Active', type: 'toggle' }]} />}
      {tab === 'payments' && <PaymentTypes />}
      {tab === 'discounts' && <CrudPage header={false} title="Discounts" path="/settings/discounts" perm="settings.manage" defaults={{ type: 'percent', scope: 'order', active: true, restricted: false }}
        subtitle="Restricted discounts need the “Apply discounts” permission or a manager PIN at the POS."
        columns={[{ key: 'name', label: 'Name' }, { key: 'type', label: 'Type' }, { key: 'value', label: 'Value' }, { key: 'scope', label: 'Applies to' }, { key: 'coupon_code', label: 'Coupon' }, { key: 'restricted', label: 'Restricted' }, { key: 'active', label: 'Active' }]}
        fields={[{ key: 'name', label: 'Name', required: true }, { key: 'type', label: 'Type', type: 'select', options: [{ value: 'percent', label: 'Percentage' }, { value: 'fixed', label: 'Fixed amount' }] }, { key: 'value', label: 'Value', type: 'number', required: true },
          { key: 'scope', label: 'Applies to', type: 'select', options: [{ value: 'order', label: 'Whole order' }, { value: 'item', label: 'Single item' }] }, { key: 'coupon_code', label: 'Coupon code' }, { key: 'restricted', label: 'Restricted access', type: 'toggle' }, { key: 'active', label: 'Active', type: 'toggle' }]} />}
      {tab === 'tables' && <CrudPage header={false} title="Tables" path="/settings/tables" perm="settings.manage" defaults={{ area: 'Main', capacity: 4, sort: 0 }} subtitle="Tables for the store selected at the top."
        columns={[{ key: 'name', label: 'Table' }, { key: 'area', label: 'Area / floor' }, { key: 'capacity', label: 'Seats' }, { key: 'status', label: 'Status', render: (r) => <Badge color={r.status === 'available' ? 'green' : r.status === 'occupied' ? 'red' : 'amber'}>{r.status}</Badge> }]}
        fields={[{ key: 'name', label: 'Table name', required: true }, { key: 'area', label: 'Area / floor' }, { key: 'capacity', label: 'Seats', type: 'number' }, { key: 'sort', label: 'Sort', type: 'number' }]} />}
      {tab === 'devices' && <Devices />}
      {tab === 'hardware' && <Hardware />}
      {tab === 'security' && <Security />}
    </div>
  );
}

function useBusiness() {
  const toast = useToast();
  const { reload } = useSession();
  const { data, setData } = useAsync(() => boApi('/settings/business'), []);
  const save = async (fields: string[]) => {
    try {
      await boApi('/settings/business', { method: 'PUT', body: Object.fromEntries(fields.map((f) => [f, data[f]])) });
      toast('Settings saved');
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  };
  return { b: data, set: (k: string, v: any) => setData({ ...data, [k]: v }), save };
}

function Business() {
  const { b, set, save } = useBusiness();
  if (!b) return null;
  const F = ['name', 'address', 'phone', 'email', 'gstin', 'logo_url', 'receipt_footer', 'currency', 'currency_symbol', 'timezone', 'date_format', 'upi_id', 'country', 'locale', 'tax_id_label', 'terms'];
  return (
    <div className="card max-w-3xl space-y-4 p-5">
      <div className="flex gap-4">
        <label className="flex h-24 w-24 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-slate-300 text-slate-400 dark:border-slate-700">
          {b.logo_url ? <img src={b.logo_url} className="h-full w-full object-contain" alt="Logo" /> : <ImagePlus />}
          <input type="file" accept="image/*" hidden onChange={async (e) => e.target.files?.[0] && set('logo_url', await imageToDataUrl(e.target.files[0], 240))} />
        </label>
        <div className="grid flex-1 gap-3 sm:grid-cols-2">
          <Field label="Business name"><input className="input" value={b.name || ''} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label={b.tax_id_label || 'Tax ID'}><input className="input" value={b.gstin || ''} onChange={(e) => set('gstin', e.target.value)} /></Field>
          <Field label="Phone"><input className="input" value={b.phone || ''} onChange={(e) => set('phone', e.target.value)} /></Field>
          <Field label="Email"><input className="input" value={b.email || ''} onChange={(e) => set('email', e.target.value)} /></Field>
        </div>
      </div>
      <Field label="Address"><input className="input" value={b.address || ''} onChange={(e) => set('address', e.target.value)} /></Field>
      <Field label="UPI ID for QR payments (India only)" hint="Leave empty outside India. Shown as a scan-to-pay QR on the POS and customer display."><input className="input" value={b.upi_id || ''} onChange={(e) => set('upi_id', e.target.value)} /></Field>
      <Field label="Receipt footer"><textarea className="input" rows={2} value={b.receipt_footer || ''} onChange={(e) => set('receipt_footer', e.target.value)} /></Field>
      <Field label="Terms & conditions (printed on every receipt and invoice)"><textarea className="input" rows={5} value={b.terms || ''} onChange={(e) => set('terms', e.target.value)} /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Country"><select className="input" value={b.country} onChange={(e) => set('country', e.target.value)}><option value="CR">Costa Rica</option><option value="IN">India</option></select></Field>
        <Field label="Language / number format" hint="es-CR prints Spanish/English receipts"><select className="input" value={b.locale} onChange={(e) => set('locale', e.target.value)}><option value="es-CR">Español (Costa Rica)</option><option value="en-US">English (US)</option><option value="en-IN">English (India)</option></select></Field>
        <Field label="Tax ID label"><input className="input" value={b.tax_id_label || ''} onChange={(e) => set('tax_id_label', e.target.value)} placeholder="Cédula jurídica" /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Currency"><input className="input" value={b.currency} onChange={(e) => set('currency', e.target.value)} /></Field>
        <Field label="Symbol"><input className="input" value={b.currency_symbol} onChange={(e) => set('currency_symbol', e.target.value)} /></Field>
        <Field label="Time zone"><input className="input" value={b.timezone} onChange={(e) => set('timezone', e.target.value)} /></Field>
        <Field label="Date format"><select className="input" value={b.date_format} onChange={(e) => set('date_format', e.target.value)}>{['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'].map((f) => <option key={f}>{f}</option>)}</select></Field>
      </div>
      <button className="btn-primary" onClick={() => save(F)}>Save</button>
    </div>
  );
}

function Loyalty() {
  const { b, set, save } = useBusiness();
  if (!b) return null;
  return (
    <div className="card max-w-3xl space-y-4 p-5">
      <Toggle checked={b.loyalty_enabled} onChange={(v) => set('loyalty_enabled', v)} label="Loyalty program enabled" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Spend amount to earn 1 point" hint="e.g. 1000 = 1 point per ₡1,000"><input className="input" type="number" value={b.points_per_amount} onChange={(e) => set('points_per_amount', Number(e.target.value))} /></Field>
        <Field label="Value of 1 point when redeemed"><input className="input" type="number" step="0.01" value={b.point_value} onChange={(e) => set('point_value', Number(e.target.value))} /></Field>
        <Field label="Minimum points to redeem"><input className="input" type="number" value={b.min_redeem_points} onChange={(e) => set('min_redeem_points', Number(e.target.value))} /></Field>
        <Field label="Points expire after inactivity (days)" hint="0 = never"><input className="input" type="number" value={b.points_expiry_days} onChange={(e) => set('points_expiry_days', Number(e.target.value))} /></Field>
      </div>
      <hr className="border-slate-200 dark:border-slate-800" />
      <div className="text-sm font-semibold">POS rules</div>
      <Toggle checked={b.allow_negative_stock} onChange={(v) => set('allow_negative_stock', v)} label="Allow selling items that are out of stock (negative stock)" />
      <Field label="Service charge for dine-in (%)" hint="Costa Rica: 10% servicio on table service, calculated before IVA" className="max-w-xs"><input className="input" type="number" step="0.5" value={b.service_charge_pct} onChange={(e) => set('service_charge_pct', Number(e.target.value))} /></Field>
      <button className="btn-primary" onClick={() => save(['loyalty_enabled', 'points_per_amount', 'point_value', 'min_redeem_points', 'points_expiry_days', 'allow_negative_stock', 'service_charge_pct'])}>Save</button>
    </div>
  );
}

function PaymentTypes() {
  return (
    <CrudPage header={false} title="Payment types" path="/settings/payment-methods" perm="settings.manage" defaults={{ type: 'other', active: true, sort: 10 }}
      subtitle="Custom payment types appear on the POS payment screen."
      columns={[{ key: 'name', label: 'Name' }, { key: 'type', label: 'Type' }, { key: 'sort', label: 'Order' }, { key: 'active', label: 'Active' }]}
      fields={[{ key: 'name', label: 'Name', required: true }, { key: 'type', label: 'Type', type: 'select', options: ['cash', 'card', 'upi', 'bank', 'gift_card', 'store_credit', 'other'].map((t) => ({ value: t, label: t.replace('_', ' ') })) },
        { key: 'sort', label: 'Display order', type: 'number' }, { key: 'active', label: 'Active', type: 'toggle' }]} />
  );
}

function Devices() {
  const toast = useToast();
  const { stores, storeId } = useSession();
  const { data, reload } = useAsync(() => boApi<any[]>('/auth/devices'), []);
  const [kind, setKind] = useState('pos');
  const [name, setName] = useState('');
  async function register(open: boolean) {
    try {
      const r = await boApi('/auth/devices', { body: { store_id: storeId, name: name || (kind === 'kds' ? 'Kitchen Display' : kind === 'display' ? 'Customer Display' : 'POS Terminal'), kind } });
      if (open) {
        localStorage.setItem(kind === 'kds' ? 'its.kds.device' : 'its.pos.device', JSON.stringify({ token: r.token, device: r.device }));
        window.open(kind === 'kds' ? '/kds' : '/pos', '_blank');
      }
      toast('Device registered');
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  }
  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-end gap-3 p-4">
        <Field label="Device type"><select className="input" value={kind} onChange={(e) => setKind(e.target.value)}><option value="pos">POS terminal</option><option value="kds">Kitchen display</option></select></Field>
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Counter 1" /></Field>
        <Field label="Store"><input className="input" disabled value={stores.find((s) => s.id === storeId)?.name || ''} /></Field>
        <button className="btn-primary" onClick={() => register(true)}><MonitorSmartphone size={16} />Register this browser & open</button>
        <p className="w-full text-xs text-slate-500">Other devices: open <b>/pos</b> or <b>/kds</b> on that device and sign in with an owner/manager account to register it. The customer display pairs with a POS terminal from the POS menu.</p>
      </div>
      <div className="card overflow-x-auto">
        {!data?.length ? <Empty>No devices yet</Empty> : (
          <table className="table">
            <thead><tr><th>Name</th><th>Type</th><th>Store</th><th>Last seen</th><th>Status</th><th /></tr></thead>
            <tbody>{data.map((d) => (
              <tr key={d.id}>
                <td className="font-medium">{d.name}<div className="font-mono text-xs text-slate-400">{d.id.slice(0, 8)}</div></td><td className="uppercase">{d.kind}</td><td>{d.store_name}</td><td>{dt(d.last_seen_at) || 'Never'}</td>
                <td>{d.active ? <Badge color="green">Active</Badge> : <Badge color="red">Revoked</Badge>}</td>
                <td><button className="btn-ghost py-1 text-xs" onClick={async () => { await boApi(`/auth/devices/${d.id}`, { method: 'PUT', body: { active: !d.active } }); reload(); }}>{d.active ? 'Revoke' : 'Re-activate'}</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const HW_KEY = 'its.hardware';
function Hardware() {
  const toast = useToast();
  const [hw, setHw] = useState<any>(() => JSON.parse(localStorage.getItem(HW_KEY) || '{}'));
  useEffect(() => localStorage.setItem(HW_KEY, JSON.stringify(hw)), [hw]);
  const set = (k: string, v: any) => setHw({ ...hw, [k]: v });
  return (
    <div className="grid max-w-4xl gap-4 md:grid-cols-2">
      <div className="card space-y-3 p-5">
        <div className="font-semibold">Receipt printer</div>
        <Field label="Paper"><select className="input" value={hw.paper || '80mm'} onChange={(e) => set('paper', e.target.value)}><option value="80mm">Thermal 80mm</option><option value="58mm">Thermal 58mm</option><option value="a4">A4 invoice</option></select></Field>
        <Toggle checked={hw.autoPrint ?? true} onChange={(v) => set('autoPrint', v)} label="Print receipt automatically after payment" />
        <Toggle checked={hw.kitchenPrint ?? false} onChange={(v) => set('kitchenPrint', v)} label="Print kitchen ticket when order is sent" />
        <p className="text-xs text-slate-500">USB, network and Bluetooth thermal printers are used through the operating system's printer driver (set as default printer, margins “none”). Cash drawers connected to the receipt printer open on each print (enable “open drawer” in the printer driver).</p>
        <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800">
          <div className="font-medium">Automatic printing (no print dialog)</div>
          <p className="mt-1 text-xs text-slate-500">Connect the printer to the PC (Windows installs the driver), set it as the default printer, then run the launcher on that PC. It opens the POS or Kitchen Display with silent printing and starts with Windows.</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button className="btn-secondary text-xs" onClick={() => downloadLauncher('pos')}><Download size={14} />Reception launcher</button>
            <button className="btn-secondary text-xs" onClick={() => downloadLauncher('kds')}><Download size={14} />Kitchen launcher</button>
          </div>
        </div>
        <button className="btn-secondary" onClick={() => window.print()}>Print test page</button>
      </div>
      <div className="card space-y-3 p-5">
        <div className="font-semibold">Barcode scanners & scales</div>
        <p className="text-sm text-slate-600 dark:text-slate-300">USB and Bluetooth scanners work in keyboard (HID) mode — scan anywhere on the POS sale screen. Phones and tablets can scan with the camera from the POS search bar.</p>
        <Field label="Weighted barcode prefix" hint="Price/weight-embedded EAN-13 labels from scales (e.g. 2x)"><input className="input" value={hw.scalePrefix || '21'} onChange={(e) => set('scalePrefix', e.target.value)} /></Field>
        <Toggle checked={hw.beep ?? true} onChange={(v) => set('beep', v)} label="Beep on scan" />
        <button className="btn-secondary" onClick={() => toast('Settings saved on this device')}>Save</button>
      </div>
      <div className="card space-y-2 p-5 md:col-span-2">
        <div className="font-semibold">Supported configurations</div>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
          <li>POS: Windows/macOS/Linux desktops (Chrome, Edge), Android tablets & phones, iPad (Safari) — installable as an app (PWA).</li>
          <li>Kitchen display: any tablet or TV browser at <b>/kds</b>; multiple stations by category (Kitchen, Bar).</li>
          <li>Customer display: second monitor or tablet at <b>/display</b>, paired to a POS terminal.</li>
          <li>Printers: 58/80mm ESC/POS thermal (USB, LAN, Bluetooth via OS driver), A4 laser/inkjet; kitchen printers via station-specific print.</li>
        </ul>
      </div>
    </div>
  );
}

function Security() {
  const toast = useToast();
  const { user } = useSession();
  const [pw, setPw] = useState({ current: '', next: '' });
  async function backup() {
    const res = await fetch('/api/settings/backup', { headers: { Authorization: `Bearer ${bo.token}` } });
    if (!res.ok) return toast((await res.json()).error, 'err');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `its-pos-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }
  return (
    <div className="grid max-w-4xl gap-4 md:grid-cols-2">
      <div className="card space-y-3 p-5">
        <div className="font-semibold">Change password</div>
        <Field label="Current password"><input className="input" type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
        <Field label="New password" hint="At least 8 characters"><input className="input" type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
        <button className="btn-primary" onClick={async () => { try { await boApi('/auth/change-password', { body: pw }); toast('Password changed'); setPw({ current: '', next: '' }); } catch (e: any) { toast(e.message, 'err'); } }}>Update password</button>
      </div>
      <div className="card space-y-3 p-5">
        <div className="font-semibold">Backup & export</div>
        <p className="text-sm text-slate-500">Download a complete JSON backup of this business (catalog, stock, customers, sales, shifts). Server-side, schedule automated PostgreSQL backups (see README).</p>
        <button className="btn-secondary" disabled={!user.is_owner} onClick={backup}><Download size={16} />Download backup</button>
        {!user.is_owner && <p className="text-xs text-amber-600">Only the owner can export backups.</p>}
      </div>
    </div>
  );
}
