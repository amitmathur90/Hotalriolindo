-- ITS POS database schema (PostgreSQL). Idempotent: safe to run on every boot.
-- Every tenant-owned row carries business_id for tenant isolation; store-level rows carry store_id.

CREATE TABLE IF NOT EXISTS businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  currency text NOT NULL DEFAULT 'INR',
  currency_symbol text NOT NULL DEFAULT '₹',
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  date_format text NOT NULL DEFAULT 'DD/MM/YYYY',
  address text, phone text, email text, gstin text, logo_url text,
  receipt_footer text DEFAULT 'Thank you! Please visit again.',
  allow_negative_stock boolean NOT NULL DEFAULT true,
  loyalty_enabled boolean NOT NULL DEFAULT true,
  points_per_amount numeric NOT NULL DEFAULT 100,   -- spend this much to earn 1 point
  point_value numeric NOT NULL DEFAULT 1,           -- currency value of 1 point
  min_redeem_points integer NOT NULL DEFAULT 10,
  points_expiry_days integer NOT NULL DEFAULT 365,
  service_charge_pct numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',            -- active | suspended
  plan text NOT NULL DEFAULT 'standard',
  max_stores integer NOT NULL DEFAULT 5,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  address text, phone text, gstin text, state text,
  gst_mode text NOT NULL DEFAULT 'intra',           -- intra (CGST+SGST) | inter (IGST)
  receipt_header text,
  receipt_seq integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '[]',
  is_system boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,  -- null for platform super admin
  name text NOT NULL,
  email text,
  password_hash text,
  pin_hash text,
  role_id uuid REFERENCES roles(id) ON DELETE SET NULL,
  extra_permissions jsonb NOT NULL DEFAULT '[]',
  denied_permissions jsonb NOT NULL DEFAULT '[]',
  store_ids jsonb NOT NULL DEFAULT '[]',            -- empty = all stores
  employee_code text, phone text, designation text, photo_url text,
  joined_on date, salary numeric DEFAULT 0, hourly_rate numeric DEFAULT 0,
  is_owner boolean NOT NULL DEFAULT false,
  is_super_admin boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_pin_uq ON users (business_id, pin_hash) WHERE pin_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS pos_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'pos',                 -- pos | kds | display
  active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid, user_id uuid, method text, ip text, device_id uuid,
  success boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text DEFAULT '#6366f1',
  kitchen_station text,                             -- e.g. Kitchen / Bar; null = not sent to KDS
  sort integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS taxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  rate numeric NOT NULL DEFAULT 0,
  inclusive boolean NOT NULL DEFAULT false,
  is_gst boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  type text NOT NULL DEFAULT 'standard',            -- standard | service | composite | weighted | digital
  unit text NOT NULL DEFAULT 'pcs',
  track_stock boolean NOT NULL DEFAULT true,
  tax_ids jsonb NOT NULL DEFAULT '[]',
  image_url text,
  color text,
  is_favorite boolean NOT NULL DEFAULT false,
  available_store_ids jsonb NOT NULL DEFAULT '[]',  -- empty = all stores
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  sku text, barcode text,
  price numeric NOT NULL DEFAULT 0,
  cost numeric NOT NULL DEFAULT 0,
  wholesale_price numeric,
  reorder_level numeric NOT NULL DEFAULT 0,
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS variants_product_idx ON variants(product_id);
CREATE INDEX IF NOT EXISTS variants_barcode_idx ON variants(business_id, barcode);

-- Store-specific price overrides (multi-store pricing)
CREATE TABLE IF NOT EXISTS store_prices (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  price numeric NOT NULL,
  PRIMARY KEY (store_id, variant_id)
);

-- Recipe / composite components: selling variant consumes component variants
CREATE TABLE IF NOT EXISTS product_components (
  variant_id uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  component_variant_id uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  qty numeric NOT NULL,
  PRIMARY KEY (variant_id, component_variant_id)
);

CREATE TABLE IF NOT EXISTS modifier_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  min_select integer NOT NULL DEFAULT 0,
  max_select integer NOT NULL DEFAULT 0,             -- 0 = unlimited
  options jsonb NOT NULL DEFAULT '[]'                -- [{id,name,price}]
);

CREATE TABLE IF NOT EXISTS product_modifier_groups (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, group_id)
);

CREATE TABLE IF NOT EXISTS inventory (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  qty numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, variant_id)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  store_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  qty_change numeric NOT NULL,
  qty_after numeric,
  reason text NOT NULL,                             -- sale | refund | adjustment | damage | loss | theft | expiry | receive | transfer_out | transfer_in | count | production
  ref_type text, ref_id uuid,
  user_id uuid, note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_mov_idx ON stock_movements(store_id, variant_id, created_at);

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, store_id uuid NOT NULL,
  reason text NOT NULL, note text,
  status text NOT NULL DEFAULT 'pending',           -- pending | approved | rejected
  items jsonb NOT NULL DEFAULT '[]',                -- [{variant_id, qty_change}]
  created_by uuid, approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz
);

CREATE TABLE IF NOT EXISTS stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  from_store_id uuid NOT NULL, to_store_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'requested',         -- requested | approved | rejected | dispatched | received
  items jsonb NOT NULL DEFAULT '[]',                -- [{variant_id, qty, received_qty}]
  note text, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL, contact_person text, phone text, email text, gstin text, address text, notes text,
  balance numeric NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, store_id uuid NOT NULL,
  supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  po_no text NOT NULL,
  status text NOT NULL DEFAULT 'draft',             -- draft | sent | partial | received | cancelled
  expected_date date, notes text, invoice_no text,
  items jsonb NOT NULL DEFAULT '[]',                -- [{variant_id, qty, cost, received_qty}]
  total numeric NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL, phone text, email text, address text, birthday date,
  code text,                                        -- loyalty card / barcode
  notes text, tags text, customer_group text,
  points numeric NOT NULL DEFAULT 0,
  store_credit numeric NOT NULL DEFAULT 0,
  total_spent numeric NOT NULL DEFAULT 0,
  visits integer NOT NULL DEFAULT 0,
  last_visit_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_phone_idx ON customers(business_id, phone);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  sale_id uuid, points numeric NOT NULL,
  type text NOT NULL,                               -- earn | redeem | adjust | refund
  note text, user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'other',               -- cash | card | upi | bank | gift_card | store_credit | other
  store_ids jsonb NOT NULL DEFAULT '[]',
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS discounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'percent',             -- percent | fixed
  value numeric NOT NULL DEFAULT 0,
  scope text NOT NULL DEFAULT 'order',              -- order | item
  coupon_code text,
  restricted boolean NOT NULL DEFAULT false,        -- needs pos.discount permission / manager approval
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS gift_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code text NOT NULL,
  balance numeric NOT NULL DEFAULT 0,
  initial_value numeric NOT NULL DEFAULT 0,
  customer_id uuid, expires_on date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gift_cards_code_uq ON gift_cards(business_id, code);

CREATE TABLE IF NOT EXISTS gift_card_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_card_id uuid NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  sale_id uuid, amount numeric NOT NULL, type text NOT NULL, user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, store_id uuid NOT NULL, device_id uuid,
  opened_by uuid NOT NULL, closed_by uuid,
  opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
  opening_cash numeric NOT NULL DEFAULT 0,
  expected_cash numeric, actual_cash numeric, difference numeric,
  status text NOT NULL DEFAULT 'open',
  close_note text
);

CREATE TABLE IF NOT EXISTS cash_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, store_id uuid NOT NULL,
  shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL,
  user_id uuid NOT NULL,
  type text NOT NULL,                               -- pay_in | pay_out | expense | deposit | withdrawal | supplier_payment
  amount numeric NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, store_id uuid NOT NULL, user_id uuid NOT NULL,
  clock_in timestamptz NOT NULL DEFAULT now(), clock_out timestamptz,
  break_minutes integer NOT NULL DEFAULT 0,
  break_started_at timestamptz,
  note text, edited_by uuid
);

CREATE TABLE IF NOT EXISTS restaurant_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name text NOT NULL, area text DEFAULT 'Main', capacity integer NOT NULL DEFAULT 4,
  status text NOT NULL DEFAULT 'available',         -- available | occupied | reserved
  sort integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS open_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, store_id uuid NOT NULL,
  user_id uuid, name text NOT NULL,
  table_id uuid REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  customer_id uuid,
  dining_option text NOT NULL DEFAULT 'dine_in',
  cart jsonb NOT NULL DEFAULT '{}',
  total numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, store_id uuid NOT NULL,
  client_uuid uuid NOT NULL,                        -- idempotency key generated by the POS (offline-safe)
  device_id uuid,
  receipt_no text NOT NULL,
  type text NOT NULL DEFAULT 'sale',                -- sale | refund
  original_sale_id uuid REFERENCES sales(id),
  user_id uuid, customer_id uuid, shift_id uuid,
  dining_option text, table_name text, ticket_name text,
  status text NOT NULL DEFAULT 'completed',         -- completed | partially_refunded | refunded
  subtotal numeric NOT NULL DEFAULT 0,
  discount_total numeric NOT NULL DEFAULT 0,
  tax_total numeric NOT NULL DEFAULT 0,
  service_charge numeric NOT NULL DEFAULT 0,
  tip numeric NOT NULL DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,
  cost_total numeric NOT NULL DEFAULT 0,
  paid numeric NOT NULL DEFAULT 0,
  change numeric NOT NULL DEFAULT 0,
  points_earned numeric NOT NULL DEFAULT 0,
  points_redeemed numeric NOT NULL DEFAULT 0,
  order_discount jsonb, tax_summary jsonb NOT NULL DEFAULT '[]',
  note text, refund_reason text,
  offline boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_client_uuid_uq ON sales(business_id, client_uuid);
CREATE INDEX IF NOT EXISTS sales_store_date_idx ON sales(store_id, created_at);

CREATE TABLE IF NOT EXISTS sale_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  original_item_id uuid,
  variant_id uuid, product_id uuid, category_id uuid,
  product_name text NOT NULL, variant_name text,
  qty numeric NOT NULL,
  unit_price numeric NOT NULL,
  modifiers jsonb NOT NULL DEFAULT '[]',
  gross numeric NOT NULL DEFAULT 0,
  discount numeric NOT NULL DEFAULT 0,
  tax numeric NOT NULL DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,
  cost numeric NOT NULL DEFAULT 0,
  taxes jsonb NOT NULL DEFAULT '[]',
  note text,
  refunded_qty numeric NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sale_items_sale_idx ON sale_items(sale_id);

CREATE TABLE IF NOT EXISTS sale_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method_id uuid, method_name text NOT NULL, method_type text NOT NULL,
  amount numeric NOT NULL,
  reference text
);

CREATE TABLE IF NOT EXISTS kitchen_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, store_id uuid NOT NULL,
  ticket_id uuid, sale_id uuid,
  order_label text NOT NULL,
  dining_option text, table_name text,
  station text NOT NULL DEFAULT 'Kitchen',
  items jsonb NOT NULL DEFAULT '[]',                -- [{name, qty, modifiers, note, done}]
  status text NOT NULL DEFAULT 'new',               -- new | preparing | ready | served | cancelled
  priority text NOT NULL DEFAULT 'normal',          -- normal | rush
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz, ready_at timestamptz, completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS kitchen_store_status_idx ON kitchen_orders(store_id, status);

CREATE TABLE IF NOT EXISTS expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, store_id uuid,
  category text NOT NULL, amount numeric NOT NULL, note text,
  spent_on date NOT NULL DEFAULT CURRENT_DATE, user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, store_id uuid,
  type text NOT NULL, message text NOT NULL, data jsonb,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid, store_id uuid, user_id uuid, user_name text,
  action text NOT NULL, entity text, entity_id text,
  details jsonb, ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_business_idx ON audit_logs(business_id, created_at);

-- Incremental migrations (idempotent)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS upi_id text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'IN';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'en-IN';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tax_id_label text NOT NULL DEFAULT 'GSTIN';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS terms text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tax_id text;

-- Costa Rica electronic invoicing (Hacienda, comprobantes electrónicos v4.4)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS id_type text;             -- 01 física | 02 jurídica | 03 DIMEX | 04 NITE | 05 extranjero
ALTER TABLE customers ADD COLUMN IF NOT EXISTS activity_code text;       -- receptor's economic activity (optional on facturas)
ALTER TABLE products ADD COLUMN IF NOT EXISTS cabys text;                -- 13-digit CABYS code
ALTER TABLE categories ADD COLUMN IF NOT EXISTS cabys text;              -- default CABYS for the category's products
ALTER TABLE stores ADD COLUMN IF NOT EXISTS hacienda_branch text;        -- sucursal (3 digits) in the consecutivo

CREATE TABLE IF NOT EXISTS hacienda_settings (
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  environment text NOT NULL DEFAULT 'stag',          -- stag (pruebas) | prod (producción)
  legal_name text, trade_name text,
  id_type text NOT NULL DEFAULT '02', id_number text,
  activity_code text, provider_id text,
  provincia text, canton text, distrito text, barrio text, otras_senas text,
  phone text, email text,
  default_cabys text,
  resolution_text text,
  api_username text, api_password_enc text,
  cert_p12_enc text, cert_pin_enc text, cert_subject text, cert_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hacienda_sequences (
  business_id uuid NOT NULL, environment text NOT NULL, branch text NOT NULL, terminal text NOT NULL, doc_type text NOT NULL,
  last bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, environment, branch, terminal, doc_type)
);

CREATE TABLE IF NOT EXISTS e_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, store_id uuid NOT NULL,
  sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  doc_type text NOT NULL,                            -- 01 factura | 03 nota de crédito | 04 tiquete
  environment text NOT NULL,
  clave text NOT NULL UNIQUE, consecutivo text NOT NULL,
  situacion text NOT NULL DEFAULT '1',
  issued_at timestamptz NOT NULL,
  receptor jsonb,                                    -- {nombre, id_type, id_number, email, activity_code}
  reference jsonb,                                   -- {doc_id, doc_type, clave, issued_at, code, reason}
  status text NOT NULL DEFAULT 'pending',            -- pending | sent | accepted | rejected | error
  message text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  total numeric,
  xml_signed text, response_xml text,
  replaced_by uuid,                                  -- tiquete annulled and replaced by a factura
  emailed_at timestamptz, email_error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS e_documents_sale_idx ON e_documents(sale_id);
CREATE INDEX IF NOT EXISTS e_documents_queue_idx ON e_documents(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS e_documents_business_idx ON e_documents(business_id, created_at);

-- ---------------------------------------------------------------- Cubo replacement (manual invoices, USD, suppliers, integrations)
-- Documents not tied to a POS sale (manual invoices, Cloudbeds check-outs) keep their lines in payload.
ALTER TABLE e_documents ALTER COLUMN sale_id DROP NOT NULL;
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'pos';        -- pos | manual | cloudbeds
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS payload jsonb;                             -- {lines, payments, condition, credit_days, notes, service_charge, tip}
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'CRC';      -- CRC | USD
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS exchange_rate numeric NOT NULL DEFAULT 1;  -- colones per document currency unit
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS external_ref text;                         -- e.g. Cloudbeds reservation ID
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS annulled_by uuid;                          -- nota de crédito that annulled it
ALTER TABLE hacienda_settings ADD COLUMN IF NOT EXISTS terminal text NOT NULL DEFAULT '00001';
ALTER TABLE hacienda_settings ADD COLUMN IF NOT EXISTS usd_rate_manual numeric;             -- fixed T/C (else Hacienda/BCCR daily rate)
ALTER TABLE hacienda_settings ADD COLUMN IF NOT EXISTS imap_host text;
ALTER TABLE hacienda_settings ADD COLUMN IF NOT EXISTS imap_port integer;
ALTER TABLE hacienda_settings ADD COLUMN IF NOT EXISTS imap_user text;
ALTER TABLE hacienda_settings ADD COLUMN IF NOT EXISTS imap_pass_enc text;
ALTER TABLE hacienda_settings ADD COLUMN IF NOT EXISTS imap_last_check timestamptz;
ALTER TABLE hacienda_settings ADD COLUMN IF NOT EXISTS imap_error text;
ALTER TABLE hacienda_settings ADD COLUMN IF NOT EXISTS auto_accept boolean NOT NULL DEFAULT false;
ALTER TABLE hacienda_settings ADD COLUMN IF NOT EXISTS expense_category text;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS supplier_id uuid;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS received_doc_id uuid;

CREATE TABLE IF NOT EXISTS exchange_rates (
  currency text NOT NULL, rate_date date NOT NULL,
  buy numeric, sell numeric NOT NULL, source text NOT NULL DEFAULT 'hacienda',
  PRIMARY KEY (currency, rate_date)
);

-- Supplier comprobantes received (Doc Recibidos) and our Mensaje Receptor answer.
CREATE TABLE IF NOT EXISTS received_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  clave text NOT NULL, doc_type text NOT NULL, consecutivo text,
  issued_at timestamptz, emisor_name text, emisor_id_type text, emisor_id text, emisor_email text,
  receptor_id text, currency text NOT NULL DEFAULT 'CRC', exchange_rate numeric NOT NULL DEFAULT 1,
  total numeric NOT NULL DEFAULT 0, total_tax numeric NOT NULL DEFAULT 0, activity_code text,
  xml text NOT NULL, source text NOT NULL DEFAULT 'upload',                -- upload | email
  decision text,                                                           -- 05 aceptado | 06 parcial | 07 rechazado
  decision_detail text, condicion_impuesto text,
  mr_consecutivo text, mr_status text,                                     -- pending | sent | accepted | rejected | error
  mr_message text, mr_xml text, mr_response_xml text, mr_attempts integer NOT NULL DEFAULT 0, mr_next_attempt_at timestamptz,
  expense_id uuid, supplier_id uuid, expense_category text,
  decided_by uuid, decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, clave)
);
CREATE INDEX IF NOT EXISTS received_documents_queue_idx ON received_documents(mr_status, mr_next_attempt_at);

-- External systems (Cloudbeds, QuickBooks Online): settings with secrets encrypted inside config.
CREATE TABLE IF NOT EXISTS integrations (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}',
  last_sync_at timestamptz, last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, provider)
);

CREATE TABLE IF NOT EXISTS cloudbeds_reservations (
  business_id uuid NOT NULL, reservation_id text NOT NULL,
  guest_name text, check_in date, check_out date, total numeric, currency text,
  status text NOT NULL DEFAULT 'new',                                      -- new | issued | skipped | error
  e_document_id uuid, message text, data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, reservation_id)
);

-- What was sent to QuickBooks (one journal entry per day, one bill per supplier invoice).
CREATE TABLE IF NOT EXISTS qb_postings (
  business_id uuid NOT NULL, kind text NOT NULL, ref text NOT NULL,       -- kind: sales_day | bill ; ref: YYYY-MM-DD | received_documents.id
  qb_id text, status text NOT NULL DEFAULT 'ok', message text, amount numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, kind, ref)
);

-- ---------------------------------------------------------------- Hacienda PRD: audit trail, snapshots, terminals, CABYS catalogue
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS xml_unsigned text;          -- immutable snapshot of the generated XML (before signing)
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS xml_hash text;              -- sha256 of xml_unsigned
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS signed_hash text;           -- sha256 of xml_signed
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS schema_version text;        -- e.g. v4.4
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS rules_version text;         -- tax/document rules used by the engine
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS terminal text;              -- terminal (5) used in the consecutivo
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS submitted_at timestamptz;   -- first time Hacienda received it
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS decided_at timestamptz;     -- final answer (accepted / rejected)
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS ambiguous boolean NOT NULL DEFAULT false; -- send timed out: reconcile before resending
ALTER TABLE e_documents ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS e_documents_idem_uq ON e_documents(business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS e_documents_cons_uq ON e_documents(business_id, environment, consecutivo);
ALTER TABLE hacienda_settings ADD COLUMN IF NOT EXISTS registro_fiscal_8707 text;  -- registro de bebidas alcohólicas (Ley 8707)
ALTER TABLE hacienda_settings ADD COLUMN IF NOT EXISTS cert_alert_sent_at timestamptz;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS hacienda_activity text;          -- actividad económica of this branch (e.g. 561001 restaurant)
ALTER TABLE pos_devices ADD COLUMN IF NOT EXISTS hacienda_terminal text;     -- terminal (5 digits) of this POS device
ALTER TABLE products ADD COLUMN IF NOT EXISTS hacienda_unit text;            -- unidad de medida (Unid, Sp, kg, L…)

-- Lifecycle history of every electronic document: validation, signing, each submission attempt, status checks, e-mails
CREATE TABLE IF NOT EXISTS e_document_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  business_id uuid NOT NULL,
  kind text NOT NULL,                     -- created | validated | validation_failed | signed | submit | status | accepted | rejected | auth_error | reconcile | email | retry | note
  status text,                            -- document status after the event
  http_status integer,
  message text,
  detail jsonb,
  created_by uuid, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS e_document_events_doc_idx ON e_document_events(document_id, created_at);

CREATE TABLE IF NOT EXISTS e_document_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL, business_id uuid NOT NULL,
  recipient text NOT NULL, status text NOT NULL,   -- sent | failed
  error text, attachments text[],
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS e_document_emails_doc_idx ON e_document_emails(document_id);

-- Official CABYS catalogue (imported from the BCCR / Hacienda file, versioned)
CREATE TABLE IF NOT EXISTS cabys_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL, source text, codes integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true, imported_by uuid, imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cabys_codes (
  code text PRIMARY KEY, description text NOT NULL, tax_rate numeric, version text, active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cabys_codes_desc_idx ON cabys_codes (lower(description));

-- History of product ↔ CABYS assignments
CREATE TABLE IF NOT EXISTS product_cabys_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, product_id uuid NOT NULL,
  old_code text, new_code text, old_unit text, new_unit text,
  user_id uuid, user_name text, created_at timestamptz NOT NULL DEFAULT now()
);
