import { toJpeg, toPng } from 'html-to-image';

/** International WhatsApp number: Costa Rica 8-digit → 506…, India 10-digit → 91…; otherwise as typed. */
export function waPhone(phone: string | null | undefined, country?: string) {
  const d = String(phone || '').replace(/\D/g, '');
  if (country === 'CR' && d.length === 8) return '506' + d;
  if (country === 'IN' && d.length === 10) return '91' + d;
  return d;
}

/** Renders the on-screen receipt element to a PNG or a PDF (receipt-sized page). */
export async function renderReceipt(el: HTMLElement, kind: 'png' | 'pdf', name: string) {
  if (kind === 'png') {
    const dataUrl = await toPng(el, { pixelRatio: 2, backgroundColor: '#ffffff', cacheBust: true });
    const blob = await (await fetch(dataUrl)).blob();
    return new File([blob], `${name}.png`, { type: 'image/png' });
  }
  const { jsPDF } = await import('jspdf');
  const jpeg = await toJpeg(el, { pixelRatio: 2, backgroundColor: '#ffffff', quality: 0.85 }); // keeps the PDF small for WhatsApp
  const img = new Image();
  img.src = jpeg;
  await img.decode();
  const w = 80; // mm, thermal-receipt width
  const h = (img.height * w) / img.width;
  const pdf = new jsPDF({ unit: 'mm', format: [w + 8, h + 8], compress: true });
  pdf.addImage(jpeg, 'JPEG', 4, 4, w, h);
  return new File([pdf.output('blob')], `${name}.pdf`, { type: 'application/pdf' });
}

export const isMobile = () =>
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

const openChat = (phone: string | undefined, text: string) =>
  window.open(
    isMobile()
      ? `https://wa.me/${phone || ''}?text=${encodeURIComponent(text)}`
      : `https://web.whatsapp.com/send?${phone ? `phone=${phone}&` : ''}text=${encodeURIComponent(text)}`,
    'its-whatsapp',
  );

function downloadFile(file: File) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/**
 * Sends the receipt as an image or PDF to WhatsApp.
 *  - Phones/tablets: native share sheet → pick WhatsApp; the file is attached.
 *  - Desktop (WhatsApp Web): image is copied to the clipboard (paste with Ctrl+V), PDF is downloaded
 *    (drag it into the chat); the customer's chat opens in WhatsApp Web.
 */
export async function shareReceiptFile(el: HTMLElement, kind: 'png' | 'pdf', opts: { name: string; text: string; phone?: string }) {
  const file = await renderReceipt(el, kind, opts.name);
  const nav: any = navigator;
  if (isMobile() && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: opts.name, text: opts.text });
      return 'shared' as const;
    } catch (e: any) {
      if (e?.name === 'AbortError') return 'cancelled' as const;
    }
  }
  if (kind === 'png' && (window as any).ClipboardItem && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': file })]);
      openChat(opts.phone, opts.text);
      return 'copied' as const;
    } catch {
      /* clipboard blocked — fall back to download */
    }
  }
  downloadFile(file);
  openChat(opts.phone, opts.text);
  return 'downloaded' as const;
}
