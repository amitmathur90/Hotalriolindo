import { Router, type Request } from 'express';
import { jsPDF } from 'jspdf';
import nodemailer from 'nodemailer';
import { db, type Q } from '../db.ts';
import { requirePerm } from '../auth.ts';
import { HttpError, ah, audit, bad, notify } from '../util.ts';
import { PAYMENT_METHODS, PERIOD_STATUS_LABELS } from '../../../shared/payroll.ts';
import { bid, getOwned, isLocked, isoDate } from './common.ts';

const r = Router();

// ---------------------------------------------------------------- PDF
const money = (v: any, cur = 'CRC') => {
  const n = Number(v) || 0;
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${cur === 'USD' ? 'US$' : '¢'}${s}`; // ¢ = colón sign available in the standard PDF fonts
};
const date = (d: any) => (d ? new Date(isoDate(d) + 'T12:00:00Z').toLocaleDateString('es-CR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const num = (v: any) => (Number(v) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

export interface SlipData {
  title: string;
  company: { name: string; id?: string | null; address?: string | null; logo?: string | null; footer?: string | null };
  info: [string, string][];
  earnings: [string, string, number][]; // label, detail, amount
  deductions: [string, string, number][];
  gross: number;
  totalDeductions: number;
  net: number;
  currency?: string;
  payment: [string, string][];
  notes?: string | null;
}

function drawSlip(doc: jsPDF, s: SlipData) {
  const W = 210, M = 14;
  let y = 14;
  if (s.company.logo && /^data:image\/(png|jpe?g)/.test(s.company.logo)) {
    try { doc.addImage(s.company.logo, s.company.logo.includes('png') ? 'PNG' : 'JPEG', M, y - 2, 22, 22); } catch { /* ignore bad logos */ }
  }
  const tx = s.company.logo ? M + 26 : M;
  doc.setFont('helvetica', 'bold').setFontSize(14).text(s.company.name || '', tx, y + 4);
  doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(90);
  if (s.company.id) doc.text(`Cédula jurídica ${s.company.id}`, tx, y + 9);
  if (s.company.address) doc.text(doc.splitTextToSize(s.company.address, 110), tx, y + 13);
  doc.setTextColor(0).setFont('helvetica', 'bold').setFontSize(12).text(s.title, W - M, y + 4, { align: 'right' });
  y += 26;
  doc.setDrawColor(200).line(M, y, W - M, y);
  y += 6;

  // Employee / period details (two columns)
  doc.setFontSize(9);
  const half = Math.ceil(s.info.length / 2);
  s.info.forEach(([k, v], i) => {
    const col = i < half ? 0 : 1, row = i < half ? i : i - half;
    const x = M + col * 92, yy = y + row * 5.2;
    doc.setFont('helvetica', 'normal').setTextColor(110).text(k, x, yy);
    doc.setFont('helvetica', 'bold').setTextColor(0).text(String(v ?? ''), x + 34, yy);
  });
  y += half * 5.2 + 4;

  // Earnings | Deductions
  const colW = (W - 2 * M - 6) / 2;
  const table = (x: number, title: string, rows: [string, string, number][], total: [string, number], color: [number, number, number]) => {
    let yy = y;
    doc.setFillColor(...color).rect(x, yy, colW, 7, 'F');
    doc.setTextColor(255).setFont('helvetica', 'bold').setFontSize(9).text(title, x + 2, yy + 4.8);
    yy += 7;
    doc.setTextColor(0).setFont('helvetica', 'normal').setFontSize(8.5);
    for (const [label, detail, amt] of rows) {
      doc.text(label, x + 2, yy + 4.5);
      if (detail) doc.setTextColor(120).setFontSize(7).text(detail, x + 2, yy + 8).setTextColor(0).setFontSize(8.5);
      doc.text(money(amt, s.currency), x + colW - 2, yy + 4.5, { align: 'right' });
      yy += detail ? 10 : 6.5;
      doc.setDrawColor(230).line(x, yy, x + colW, yy);
    }
    if (!rows.length) { doc.setTextColor(150).text('—', x + 2, yy + 4.5).setTextColor(0); yy += 6.5; }
    doc.setFont('helvetica', 'bold').text(total[0], x + 2, yy + 5).text(money(total[1], s.currency), x + colW - 2, yy + 5, { align: 'right' });
    return yy + 8;
  };
  const y1 = table(M, 'INGRESOS / EARNINGS', s.earnings, ['Total ingresos', s.gross], [13, 148, 136]);
  const y2 = table(M + colW + 6, 'DEDUCCIONES / DEDUCTIONS', s.deductions, ['Total deducciones', s.totalDeductions], [190, 18, 60]);
  y = Math.max(y1, y2) + 2;

  doc.setFillColor(240, 253, 250).setDrawColor(13, 148, 136).roundedRect(M, y, W - 2 * M, 14, 2, 2, 'FD');
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(15, 118, 110).text('NETO A PAGAR / NET PAYABLE', M + 4, y + 9);
  doc.setFontSize(14).text(money(s.net, s.currency), W - M - 4, y + 9.5, { align: 'right' });
  doc.setTextColor(0);
  y += 20;

  doc.setFontSize(8.5);
  s.payment.forEach(([k, v], i) => {
    const x = M + (i % 3) * 61, yy = y + Math.floor(i / 3) * 5.2;
    doc.setFont('helvetica', 'normal').setTextColor(110).text(k, x, yy);
    doc.setFont('helvetica', 'bold').setTextColor(0).text(String(v ?? ''), x + 24, yy);
  });
  y += Math.ceil(s.payment.length / 3) * 5.2 + 3;
  if (s.notes) {
    doc.setFont('helvetica', 'italic').setFontSize(8).setTextColor(90).text(doc.splitTextToSize(s.notes, W - 2 * M), M, y + 2);
    y += 8;
  }
  doc.setTextColor(0);
  const sy = Math.max(y + 18, 235);
  doc.setDrawColor(120);
  doc.line(M, sy, M + 75, sy).line(W - M - 75, sy, W - M, sy);
  doc.setFont('helvetica', 'normal').setFontSize(8.5).text('Firma del colaborador / Employee signature', M, sy + 4.5);
  doc.text('Firma autorizada / Authorized signature', W - M - 75, sy + 4.5);
  doc.setFontSize(7.5).setTextColor(130);
  if (s.company.footer) doc.text(doc.splitTextToSize(s.company.footer, W - 2 * M), M, 282);
  doc.text(`Generado ${new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' })}`, W - M, 289, { align: 'right' });
  doc.setTextColor(0);
}

async function company(q: Q, businessId: string) {
  const s = await q.one(`SELECT * FROM pr_settings WHERE business_id=$1`, [businessId]);
  const b = await q.one(`SELECT name, logo_url, address, gstin FROM businesses WHERE id=$1`, [businessId]);
  return { name: s?.company_name || b?.name, id: s?.company_id || b?.gstin, address: s?.company_address || b?.address, logo: s?.logo_url || b?.logo_url, footer: s?.payslip_footer };
}

export async function recordSlip(q: Q, rec: any): Promise<SlipData> {
  const p = await q.one(`SELECT * FROM pr_periods WHERE id=$1`, [rec.period_id]);
  const pays = await q.query(`SELECT * FROM pr_payments WHERE record_id=$1 AND NOT voided ORDER BY payment_date`, [rec.id]);
  const adj = await q.query(`SELECT adj_type, reason, difference FROM pr_adjustments WHERE pay_in_period_id=$1 AND employee_id=$2 AND status='approved'`, [rec.period_id, rec.employee_id]);
  const calc = rec.calc || {};
  const line = (k: string) => (calc.lines || []).find((l: any) => l.key === k)?.formula || '';
  const monthly = rec.salary_type === 'monthly';
  const earnings: [string, string, number][] = [
    ['Salario bruto / Gross salary', line('gross'), Number(rec.gross)],
    ...(Number(rec.overtime_pay) ? [['Horas extra / Overtime', line('overtime_pay'), Number(rec.overtime_pay)] as [string, string, number]] : []),
    ...(Number(rec.excess_premium) ? [['Exceso de horas / Excess hours', line('excess_premium'), Number(rec.excess_premium)] as [string, string, number]] : []),
    ...(Number(rec.holiday_pay) ? [['Feriados / Holiday', line('holiday_pay'), Number(rec.holiday_pay)] as [string, string, number]] : []),
    ...(Number(rec.vacation_pay) ? [['Vacaciones / Vacation', line('vacation_pay'), Number(rec.vacation_pay)] as [string, string, number]] : []),
    ...(Number(calc.bonus) ? [['Bonificación / Bonus', '', Number(calc.bonus)] as [string, string, number]] : []),
    ...adj.filter((a) => Number(a.difference) > 0).map((a) => [`Ajuste / Adjustment`, a.reason, Number(a.difference)] as [string, string, number]),
  ];
  const deductions: [string, string, number][] = [
    ...(Number(rec.caja) ? [['CAJA / Seguro (CCSS)', line('caja'), Number(rec.caja)] as [string, string, number]] : []),
    ...(Number(rec.accounts_deduction) ? [['Cuentas / Accounts', `${num(rec.accounts_amount)} × ${num(rec.accounts_pct)}%`, Number(rec.accounts_deduction)] as [string, string, number]] : []),
    ...(Number(rec.vales) ? [['Vales / Adelantos', 'Advance recovery', Number(rec.vales)] as [string, string, number]] : []),
    ...(Number(rec.other_deductions) ? [['Otras deducciones / Other', '', Number(rec.other_deductions)] as [string, string, number]] : []),
    ...adj.filter((a) => Number(a.difference) < 0).map((a) => [`Ajuste / Adjustment`, a.reason, -Number(a.difference)] as [string, string, number]),
  ];
  const paid = Number(rec.paid_amount);
  return {
    title: 'COMPROBANTE DE PAGO / PAYSLIP',
    company: await company(q, rec.business_id),
    info: [
      ['Colaborador', rec.employee_name], ['Cédula', rec.cedula || '—'], ['Departamento', rec.department_name || '—'], ['Puesto', rec.position_name || '—'],
      ['Periodo', `${date(p!.start_date)} – ${date(p!.end_date)}`], ['Planilla', p!.code],
      ['Horas trabajadas', `${num(rec.hours)} h${Number(rec.overtime_hours) ? ` + ${num(rec.overtime_hours)} h extra` : ''}`],
      [monthly ? 'Salario mensual' : 'Tarifa por hora', monthly ? money(rec.monthly_salary, rec.currency) : money(rec.hourly_rate, rec.currency)],
      ...(monthly ? [['Valor hora', money(calc.hourly_equivalent, rec.currency)] as [string, string]] : []),
      ['Fecha de pago', date(p!.pay_date || pays[0]?.payment_date) || '—'],
    ],
    earnings, deductions,
    gross: earnings.reduce((s, e) => s + e[2], 0),
    totalDeductions: deductions.reduce((s, e) => s + e[2], 0),
    net: Number(rec.net_payable),
    currency: rec.currency,
    payment: [
      ['Método', PAYMENT_METHODS[rec.payment_method] || rec.payment_method || '—'],
      ['Banco', rec.bank_group || '—'],
      ['Cuenta', rec.bank_account || '—'],
      ['Estado', paid <= 0 ? 'Pendiente' : rec.payment_status === 'paid' ? 'Pagado' : `Parcial (${money(paid, rec.currency)})`],
      ...(pays.length ? [['Referencia', pays.map((x) => x.reference).filter(Boolean).join(', ') || '—'] as [string, string]] : []),
    ],
    notes: isLocked(p!.status) ? null : `BORRADOR — planilla ${PERIOD_STATUS_LABELS[p!.status as keyof typeof PERIOD_STATUS_LABELS]}, sujeto a cambios.`,
  };
}

export function slipsPdf(slips: SlipData[]) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  slips.forEach((s, i) => {
    if (i) doc.addPage();
    drawSlip(doc, s);
  });
  return Buffer.from(doc.output('arraybuffer'));
}

const sendPdf = (res: any, name: string, buf: Buffer) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${name.replace(/[^\w.-]+/g, '_')}"`);
  res.send(buf);
};
const slipRead = requirePerm('payroll.access', 'payroll.process', 'payroll.payments');

r.get('/records/:id/payslip.pdf', slipRead, ah(async (req, res) => {
  const rec = await getOwned(db, 'pr_records', req.params.id, bid(req), 'Payroll record');
  sendPdf(res, `payslip-${rec.employee_name}.pdf`, slipsPdf([await recordSlip(db, rec)]));
}));

r.get('/periods/:id/payslips.pdf', slipRead, ah(async (req, res) => {
  const p = await getOwned(db, 'pr_periods', req.params.id, bid(req), 'Payroll period');
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  const recs = await db.query(`SELECT * FROM pr_records WHERE period_id=$1 ${ids.length ? 'AND id = ANY($2::uuid[])' : ''} ORDER BY department_name, employee_name`, ids.length ? [p.id, ids] : [p.id]);
  if (!recs.length) throw bad('No payslips to print');
  const slips: SlipData[] = [];
  for (const rec of recs) slips.push(await recordSlip(db, rec));
  await audit(req, 'payroll_payslips_pdf', 'pr_periods', p.id, { count: recs.length });
  sendPdf(res, `payslips-${p.code}.pdf`, slipsPdf(slips));
}));

// ---------------------------------------------------------------- Email (Module 15)
export const smtpReady = () => !!process.env.SMTP_HOST;

function fill(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m).replace(/\\n/g, '\n');
}

async function queueEmails(req: Request, recs: any[], periodId: string) {
  if (!smtpReady()) throw new HttpError(400, 'Email is not configured on the server (SMTP_HOST, SMTP_USER, SMTP_PASS in server/.env)');
  const emails = new Map((await db.query(`SELECT id, email FROM pr_employees WHERE id = ANY($1::uuid[])`, [recs.map((r) => r.employee_id)])).map((e) => [e.id, e.email]));
  let queued = 0;
  const skipped: string[] = [];
  for (const rec of recs) {
    const to = emails.get(rec.employee_id);
    if (!to) { skipped.push(rec.employee_name); continue; }
    await db.query(
      `INSERT INTO pr_email_log (business_id, record_id, period_id, employee_id, to_email, status, created_by) VALUES ($1,$2,$3,$4,$5,'queued',$6)`,
      [bid(req), rec.id, periodId, rec.employee_id, to, req.auth.userId],
    );
    queued++;
  }
  setImmediate(() => processEmailQueue().catch(console.error));
  return { queued, skipped };
}

r.post('/periods/:id/email', requirePerm('payroll.process', 'payroll.payments'), ah(async (req, res) => {
  const p = await getOwned(db, 'pr_periods', req.params.id, bid(req), 'Payroll period');
  if (!isLocked(p.status)) throw bad('Approve the payroll before emailing payslips');
  const ids: string[] = Array.isArray(req.body?.record_ids) ? req.body.record_ids : [];
  const onlyUnsent = req.body?.only_unsent !== false;
  let recs = await db.query(`SELECT * FROM pr_records WHERE period_id=$1 ${ids.length ? 'AND id = ANY($2::uuid[])' : ''}`, ids.length ? [p.id, ids] : [p.id]);
  if (onlyUnsent && !ids.length) {
    const sent = new Set((await db.query(`SELECT record_id FROM pr_email_log WHERE period_id=$1 AND status IN ('sent','queued')`, [p.id])).map((x) => x.record_id));
    recs = recs.filter((r) => !sent.has(r.id));
  }
  const out = await queueEmails(req, recs, p.id);
  await audit(req, 'payroll_payslip_email', 'pr_periods', p.id, out);
  res.json(out);
}));

r.get('/email-log', requirePerm('payroll.access', 'payroll.process', 'payroll.payments'), ah(async (req, res) => {
  const params: any[] = [bid(req)];
  let w = 'l.business_id=$1';
  if (req.query.period_id) w += ` AND l.period_id=$${params.push(String(req.query.period_id))}`;
  if (req.query.status) w += ` AND l.status=$${params.push(String(req.query.status))}`;
  res.json(await db.query(
    `SELECT l.*, e.full_name, p.code AS period_code, p.name AS period_name FROM pr_email_log l
       LEFT JOIN pr_employees e ON e.id=l.employee_id LEFT JOIN pr_periods p ON p.id=l.period_id
      WHERE ${w} ORDER BY l.created_at DESC LIMIT 1000`, params));
}));

r.post('/email-log/:id/resend', requirePerm('payroll.process', 'payroll.payments'), ah(async (req, res) => {
  const l = await getOwned(db, 'pr_email_log', req.params.id, bid(req), 'Email');
  if (!smtpReady()) throw bad('Email is not configured on the server');
  const e = await db.one(`SELECT email FROM pr_employees WHERE id=$1`, [l.employee_id]);
  await db.query(`UPDATE pr_email_log SET status='queued', error=NULL, to_email=COALESCE($2,to_email) WHERE id=$1`, [l.id, e?.email || null]);
  setImmediate(() => processEmailQueue().catch(console.error));
  res.json({ ok: true });
}));

let busy = false;
export async function processEmailQueue() {
  if (busy || !smtpReady()) return;
  busy = true;
  try {
    const port = Number(process.env.SMTP_PORT || 587);
    const mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    for (;;) {
      const l = await db.one(`SELECT * FROM pr_email_log WHERE status='queued' AND attempts < 3 ORDER BY created_at LIMIT 1`);
      if (!l) break;
      try {
        const rec = await db.one(`SELECT * FROM pr_records WHERE id=$1`, [l.record_id]);
        const p = await db.one(`SELECT * FROM pr_periods WHERE id=$1`, [l.period_id]);
        const s = await db.one(`SELECT * FROM pr_settings WHERE business_id=$1`, [l.business_id]);
        const slip = await recordSlip(db, rec);
        const vars = { name: rec!.employee_name, period: p!.name, code: p!.code, net: money(rec!.net_payable, rec!.currency).replace('¢', '₡'), company: slip.company.name || '' };
        const subject = fill(s?.email_subject || 'Comprobante de pago – {period}', vars);
        await mailer.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER, to: l.to_email, subject,
          text: fill(s?.email_body || 'Adjuntamos su comprobante de pago.', vars),
          attachments: [{ filename: `comprobante-${p!.code}.pdf`, content: slipsPdf([slip]) }],
        });
        await db.query(`UPDATE pr_email_log SET status='sent', sent_at=now(), subject=$2, attempts=attempts+1, error=NULL WHERE id=$1`, [l.id, subject]);
      } catch (e: any) {
        const failed = await db.one(`UPDATE pr_email_log SET attempts=attempts+1, error=$2, status=CASE WHEN attempts+1 >= 3 THEN 'failed' ELSE 'queued' END WHERE id=$1 RETURNING status`, [l.id, String(e.message || e).slice(0, 500)]);
        if (failed?.status === 'failed') {
          const emp = await db.one(`SELECT full_name FROM pr_employees WHERE id=$1`, [l.employee_id]);
          await notify(l.business_id, null, 'payroll_email_failed', `Payslip email to ${emp?.full_name} (${l.to_email}) failed: ${String(e.message || e).slice(0, 120)}`);
        } else await new Promise((ok) => setTimeout(ok, 3000));
      }
    }
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------- Employee self-service (own payslips)
async function myEmployee(req: Request) {
  const e = await db.one(`SELECT * FROM pr_employees WHERE user_id=$1 AND business_id=$2`, [req.auth.userId, bid(req)]);
  if (!e) throw new HttpError(404, 'Your user is not linked to a payroll employee record. Ask HR to link it.');
  return e;
}
r.get('/me', requirePerm('payroll.self'), ah(async (req, res) => {
  const e = await myEmployee(req);
  const records = await db.query(
    `SELECT r.id, p.code, p.name AS period_name, p.start_date, p.end_date, p.pay_date, r.hours, r.gross, r.total_deductions, r.net_payable, r.paid_amount, r.payment_status
       FROM pr_records r JOIN pr_periods p ON p.id=r.period_id
      WHERE r.employee_id=$1 AND p.status IN ('approved','partially_paid','paid','closed') ORDER BY p.end_date DESC`, [e.id]);
  const salaries = await db.query(`SELECT effective_from, salary_type, hourly_rate, monthly_salary, currency FROM pr_salary_history WHERE employee_id=$1 ORDER BY effective_from DESC`, [e.id]);
  const dept = e.department_id ? await db.one(`SELECT name FROM pr_departments WHERE id=$1`, [e.department_id]) : null;
  res.json({ employee: { id: e.id, code: e.code, full_name: e.full_name, cedula: e.cedula, email: e.email, phone: e.phone, department: dept?.name, joining_date: e.joining_date, bank_account: e.bank_account }, records, salaries });
}));
r.get('/me/payslips/:id.pdf', requirePerm('payroll.self'), ah(async (req, res) => {
  const e = await myEmployee(req);
  const rec = await db.one(
    `SELECT r.* FROM pr_records r JOIN pr_periods p ON p.id=r.period_id WHERE r.id=$1 AND r.employee_id=$2 AND p.status IN ('approved','partially_paid','paid','closed')`,
    [req.params.id, e.id]);
  if (!rec) throw bad('Payslip not found');
  sendPdf(res, `payslip.pdf`, slipsPdf([await recordSlip(db, rec)]));
}));

export default r;
