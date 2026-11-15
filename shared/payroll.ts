/**
 * Payroll calculation engine (PRD Module 6). Pure functions shared by the server (official calculation)
 * and the browser (simulation sandbox), so both always agree.
 *
 * Every rate is configurable (PRD §8). Defaults follow the newest sheet of "26 RL PAYROLL.xlsx"
 * (period 23 Oct – 5 Nov) and must be confirmed by the business owner before production.
 */

export type SalaryType = 'hourly' | 'monthly';
export type InsuranceMethod = 'percent' | 'fixed' | 'none';

export interface PayrollRules {
  reference_hours: number; // hours in a payroll period for a full quincenal salary (96)
  quincenal_divisor: number; // monthly salary / this = quincenal salary (2)
  monthly_day_divisor: number; // monthly salary / this = daily salary (30)
  hours_per_day: number; // daily hours for hourly employees' vacation/holiday days (8)
  caja_rate: number; // % of the CAJA base for payroll-period insurance (10.83)
  caja_include_holiday: boolean;
  caja_include_overtime: boolean;
  caja_include_vacation: boolean;
  caja_include_bonus: boolean;
  fixed_insurance_rate: number; // % of the insurance reference salary per month (Seguro Fijo, 10.67)
  overtime_multiplier: number; // entered overtime hours × hourly rate × this (1.5)
  excess_hours_premium: number; // extra multiplier on hours above the reference for monthly staff (0 = paid at 1× only)
  holiday_multiplier: number; // holiday hours/days × rate × this (1)
  holiday_monthly_method: 'proportional' | 'daily'; // proportional: days × daily × hours/reference (sheet 8)
  accounts_deduction_pct: number; // % of "Cuentas" deducted from pay (60 in the newest sheet)
  rounding_decimals: number; // rounding of each money component (2)
  aguinaldo_months: number; // months in the annual bonus period (12)
  vacation_days_per_month: number; // vacation accrual (1 day per month worked)
}

export const DEFAULT_RULES: PayrollRules = {
  reference_hours: 96,
  quincenal_divisor: 2,
  monthly_day_divisor: 30,
  hours_per_day: 8,
  caja_rate: 10.83,
  caja_include_holiday: true,
  caja_include_overtime: true,
  caja_include_vacation: false,
  caja_include_bonus: false,
  fixed_insurance_rate: 10.67,
  overtime_multiplier: 1.5,
  excess_hours_premium: 0,
  holiday_multiplier: 1,
  holiday_monthly_method: 'proportional',
  accounts_deduction_pct: 60,
  rounding_decimals: 2,
  aguinaldo_months: 12,
  vacation_days_per_month: 1,
};

export const RULE_LABELS: Record<keyof PayrollRules, string> = {
  reference_hours: 'Reference hours per payroll period',
  quincenal_divisor: 'Quincenal salary divisor',
  monthly_day_divisor: 'Monthly salary divisor (daily salary)',
  hours_per_day: 'Hours per working day',
  caja_rate: 'CAJA / insurance rate (%)',
  caja_include_holiday: 'CAJA base includes holiday pay',
  caja_include_overtime: 'CAJA base includes overtime pay',
  caja_include_vacation: 'CAJA base includes vacation pay',
  caja_include_bonus: 'CAJA base includes bonus',
  fixed_insurance_rate: 'Fixed insurance rate (% per month)',
  overtime_multiplier: 'Overtime multiplier',
  excess_hours_premium: 'Premium on hours above reference (monthly)',
  holiday_multiplier: 'Holiday pay multiplier',
  holiday_monthly_method: 'Holiday method for monthly staff',
  accounts_deduction_pct: 'Accounts (Cuentas) deduction (%)',
  rounding_decimals: 'Rounding (decimals)',
  aguinaldo_months: 'Aguinaldo period (months)',
  vacation_days_per_month: 'Vacation days earned per month',
};

export interface CalcInput {
  salary_type: SalaryType;
  hourly_rate?: number | null; // hourly employees
  monthly_salary?: number | null; // monthly employees
  use_reference_hours?: boolean; // monthly: gross scales with hours/reference (default true); false = fixed quincenal
  insurance_method?: InsuranceMethod;
  insurance_salary?: number | null; // fixed method: reference salary
  accounts_pct?: number | null; // resolved employee/department/rule percentage
  hours?: number | null; // regular hours worked in the period
  overtime_hours?: number | null; // approved overtime hours (paid on top)
  holiday_hours?: number | null;
  holiday_days?: number | null;
  vacation_days?: number | null;
  bonus?: number | null;
  accounts_amount?: number | null;
  vales?: number | null; // advances / vouchers recovered this period
  other_deductions?: number | null;
  adjustments?: number | null; // signed: + paid to employee, − recovered
  overrides?: Partial<Record<OverrideKey, number>> | null;
}

export const OVERRIDE_KEYS = ['gross', 'overtime_pay', 'holiday_pay', 'vacation_pay', 'caja', 'accounts_deduction'] as const;
export type OverrideKey = (typeof OVERRIDE_KEYS)[number];
export const OVERRIDE_LABELS: Record<OverrideKey, string> = {
  gross: 'Gross salary',
  overtime_pay: 'Overtime',
  holiday_pay: 'Holiday',
  vacation_pay: 'Vacation',
  caja: 'CAJA / insurance',
  accounts_deduction: 'Accounts deduction',
};

export interface CalcLine {
  key: string;
  label: string;
  formula: string;
  value: number;
  overridden?: boolean;
}

export interface CalcResult {
  quincenal_salary: number;
  hourly_rate: number; // effective hourly rate used for overtime/holiday
  hourly_equivalent: number;
  hours: number;
  excess_hours: number;
  gross: number;
  overtime_pay: number;
  excess_premium: number;
  holiday_pay: number;
  vacation_pay: number;
  bonus: number;
  caja_base: number;
  caja: number;
  earnings: number; // gross + overtime + premium + holiday + vacation + bonus
  payroll_expense: number; // earnings − CAJA (workbook "Pay Expense")
  accounts_amount: number;
  accounts_pct: number;
  accounts_deduction: number;
  accounts_business: number; // part of the accounts carried by the business
  vales: number;
  other_deductions: number;
  adjustments: number;
  total_deductions: number; // CAJA + accounts deduction + vales + other deductions
  net_payable: number; // payroll expense − accounts deduction − vales − other deductions + adjustments
  calculated: Record<OverrideKey, number>; // values before manual overrides
  lines: CalcLine[];
}

const n = (v: any) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

export const roundTo = (v: number, d = 2) => {
  const f = 10 ** d;
  return Math.round((v + Math.sign(v) * Number.EPSILON) * f) / f;
};

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toLocaleString('en-US', { maximumFractionDigits: 4 }));

export function mergeRules(...parts: (Partial<PayrollRules> | null | undefined)[]): PayrollRules {
  const out: any = { ...DEFAULT_RULES };
  for (const p of parts) if (p) for (const [k, v] of Object.entries(p)) if (k in DEFAULT_RULES && v !== null && v !== undefined && (v as any) !== '') out[k] = v;
  for (const k of Object.keys(DEFAULT_RULES) as (keyof PayrollRules)[]) {
    if (typeof (DEFAULT_RULES as any)[k] === 'number') out[k] = n(out[k]);
    if (typeof (DEFAULT_RULES as any)[k] === 'boolean') out[k] = out[k] === true || out[k] === 'true';
  }
  return out;
}

export function calculatePay(input: CalcInput, rulesIn: Partial<PayrollRules> = {}): CalcResult {
  const R = mergeRules(rulesIn);
  const rd = (v: number) => roundTo(v, R.rounding_decimals);
  const ref = R.reference_hours > 0 ? R.reference_hours : 96;
  const lines: CalcLine[] = [];
  const line = (key: string, label: string, formula: string, value: number) => {
    lines.push({ key, label, formula, value });
    return value;
  };
  const hours = n(input.hours);
  const otHours = n(input.overtime_hours);
  const monthly = input.salary_type === 'monthly';
  const ov = input.overrides || {};

  let quincenal = 0, hourlyEq = 0, rate = 0, daily = 0, gross = 0, excess = 0, premium = 0;
  if (monthly) {
    const ms = n(input.monthly_salary);
    quincenal = ms / (R.quincenal_divisor || 2);
    hourlyEq = quincenal / ref;
    rate = hourlyEq;
    daily = ms / (R.monthly_day_divisor || 30);
    line('quincenal', 'Quincenal salary', `${fmt(ms)} ÷ ${R.quincenal_divisor}`, rd(quincenal));
    line('hourly_equivalent', 'Hourly equivalent', `${fmt(rd(quincenal))} ÷ ${ref}`, rd(hourlyEq));
    if (input.use_reference_hours === false) {
      gross = quincenal;
      line('gross', 'Gross salary', 'Fixed quincenal salary', rd(gross));
    } else {
      gross = quincenal * (hours / ref);
      line('gross', 'Gross salary', `${fmt(rd(quincenal))} × (${fmt(hours)} ÷ ${ref})`, rd(gross));
      excess = Math.max(0, hours - ref);
      if (excess > 0) {
        premium = excess * hourlyEq * R.excess_hours_premium;
        line('excess_premium', `Hours above reference (${fmt(excess)} h)`,
          R.excess_hours_premium ? `${fmt(excess)} × ${fmt(rd(hourlyEq))} × ${R.excess_hours_premium}` : 'Paid at 1× inside gross (no premium configured)', rd(premium));
      }
    }
  } else {
    rate = n(input.hourly_rate);
    hourlyEq = rate;
    daily = rate * R.hours_per_day;
    gross = hours * rate;
    line('gross', 'Gross salary', `${fmt(hours)} h × ${fmt(rate)}`, rd(gross));
  }

  // Overtime: approved hours paid on top of regular hours
  let overtime = otHours * rate * R.overtime_multiplier;
  if (otHours) line('overtime_pay', 'Overtime', `${fmt(otHours)} h × ${fmt(rd(rate))} × ${R.overtime_multiplier}`, rd(overtime));

  // Holiday: hours × hourly rate, plus days × daily salary (proportional to hours for monthly staff)
  const hh = n(input.holiday_hours), hd = n(input.holiday_days);
  let holiday = 0;
  const hParts: string[] = [];
  if (hh) {
    holiday += hh * rate * R.holiday_multiplier;
    hParts.push(`${fmt(hh)} h × ${fmt(rd(rate))}`);
  }
  if (hd) {
    const factor = monthly && R.holiday_monthly_method === 'proportional' && input.use_reference_hours !== false ? hours / ref : 1;
    holiday += hd * daily * factor * R.holiday_multiplier;
    hParts.push(`${fmt(hd)} d × ${fmt(rd(daily))}${factor !== 1 ? ` × (${fmt(hours)} ÷ ${ref})` : ''}`);
  }
  if (holiday) line('holiday_pay', 'Holiday', hParts.join(' + ') + (R.holiday_multiplier !== 1 ? ` × ${R.holiday_multiplier}` : ''), rd(holiday));

  const vd = n(input.vacation_days);
  let vacation = vd * daily;
  if (vd) line('vacation_pay', 'Vacation', `${fmt(vd)} d × ${fmt(rd(daily))}`, rd(vacation));
  const bonus = rd(n(input.bonus));
  if (bonus) line('bonus', 'Bonus', 'Entered', bonus);

  const calculated: Record<OverrideKey, number> = {
    gross: rd(gross), overtime_pay: rd(overtime), holiday_pay: rd(holiday), vacation_pay: rd(vacation), caja: 0, accounts_deduction: 0,
  };
  const pickOv = (k: OverrideKey, v: number) => {
    if (ov[k] === undefined || ov[k] === null || !Number.isFinite(Number(ov[k]))) return v;
    const l = lines.find((x) => x.key === k);
    const val = rd(Number(ov[k]));
    if (l) Object.assign(l, { value: val, overridden: true, formula: `Manual adjustment (calculated ${fmt(v)})` });
    else lines.push({ key: k, label: OVERRIDE_LABELS[k], formula: `Manual adjustment (calculated ${fmt(v)})`, value: val, overridden: true });
    return val;
  };
  gross = pickOv('gross', rd(gross));
  overtime = pickOv('overtime_pay', rd(overtime));
  holiday = pickOv('holiday_pay', rd(holiday));
  vacation = pickOv('vacation_pay', rd(vacation));
  premium = rd(premium);

  // CAJA / insurance
  const method: InsuranceMethod = input.insurance_method || 'percent';
  let cajaBase = 0, caja = 0;
  if (method === 'percent') {
    cajaBase = gross + premium + (R.caja_include_holiday ? holiday : 0) + (R.caja_include_overtime ? overtime : 0) +
      (R.caja_include_vacation ? vacation : 0) + (R.caja_include_bonus ? bonus : 0);
    caja = (cajaBase * R.caja_rate) / 100;
    line('caja', 'CAJA / insurance', `${fmt(rd(cajaBase))} × ${R.caja_rate}%`, rd(caja));
  } else if (method === 'fixed') {
    const ins = n(input.insurance_salary);
    cajaBase = ins;
    caja = (ins * R.fixed_insurance_rate) / 100 / (R.quincenal_divisor || 2);
    line('caja', 'CAJA / insurance (fixed)', `${fmt(ins)} × ${R.fixed_insurance_rate}% ÷ ${R.quincenal_divisor}`, rd(caja));
  }
  calculated.caja = rd(caja);
  caja = pickOv('caja', rd(caja));

  const earnings = rd(gross + overtime + premium + holiday + vacation + bonus);
  const expense = rd(earnings - caja);
  line('payroll_expense', 'Payroll expense', 'Gross + overtime + holiday + vacation + bonus − CAJA', expense);

  const accAmt = rd(n(input.accounts_amount));
  const accPct = input.accounts_pct === null || input.accounts_pct === undefined ? R.accounts_deduction_pct : n(input.accounts_pct);
  let accDed = rd((accAmt * accPct) / 100);
  if (accAmt) line('accounts_deduction', 'Accounts deduction', `${fmt(accAmt)} × ${accPct}%`, accDed);
  calculated.accounts_deduction = accDed;
  accDed = pickOv('accounts_deduction', accDed);

  const vales = rd(n(input.vales));
  const other = rd(n(input.other_deductions));
  const adj = rd(n(input.adjustments));
  if (vales) line('vales', 'Vales / advances', 'Advance recovery', vales);
  if (other) line('other_deductions', 'Other deductions', 'Entered', other);
  if (adj) line('adjustments', 'Other adjustments', 'Adjustment register', adj);
  const net = rd(expense - accDed - vales - other + adj);
  line('net_payable', 'Net payable', 'Payroll expense − accounts deduction − vales − other deductions + adjustments', net);

  return {
    quincenal_salary: rd(quincenal), hourly_rate: rd(rate), hourly_equivalent: rd(hourlyEq), hours, excess_hours: excess,
    gross, overtime_pay: overtime, excess_premium: premium, holiday_pay: holiday, vacation_pay: vacation, bonus,
    caja_base: rd(cajaBase), caja, earnings, payroll_expense: expense,
    accounts_amount: accAmt, accounts_pct: accPct, accounts_deduction: accDed, accounts_business: rd(accAmt - accDed),
    vales, other_deductions: other, adjustments: adj,
    total_deductions: rd(caja + accDed + vales + other), net_payable: net, calculated, lines,
  };
}

// ---------------------------------------------------------------- Pre-approval validation (PRD §16.3)
export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  employee_id?: string;
}

export const PERIOD_STATUSES = ['draft', 'attendance_pending', 'calculation_pending', 'under_review', 'approved', 'partially_paid', 'paid', 'closed'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];
export const PERIOD_STATUS_LABELS: Record<PeriodStatus, string> = {
  draft: 'Draft',
  attendance_pending: 'Attendance pending',
  calculation_pending: 'Calculation pending',
  under_review: 'Under review',
  approved: 'Approved',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  closed: 'Closed',
};
/** Periods in these statuses are locked: records cannot be edited without an authorised reopening. */
export const LOCKED_STATUSES: PeriodStatus[] = ['approved', 'partially_paid', 'paid', 'closed'];

export const ADJUSTMENT_TYPES: Record<string, string> = {
  previous_correction: 'Previous payroll correction',
  additional_salary: 'Additional salary',
  salary_difference: 'Salary difference',
  cash_correction: 'Cash payment correction',
  missing_payment: 'Missing payment',
  recovery: 'Recovery',
  other: 'Other adjustment',
};

export const PAYMENT_METHODS: Record<string, string> = { cash: 'Cash', transfer: 'Bank transfer', usd: 'USD', sinpe: 'SINPE Móvil', other: 'Other' };
export const BANK_GROUPS: Record<string, string> = { BCR: 'BCR', 'Non-BCR': 'Non-BCR', Other: 'Other' };

/** Costa Rica aguinaldo: total ordinary + extraordinary earnings in the bonus period ÷ 12. */
export function aguinaldoAmount(totalEarnings: number, months = 12, decimals = 2) {
  return roundTo(totalEarnings / (months || 12), decimals);
}
