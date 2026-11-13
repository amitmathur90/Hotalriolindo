import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { Receipt } from '../components/Receipt';
import { Spinner } from '../components/ui';

/** Digital receipt shared by link / WhatsApp / email. */
export default function PublicReceipt() {
  const { id, sig } = useParams();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch(`/api/public/receipt/${id}/${sig}`).then(async (r) => (r.ok ? setD(await r.json()) : setErr('Receipt not found'))).catch(() => setErr('Could not load receipt'));
  }, [id, sig]);
  if (err) return <div className="flex h-full items-center justify-center text-slate-500">{err}</div>;
  if (!d) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  return (
    <div className="min-h-full bg-slate-100 py-6">
      <div className="mx-auto w-fit rounded-lg bg-white shadow"><Receipt sale={d.sale} business={d.business} /></div>
      <div className="mt-4 text-center"><button className="btn-secondary" onClick={() => window.print()}><Printer size={16} />Print / Save PDF</button></div>
    </div>
  );
}
