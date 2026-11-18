import bcrypt from 'bcryptjs';
import { db, json, tx, type Q } from './db.ts';
import { hashPin } from './auth.ts';
import { COUNTRY_PRESETS, type CountryCode } from '../../shared/pricing.ts';
import { MULTI_TENANT } from './config.ts';

export const DEFAULT_ROLES: Record<string, string[]> = {
  Owner: ['*'],
  'Store Manager': [
    'backoffice.access', 'pos.sell', 'pos.discount', 'pos.custom_price', 'pos.refund', 'pos.void', 'pos.reprint',
    'pos.all_tickets', 'shift.manage', 'cash.manage', 'reports.view', 'products.manage', 'inventory.manage',
    'inventory.approve', 'purchases.manage', 'customers.manage', 'employees.manage', 'kitchen.view', 'timeclock.manage',
  ],
  Cashier: ['pos.sell', 'pos.reprint', 'shift.manage', 'customers.manage'],
  'Inventory Manager': ['backoffice.access', 'inventory.manage', 'purchases.manage', 'products.manage'],
  'Kitchen Staff': ['kitchen.view'],
  Accountant: ['backoffice.access', 'reports.view', 'audit.view', 'accounting.view', 'accounting.manage'],
};

export interface NewBusiness {
  businessName: string;
  ownerName: string;
  email: string;
  password: string;
  pin?: string;
  storeName?: string;
  phone?: string;
  country?: string;
}

/** Creates a tenant with country defaults: store, roles, owner, taxes, payment methods, discounts. */
export async function createBusiness(q: Q, nb: NewBusiness) {
  const code = (nb.country && nb.country in COUNTRY_PRESETS ? nb.country : 'CR') as CountryCode;
  const c = COUNTRY_PRESETS[code];
  const b = await q.one(
    `INSERT INTO businesses (name, email, phone, country, currency, currency_symbol, timezone, locale, date_format, tax_id_label,
       service_charge_pct, points_per_amount, point_value, receipt_footer, terms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [nb.businessName, nb.email, nb.phone ?? null, code, c.currency, c.currency_symbol, c.timezone, c.locale, c.date_format, c.tax_id_label,
     c.service_charge_pct, c.points_per_amount, c.point_value, c.footer, c.terms || null],
  );
  const store = await q.one(`INSERT INTO stores (business_id, name) VALUES ($1,$2) RETURNING *`, [b!.id, nb.storeName || 'Main Store']);
  const roles: Record<string, string> = {};
  for (const [name, perms] of Object.entries(DEFAULT_ROLES)) {
    const r = await q.one(`INSERT INTO roles (business_id, name, permissions, is_system) VALUES ($1,$2,$3,$4) RETURNING id`, [
      b!.id, name, json(perms), name === 'Owner',
    ]);
    roles[name] = r!.id;
  }
  const owner = await q.one(
    `INSERT INTO users (business_id, name, email, password_hash, pin_hash, role_id, is_owner, employee_code, designation, joined_on)
     VALUES ($1,$2,$3,$4,$5,$6,true,'EMP001','Owner',CURRENT_DATE) RETURNING id`,
    [b!.id, nb.ownerName, nb.email.toLowerCase(), await bcrypt.hash(nb.password, 10), hashPin(b!.id, nb.pin || '1111'), roles.Owner],
  );
  for (const [i, [name, type]] of c.payments.entries())
    await q.query(`INSERT INTO payment_methods (business_id, name, type, sort) VALUES ($1,$2,$3,$4)`, [b!.id, name, type, i]);
  for (const [name, rate, incl] of c.taxes)
    await q.query(`INSERT INTO taxes (business_id, name, rate, inclusive, is_gst) VALUES ($1,$2,$3,$4,$5)`, [b!.id, name, rate, incl, c.is_gst]);
  for (const [name, type, value] of c.discounts)
    await q.query(`INSERT INTO discounts (business_id, name, type, value, scope) VALUES ($1,$2,$3,$4,'order')`, [b!.id, name, type, value]);
  return { business: b!, store: store!, ownerId: owner!.id, roles };
}

/**
 * Demo tenant: Hotel Rio Lindo (Costa Rica) — restaurant and pool bar.
 * Address, phone and cédula jurídica are PLACEHOLDERS to be replaced in Settings.
 */
export async function seedDemo() {
  const exists = await db.one(`SELECT id FROM users WHERE lower(email)='owner@demo.com'`);
  if (exists) return false;
  // Single-hotel mode: never add the demo next to a real hotel set up via first-run setup.
  if (!MULTI_TENANT && (await db.one(`SELECT 1 FROM businesses LIMIT 1`))) return false;
  await tx(async (q) => {
    if (MULTI_TENANT) {
      await q.query(
        `INSERT INTO users (business_id, name, email, password_hash, is_super_admin) VALUES (NULL,'Platform Admin','admin@itspos.local',$1,true)`,
        [await bcrypt.hash('admin123', 10)],
      );
    }
    const { business: b, store, roles } = await createBusiness(q, {
      businessName: 'Hotel Rio Lindo', ownerName: 'Gerencia Rio Lindo', email: 'owner@demo.com', password: 'demo123', pin: '1111',
      storeName: 'Restaurante Rio Lindo', country: 'CR',
    });
    const addr = 'Dirección del hotel (editar en Configuración), Costa Rica';
    await q.query(`UPDATE businesses SET address=$2, phone='+506 0000-0000', gstin='3-101-000000' WHERE id=$1`, [b.id, addr]);
    await q.query(`UPDATE stores SET address=$2, gstin='3-101-000000', receipt_header='Restaurante · Hotel Rio Lindo' WHERE id=$1`, [store.id, addr]);
    const store2 = await q.one(
      `INSERT INTO stores (business_id, name, address, gstin, receipt_header, created_at) VALUES ($1,'Bar Piscina',$2,'3-101-000000','Bar Piscina · Hotel Rio Lindo', now() + interval '1 second') RETURNING id`,
      [b.id, addr],
    );

    const staff: [string, string, string, string, string | null][] = [
      ['María Fernández', 'Store Manager', '2222', 'EMP002', 'manager@demo.com'],
      ['José Rodríguez', 'Cashier', '3333', 'EMP003', null],
      ['Carlos Jiménez', 'Kitchen Staff', '4444', 'EMP004', null],
      ['Ana Vargas', 'Accountant', '5555', 'EMP005', null],
    ];
    for (const [name, role, pin, code, email] of staff)
      await q.query(
        `INSERT INTO users (business_id, name, email, password_hash, pin_hash, role_id, employee_code, designation, joined_on, hourly_rate, salary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_DATE - 90, 0, 450000)`,
        [b.id, name, email, email ? await bcrypt.hash('demo123', 10) : null, hashPin(b.id, pin), roles[role], code, role],
      );

    const iva = async (rate: number) => (await q.one(`SELECT id FROM taxes WHERE business_id=$1 AND rate=$2`, [b.id, rate]))!.id;
    const iva13 = await iva(13);
    const exento = await iva(0);

    const cats: Record<string, string> = {};
    for (const [i, [name, color, station]] of [
      ['Bebidas calientes', '#92400e', 'Bar'], ['Desayunos', '#c2410c', 'Cocina'], ['Repostería', '#be185d', 'Cocina'],
      ['Platos fuertes', '#4d7c0f', 'Cocina'], ['Bebidas frías', '#0369a1', 'Bar'], ['Tienda', '#6d28d9', null],
    ].entries()) {
      const c = await q.one(`INSERT INTO categories (business_id, name, color, kitchen_station, sort) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [b.id, name, color, station, i]);
      cats[name as string] = c!.id;
    }

    const leche = await q.one(`INSERT INTO modifier_groups (business_id, name, min_select, max_select, options) VALUES ($1,'Leche',0,1,$2) RETURNING id`, [
      b.id, json([{ id: 'm1', name: 'Leche de almendra', price: 600 }, { id: 'm2', name: 'Leche deslactosada', price: 300 }, { id: 'm3', name: 'Leche descremada', price: 0 }]),
    ]);
    const extras = await q.one(`INSERT INTO modifier_groups (business_id, name, min_select, max_select, options) VALUES ($1,'Extras',0,0,$2) RETURNING id`, [
      b.id, json([{ id: 'e1', name: 'Shot extra de espresso', price: 500 }, { id: 'e2', name: 'Crema batida', price: 400 }, { id: 'e3', name: 'Sirope de caramelo', price: 400 }]),
    ]);
    const azucar = await q.one(`INSERT INTO modifier_groups (business_id, name, min_select, max_select, options) VALUES ($1,'Azúcar',1,1,$2) RETURNING id`, [
      b.id, json([{ id: 's1', name: 'Con azúcar', price: 0 }, { id: 's2', name: 'Poca azúcar', price: 0 }, { id: 's3', name: 'Sin azúcar', price: 0 }]),
    ]);
    const huevos = await q.one(`INSERT INTO modifier_groups (business_id, name, min_select, max_select, options) VALUES ($1,'Huevos',1,1,$2) RETURNING id`, [
      b.id, json([{ id: 'h1', name: 'Huevos fritos', price: 0 }, { id: 'h2', name: 'Huevos revueltos', price: 0 }, { id: 'h3', name: 'Huevo cocido', price: 0 }]),
    ]);

    type P = { name: string; cat: string; tax?: string; variants: [string, number, number, string?][]; mods?: string[]; fav?: boolean; type?: string; unit?: string; track?: boolean };
    // Prices in colones, IVA 13% included
    const products: P[] = [
      { name: 'Capuchino', cat: 'Bebidas calientes', fav: true, variants: [['Regular', 2200, 600], ['Grande', 2800, 780]], mods: [leche!.id, extras!.id, azucar!.id], track: false },
      { name: 'Café chorreado', cat: 'Bebidas calientes', fav: true, variants: [['Taza', 1500, 300], ['Jarra', 4500, 900]], mods: [azucar!.id], track: false },
      { name: 'Café latte', cat: 'Bebidas calientes', variants: [['Regular', 2400, 650], ['Grande', 3000, 820]], mods: [leche!.id, extras!.id, azucar!.id], track: false },
      { name: 'Chocolate caliente', cat: 'Bebidas calientes', variants: [['', 2300, 700]], mods: [leche!.id], track: false },
      { name: 'Té de manzanilla', cat: 'Bebidas calientes', variants: [['', 1400, 250]], track: false },
      { name: 'Gallo pinto tradicional', cat: 'Desayunos', fav: true, variants: [['', 4200, 1400]], mods: [huevos!.id], track: false },
      { name: 'Desayuno americano', cat: 'Desayunos', variants: [['', 5200, 1900]], mods: [huevos!.id], track: false },
      { name: 'Empanada de queso', cat: 'Repostería', fav: true, variants: [['', 1200, 400, '7441000000011']] },
      { name: 'Pan de banano', cat: 'Repostería', variants: [['Tajada', 1600, 500, '7441000000028']] },
      { name: 'Tres leches', cat: 'Repostería', variants: [['Porción', 2800, 900]] },
      { name: 'Casado con pollo', cat: 'Platos fuertes', fav: true, variants: [['', 5500, 2000]], track: false },
      { name: 'Arroz con camarones', cat: 'Platos fuertes', variants: [['', 7800, 3100]], track: false },
      { name: 'Patacones con frijolitos', cat: 'Platos fuertes', variants: [['Regular', 3800, 1100], ['Para compartir', 5900, 1700]], track: false },
      { name: 'Batido natural', cat: 'Bebidas frías', fav: true, variants: [['En agua', 2200, 600], ['En leche', 2600, 750]], track: false },
      { name: 'Agua Cristal 600ml', cat: 'Bebidas frías', variants: [['', 1000, 400, '7441000000035']] },
      { name: 'Cerveza Imperial', cat: 'Bebidas frías', variants: [['', 2200, 900, '7441000000042']] },
      { name: 'Café Rio Lindo 340g', cat: 'Tienda', tax: 'exento', variants: [['Molido', 6500, 3200, '7441000000059'], ['En grano', 6500, 3200, '7441000000066']] },
      { name: 'Taza Rio Lindo', cat: 'Tienda', variants: [['Blanca', 6500, 2400, '7441000000073'], ['Negra', 6500, 2400, '7441000000080']] },
    ];
    let sku = 1000;
    for (const p of products) {
      const pr = await q.one(
        `INSERT INTO products (business_id, category_id, name, type, unit, track_stock, tax_ids, is_favorite) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [b.id, cats[p.cat], p.name, p.type || 'standard', p.unit || 'pcs', p.track ?? true, json([p.tax === 'exento' ? exento : iva13]), !!p.fav],
      );
      for (const [i, [vn, price, cost, barcode]] of p.variants.entries()) {
        const v = await q.one(
          `INSERT INTO variants (business_id, product_id, name, sku, barcode, price, cost, reorder_level, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [b.id, pr!.id, vn, `RL${sku++}`, barcode ?? null, price, cost, 10, i],
        );
        if (p.track ?? true) await q.query(`INSERT INTO inventory (store_id, variant_id, qty) VALUES ($1,$2,60), ($3,$2,30)`, [store.id, v!.id, store2!.id]);
      }
      for (const g of p.mods || []) await q.query(`INSERT INTO product_modifier_groups VALUES ($1,$2)`, [pr!.id, g]);
    }

    for (const [i, t] of ['Mesa 1', 'Mesa 2', 'Mesa 3', 'Mesa 4', 'Mesa 5', 'Mesa 6', 'Terraza 1', 'Terraza 2'].entries())
      await q.query(`INSERT INTO restaurant_tables (business_id, store_id, name, area, capacity, sort) VALUES ($1,$2,$3,$4,$5,$6)`, [
        b.id, store.id, t, t.startsWith('Terraza') ? 'Terraza' : 'Salón', i % 3 === 0 ? 6 : 4, i,
      ]);
    for (const [i, t] of ['Piscina 1', 'Piscina 2', 'Piscina 3', 'Barra'].entries())
      await q.query(`INSERT INTO restaurant_tables (business_id, store_id, name, area, capacity, sort) VALUES ($1,$2,$3,'Piscina',4,$4)`, [b.id, store2!.id, t, i]);

    for (const [name, phone, email, pts, ced] of [
      ['Laura Mora', '88112233', 'laura.mora@example.com', 120, '1-1234-0567'], ['Diego Solís', '87223344', null, 45, null], ['Sofía Castro', '86334455', 'sofia.castro@example.com', 0, null],
    ] as const)
      await q.query(`INSERT INTO customers (business_id, name, phone, email, points, code, tax_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [b.id, name, phone, email, pts, `C${phone.slice(-6)}`, ced]);

    await q.query(`INSERT INTO suppliers (business_id, name, contact_person, phone, gstin) VALUES ($1,'Dos Pinos (lácteos)','Ventas','+506 0000-0001','3-004-000001'), ($1,'Café de la Zona S.A.','Ventas','+506 0000-0002','3-101-000002')`, [b.id]);
    await q.query(`INSERT INTO gift_cards (business_id, code, balance, initial_value) VALUES ($1,'REGALO-25000',25000,25000)`, [b.id]);
  });
  return true;
}
