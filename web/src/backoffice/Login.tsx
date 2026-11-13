import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Store, MonitorSmartphone, ChefHat } from 'lucide-react';
import { bo, boApi } from '../lib/api';
import { Field, useToast } from '../components/ui';

export default function Login({ mode }: { mode: 'login' | 'register' }) {
  const nav = useNavigate();
  const toast = useToast();
  const [f, setF] = useState({ email: '', password: '', businessName: '', ownerName: '', phone: '', country: 'CR' });
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await boApi(mode === 'login' ? '/auth/login' : '/auth/register', { body: f });
      bo.token = r.token;
      bo.store = r.stores?.[0]?.id ?? null;
      nav(r.user.is_super_admin ? '/backoffice/admin' : '/backoffice');
    } catch (err: any) {
      toast(err.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-brand-700 via-brand-800 to-slate-900 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3 text-white">
          <img src="/icon.svg" className="h-11 w-11" alt="" />
          <div>
            <div className="text-2xl font-bold tracking-tight">ITS POS</div>
            <div className="text-sm text-brand-100">Retail & restaurant management</div>
          </div>
        </div>
        <form onSubmit={submit} className="card space-y-4 p-6">
          <h1 className="text-lg font-semibold">{mode === 'login' ? 'Sign in to Back Office' : 'Create your business account'}</h1>
          {mode === 'register' && (
            <>
              <Field label="Business name"><input className="input" required value={f.businessName} onChange={set('businessName')} /></Field>
              <Field label="Your name"><input className="input" required value={f.ownerName} onChange={set('ownerName')} /></Field>
              <Field label="Phone"><input className="input" value={f.phone} onChange={set('phone')} /></Field>
              <Field label="Country" hint="Sets currency, taxes, payment types and receipt language">
                <select className="input" value={f.country} onChange={set('country')}><option value="CR">Costa Rica (₡, IVA 13%)</option><option value="IN">India (₹, GST)</option></select>
              </Field>
            </>
          )}
          <Field label="Email"><input className="input" type="email" required autoComplete="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="Password" hint={mode === 'register' ? 'Your owner POS PIN will be 1111 — change it under Employees.' : undefined}>
            <input className="input" type="password" required minLength={6} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={f.password} onChange={set('password')} />
          </Field>
          <button className="btn-primary w-full py-2.5" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
          <div className="text-center text-sm text-slate-500">
            {mode === 'login' ? <>New business? <Link className="font-medium text-brand-700" to="/register">Create an account</Link></> : <>Have an account? <Link className="font-medium text-brand-700" to="/login">Sign in</Link></>}
          </div>
          {mode === 'login' && (
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-800">
              Demo: <b>owner@demo.com</b> / <b>demo123</b> · POS PINs: owner 1111, manager 2222, cashier 3333, kitchen 4444
            </div>
          )}
        </form>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs text-brand-100">
          <Link to="/pos" className="rounded-lg bg-white/10 p-3 hover:bg-white/20"><Store className="mx-auto mb-1" size={20} />POS Terminal</Link>
          <Link to="/kds" className="rounded-lg bg-white/10 p-3 hover:bg-white/20"><ChefHat className="mx-auto mb-1" size={20} />Kitchen Display</Link>
          <Link to="/display" className="rounded-lg bg-white/10 p-3 hover:bg-white/20"><MonitorSmartphone className="mx-auto mb-1" size={20} />Customer Display</Link>
        </div>
      </div>
    </div>
  );
}
