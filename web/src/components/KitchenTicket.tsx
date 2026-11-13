import { qty as fq } from '../lib/format';
import { hwSettings } from './PrinterSetup';

export type KitchenTicketData = {
  station?: string | null; label: string; dining?: string | null; time?: string | Date; priority?: string;
  items: { qty: number; name: string; modifiers?: string[]; note?: string | null }[];
};

const DINING: Record<string, string> = { dine_in: 'Comer aquí', takeaway: 'Para llevar', delivery: 'Express', pickup: 'Recoger' };

/** Kitchen order ticket (comanda) for thermal printers. Marked so it prints on its own (see index.css). */
export function KitchenTicket({ data }: { data: KitchenTicketData }) {
  return (
    <div className="print-area kitchen-ticket bg-white p-2 font-mono text-[14px] leading-snug text-black">
      <div className="text-center text-lg font-bold">{(data.station || 'Cocina').toUpperCase()}</div>
      {data.priority === 'rush' && <div className="text-center font-bold">*** URGENTE ***</div>}
      <div className="text-center text-xl font-bold">{data.label}</div>
      <div className="text-center">{new Date(data.time || Date.now()).toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit' })}{data.dining ? ` · ${DINING[data.dining] || data.dining}` : ''}</div>
      <div className="my-1 border-t border-dashed border-black" />
      {data.items.map((i, k) => (
        <div key={k} className="mb-1">
          <b className="text-[15px]">{fq(i.qty)} × {i.name}</b>
          {i.modifiers?.map((m) => <div key={m} className="pl-3">+ {m}</div>)}
          {i.note && <div className="pl-3 font-bold">** {i.note}</div>}
        </div>
      ))}
      <div className="mt-1 border-t border-dashed border-black" />
    </div>
  );
}

/**
 * Prints what is currently marked for printing. `only='kitchen'` prints just the kitchen ticket even when a receipt
 * is also on screen. window.print() returns once the page has been handed to the printer (immediately in
 * kiosk-printing mode).
 */
export function printNow(only?: 'kitchen' | 'receipt') {
  const root = document.documentElement;
  root.dataset.paper = hwSettings().paper || '80mm';
  if (only) root.dataset.printOnly = only;
  try {
    window.print();
  } finally {
    delete root.dataset.printOnly;
  }
}
