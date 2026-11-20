import { gstSplit } from '../../../shared/pricing';
import { money, qty as fq } from '../lib/format';

// Code 39 barcode (digits + '-') rendered as SVG — no external services needed.
const C39: Record<string, string> = {
  '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw', '5': 'wnnwwnnnn',
  '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn', '-': 'nwnnnnwnw', '*': 'nwnnwnwnn',
};
export function Barcode({ value, height = 36 }: { value: string; height?: number }) {
  const chars = `*${value.replace(/[^0-9-]/g, '')}*`.split('');
  const rects: { x: number; w: number }[] = [];
  let x = 0;
  for (const ch of chars) {
    const p = C39[ch];
    for (let i = 0; i < 9; i++) {
      const w = p[i] === 'w' ? 3 : 1;
      if (i % 2 === 0) rects.push({ x, w });
      x += w;
    }
    x += 1;
  }
  return (
    <svg viewBox={`0 0 ${x} ${height}`} className="mx-auto h-9 w-full max-w-[220px]" preserveAspectRatio="none" aria-label={`Barcode ${value}`}>
      {rects.map((r, i) => <rect key={i} x={r.x} y={0} width={r.w} height={height} fill="currentColor" />)}
    </svg>
  );
}

// Receipt wording. Spanish receipts (e.g. Costa Rica) are bilingual for international guests.
const LABELS = {
  en: { invoice: 'TAX INVOICE', refund: 'REFUND RECEIPT', dup: '*** DUPLICATE ***', offline: '(Offline – pending sync)', receipt: 'Receipt', cashier: 'Cashier', order: 'Order', customer: 'Customer', taxId: 'Tax ID', reason: 'Reason', item: 'Item', qty: 'Qty', rate: 'Rate', amount: 'Amount', subtotal: 'Subtotal', discount: 'Discount', taxReversed: 'Tax reversed', service: 'Service charge', tip: 'Tip', total: 'TOTAL', refunded: 'REFUNDED', change: 'Change', earned: 'Points earned', redeemed: 'Points redeemed', balance: 'Points balance', tax: 'Tax', taxable: 'Taxable', phone: 'Ph', terms: 'Terms & conditions', dining: { dine_in: 'dine in', takeaway: 'takeaway', delivery: 'delivery', pickup: 'pickup' } as Record<string, string> },
  es: { invoice: 'TIQUETE / RECEIPT', refund: 'DEVOLUCIÓN / REFUND', dup: '*** COPIA / DUPLICATE ***', offline: '(Sin conexión – pendiente de sincronizar)', receipt: 'Recibo', cashier: 'Cajero(a)', order: 'Orden', customer: 'Cliente', taxId: 'Céd.', reason: 'Motivo', item: 'Artículo', qty: 'Cant.', rate: 'Precio', amount: 'Monto', subtotal: 'Subtotal', discount: 'Descuento', taxReversed: 'Impuesto devuelto', service: 'Servicio 10%', tip: 'Propina', total: 'TOTAL', refunded: 'DEVUELTO', change: 'Vuelto', earned: 'Puntos ganados', redeemed: 'Puntos canjeados', balance: 'Saldo de puntos', tax: 'Impuesto', taxable: 'Base imponible', phone: 'Tel', terms: 'Términos y condiciones', dining: { dine_in: 'comer aquí', takeaway: 'para llevar', delivery: 'express', pickup: 'recoger' } as Record<string, string> },
};
export const receiptLabels = (business: any) => (String(business?.locale || '').startsWith('es') ? LABELS.es : LABELS.en);

// Costa Rica electronic documents (Hacienda v4.4)
export const EDOC_NAMES: Record<string, string> = { '01': 'Factura electrónica', '02': 'Nota de débito electrónica', '03': 'Nota de crédito electrónica', '04': 'Tiquete electrónico' };
export const ID_TYPE_LABELS: Record<string, string> = { '01': 'Cédula física', '02': 'Cédula jurídica', '03': 'DIMEX', '04': 'NITE', '05': 'Extranjero', '06': 'No contribuyente' };
/** The electronic document a receipt represents: the sale's tiquete/factura, or the refund's nota de crédito. */
export function receiptEDoc(sale: any) {
  const docs: any[] = sale?.e_documents || [];
  const wanted = sale?.type === 'refund' ? ['03'] : ['01', '04'];
  return [...docs].reverse().find((d) => wanted.includes(d.doc_type) && !d.replaced_by) || null;
}
/** 00100001040000000123 → 001-00001-04-0000000123 */
export const fmtConsecutivo = (c: string) => (c && c.length === 20 ? `${c.slice(0, 3)}-${c.slice(3, 8)}-${c.slice(8, 10)}-${c.slice(10)}` : c);

export function Receipt({ sale, business, format = 'thermal' }: { sale: any; business: any; format?: 'thermal' | 'a4' }) {
  const sym = business?.currency_symbol || '₡';
  const m = (n: any) => money(n, sym);
  const L = receiptLabels(business);
  const locale = business?.locale || undefined;
  const taxIdLabel = business?.tax_id_label || 'Tax ID';
  const isRefund = sale.type === 'refund';
  const taxLines = (sale.type === 'sale' ? sale.tax_summary || [] : []).flatMap((t: any) => gstSplit(t, sale.gst_mode || 'intra').map((x) => ({ ...x, taxable: t.taxable })));
  const refundTaxes = isRefund ? sale.items.flatMap((i: any) => i.taxes || []) : [];
  const a4 = format === 'a4';
  const ed = receiptEDoc(sale);
  return (
    <div className={`print-area ${a4 ? 'a4 text-sm' : 'text-[12px] leading-snug'} mx-auto bg-white font-mono text-black ${a4 ? 'max-w-[720px] p-8' : 'max-w-[320px] p-3'}`}>
      <div className="text-center">
        {business?.logo_url && <img src={business.logo_url} alt="" className="mx-auto mb-1 max-h-14 object-contain" />}
        <div className={`font-bold ${a4 ? 'text-xl' : 'text-sm'}`}>{business?.name}</div>
        {sale.store_name && <div>{sale.store_name}</div>}
        {(sale.store_address || business?.address) && <div>{sale.store_address || business?.address}</div>}
        {(sale.store_phone || business?.phone) && <div>{L.phone}: {sale.store_phone || business?.phone}</div>}
        {(sale.store_gstin || business?.gstin) && <div>{taxIdLabel}: {sale.store_gstin || business?.gstin}</div>}
        {sale.receipt_header && <div className="mt-1 italic">{sale.receipt_header}</div>}
        {ed ? (
          <>
            <div className={`mt-2 font-bold uppercase ${a4 ? 'text-lg' : ''}`}>{EDOC_NAMES[ed.doc_type]}</div>
            <div className="font-bold">N° {fmtConsecutivo(ed.consecutivo)}</div>
            {ed.environment === 'stag' && <div className="font-bold">*** PRUEBAS – SIN VALIDEZ FISCAL ***</div>}
          </>
        ) : (
          <div className={`mt-2 font-bold ${a4 ? 'text-lg' : ''}`}>{isRefund ? L.refund : L.invoice}</div>
        )}
        {sale._reprint && <div className="font-bold">{L.dup}</div>}
        {sale.offline && !sale.id && <div className="font-bold">{L.offline}</div>}
      </div>
      <div className="my-2 border-t border-dashed border-black" />
      <div className="flex justify-between"><span>{L.receipt} #{sale.receipt_no}</span><span>{new Date(sale.created_at).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}</span></div>
      {sale.employee_name && <div>{L.cashier}: {sale.employee_name}</div>}
      {sale.dining_option && <div>{L.order}: {L.dining[sale.dining_option] || String(sale.dining_option).replace('_', ' ')}{sale.table_name ? ` · ${sale.table_name}` : ''}{sale.ticket_name && sale.ticket_name !== sale.table_name ? ` · ${sale.ticket_name}` : ''}</div>}
      {sale.customer_name && <div>{L.customer}: {sale.customer_name}{sale.customer_phone ? ` (${sale.customer_phone})` : ''}</div>}
      {ed?.receptor?.nombre ? (
        <div>
          <div>Receptor: {ed.receptor.nombre}</div>
          {ed.receptor.id_number && <div>{ID_TYPE_LABELS[ed.receptor.id_type] || L.taxId}: {ed.receptor.id_number}</div>}
          {ed.receptor.email && <div>{ed.receptor.email}</div>}
        </div>
      ) : (
        sale.customer_tax_id && <div>{L.taxId}: {sale.customer_tax_id}</div>
      )}
      {sale.refund_reason && <div>{L.reason}: {sale.refund_reason}</div>}
      <div className="my-2 border-t border-dashed border-black" />
      <table className="w-full">
        <thead>
          <tr className="text-left"><th className="font-semibold">{L.item}</th><th className="text-right font-semibold">{L.qty}</th>{a4 && <th className="text-right font-semibold">{L.rate}</th>}<th className="text-right font-semibold">{L.amount}</th></tr>
        </thead>
        <tbody>
          {sale.items.map((it: any) => (
            <tr key={it.id || it.line_id} className="align-top">
              <td className="pr-1">
                {it.product_name}{it.variant_name ? ` (${it.variant_name})` : ''}
                {(it.modifiers || []).map((md: any) => <div key={md.id || md.name} className="pl-2 text-[0.92em]">+ {md.name}{md.price ? ` ${m(md.price)}` : ''}</div>)}
                {it.note && <div className="pl-2 text-[0.92em] italic">“{it.note}”</div>}
                {!a4 && <div className="pl-2 text-[0.92em]">@ {m(it.unit_price)}</div>}
                {Number(it.discount) > 0 && <div className="pl-2 text-[0.92em]">{L.discount} -{m(it.discount)}</div>}
              </td>
              <td className="text-right">{fq(it.qty)}</td>
              {a4 && <td className="text-right">{m(it.unit_price)}</td>}
              <td className="text-right">{m(it.gross)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="my-2 border-t border-dashed border-black" />
      <Row l={L.subtotal} r={m(sale.subtotal)} />
      {Number(sale.discount_total) > 0 && <Row l={L.discount} r={`-${m(sale.discount_total)}`} />}
      {taxLines.map((t: any, i: number) => <Row key={i} l={/%/.test(t.name) ? t.name : `${t.name} ${t.rate}%`} r={m(t.amount)} />)}
      {isRefund && refundTaxes.length > 0 && <Row l={L.taxReversed} r={m(sale.tax_total)} />}
      {Number(sale.service_charge) > 0 && <Row l={L.service} r={m(sale.service_charge)} />}
      {Number(sale.tip) > 0 && <Row l={L.tip} r={m(sale.tip)} />}
      <div className={`mt-1 flex justify-between font-bold ${a4 ? 'text-lg' : 'text-sm'}`}><span>{isRefund ? L.refunded : L.total}</span><span>{m(sale.total)}</span></div>
      <div className="my-2 border-t border-dashed border-black" />
      {(sale.payments || []).map((p: any, i: number) => <Row key={i} l={`${p.method_name}${p.reference && p.method_type !== 'cash' ? ` (${p.reference})` : ''}`} r={m(p.method_type === 'cash' && !isRefund ? Number(p.amount) + Number(sale.change || 0) : p.amount)} />)}
      {Number(sale.change) > 0 && <Row l={L.change} r={m(sale.change)} />}
      {(Number(sale.points_earned) > 0 || Number(sale.points_redeemed) > 0) && (
        <div className="mt-1">
          {Number(sale.points_earned) > 0 && <Row l={L.earned} r={String(sale.points_earned)} />}
          {Number(sale.points_redeemed) > 0 && <Row l={L.redeemed} r={String(sale.points_redeemed)} />}
          {sale.customer_points != null && <Row l={L.balance} r={String(sale.customer_points)} />}
        </div>
      )}
      {a4 && taxLines.length > 0 && (
        <table className="mt-3 w-full border border-black text-xs">
          <thead><tr><th className="border border-black p-1 text-left">{L.tax}</th><th className="border border-black p-1 text-right">{L.taxable}</th><th className="border border-black p-1 text-right">{L.amount}</th></tr></thead>
          <tbody>{taxLines.map((t: any, i: number) => <tr key={i}><td className="border border-black p-1">{t.name} @ {t.rate}%</td><td className="border border-black p-1 text-right">{m(t.taxable)}</td><td className="border border-black p-1 text-right">{m(t.amount)}</td></tr>)}</tbody>
        </table>
      )}
      {ed && (
        <div className="mt-2 border-t border-dashed border-black pt-1 text-[0.9em]">
          {ed.reference?.clave && (
            <div className="mb-1">Referencia: {EDOC_NAMES[ed.reference.doc_type] || ed.reference.doc_type} N° {fmtConsecutivo(ed.reference.clave.slice(21, 41))}{ed.reference.reason ? ` · ${ed.reference.reason}` : ''}</div>
          )}
          <div className="font-bold">Clave numérica:</div>
          <div className="break-all tracking-tight">{ed.clave.slice(0, 25)}<br />{ed.clave.slice(25)}</div>
          {sale.e_resolution && <div className="mt-1 text-center text-[0.9em]">{sale.e_resolution}</div>}
        </div>
      )}
      <div className="mt-3 text-center">
        <Barcode value={String(sale.receipt_no || '0')} />
        <div className="mt-2 whitespace-pre-line">{business?.receipt_footer}</div>
      </div>
      {business?.terms && (
        <div className="mt-2 border-t border-dashed border-black pt-1 text-[0.85em] whitespace-pre-line">
          <div className="font-bold">{L.terms}</div>
          {business.terms}
        </div>
      )}
    </div>
  );
}
const Row = ({ l, r }: { l: string; r: string }) => <div className="flex justify-between gap-2"><span>{l}</span><span className="tabular-nums">{r}</span></div>;

/** Text version of a receipt for WhatsApp / email sharing. */
export function receiptText(sale: any, business: any, link?: string) {
  const sym = business?.currency_symbol || '₡';
  const L = receiptLabels(business);
  const lines = [
    `*${business?.name}*`, `${L.receipt} #${sale.receipt_no} · ${new Date(sale.created_at).toLocaleString(business?.locale || undefined)}`, '',
    ...sale.items.map((i: any) => `${fq(i.qty)} × ${i.product_name}${i.variant_name ? ` (${i.variant_name})` : ''} — ${money(i.gross, sym)}`), '',
    Number(sale.discount_total) > 0 ? `${L.discount}: -${money(sale.discount_total, sym)}` : '',
    `${L.tax}: ${money(sale.tax_total, sym)}`, Number(sale.service_charge) > 0 ? `${L.service}: ${money(sale.service_charge, sym)}` : '', `*${L.total}: ${money(sale.total, sym)}*`,
    ...(() => {
      const ed = receiptEDoc(sale);
      return ed ? ['', `${EDOC_NAMES[ed.doc_type]} N° ${fmtConsecutivo(ed.consecutivo)}`, `Clave: ${ed.clave}`] : [];
    })(),
    link ? `\n${L.receipt}: ${link}` : '', business?.receipt_footer || '',
  ];
  return lines.filter((l) => l !== '').join('\n');
}
