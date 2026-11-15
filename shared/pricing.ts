// Shared pricing engine used by both the POS client (live cart preview)
// and the server (authoritative recalculation). Keep it dependency-free.

export type Discount = { type: 'percent' | 'fixed'; value: number } | null | undefined;

export interface TaxDef {
  id: string;
  name: string;
  rate: number; // percent, e.g. 5 for 5%
  inclusive: boolean; // price already includes the tax
  is_gst?: boolean; // split into CGST/SGST (intra-state) or IGST (inter-state)
}

export interface LineInput {
  unit_price: number; // base/variant price + modifiers
  qty: number;
  discount?: Discount;
  taxes: TaxDef[];
}

export interface TaxAmount {
  tax_id: string;
  name: string;
  rate: number;
  inclusive: boolean;
  is_gst?: boolean;
  taxable: number;
  amount: number;
}

export interface LineResult {
  gross: number; // unit_price * qty
  line_discount: number;
  order_discount: number; // share of the order-level discount
  net: number; // gross - discounts (still includes inclusive tax)
  taxable: number; // pre-tax base
  tax: number; // all taxes on the line
  excl_tax: number; // exclusive taxes added on top
  total: number; // net + exclusive tax
  taxes: TaxAmount[];
}

export interface CartResult {
  lines: LineResult[];
  subtotal: number; // sum of gross
  line_discounts: number;
  order_discount: number;
  discount_total: number;
  taxable_total: number;
  tax_total: number;
  service_charge: number;
  tip: number;
  total: number;
  tax_summary: TaxAmount[];
}

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function discountAmount(d: Discount, base: number) {
  if (!d || !d.value || base <= 0) return 0;
  if (d.type === 'percent') return r2((base * Math.min(100, Math.max(0, d.value))) / 100);
  return r2(Math.min(Math.max(0, d.value), base));
}

export function computeCart(
  lines: LineInput[],
  orderDiscount?: Discount,
  opts: { service_charge_pct?: number; tip?: number } = {},
): CartResult {
  const pre = lines.map((l) => {
    const gross = r2(l.unit_price * l.qty);
    const ld = discountAmount(l.discount, gross);
    return { gross, ld, after: r2(gross - ld) };
  });
  const sumAfter = r2(pre.reduce((s, p) => s + p.after, 0));
  const od = discountAmount(orderDiscount, sumAfter);

  // Distribute the order discount pro rata; last line absorbs rounding remainder.
  let distributed = 0;
  const lastIdx = pre.map((p) => p.after > 0).lastIndexOf(true);
  const results: LineResult[] = lines.map((l, i) => {
    const p = pre[i];
    let share = 0;
    if (od > 0 && p.after > 0) {
      share = i === lastIdx ? r2(od - distributed) : r2((od * p.after) / sumAfter);
      distributed = r2(distributed + share);
    }
    const net = r2(p.after - share);
    const inclRate = l.taxes.filter((t) => t.inclusive).reduce((s, t) => s + t.rate, 0);
    const base = r2(net / (1 + inclRate / 100));
    const taxes: TaxAmount[] = l.taxes.map((t) => ({
      tax_id: t.id,
      name: t.name,
      rate: t.rate,
      inclusive: t.inclusive,
      is_gst: t.is_gst,
      taxable: base,
      amount: r2((base * t.rate) / 100),
    }));
    // Fix inclusive rounding so base + inclusive taxes == net exactly.
    const inclTaxes = taxes.filter((t) => t.inclusive);
    if (inclTaxes.length) {
      const diff = r2(net - base - inclTaxes.reduce((s, t) => s + t.amount, 0));
      inclTaxes[inclTaxes.length - 1].amount = r2(inclTaxes[inclTaxes.length - 1].amount + diff);
    }
    const excl = r2(taxes.filter((t) => !t.inclusive).reduce((s, t) => s + t.amount, 0));
    const tax = r2(taxes.reduce((s, t) => s + t.amount, 0));
    return {
      gross: p.gross,
      line_discount: p.ld,
      order_discount: share,
      net,
      taxable: base,
      tax,
      excl_tax: excl,
      total: r2(net + excl),
      taxes,
    };
  });

  const sum = (f: (r: LineResult) => number) => r2(results.reduce((s, r) => s + f(r), 0));
  const netTotal = sum((r) => r.net);
  // Service charge is calculated on the pre-tax amount (e.g. Costa Rica's 10% servicio; India's service charge)
  const service_charge = r2((sum((r) => r.taxable) * (opts.service_charge_pct || 0)) / 100);
  const tip = r2(Math.max(0, opts.tip || 0));

  const summary = new Map<string, TaxAmount>();
  for (const r of results)
    for (const t of r.taxes) {
      const cur = summary.get(t.tax_id);
      if (cur) {
        cur.amount = r2(cur.amount + t.amount);
        cur.taxable = r2(cur.taxable + t.taxable);
      } else summary.set(t.tax_id, { ...t });
    }

  return {
    lines: results,
    subtotal: sum((r) => r.gross),
    line_discounts: sum((r) => r.line_discount),
    order_discount: od,
    discount_total: sum((r) => r.line_discount + r.order_discount),
    taxable_total: sum((r) => r.taxable),
    tax_total: sum((r) => r.tax),
    service_charge,
    tip,
    total: r2(netTotal + sum((r) => r.excl_tax) + service_charge + tip),
    tax_summary: [...summary.values()],
  };
}

/** Country presets applied when a business is created. */
export const COUNTRY_PRESETS = {
  CR: {
    label: 'Costa Rica', currency: 'CRC', currency_symbol: '₡', timezone: 'America/Costa_Rica', locale: 'es-CR', date_format: 'DD/MM/YYYY',
    tax_id_label: 'Cédula jurídica', service_charge_pct: 10, points_per_amount: 1000, point_value: 10,
    // IVA (Ley 9635): 13% general; reduced 4%, 2%, 1%; exempt 0%. Prices shown to consumers include IVA.
    taxes: [['IVA 13%', 13, true], ['IVA 4%', 4, true], ['IVA 2%', 2, true], ['IVA 1%', 1, true], ['Exento', 0, true]] as [string, number, boolean][],
    is_gst: false,
    payments: [['Efectivo', 'cash'], ['Tarjeta', 'card'], ['SINPE Móvil', 'bank'], ['Transferencia', 'bank'], ['Cargo a habitación', 'other'], ['Tarjeta de regalo', 'gift_card'], ['Crédito de cliente', 'store_credit']] as [string, string][],
    discounts: [['10% Descuento', 'percent', 10], ['Huésped del hotel 15%', 'percent', 15], ['Personal 20%', 'percent', 20]] as [string, string, number][],
    footer: '¡Gracias por su visita! / Thank you for your visit!\nPura Vida',
    terms:
      'Precios en colones costarricenses (₡) con IVA incluido (Ley 9635).\n' +
      'Consumo en mesa incluye 10% de servicio.\n' +
      'Este tiquete es un comprobante interno; solicite su comprobante electrónico (Hacienda) al cajero.\n' +
      'Cargos a habitación se liquidan en recepción al hacer check-out.\n' +
      'Devoluciones sujetas a las políticas del hotel.',
  },
  IN: {
    label: 'India', currency: 'INR', currency_symbol: '₹', timezone: 'Asia/Kolkata', locale: 'en-IN', date_format: 'DD/MM/YYYY',
    tax_id_label: 'GSTIN', service_charge_pct: 0, points_per_amount: 100, point_value: 1,
    taxes: [['GST 5%', 5, false], ['GST 12%', 12, false], ['GST 18%', 18, false]] as [string, number, boolean][],
    is_gst: true,
    payments: [['Cash', 'cash'], ['Card', 'card'], ['UPI', 'upi'], ['Bank Transfer', 'bank'], ['Gift Card', 'gift_card'], ['Store Credit', 'store_credit']] as [string, string][],
    discounts: [['10% Off', 'percent', 10], ['Staff 20%', 'percent', 20], ['₹50 Off', 'fixed', 50]] as [string, string, number][],
    footer: 'Thank you! Please visit again.',
    terms: '',
  },
} as const;
export type CountryCode = keyof typeof COUNTRY_PRESETS;

/** Split a GST amount into CGST+SGST (intra-state) or IGST (inter-state). */
export function gstSplit(t: TaxAmount, mode: 'intra' | 'inter') {
  if (!t.is_gst) return [{ name: t.name, rate: t.rate, amount: t.amount }];
  if (mode === 'inter') return [{ name: 'IGST', rate: t.rate, amount: t.amount }];
  const half = r2(t.amount / 2);
  return [
    { name: 'CGST', rate: t.rate / 2, amount: half },
    { name: 'SGST', rate: t.rate / 2, amount: r2(t.amount - half) },
  ];
}

export const PERMISSIONS: Record<string, string> = {
  'backoffice.access': 'Access Back Office',
  'pos.sell': 'Make sales on POS',
  'pos.discount': 'Apply discounts',
  'pos.custom_price': 'Change item prices',
  'pos.refund': 'Perform refunds',
  'pos.void': 'Delete items / void open tickets',
  'pos.reprint': 'Reprint receipts',
  'pos.all_tickets': 'Manage open tickets of other employees',
  'shift.manage': 'Open / close shifts',
  'cash.manage': 'Pay in / pay out cash',
  'reports.view': 'View sales reports',
  'products.manage': 'Manage items & categories',
  'inventory.manage': 'Manage inventory & stock',
  'inventory.approve': 'Approve stock adjustments',
  'purchases.manage': 'Manage suppliers & purchase orders',
  'customers.manage': 'Manage customers & loyalty',
  'employees.manage': 'Manage employees & roles',
  'settings.manage': 'Manage settings, taxes, payments, stores',
  'kitchen.view': 'Use Kitchen Display',
  'audit.view': 'View audit log',
  'timeclock.manage': 'Edit attendance records',
  // Payroll Management System
  'payroll.access': 'Open Payroll Management (read-only payroll & reports)',
  'payroll.employees': 'Manage payroll employee records & documents',
  'payroll.salary': 'Change salaries, rates & payroll rules',
  'payroll.attendance': 'Enter & submit attendance / working hours',
  'payroll.process': 'Prepare & calculate payroll, adjustments',
  'payroll.approve': 'Approve, reject & reopen payroll',
  'payroll.payments': 'Record payroll payments',
  'payroll.advances': 'Manage advances (vales) & accounts (cuentas)',
  'payroll.reports': 'Payroll reports, revenue & reconciliation',
  'payroll.settings': 'Payroll settings, departments & holidays',
  'payroll.self': 'View own payslips (employee self-service)',
};

/** Payroll roles added to every business (PRD §3). Owners have every permission. */
export const PAYROLL_ROLES: Record<string, string[]> = {
  'Payroll Admin': ['backoffice.access', 'payroll.access', 'payroll.employees', 'payroll.salary', 'payroll.attendance', 'payroll.process',
    'payroll.payments', 'payroll.advances', 'payroll.reports', 'payroll.settings'],
  'HR Manager': ['backoffice.access', 'payroll.access', 'payroll.employees', 'payroll.salary', 'payroll.attendance'],
  'Payroll Accountant': ['backoffice.access', 'payroll.access', 'payroll.payments', 'payroll.reports', 'audit.view'],
  'Department Manager': ['backoffice.access', 'payroll.attendance'],
  'Auditor': ['backoffice.access', 'payroll.access', 'payroll.reports', 'audit.view', 'reports.view'],
  'Employee': ['backoffice.access', 'payroll.self'],
};
