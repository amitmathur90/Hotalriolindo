// End-to-end check of the accounting module (contabilidad). Fresh demo database, server pointed at the mock services
// (see cubo-e2e.mjs for the env vars). Usage: node scripts/accounting-e2e.mjs [apiBase] [mockBase]
import forge from 'node-forge';

const BASE = process.argv[2] || 'http://localhost:4100';
let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ✔', m); } else { fail++; console.log('  ✘', m, x === undefined ? '' : JSON.stringify(x).slice(0, 500)); } };
async function api(method, path, body, token) {
  const res = await fetch(BASE + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  let data = t;
  try { data = JSON.parse(t); } catch {}
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(d + 'T12:00:00Z').getTime() + n * 86400e3).toISOString().slice(0, 10);
const near = (a, b, t = 0.011) => Math.abs(Number(a) - Number(b)) < t;
function testP12(pin) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400e3); cert.validity.notAfter = new Date(Date.now() + 365 * 86400e3);
  const attrs = [{ name: 'commonName', value: 'HOTEL RIO LINDO PRUEBA' }, { type: '2.5.4.5', value: 'CPJ-3-101-123456' }];
  cert.setSubject(attrs); cert.setIssuer(attrs); cert.sign(keys.privateKey, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], pin, { algorithm: '3des' })).getBytes(), 'binary').toString('base64');
}
const supplierXml = (n, total = 11300, tax = 1300) => {
  const cons = '0010000101' + String(n).padStart(10, '0');
  const clave = '506' + '181126' + '003101999999' + cons + '1' + String(20000000 + n).slice(-8);
  return `<?xml version="1.0" encoding="utf-8"?><FacturaElectronica xmlns="https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronica"><Clave>${clave}</Clave>` +
    `<CodigoActividadEmisor>461001</CodigoActividadEmisor><NumeroConsecutivo>${cons}</NumeroConsecutivo><FechaEmision>${today}T10:00:00-06:00</FechaEmision>` +
    `<Emisor><Nombre>Distribuidora Contable S.A.</Nombre><Identificacion><Tipo>02</Tipo><Numero>3101999999</Numero></Identificacion></Emisor>` +
    `<Receptor><Nombre>Hotel Rio Lindo S.A.</Nombre><Identificacion><Tipo>02</Tipo><Numero>3101123456</Numero></Identificacion></Receptor><CondicionVenta>02</CondicionVenta><PlazoCredito>15</PlazoCredito>` +
    `<DetalleServicio><LineaDetalle><NumeroLinea>1</NumeroLinea><CodigoCABYS>2213000000000</CodigoCABYS><Cantidad>10</Cantidad><UnidadMedida>Unid</UnidadMedida><Detalle>Cerveza</Detalle>` +
    `<PrecioUnitario>1000</PrecioUnitario><MontoTotal>10000</MontoTotal><SubTotal>10000</SubTotal><Impuesto><Codigo>01</Codigo><CodigoTarifaIVA>08</CodigoTarifaIVA><Tarifa>13</Tarifa><Monto>${tax}</Monto></Impuesto>` +
    `<MontoTotalLinea>${total}</MontoTotalLinea></LineaDetalle></DetalleServicio><ResumenFactura><CodigoTipoMoneda><CodigoMoneda>CRC</CodigoMoneda><TipoCambio>1</TipoCambio></CodigoTipoMoneda>` +
    `<TotalVenta>10000</TotalVenta><TotalVentaNeta>10000</TotalVentaNeta><TotalImpuesto>${tax}</TotalImpuesto><TotalComprobante>${total}</TotalComprobante></ResumenFactura></FacturaElectronica>`;
};
async function balanced(O, label) {
  const tb = (await api('GET', `/accounting/reports/trial-balance?from=2000-01-01&to=${addDays(today, 400)}`, null, O)).data;
  ok(tb.totals?.balanced, `${label}: trial balance balanced (₡${tb.totals?.debit})`, tb.totals);
  const bs = (await api('GET', `/accounting/reports/balance-sheet?as_of=${addDays(today, 400)}`, null, O)).data;
  ok(bs.totals?.balanced, `${label}: balance sheet balances (assets ₡${bs.totals?.assets})`, bs.totals);
  return { tb, bs };
}
const acct = (list, key) => list.find((a) => a.key === key);
const entriesOf = async (O, q) => (await api('GET', `/accounting/entries?from=2000-01-01&to=${addDays(today, 400)}&q=${encodeURIComponent(q)}`, null, O)).data;

for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(1000); }
const owner = (await api('POST', '/auth/login', { email: 'owner@demo.com', password: 'demo123' })).data;
const O = owner.token;
const dev = (await api('POST', '/auth/devices', { store_id: owner.stores[0].id, name: 'Acc E2E' }, O)).data;
const C = (await api('POST', '/auth/pin', { pin: '3333' }, dev.token)).data.token;
const M = (await api('POST', '/auth/pin', { pin: '2222' }, dev.token)).data.token;

console.log('Chart & permissions');
let accounts = (await api('GET', '/accounting/accounts', null, O)).data;
ok(accounts.length >= 40 && acct(accounts, 'iva_payable') && acct(accounts, 'bank_usd')?.currency === 'USD', `Costa Rican chart of accounts created (${accounts.length} accounts)`);
ok((await api('GET', '/accounting/accounts', null, C)).status === 403, 'cashier cannot open accounting');
const roles = (await api('GET', '/roles', null, O)).data;
ok(roles.find((r) => r.name === 'Accountant')?.permissions.includes('accounting.manage'), 'Accountant role has accounting permissions');

console.log('POS sales posted automatically');
await balanced(O, 'demo history');
const cat = (await api('GET', '/pos/catalog', null, C)).data;
const casado = cat.products.find((p) => p.name === 'Casado con pollo');
const cash = cat.paymentMethods.find((m) => m.type === 'cash');
const card = cat.paymentMethods.find((m) => m.type === 'card');
await api('POST', '/shifts/open', { opening_cash: 0 }, C);
const sale = (await api('POST', '/sales', { client_uuid: crypto.randomUUID(), items: [{ variant_id: casado.variants[0].id, qty: 2 }], payments: [{ method_id: cash.id, amount: 20000 }] }, C)).data;
const sale2 = (await api('POST', '/sales', { client_uuid: crypto.randomUUID(), items: [{ variant_id: casado.variants[0].id, qty: 1 }], payments: [{ method_id: card.id, amount: 1 }] }, C));
await api('POST', '/accounting/sync', {}, O);
let es = await entriesOf(O, `#${sale.receipt_no}`);
const se = es.find((e) => e.source_id === sale.id);
const line = (e, key) => e?.lines.find((l) => l.account_id === acct(accounts, key).id);
ok(se && near(line(se, 'cash').debit, sale.total) && near(line(se, 'iva_payable').credit, sale.tax_total), `sale #${sale.receipt_no}: cash ₡${sale.total} debited (change excluded), IVA ₡${sale.tax_total} credited`, { lines: se?.lines.map((l) => [l.account_name, l.debit, l.credit]), sale: [sale.total, sale.paid, sale.change, sale.tax_total, sale.service_charge] });
ok(!sale.service_charge || near(line(se, 'service_payable')?.credit, sale.service_charge), 'service charge to its liability');
ok(sale.cost_total == 0 || near(line(se, 'cogs')?.debit, sale.cost_total), 'cost of sales posted against inventory');
const refund = await api('POST', `/sales/${sale.id}/refund`, { reason: 'Prueba contable' }, M);
await api('POST', '/accounting/sync', {}, O);
es = await entriesOf(O, `Devolución POS #${refund.data.receipt_no}`);
const re = es.find((e) => e.source_id === refund.data.id);
ok(re && near(line(re, 'cash').credit, sale.total) && near(line(re, 'sales_pos').debit, line(se, 'sales_pos').credit), 'refund reverses the cash and sales', es.map((e) => [e.source_id, e.memo]));
await balanced(O, 'after POS sales');

console.log('Receivables (credit invoice in USD) with exchange difference');
await api('PUT', '/hacienda/settings', { environment: 'stag', legal_name: 'Hotel Rio Lindo S.A.', trade_name: 'Hotel Rio Lindo', id_type: '02', id_number: '3101123456', activity_code: '551001', provider_id: '3101123456', provincia: '6', canton: '05', distrito: '04', otras_senas: 'Dominical centro', email: 'f@riolindo.test', api_username: 'cpj-test', api_password: 'secret', default_cabys: '6331000000100' }, O);
await api('POST', '/hacienda/settings/certificate', { p12_base64: testP12('4321'), pin: '4321' }, O);
await api('PUT', '/hacienda/settings', { enabled: true }, O);
const fe = (await api('POST', '/hacienda/invoices', { doc_type: '01', currency: 'USD', exchange_rate: 500, condition: '02', credit_days: 30, receptor: { nombre: 'Agencia de Viajes Tico S.A.', id_type: '02', id_number: '3101888888' }, lines: [{ name: 'Paquete hospedaje grupo', qty: 1, price: 1000, tax_rate: 13 }] }, O)).data;
await api('POST', '/accounting/sync', {}, O);
let ar = (await api('GET', '/accounting/open-items?kind=ar', null, O)).data;
const item = ar.find((i) => i.number === fe.consecutivo);
ok(item && item.currency === 'USD' && near(item.total, 1130) && item.status === 'open' && item.due_date?.slice(0, 10) === addDays(today, 30), 'credit factura opens a US$1 130 receivable due in 30 days', item);
es = await entriesOf(O, fe.consecutivo);
const fen = es.find((e) => e.source === 'edoc');
ok(fen && near(line(fen, 'ar').debit, 565000) && near(line(fen, 'sales_other').credit, 500000) && near(line(fen, 'iva_payable').credit, 65000), 'invoice entry: AR ₡565 000 = sales ₡500 000 + IVA ₡65 000 (T/C 500)', fen?.lines);
const ageing = (await api('GET', `/accounting/reports/ageing?kind=ar&as_of=${addDays(today, 45)}`, null, O)).data;
ok(ageing.rows.find((r) => r.number === fe.consecutivo)?.bucket === 'd1_30' && near(ageing.totals.USD.d1_30, 1130), 'ageing at +45 days: in the 1–30 days overdue bucket');
const usdBank = acct(accounts, 'bank_usd');
const crcBank = acct(accounts, 'bank_crc');
const mismatch = await api('POST', '/accounting/payments', { kind: 'receipt', account_id: usdBank.id, currency: 'CRC', allocations: [{ item_id: item.id, amount: 100 }] }, O);
ok(mismatch.status === 400, 'payment currency must match the invoice', mismatch.data);
const over = await api('POST', '/accounting/payments', { kind: 'receipt', account_id: usdBank.id, currency: 'USD', exchange_rate: 510, allocations: [{ item_id: item.id, amount: 2000 }] }, O);
ok(over.status === 400 && /saldo/.test(over.data.error), 'cannot apply more than the balance');
const rc = await api('POST', '/accounting/payments', { kind: 'receipt', account_id: usdBank.id, currency: 'USD', exchange_rate: 510, reference: 'TRF-001', allocations: [{ item_id: item.id, amount: 1130 }] }, O);
ok(rc.status === 201, 'customer payment US$1 130 at T/C 510 recorded', rc.data);
es = await entriesOf(O, 'TRF-001');
ok(es[0] && near(line(es[0], 'fx_gain')?.credit, 11300) && near(line(es[0], 'bank_usd').debit, 576300) && near(line(es[0], 'bank_usd').amount_fc, 1130), 'exchange gain ₡11 300 booked; USD bank shows US$1 130', es[0]?.lines);
ar = (await api('GET', '/accounting/open-items?kind=ar', null, O)).data;
ok(ar.find((i) => i.id === item.id)?.status === 'paid', 'receivable marked paid');

console.log('Payables (supplier invoice) and IVA credit');
const imp = (await api('POST', '/hacienda/received/import', { files: [{ name: 'p.xml', content: supplierXml(77) }] }, O)).data.results[0];
await api('POST', `/hacienda/received/${imp.id}/decide`, { decision: '05', category: 'Insumos de bar', condicion: '01' }, O);
await api('POST', '/accounting/sync', {}, O);
let ap = (await api('GET', '/accounting/open-items?kind=ap', null, O)).data;
const bill = ap.find((i) => i.partner_name === 'Distribuidora Contable S.A.');
ok(bill && near(bill.total, 11300) && bill.due_date?.slice(0, 10) === addDays(today, 15), 'supplier invoice opens an ₡11 300 payable due in 15 days (plazo from the XML)', bill);
es = await entriesOf(O, 'Distribuidora Contable');
const be = es.find((e) => e.source === 'received');
ok(be && near(line(be, 'iva_credit').debit, 1300) && near(line(be, 'ap').credit, 11300), 'IVA ₡1 300 to tax credit, ₡11 300 to payables', be?.lines);
ok(be?.lines.some((l) => /Insumos de cocina y bar/.test(l.account_name) && near(l.debit, 10000)), 'expense category mapped to "Insumos de cocina y bar"', be?.lines.map((l) => l.account_name));
const pay = await api('POST', '/accounting/payments', { kind: 'payment', account_id: crcBank.id, currency: 'CRC', reference: 'CHQ-55', allocations: [{ item_id: bill.id, amount: 11300 }] }, O);
ok(pay.status === 201, 'supplier paid from the colones bank');
ap = (await api('GET', '/accounting/open-items?kind=ap', null, O)).data;
ok(ap.find((i) => i.id === bill.id)?.status === 'paid', 'payable marked paid');

console.log('Expenses & manual entries');
await api('POST', '/expenses', { category: 'Mantenimiento', amount: 25000, note: 'Reparación bomba de agua', spent_on: today }, O);
await api('POST', '/accounting/sync', {}, O);
es = await entriesOf(O, 'bomba de agua');
ok(es[0] && es[0].lines.some((l) => /Mantenimiento/.test(l.account_name) && near(l.debit, 25000)) && near(line(es[0], 'cash').credit, 25000), 'hand-entered expense: maintenance account against cash');
const unb = await api('POST', '/accounting/entries', { date: today, memo: 'Aporte de capital', lines: [{ account_id: crcBank.id, debit: 1000000 }, { account_id: acct(accounts, 'capital').id, credit: 900000 }] }, O);
ok(unb.status === 400 && /no cuadra/.test(unb.data.error), 'unbalanced entry refused');
const cap = await api('POST', '/accounting/entries', { date: today, memo: 'Aporte de capital socios', lines: [{ account_id: crcBank.id, debit: 1000000 }, { account_id: acct(accounts, 'capital').id, credit: 1000000 }] }, O);
ok(cap.status === 201, 'manual journal entry posted', cap.data);
const autoRev = await api('POST', `/accounting/entries/${se.id}/reverse`, {}, O);
ok(autoRev.status === 400, 'automatic entries cannot be reversed by hand');

console.log('Bank statement & reconciliation');
const csv = `Fecha;Descripción;Referencia;Débito;Crédito;Saldo\n${today.split('-').reverse().join('/')};Aporte socios;DEP-1;;1.000.000,00;1.000.000,00\n` +
  `${today.split('-').reverse().join('/')};Cheque proveedor;CHQ-55;11.300,00;;988.700,00\n${today.split('-').reverse().join('/')};Comisión mantenimiento cuenta;COM;1.500,00;;987.200,00\n`;
const imp1 = (await api('POST', `/accounting/banks/${crcBank.id}/import`, { content: csv }, O)).data;
ok(imp1.created === 3 && imp1.matched === 2, `statement imported: 3 lines, 2 matched automatically`, imp1);
const imp2 = (await api('POST', `/accounting/banks/${crcBank.id}/import`, { content: csv }, O)).data;
ok(imp2.created === 0 && imp2.duplicates === 3, 're-importing the same statement adds nothing');
let rec = (await api('GET', `/accounting/banks/${crcBank.id}/reconciliation`, null, O)).data;
const fee = rec.bank_lines.find((l) => l.status === 'open');
ok(fee && near(fee.amount, -1500), 'bank fee left to reconcile');
await api('POST', `/accounting/bank-lines/${fee.id}/entry`, { account_id: acct(accounts, 'bank_fees').id, memo: 'Comisión bancaria' }, O);
rec = (await api('GET', `/accounting/banks/${crcBank.id}/reconciliation`, null, O)).data;
ok(rec.unmatched_bank === 0 && near(rec.book_balance, rec.statement_balance), `reconciled: book ₡${rec.book_balance} = statement ₡${rec.statement_balance}`, { b: rec.book_balance, s: rec.statement_balance });

console.log('Reports');
const { bs } = await balanced(O, 'after all transactions');
const pnl = (await api('GET', `/accounting/reports/pnl?from=2000-01-01&to=${addDays(today, 400)}&by_month=1`, null, O)).data;
ok(pnl.totals.income > 0 && pnl.months?.length >= 1 && near(pnl.totals.net, pnl.totals.income - pnl.totals.cogs - pnl.totals.expenses), `P&L: income ₡${pnl.totals.income}, net ₡${pnl.totals.net}`);
ok(near(bs.current_result, pnl.totals.net), 'balance sheet result equals P&L net');
const cf = (await api('GET', `/accounting/reports/cash-flow?from=2000-01-01&to=${addDays(today, 400)}`, null, O)).data;
const cashBal = accounts.length && (await api('GET', '/accounting/accounts', null, O)).data.filter((a) => a.subtype === 'cash' || a.subtype === 'bank').reduce((s, a) => s + Number(a.balance), 0);
ok(near(cf.closing, cashBal, 0.05) && cf.sections.find((s) => s.section === 'financing')?.total >= 1000000, `cash flow closing ₡${cf.closing} = cash + banks; capital in financing`, cf);
const iva = (await api('GET', `/accounting/reports/iva?month=${today.slice(0, 7)}`, null, O)).data;
ok(iva.iva_credit >= 1300 && iva.sales.some((s) => s.rate === 13 && s.iva >= 65000), `IVA (D-104) ${today.slice(0, 7)}: débito ₡${iva.iva_debit}, crédito ₡${iva.iva_credit}, a pagar ₡${iva.iva_payable}`, iva);

console.log('Closing');
const rv = (await api('POST', '/accounting/close/revalue', { date: today, rate: 520 }, O)).data;
ok(rv.posted && near(rv.net, 1130 * 10), `USD revaluation at ₡520: +₡${rv.net} unrealised, reversed next day`, rv);
await balanced(O, 'after revaluation');
await api('POST', '/accounting/close/lock', { date: today }, O);
const locked = await api('POST', '/accounting/entries', { date: today, memo: 'Ajuste tardío', lines: [{ account_id: crcBank.id, debit: 10 }, { account_id: acct(accounts, 'capital').id, credit: 10 }] }, O);
ok(locked.status === 400 && /cerrado/.test(locked.data.error), 'closed period refuses new manual entries');
const late = (await api('POST', '/expenses', { category: 'Limpieza', amount: 5000, note: 'Gasto tardío', spent_on: today }, O)).data;
await api('POST', '/accounting/sync', {}, O);
es = await entriesOf(O, 'Gasto tardío');
ok(es[0]?.entry_date.slice(0, 10) === addDays(today, 1) && /período cerrado/.test(es[0].memo), 'automatic entry for a closed day moves to the first open day', es[0]);
await api('POST', '/accounting/close/lock', { date: null }, O);
const yr = Number(today.slice(0, 4));
const cy = await api('POST', '/accounting/close/year', { year: yr }, O);
ok(cy.status === 200 && cy.data.entry, `year ${yr} closed to retained earnings (result ₡${cy.data.result})`, cy.data);
const bs2 = (await api('GET', `/accounting/reports/balance-sheet?as_of=${yr}-12-31`, null, O)).data;
ok(bs2.totals.balanced && bs2.equity.some((e) => /Utilidades retenidas/.test(e.name)), 'balance sheet still balances with the result in retained earnings');
const again = await api('POST', '/accounting/close/year', { year: yr }, O);
ok(again.status === 400, 'a year cannot be closed twice');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
