/**
 * Payroll engine self-test: recalculates employees from "26 RL PAYROLL.xlsx" and compares with the workbook results
 * (PRD §17 testing recommendation). Run: npx tsx server/scripts/payroll-selftest.ts
 */
import { calculatePay, type CalcInput, type PayrollRules } from '../../shared/payroll.ts';

type Case = { name: string; sheet: string; input: CalcInput; rules?: Partial<PayrollRules>; expect: Record<string, number>; tol?: number; note?: string };

// Rules as the workbook applied them in each sheet
const sheet11b: Partial<PayrollRules> = { accounts_deduction_pct: 60, caja_include_overtime: false, rounding_decimals: 6 }; // 23 Oct – 5 Nov
const sheet11a: Partial<PayrollRules> = { accounts_deduction_pct: 65, caja_include_overtime: false, rounding_decimals: 6 }; // 9 Oct – 22 Oct
const sheet8: Partial<PayrollRules> = { accounts_deduction_pct: 65, rounding_decimals: 6 };
const hourly: Partial<PayrollRules> = { accounts_deduction_pct: 100, rounding_decimals: 6 }; // older sheets deducted Cuentas in full

const cases: Case[] = [
  {
    name: 'Employee A', sheet: '11 (23 Oct–5 Nov) row 43', rules: sheet11b,
    input: { salary_type: 'monthly', monthly_salary: 480000, hours: 66, bonus: 10000, accounts_amount: 6500 },
    expect: { gross: 165000, caja: 17869.5, payroll_expense: 157130.5, accounts_deduction: 3900, net_payable: 153230.5 },
  },
  {
    name: 'Employee B', sheet: '11 row 44', rules: sheet11b,
    input: { salary_type: 'monthly', monthly_salary: 433746.11, hours: 60, accounts_amount: 43800 },
    expect: { gross: 135545.6594, caja: 14679.59491, payroll_expense: 120866.0645, accounts_deduction: 26280, net_payable: 94586.06446 },
  },
  {
    name: 'Employee C (8 h overtime)', sheet: '11 row 45', rules: sheet11b, tol: 1,
    note: 'Workbook adds the 8 overtime *hours* into the CAJA base (=(J+L+M)*10.83%), a ₡0.87 formula slip',
    input: { salary_type: 'monthly', monthly_salary: 585485, hours: 96, overtime_hours: 8, accounts_amount: 16000 },
    expect: { gross: 292742.5, overtime_pay: 36592.8125, caja: 31704.87915, payroll_expense: 297630.4334, net_payable: 288030.4334 },
  },
  {
    name: 'Employee D (100 h, above reference)', sheet: '11 row 48', rules: sheet11b,
    input: { salary_type: 'monthly', monthly_salary: 480000, hours: 100 },
    expect: { gross: 250000, caja: 27075, payroll_expense: 222925, net_payable: 222925 },
  },
  {
    name: 'Employee E (vale 50,000)', sheet: '11 row 50', rules: sheet11b,
    input: { salary_type: 'monthly', monthly_salary: 487335, hours: 80, vales: 50000 },
    expect: { gross: 203056.25, caja: 21990.99188, net_payable: 131065.2581 },
  },
  {
    name: 'Employee F (hourly, not insured)', sheet: '11 row 54', rules: sheet11b,
    input: { salary_type: 'hourly', hourly_rate: 2000, hours: 54.13, insurance_method: 'none', accounts_amount: 21300 },
    expect: { gross: 108260, caja: 0, payroll_expense: 108260, accounts_deduction: 12780, net_payable: 95480 },
  },
  {
    name: 'Employee B (overtime, 65%)', sheet: '11 (9–22 Oct) row 3', rules: sheet11a, tol: 1,
    note: 'Workbook CAJA base again includes overtime hours (M3 = 8)',
    input: { salary_type: 'monthly', monthly_salary: 433746.11, hours: 68, overtime_hours: 8, accounts_amount: 32000 },
    expect: { gross: 153618.414, overtime_pay: 27109.13188, caja: 16637.74063, payroll_expense: 164089.8052, accounts_deduction: 20800, net_payable: 143289.8052 },
  },
  {
    name: 'Employee G (vacation amount 100,000)', sheet: '11 (9–22 Oct) row 10', rules: sheet11a,
    input: { salary_type: 'monthly', monthly_salary: 480000, hours: 48, vacation_days: 6.25, accounts_amount: 27000 },
    expect: { gross: 120000, vacation_pay: 100000, caja: 12996, payroll_expense: 207004, accounts_deduction: 17550, net_payable: 189454 },
  },
  {
    name: 'Employee A (2 holidays, proportional)', sheet: '8 (17–30 Jul) row 2', rules: sheet8,
    input: { salary_type: 'monthly', monthly_salary: 480000, hours: 68.2, holiday_days: 2, vales: 130000 },
    expect: { gross: 170500, holiday_pay: 22733.33333, caja: 20927.17, payroll_expense: 172306.1633, net_payable: 42306.16333 },
  },
  {
    name: 'Employee H (hourly, fixed CAJA, holiday + vacation)', sheet: '4 (27/3–09/4) row 4', rules: hourly,
    note: 'Fixed CAJA 7,015 entered by hand in the workbook; entered here as an override',
    input: { salary_type: 'hourly', hourly_rate: 1800, hours: 57.5, holiday_hours: 16, vacation_days: 3, insurance_method: 'fixed', insurance_salary: 0, accounts_amount: 15015, overrides: { caja: 7015 } },
    expect: { gross: 103500, holiday_pay: 28800, vacation_pay: 43200, caja: 7015, payroll_expense: 168485, net_payable: 153470 },
  },
  {
    name: 'Employee A (Seguro Fijo)', sheet: '1 (Dic 31–Jan 14) row 2 + Seguro Fijo', rules: hourly, tol: 0.1,
    note: 'Workbook uses the rounded monthly amount 21,054.57 ÷ 2',
    input: { salary_type: 'hourly', hourly_rate: 2000, hours: 69.79, holiday_hours: 8.46, insurance_method: 'fixed', insurance_salary: 197324, accounts_amount: 4250 },
    expect: { gross: 139580, holiday_pay: 16920, caja: 10527.285, payroll_expense: 145972.715, net_payable: 141722.715 },
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r: any = calculatePay(c.input, c.rules);
  const errs: string[] = [];
  for (const [k, want] of Object.entries(c.expect)) {
    const got = r[k];
    if (Math.abs(got - want) > (c.tol ?? 0.01)) errs.push(`${k}: got ${got}, workbook ${want}`);
  }
  if (errs.length) {
    fail++;
    console.log(`✗ ${c.name} [${c.sheet}]\n    ${errs.join('\n    ')}`);
  } else {
    pass++;
    console.log(`✓ ${c.name} [${c.sheet}]${c.note ? `  (${c.note})` : ''}`);
  }
}

// Default rules sanity checks
const d = calculatePay({ salary_type: 'monthly', monthly_salary: 480000, hours: 104 });
const checks: [string, boolean][] = [
  ['default rounding to 2 decimals', d.gross === 260000 && d.caja === 28158],
  ['excess hours detected (104 − 96 = 8)', d.excess_hours === 8],
  ['premium applies when configured', calculatePay({ salary_type: 'monthly', monthly_salary: 480000, hours: 104 }, { excess_hours_premium: 0.5 }).excess_premium === 10000],
  ['override keeps calculated value', (() => { const x = calculatePay({ salary_type: 'hourly', hourly_rate: 2000, hours: 10, overrides: { gross: 25000 } }); return x.gross === 25000 && x.calculated.gross === 20000; })()],
  ['fixed quincenal ignores hours', calculatePay({ salary_type: 'monthly', monthly_salary: 360000, hours: 80, use_reference_hours: false }).gross === 180000],
  ['accounts example 50,000 × 65% (PRD M7)', (() => { const x = calculatePay({ salary_type: 'hourly', accounts_amount: 50000, accounts_pct: 65 }); return x.accounts_deduction === 32500 && x.accounts_business === 17500; })()],
];
for (const [name, ok] of checks) {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
