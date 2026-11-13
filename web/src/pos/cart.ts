import { computeCart, type Discount, type TaxDef } from '../../../shared/pricing';
import { uuid } from '../lib/format';

export interface CartLine {
  line_id: string;
  variant_id: string;
  product_id: string;
  name: string;
  variant_name: string;
  base_price: number;
  modifier_ids: string[];
  modifiers: { id: string; name: string; price: number }[];
  qty: number;
  discount?: Discount & { discount_id?: string; name?: string };
  custom_price?: number | null;
  note?: string;
  sent?: boolean;
  tax_ids: string[];
  kitchen_station?: string | null;
  preview_total?: number;
}

export interface Cart {
  items: CartLine[];
  order_discount?: (Discount & { discount_id?: string; name?: string }) | null;
  customer?: any | null;
  dining_option: string;
  table_id?: string | null;
  ticket_id?: string | null;
  ticket_name?: string | null;
  note?: string;
  tip?: number;
}

export const emptyCart = (dining = 'takeaway'): Cart => ({ items: [], order_discount: null, customer: null, dining_option: dining, table_id: null, ticket_id: null, ticket_name: null, tip: 0 });

export const DINING = [
  { id: 'dine_in', label: 'Dine in' }, { id: 'takeaway', label: 'Takeaway' }, { id: 'delivery', label: 'Delivery' }, { id: 'pickup', label: 'Pickup' },
];

export function makeLine(product: any, variant: any, modifiers: any[], qty = 1, categories: any[] = []): CartLine {
  return {
    line_id: uuid(),
    variant_id: variant.id,
    product_id: product.id,
    name: product.name,
    variant_name: variant.name || '',
    base_price: Number(variant.price),
    modifier_ids: modifiers.map((m) => m.id),
    modifiers: modifiers.map((m) => ({ id: m.id, name: m.name, price: Number(m.price) })),
    qty,
    tax_ids: product.tax_ids || [],
    kitchen_station: categories.find((c) => c.id === product.category_id)?.kitchen_station ?? null,
  };
}

/** Client-side preview using the same engine as the server (server stays authoritative). */
export function priceCart(cart: Cart, taxes: any[], servicePct = 0) {
  const tmap = new Map(taxes.map((t) => [t.id, t]));
  const lines = cart.items.map((l) => {
    const base = l.custom_price != null ? Number(l.custom_price) : l.base_price;
    return {
      unit_price: base + l.modifiers.reduce((s, m) => s + m.price, 0),
      qty: l.qty,
      discount: l.discount,
      taxes: l.tax_ids.map((id) => tmap.get(id)).filter(Boolean).map((t: any): TaxDef => ({ id: t.id, name: t.name, rate: Number(t.rate), inclusive: t.inclusive, is_gst: t.is_gst })),
    };
  });
  const res = computeCart(lines, cart.order_discount, { service_charge_pct: cart.dining_option === 'dine_in' ? servicePct : 0, tip: cart.tip });
  return { ...res, unit_prices: lines.map((l) => l.unit_price) };
}

/** Payload sent to POST /sales and /tickets. */
export function toPayload(cart: Cart) {
  return cart.items.map((l) => ({
    line_id: l.line_id, variant_id: l.variant_id, qty: l.qty, modifier_ids: l.modifier_ids, note: l.note, sent: l.sent,
    custom_price: l.custom_price ?? null, discount: l.discount ? { type: l.discount.type, value: l.discount.value, discount_id: l.discount.discount_id } : null,
  }));
}

/** Restore a cart from a saved ticket using the current catalog. */
export function cartFromTicket(t: any, catalog: any): Cart {
  const c = t.cart || {};
  return {
    ...emptyCart(t.dining_option),
    ...c,
    items: (c.items || []).map((it: any) => {
      const p = catalog.products.find((x: any) => x.variants.some((v: any) => v.id === it.variant_id));
      const v = p?.variants.find((x: any) => x.id === it.variant_id);
      const mods = catalog.modifierGroups.flatMap((g: any) => g.options).filter((o: any) => (it.modifier_ids || []).includes(o.id));
      return { ...(p && v ? makeLine(p, v, mods, it.qty, catalog.categories) : { name: it.name || 'Item', variant_name: '', base_price: 0, modifiers: [], tax_ids: [] }), ...it, line_id: it.line_id || uuid() };
    }),
    customer: c.customer ?? null,
    ticket_id: t.id,
    ticket_name: t.name,
    table_id: t.table_id,
    dining_option: t.dining_option,
  };
}
