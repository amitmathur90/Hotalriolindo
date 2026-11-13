import { useState, type RefObject } from 'react';
import { Image as ImageIcon, FileText, MessageCircle, Mail, Download } from 'lucide-react';
import { receiptText } from './Receipt';
import { renderReceipt, shareReceiptFile, waPhone } from './shareReceipt';
import { useToast } from './ui';

/**
 * WhatsApp / email sharing for a rendered receipt.
 * `receiptRef` must wrap the on-screen <Receipt> element (it is captured as the image/PDF).
 */
export function ReceiptShare({ sale, business, receiptRef }: { sale: any; business: any; receiptRef: RefObject<HTMLDivElement | null> }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const es = String(business?.locale || '').startsWith('es');
  const link = sale.id ? `${location.origin}/r/${sale.id}/${sale.share_sig}` : undefined;
  const phone = waPhone(sale.customer_phone, business?.country);
  const name = `${es ? 'Tiquete' : 'Receipt'}-${sale.receipt_no}`;
  const caption = `${business?.name} · ${es ? 'Tiquete' : 'Receipt'} #${sale.receipt_no}`;
  const el = () => (receiptRef.current?.querySelector('.print-area') as HTMLElement) || receiptRef.current!;

  async function run(kind: 'png' | 'pdf', key: string) {
    setBusy(key);
    try {
      const r = await shareReceiptFile(el(), kind, { name, text: caption, phone });
      if (r === 'copied') toast('Receipt image copied — press Ctrl+V in the WhatsApp chat, then Send', 'info');
      if (r === 'downloaded') toast(`${kind === 'png' ? 'Image' : 'PDF'} downloaded — drag it into the WhatsApp chat that opened`, 'info');
    } catch (e: any) {
      toast(e.message || 'Could not create the file', 'err');
    } finally {
      setBusy(null);
    }
  }
  async function downloadPdf() {
    setBusy('dl');
    try {
      const f = await renderReceipt(el(), 'pdf', name);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      a.click();
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <button className="btn border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" disabled={!!busy} onClick={() => run('png', 'png')}>
          <ImageIcon size={16} />{busy === 'png' ? '…' : 'WhatsApp · Image'}
        </button>
        <button className="btn border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" disabled={!!busy} onClick={() => run('pdf', 'pdf')}>
          <FileText size={16} />{busy === 'pdf' ? '…' : 'WhatsApp · PDF'}
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <button className="btn-secondary px-2 text-xs" onClick={() => window.open(`https://wa.me/${phone}?text=${encodeURIComponent(receiptText(sale, business, link))}`, '_blank')}><MessageCircle size={14} />Text</button>
        <button className="btn-secondary px-2 text-xs" onClick={() => (location.href = `mailto:?subject=${encodeURIComponent(caption)}&body=${encodeURIComponent(receiptText(sale, business, link))}`)}><Mail size={14} />Email</button>
        <button className="btn-secondary px-2 text-xs" disabled={!!busy} onClick={downloadPdf}><Download size={14} />PDF</button>
      </div>
      {!phone && <p className="text-xs text-slate-400">Tip: attach a customer with a phone number to open their WhatsApp chat directly.</p>}
    </div>
  );
}
