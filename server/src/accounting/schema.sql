-- ================================================================ Accounting (contabilidad) — replaces QuickBooks
-- Chart of accounts. "key" marks the accounts the automatic postings use (cash, bank_crc, ar, iva_payable, …).
CREATE TABLE IF NOT EXISTS acc_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code text NOT NULL, name text NOT NULL,
  type text NOT NULL,                                -- asset | liability | equity | income | expense
  subtype text,                                      -- cash | bank | receivable | payable | inventory | fixed | tax | cogs | other
  currency text NOT NULL DEFAULT 'CRC',              -- CRC | USD (USD accounts also keep the dollar amount)
  key text,                                          -- system key used by automatic postings
  cash_flow text,                                    -- operating | investing | financing
  bank_name text, bank_account text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS acc_accounts_code_uq ON acc_accounts (business_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS acc_accounts_key_uq ON acc_accounts (business_id, key) WHERE key IS NOT NULL;

CREATE TABLE IF NOT EXISTS acc_settings (
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  locked_until date,                                 -- periods up to this date are closed
  start_date date,                                   -- automatic postings from this date (earlier = opening balances)
  employer_ccss_rate numeric NOT NULL DEFAULT 26.67, -- cargas sociales patronales on payroll earnings (%)
  expense_paid_from text NOT NULL DEFAULT 'cash',    -- account key for expenses entered by hand (cash | petty_cash | bank_crc)
  category_map jsonb NOT NULL DEFAULT '{}',          -- expense category → account id
  last_sync_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Journal entries. Automatic ones are linked to their source (one per source); "hash" detects source changes,
-- in which case the old entry is reversed and a new one posted (the ledger is never edited in place).
CREATE TABLE IF NOT EXISTS acc_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  number bigint NOT NULL,
  entry_date date NOT NULL,
  memo text,
  source text NOT NULL DEFAULT 'manual',             -- manual | sale | edoc | received | expense | payroll | payroll_payment | payment | bank | reval | closing | opening
  source_id text,
  hash text,
  active boolean NOT NULL DEFAULT true,              -- false once reversed / superseded
  reverses uuid, reversed_by uuid,
  created_by uuid, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS acc_entries_number_uq ON acc_entries (business_id, number);
CREATE INDEX IF NOT EXISTS acc_entries_source_idx ON acc_entries (business_id, source, source_id) WHERE active;
CREATE INDEX IF NOT EXISTS acc_entries_date_idx ON acc_entries (business_id, entry_date);

CREATE TABLE IF NOT EXISTS acc_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES acc_entries(id) ON DELETE CASCADE,
  business_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES acc_accounts(id),
  debit numeric NOT NULL DEFAULT 0,                  -- colones
  credit numeric NOT NULL DEFAULT 0,                 -- colones
  amount_fc numeric,                                 -- signed amount in the account's foreign currency (USD accounts)
  description text,
  partner text,
  bank_line_id uuid                                  -- matched bank statement line
);
CREATE INDEX IF NOT EXISTS acc_lines_entry_idx ON acc_lines (entry_id);
CREATE INDEX IF NOT EXISTS acc_lines_account_idx ON acc_lines (business_id, account_id);

-- Accounts receivable (credit invoices) and payable (supplier invoices).
CREATE TABLE IF NOT EXISTS acc_open_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind text NOT NULL,                                -- ar | ap
  source text NOT NULL, source_id text NOT NULL,     -- edoc | received | manual
  partner_name text NOT NULL, partner_id text, partner_email text,
  number text, issue_date date NOT NULL, due_date date,
  currency text NOT NULL DEFAULT 'CRC', exchange_rate numeric NOT NULL DEFAULT 1,
  total numeric NOT NULL,                            -- in the item currency
  credited numeric NOT NULL DEFAULT 0,               -- credit notes applied
  paid numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',               -- open | paid | void
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, source, source_id)
);

CREATE TABLE IF NOT EXISTS acc_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind text NOT NULL,                                -- receipt (customer pays us) | payment (we pay a supplier)
  payment_date date NOT NULL,
  account_id uuid NOT NULL REFERENCES acc_accounts(id),
  currency text NOT NULL DEFAULT 'CRC', exchange_rate numeric NOT NULL DEFAULT 1,
  amount numeric NOT NULL,
  partner_name text, reference text, memo text,
  allocations jsonb NOT NULL DEFAULT '[]',           -- [{item_id, amount}] in the payment currency
  voided boolean NOT NULL DEFAULT false,
  created_by uuid, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Bank statement lines imported from the bank's CSV / Excel export.
CREATE TABLE IF NOT EXISTS acc_bank_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES acc_accounts(id),
  line_date date NOT NULL, description text, reference text,
  amount numeric NOT NULL,                           -- + deposit / − withdrawal, in the account currency
  balance numeric,
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'open',               -- open | matched | ignored
  acc_line_id uuid,
  batch text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, account_id, fingerprint)
);
