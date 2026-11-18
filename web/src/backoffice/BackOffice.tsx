import { createContext, lazy, Suspense, useContext, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, BarChart3, Receipt, Package, Boxes, Truck, Users, UserCog, Wallet, Settings, ShieldCheck, Building2,
  Bell, Moon, Sun, LogOut, Store as StoreIcon, Menu, X, Landmark, Plug, BadgeDollarSign, ArrowLeft,
} from 'lucide-react';
import { PAYROLL_NAV } from '../payroll/nav';
import { bo, boApi } from '../lib/api';
import { setCurrency, dt } from '../lib/format';
import { connectSocket, toggleTheme } from '../lib/misc';
import { Spinner, useToast } from '../components/ui';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Reports = lazy(() => import('./pages/Reports'));
const Receipts = lazy(() => import('./pages/Receipts'));
const Items = lazy(() => import('./pages/Items'));
const Inventory = lazy(() => import('./pages/Inventory'));
const Purchases = lazy(() => import('./pages/Purchases'));
const Customers = lazy(() => import('./pages/Customers'));
const Employees = lazy(() => import('./pages/Employees'));
const Cash = lazy(() => import('./pages/Cash'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const Audit = lazy(() => import('./pages/Audit'));
const Hacienda = lazy(() => import('./pages/Hacienda'));
const Integrations = lazy(() => import('./pages/Integrations'));
const Admin = lazy(() => import('./pages/Admin'));
const Payroll = lazy(() => import('../payroll/Payroll'));

export interface Session {
  user: any;
  business: any;
  stores: any[];
  storeId: string | null;
  store: any;
  setStore: (id: string) => void;
  can: (p: string) => boolean;
  reload: () => Promise<void>;
}
const Ctx = createContext<Session>(null as any);
export const useSession = () => useContext(Ctx);

const NAV = [
  { to: '', label: 'Dashboard', icon: LayoutDashboard, perm: 'reports.view' },
  { to: 'reports', label: 'Reports', icon: BarChart3, perm: 'reports.view' },
  { to: 'receipts', label: 'Receipts', icon: Receipt, perm: 'reports.view' },
  { to: 'items', label: 'Items', icon: Package, perm: 'products.manage' },
  { to: 'inventory', label: 'Inventory', icon: Boxes, perm: 'inventory.manage' },
  { to: 'purchases', label: 'Purchases', icon: Truck, perm: 'purchases.manage' },
  { to: 'customers', label: 'Customers', icon: Users, perm: 'customers.manage' },
  { to: 'employees', label: 'Employees', icon: UserCog, perm: 'employees.manage' },
  { to: 'cash', label: 'Shifts & Cash', icon: Wallet, perm: 'reports.view' },
  { to: 'hacienda', label: 'Hacienda', icon: Landmark, perm: 'reports.view' },
  { to: 'integrations', label: 'Integrations', icon: Plug, perm: 'settings.manage' },
  { to: 'settings', label: 'Settings', icon: Settings, perm: 'settings.manage' },
  { to: 'audit', label: 'Audit log', icon: ShieldCheck, perm: 'audit.view' },
];

export default function BackOffice() {
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const [s, setS] = useState<any>(null);
  const [storeId, setStoreId] = useState<string | null>(bo.store);
  const [notifs, setNotifs] = useState<any[]>([]);
  const [showNotifs, setShowNotifs] = useState(false);
  const [menu, setMenu] = useState(false);

  async function reload() {
    const r = await boApi('/auth/me');
    setS(r);
    setCurrency(r.business?.currency_symbol, r.business?.locale);
    if (!bo.store || !r.stores.some((x: any) => x.id === bo.store)) {
      bo.store = r.stores[0]?.id ?? null;
      setStoreId(bo.store);
    }
  }
  useEffect(() => {
    if (!bo.token) return nav('/login');
    reload().catch(() => nav('/login'));
  }, []);
  useEffect(() => {
    if (!s?.business) return;
    boApi('/settings/notifications').then(setNotifs).catch(() => {});
    const sock = connectSocket(bo.token!);
    sock.on('notification', (n) => {
      setNotifs((x) => [n, ...x]);
      toast(n.message, 'info');
    });
    return () => { sock.disconnect(); };
  }, [s?.business?.id]);

  if (!s) return <div className="flex h-full items-center justify-center"><Spinner size={28} /></div>;
  const perms = new Set<string>(s.user.permissions);
  const session: Session = {
    ...s, storeId, store: s.stores.find((x: any) => x.id === storeId),
    setStore: (id) => { bo.store = id; setStoreId(id); },
    can: (p) => perms.has(p), reload,
  };
  const unread = notifs.filter((n) => !n.read).length;
  const payrollItems = s.business ? PAYROLL_NAV.filter((n) => n.perms.some((p) => perms.has(p))) : [];
  const inPayroll = loc.pathname.startsWith('/backoffice/payroll');
  const items = s.user.is_super_admin && !s.business ? [] : [
    ...NAV.filter((n) => perms.has(n.perm)),
    ...(payrollItems.length ? [{ to: payrollItems[0].to, label: 'Payroll', icon: BadgeDollarSign, perm: '' }] : []),
  ];
  const home = s.user.is_super_admin && !s.business ? 'admin' : items[0]?.to ?? 'settings';

  const sidebar = (
    <nav className="flex h-full flex-col gap-1 overflow-y-auto p-3">
      <div className="mb-4 flex items-center gap-2 px-2 pt-1">
        <img src="/icon.svg" className="h-8 w-8" alt="" />
        <div className="min-w-0">
          <div className="font-bold tracking-tight">Rio Lindo POS</div>
          <div className="truncate text-xs text-slate-500">{s.business?.name || 'Platform'}</div>
        </div>
      </div>
      {inPayroll && (
        <>
          <NavLink to="" end onClick={() => setMenu(false)} className="mb-1 flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><ArrowLeft size={14} />Back Office</NavLink>
          <div className="px-3 pb-1 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">Payroll Management</div>
        </>
      )}
      {(inPayroll ? payrollItems : items).map((n) => (
        <NavLink key={n.to} to={n.to} end={n.to === '' || n.to === 'payroll'} onClick={() => setMenu(false)}
          className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${isActive ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'}`}>
          <n.icon size={18} />{n.label}
        </NavLink>
      ))}
      {s.user.is_super_admin && (
        <NavLink to="admin" onClick={() => setMenu(false)} className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'}`}>
          <Building2 size={18} />Platform admin
        </NavLink>
      )}
      <div className="mt-auto space-y-1 border-t border-slate-200 pt-3 dark:border-slate-800">
        {s.business && <a href="/pos" target="_blank" className="btn-primary w-full"><StoreIcon size={16} />Open POS</a>}
        <div className="px-2 pt-2 text-xs text-slate-500">{s.user.name} · {s.user.role_name || (s.user.is_super_admin ? 'Super admin' : '')}</div>
      </div>
    </nav>
  );

  return (
    <Ctx.Provider value={session}>
      <div className="flex h-full">
        <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white lg:block dark:border-slate-800 dark:bg-slate-900">{sidebar}</aside>
        {menu && (
          <div className="fixed inset-0 z-40 bg-slate-900/40 lg:hidden" onClick={() => setMenu(false)}>
            <aside className="h-full w-64 bg-white dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>{sidebar}</aside>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:px-5 dark:border-slate-800 dark:bg-slate-900">
            <button className="btn-ghost p-2 lg:hidden" onClick={() => setMenu(true)} aria-label="Menu">{menu ? <X size={18} /> : <Menu size={18} />}</button>
            {s.stores.length > 0 && (
              <div className="flex items-center gap-2">
                <StoreIcon size={16} className="text-slate-400" />
                <select className="input w-auto py-1.5" value={storeId ?? ''} onChange={(e) => session.setStore(e.target.value)} aria-label="Store">
                  {s.stores.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </div>
            )}
            <div className="ml-auto flex items-center gap-1">
              <div className="relative">
                <button className="btn-ghost relative p-2" onClick={() => { setShowNotifs(!showNotifs); if (unread) boApi('/settings/notifications/read', { body: {} }).then(() => setNotifs((x) => x.map((n) => ({ ...n, read: true })))); }} aria-label="Notifications">
                  <Bell size={18} />
                  {unread > 0 && <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold text-white">{unread}</span>}
                </button>
                {showNotifs && (
                  <div className="card absolute right-0 z-30 mt-2 max-h-96 w-80 overflow-y-auto p-2 shadow-xl">
                    {notifs.length === 0 && <div className="p-4 text-center text-sm text-slate-400">No notifications</div>}
                    {notifs.slice(0, 40).map((n) => (
                      <div key={n.id} className="rounded-lg p-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                        <div>{n.message}</div>
                        <div className="text-xs text-slate-400">{n.type.replace(/_/g, ' ')} · {dt(n.created_at)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <button className="btn-ghost p-2" onClick={toggleTheme} aria-label="Toggle theme"><Sun size={18} className="hidden dark:block" /><Moon size={18} className="dark:hidden" /></button>
              <button className="btn-ghost p-2" onClick={() => { bo.token = null; nav('/login'); }} aria-label="Sign out"><LogOut size={18} /></button>
            </div>
          </header>
          <main className="flex-1 overflow-y-auto p-3 sm:p-6" onClick={() => showNotifs && setShowNotifs(false)}>
            <Suspense fallback={<div className="flex justify-center py-20"><Spinner /></div>}>
              <Routes>
                <Route index element={perms.has('reports.view') && s.business ? <Dashboard /> : <Navigate to={home} replace />} />
                <Route path="reports" element={<Reports />} />
                <Route path="receipts" element={<Receipts />} />
                <Route path="items/*" element={<Items />} />
                <Route path="inventory" element={<Inventory />} />
                <Route path="purchases" element={<Purchases />} />
                <Route path="customers" element={<Customers />} />
                <Route path="employees" element={<Employees />} />
                <Route path="cash" element={<Cash />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="audit" element={<Audit />} />
                <Route path="hacienda" element={<Hacienda />} />
                <Route path="integrations" element={<Integrations />} />
                <Route path="admin" element={<Admin />} />
                <Route path="payroll/*" element={<Payroll />} />
                <Route path="*" element={<Navigate to={home} replace />} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </div>
    </Ctx.Provider>
  );
}
