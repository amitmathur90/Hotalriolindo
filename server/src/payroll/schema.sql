-- Payroll Management System schema (PostgreSQL). Idempotent: runs on every boot after schema.sql.
-- All money columns are NUMERIC (never floating point). Every row carries business_id for tenant isolation.

-- ---------------------------------------------------------------- Departments & positions (Module 3)
CREATE TABLE IF NOT EXISTS pr_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text,                                        -- short code used in reports
  expense_account text,                             -- e.g. 6010-BAR STAFF SALARY
  manager_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  accounts_deduction_pct numeric,                   -- overrides the rule set for this department (null = rule)
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_departments_name_uq ON pr_departments (business_id, lower(name));

CREATE TABLE IF NOT EXISTS pr_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  department_id uuid REFERENCES pr_departments(id) ON DELETE SET NULL,
  name text NOT NULL,
  minimum_salary numeric,                           -- legal minimum monthly salary reference for the position
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- Payroll rules, effective-dated (PRD §8)
CREATE TABLE IF NOT EXISTS pr_rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  effective_from date NOT NULL,
  rules jsonb NOT NULL,                             -- PayrollRules (shared/payroll.ts)
  notes text,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pr_rule_sets_idx ON pr_rule_sets (business_id, effective_from);

-- ---------------------------------------------------------------- Employees (Module 2)
CREATE TABLE IF NOT EXISTS pr_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code text NOT NULL,                               -- auto-generated E0001
  full_name text NOT NULL,
  short_name text,                                  -- names used in older workbook sheets (Jazz, Kat …) for matching
  cedula text,                                      -- TEXT keeps formatting (1-0000-0000)
  email text, phone text, address text, birth_date date,
  department_id uuid REFERENCES pr_departments(id) ON DELETE SET NULL,
  position_id uuid REFERENCES pr_positions(id) ON DELETE SET NULL,
  employment_type text NOT NULL DEFAULT 'monthly',  -- hourly | monthly | temporary
  joining_date date, leaving_date date,
  status text NOT NULL DEFAULT 'active',            -- active | inactive | suspended
  currency text NOT NULL DEFAULT 'CRC',             -- CRC | USD
  bank_name text, bank_account text,
  bank_group text,                                  -- BCR | Non-BCR | Other
  payment_method text NOT NULL DEFAULT 'transfer',  -- cash | transfer | usd | sinpe | other
  insurance_status text NOT NULL DEFAULT 'insured', -- insured | not_insured
  insurance_method text NOT NULL DEFAULT 'percent', -- percent (CAJA % of earnings) | fixed (Seguro Fijo)
  insurance_salary numeric,                         -- reference salary for the fixed method
  accounts_deduction_pct numeric,                   -- employee override (null = department / rule)
  use_reference_hours boolean NOT NULL DEFAULT true,-- monthly: gross scales with hours ÷ reference hours
  vacation_opening_days numeric NOT NULL DEFAULT 0, -- balance brought forward at go-live
  photo_url text,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL, -- optional POS / self-service login
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_employees_code_uq ON pr_employees (business_id, code);
CREATE INDEX IF NOT EXISTS pr_employees_dept_idx ON pr_employees (business_id, department_id);

-- Effective-dated salary: a new salary never changes payroll already processed
CREATE TABLE IF NOT EXISTS pr_salary_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, employee_id uuid NOT NULL REFERENCES pr_employees(id) ON DELETE CASCADE,
  effective_from date NOT NULL,
  salary_type text NOT NULL,                        -- hourly | monthly
  hourly_rate numeric, monthly_salary numeric,
  currency text NOT NULL DEFAULT 'CRC',
  reason text,
  created_by uuid, created_by_name text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pr_salary_history_idx ON pr_salary_history (employee_id, effective_from);

-- Field-level change history (department, position, bank, insurance …)
CREATE TABLE IF NOT EXISTS pr_employee_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, employee_id uuid NOT NULL REFERENCES pr_employees(id) ON DELETE CASCADE,
  field text NOT NULL, old_value text, new_value text,
  changed_by uuid, changed_by_name text, changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pr_employee_changes_idx ON pr_employee_changes (employee_id, changed_at);

CREATE TABLE IF NOT EXISTS pr_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, employee_id uuid NOT NULL REFERENCES pr_employees(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'other',               -- identification | contract | other
  name text NOT NULL, mime text, size integer,
  data_url text NOT NULL,
  uploaded_by uuid, uploaded_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- Holidays & attendance (Modules 4, 9)
CREATE TABLE IF NOT EXISTS pr_holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  holiday_date date NOT NULL, name text NOT NULL,
  paid boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_holidays_uq ON pr_holidays (business_id, holiday_date);

CREATE TABLE IF NOT EXISTS pr_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, employee_id uuid NOT NULL REFERENCES pr_employees(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  check_in time, check_out time,
  regular_hours numeric NOT NULL DEFAULT 0,
  overtime_hours numeric NOT NULL DEFAULT 0,
  overtime_approved boolean NOT NULL DEFAULT false,
  holiday_hours numeric NOT NULL DEFAULT 0,
  leave_type text,                                  -- vacation | sick | unpaid | permission | null
  status text NOT NULL DEFAULT 'present',           -- present | absent | leave | holiday | off
  remarks text,
  source text NOT NULL DEFAULT 'manual',            -- manual | import | timeclock
  submitted boolean NOT NULL DEFAULT false,         -- submitted by the department manager
  created_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_attendance_uq ON pr_attendance (employee_id, work_date);
CREATE INDEX IF NOT EXISTS pr_attendance_idx ON pr_attendance (business_id, work_date);

-- ---------------------------------------------------------------- Payroll periods & records (Modules 5, 6)
CREATE TABLE IF NOT EXISTS pr_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code text NOT NULL,                               -- PP-2026-01
  name text NOT NULL,                               -- "9 Oct – 22 Oct 2026"
  start_date date NOT NULL, end_date date NOT NULL, pay_date date,
  kind text NOT NULL DEFAULT 'regular',             -- regular | special
  status text NOT NULL DEFAULT 'draft',
  department_ids jsonb NOT NULL DEFAULT '[]',       -- empty = all departments
  rule_set_id uuid REFERENCES pr_rule_sets(id) ON DELETE SET NULL,
  rules jsonb,                                      -- snapshot of the rules used (immutable once approved)
  notes text,
  validation jsonb,                                 -- last pre-approval validation result
  created_by uuid, created_by_name text, created_at timestamptz NOT NULL DEFAULT now(),
  submitted_by uuid, submitted_at timestamptz,
  approved_by uuid, approved_by_name text, approved_at timestamptz,
  rejected_reason text,
  closed_by uuid, closed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_periods_code_uq ON pr_periods (business_id, code);

CREATE TABLE IF NOT EXISTS pr_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  period_id uuid NOT NULL REFERENCES pr_periods(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES pr_employees(id),
  -- snapshot of the employee at calculation time
  employee_name text NOT NULL, cedula text,
  department_id uuid, department_name text, position_name text,
  salary_type text NOT NULL, currency text NOT NULL DEFAULT 'CRC',
  hourly_rate numeric, monthly_salary numeric, salary_history_id uuid,
  use_reference_hours boolean NOT NULL DEFAULT true,
  insurance_method text NOT NULL DEFAULT 'percent', insurance_salary numeric,
  accounts_pct numeric,
  payment_method text, bank_group text, bank_account text,
  -- inputs
  hours numeric NOT NULL DEFAULT 0,
  overtime_hours numeric NOT NULL DEFAULT 0,
  holiday_hours numeric NOT NULL DEFAULT 0,
  holiday_days numeric NOT NULL DEFAULT 0,
  vacation_days numeric NOT NULL DEFAULT 0,
  bonus numeric NOT NULL DEFAULT 0,
  other_deductions numeric NOT NULL DEFAULT 0,
  hours_source text,                                -- attendance | manual | import
  vales_plan jsonb NOT NULL DEFAULT '[]',           -- [{advance_id, amount}] planned advance recoveries
  overrides jsonb NOT NULL DEFAULT '{}',            -- {component: {value, reason, by, by_name, at}}
  notes text,
  -- results (calculated snapshot)
  gross numeric NOT NULL DEFAULT 0, overtime_pay numeric NOT NULL DEFAULT 0, excess_premium numeric NOT NULL DEFAULT 0,
  holiday_pay numeric NOT NULL DEFAULT 0, vacation_pay numeric NOT NULL DEFAULT 0,
  caja numeric NOT NULL DEFAULT 0, earnings numeric NOT NULL DEFAULT 0, payroll_expense numeric NOT NULL DEFAULT 0,
  accounts_amount numeric NOT NULL DEFAULT 0, accounts_deduction numeric NOT NULL DEFAULT 0,
  vales numeric NOT NULL DEFAULT 0, adjustments numeric NOT NULL DEFAULT 0,
  total_deductions numeric NOT NULL DEFAULT 0, net_payable numeric NOT NULL DEFAULT 0,
  calc jsonb,                                       -- full CalcResult incl. formula lines and pre-override values
  warnings jsonb NOT NULL DEFAULT '[]',
  -- payment status
  paid_amount numeric NOT NULL DEFAULT 0,
  payment_status text NOT NULL DEFAULT 'pending',   -- pending | partial | paid
  calculated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_records_uq ON pr_records (period_id, employee_id);
CREATE INDEX IF NOT EXISTS pr_records_emp_idx ON pr_records (employee_id);

-- ---------------------------------------------------------------- Accounts (Cuentas), advances (Vales), adjustments (Modules 7, 8, 12)
CREATE TABLE IF NOT EXISTS pr_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, employee_id uuid NOT NULL REFERENCES pr_employees(id) ON DELETE CASCADE,
  period_id uuid NOT NULL REFERENCES pr_periods(id) ON DELETE CASCADE,
  entry_date date NOT NULL DEFAULT CURRENT_DATE,
  amount numeric NOT NULL,
  description text,
  source text NOT NULL DEFAULT 'manual',            -- manual | grid | import
  created_by uuid, created_by_name text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pr_accounts_idx ON pr_accounts (period_id, employee_id);

CREATE TABLE IF NOT EXISTS pr_advances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, employee_id uuid NOT NULL REFERENCES pr_employees(id) ON DELETE CASCADE,
  advance_date date NOT NULL DEFAULT CURRENT_DATE,
  amount numeric NOT NULL,
  reason text,
  payment_method text NOT NULL DEFAULT 'cash',
  deduction_per_payroll numeric,                    -- null = recover the full balance in the next payroll
  status text NOT NULL DEFAULT 'requested',         -- requested | approved | rejected | repaid | cancelled
  requested_by uuid, requested_by_name text,
  approved_by uuid, approved_by_name text, approved_at timestamptz,
  rejected_reason text,
  issued_by_name text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pr_advances_idx ON pr_advances (business_id, employee_id);

CREATE TABLE IF NOT EXISTS pr_advance_txns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, advance_id uuid NOT NULL REFERENCES pr_advances(id) ON DELETE CASCADE,
  kind text NOT NULL,                               -- repayment_payroll | repayment_cash | write_off
  amount numeric NOT NULL,
  period_id uuid REFERENCES pr_periods(id) ON DELETE CASCADE,
  record_id uuid REFERENCES pr_records(id) ON DELETE CASCADE,
  txn_date date NOT NULL DEFAULT CURRENT_DATE,
  note text,
  created_by uuid, created_by_name text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pr_advance_txns_idx ON pr_advance_txns (advance_id);

CREATE TABLE IF NOT EXISTS pr_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, employee_id uuid NOT NULL REFERENCES pr_employees(id) ON DELETE CASCADE,
  period_id uuid NOT NULL REFERENCES pr_periods(id),            -- the payroll being corrected
  pay_in_period_id uuid REFERENCES pr_periods(id),              -- payroll that pays/recovers it (null = paid outside payroll)
  adj_type text NOT NULL,                                       -- ADJUSTMENT_TYPES
  original_amount numeric NOT NULL DEFAULT 0,
  actual_amount numeric NOT NULL DEFAULT 0,
  difference numeric NOT NULL DEFAULT 0,                        -- actual − original (+ owed to employee)
  reason text NOT NULL,
  payment_source text,                                          -- payroll | cash | bar_cash | transfer
  status text NOT NULL DEFAULT 'pending',                       -- pending | approved | rejected
  created_by uuid, created_by_name text, created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid, approved_by_name text, approved_at timestamptz
);
CREATE INDEX IF NOT EXISTS pr_adjustments_idx ON pr_adjustments (business_id, period_id);

-- ---------------------------------------------------------------- Vacation (Module 9)
CREATE TABLE IF NOT EXISTS pr_vacation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, employee_id uuid NOT NULL REFERENCES pr_employees(id) ON DELETE CASCADE,
  start_date date NOT NULL, end_date date NOT NULL, days numeric NOT NULL,
  status text NOT NULL DEFAULT 'requested',         -- requested | approved | rejected | cancelled
  notes text,
  requested_by uuid, approved_by uuid, approved_by_name text, decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pr_vacation_txns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, employee_id uuid NOT NULL REFERENCES pr_employees(id) ON DELETE CASCADE,
  txn_date date NOT NULL DEFAULT CURRENT_DATE,
  kind text NOT NULL,                               -- taken | paid | adjustment
  days numeric NOT NULL,                            -- positive reduces the balance for taken/paid; signed for adjustment
  period_id uuid REFERENCES pr_periods(id) ON DELETE CASCADE,
  request_id uuid REFERENCES pr_vacation_requests(id) ON DELETE SET NULL,
  note text,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pr_vacation_txns_idx ON pr_vacation_txns (employee_id);

-- ---------------------------------------------------------------- Payments & exchange rates (Module 13, 16D)
CREATE TABLE IF NOT EXISTS pr_exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  rate_date date NOT NULL,
  usd_crc numeric NOT NULL,                         -- colones per US dollar
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_exchange_rates_uq ON pr_exchange_rates (business_id, rate_date);

CREATE TABLE IF NOT EXISTS pr_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  record_id uuid NOT NULL REFERENCES pr_records(id),
  period_id uuid NOT NULL REFERENCES pr_periods(id),
  employee_id uuid NOT NULL REFERENCES pr_employees(id),
  amount numeric NOT NULL,                          -- in the payment currency
  currency text NOT NULL DEFAULT 'CRC',
  exchange_rate numeric NOT NULL DEFAULT 1,         -- CRC per unit of currency, at the payment date
  amount_crc numeric NOT NULL,
  method text NOT NULL,                             -- PAYMENT_METHODS
  bank text,                                        -- BCR | Non-BCR | Other
  account_ref text,
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  reference text,
  notes text,
  voided boolean NOT NULL DEFAULT false, void_reason text, voided_by uuid, voided_at timestamptz,
  created_by uuid, created_by_name text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pr_payments_idx ON pr_payments (period_id, record_id);

-- ---------------------------------------------------------------- Payslip email log (Modules 14, 15)
CREATE TABLE IF NOT EXISTS pr_email_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  record_id uuid REFERENCES pr_records(id) ON DELETE CASCADE,
  aguinaldo_id uuid,
  period_id uuid REFERENCES pr_periods(id) ON DELETE CASCADE,
  employee_id uuid REFERENCES pr_employees(id) ON DELETE CASCADE,
  to_email text,
  subject text,
  status text NOT NULL DEFAULT 'queued',            -- queued | sent | failed
  error text,
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pr_email_log_idx ON pr_email_log (business_id, status);
CREATE INDEX IF NOT EXISTS pr_email_log_rec_idx ON pr_email_log (record_id);

-- ---------------------------------------------------------------- Aguinaldo (Module 11)
CREATE TABLE IF NOT EXISTS pr_aguinaldo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL, employee_id uuid NOT NULL REFERENCES pr_employees(id) ON DELETE CASCADE,
  year integer NOT NULL,
  period_start date NOT NULL, period_end date NOT NULL,
  months_worked numeric NOT NULL DEFAULT 0,
  total_earnings numeric NOT NULL DEFAULT 0,
  monthly_detail jsonb NOT NULL DEFAULT '[]',       -- [{month, earnings, periods}]
  average_monthly numeric NOT NULL DEFAULT 0,
  calculated_amount numeric NOT NULL DEFAULT 0,
  adjusted_amount numeric,
  adjustment_reason text,
  final_amount numeric NOT NULL DEFAULT 0,
  warnings jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'draft',             -- draft | approved | paid
  approved_by uuid, approved_by_name text, approved_at timestamptz,
  paid_amount numeric NOT NULL DEFAULT 0, payment_method text, paid_at date, paid_by_name text, payment_reference text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_aguinaldo_uq ON pr_aguinaldo (business_id, year, employee_id);

-- ---------------------------------------------------------------- Revenue & reconciliation (Modules 16C, 17)
CREATE TABLE IF NOT EXISTS pr_revenue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  year integer NOT NULL, month integer NOT NULL,
  bar_revenue numeric NOT NULL DEFAULT 0,
  food_revenue numeric NOT NULL DEFAULT 0,
  other_revenue numeric NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'manual',            -- manual | pos | import
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pr_revenue_uq ON pr_revenue (business_id, year, month);

CREATE TABLE IF NOT EXISTS pr_reconciliation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  period_id uuid REFERENCES pr_periods(id) ON DELETE CASCADE, -- null = a month-level line
  year integer NOT NULL, month integer NOT NULL,
  label text,                                       -- 15TH / 30TH
  payroll_amount numeric NOT NULL DEFAULT 0,
  cashbook_amount numeric,
  qbo_amount numeric,
  status text NOT NULL DEFAULT 'pending',           -- pending | matched | difference | manual
  notes text,
  updated_by uuid, updated_by_name text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pr_reconciliation_idx ON pr_reconciliation (business_id, year, month);

-- Per-business payroll settings (company details on payslips, email template)
CREATE TABLE IF NOT EXISTS pr_settings (
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  company_name text, company_id text, company_address text, logo_url text,
  payslip_footer text,
  email_subject text NOT NULL DEFAULT 'Comprobante de pago – {period}',
  email_body text NOT NULL DEFAULT 'Hola {name},\n\nAdjuntamos su comprobante de pago del periodo {period}.\nMonto neto: {net}.\n\nSaludos,\n{company}',
  employee_code_prefix text NOT NULL DEFAULT 'E',
  updated_at timestamptz NOT NULL DEFAULT now()
);
