import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { ToastProvider, Spinner } from './components/ui';
import { initTheme } from './lib/misc';
import { bo } from './lib/api';

const Login = lazy(() => import('./backoffice/Login'));
const BackOffice = lazy(() => import('./backoffice/BackOffice'));
const PosApp = lazy(() => import('./pos/PosApp'));
const Kds = lazy(() => import('./kds/Kds'));
const CustomerDisplay = lazy(() => import('./display/CustomerDisplay'));
const PublicReceipt = lazy(() => import('./display/PublicReceipt'));

initTheme();
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => {});

const Loading = () => (
  <div className="flex h-full items-center justify-center"><Spinner size={28} /></div>
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <BrowserRouter>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Navigate to={bo.token ? '/backoffice' : '/login'} replace />} />
            <Route path="/login" element={<Login mode="login" />} />
            <Route path="/register" element={<Login mode="register" />} />
            <Route path="/backoffice/*" element={<BackOffice />} />
            <Route path="/pos" element={<PosApp />} />
            <Route path="/kds" element={<Kds />} />
            <Route path="/display" element={<CustomerDisplay />} />
            <Route path="/r/:id/:sig" element={<PublicReceipt />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  </StrictMode>,
);
