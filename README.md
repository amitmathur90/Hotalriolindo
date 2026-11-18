# ITS POS

Cloud POS, retail and restaurant management system built from `ITS_POS_Complete_PRD.docx`.
One backend and database serve every app: Back Office, POS terminal, Kitchen Display, Customer Display and the digital receipt page. All apps sync in real time over WebSocket.

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS v4, installable PWA |
| Backend | Node.js, Express, TypeScript (run with `tsx`), Socket.IO |
| Database | PostgreSQL (or embedded PGlite for zero-setup development); IndexedDB on the POS for offline use |
| Shared | `shared/pricing.ts`: one pricing/tax engine used by both server and POS, so totals always match |

## Quick start

```bash
cd its-pos
npm install
npm run dev          # API on :4000, web on :5173
```

Open http://localhost:5173. With no `DATABASE_URL` set, the server creates an embedded PostgreSQL database in `server/data/pglite` and seeds a demo café.

| Login | Credentials |
|---|---|
| Back Office (owner) | `owner@demo.com` / `demo123` |
| Back Office (manager) | `manager@demo.com` / `demo123` |
| Platform super admin | `admin@itspos.local` / `admin123` |
| POS PINs | owner `1111`, manager `2222`, cashier `3333`, kitchen `4444`, accountant `5555` |

**App URLs:** `/backoffice` · `/pos` · `/kds` · `/display` (paired from POS → Menu → Customer display) · `/r/:id/:sig` (digital receipt)

The first time a browser opens `/pos` or `/kds`, an owner or manager signs in once to register it as a device. Back Office → Settings → Devices can also register the current browser in one click, and revoke devices.

### Production

```bash
cp server/.env.example server/.env   # set DATABASE_URL, JWT_SECRET, SEED_DEMO=false
npm run build                        # builds web/dist
npm start                            # Express serves the API and the built web app on one port
```

The schema is created and migrated automatically at startup (`server/src/schema.sql`, idempotent). Put the server behind HTTPS (nginx/Caddy). Schedule `pg_dump` backups. Owners can also download a JSON backup from Settings → Security & backup.

### Tests

```bash
# with the server running (e.g. PORT=4100 PGLITE_DIR=./data/test-pglite npm start -w server)
node server/scripts/e2e.mjs http://localhost:4100
```

The end-to-end script exercises the PRD acceptance criteria: 46 checks covering sales, split payments, idempotent offline sync, stock deduction, permissions and manager overrides, refunds, loyalty, tables and kitchen, split bills, POs, transfers, shift cash, report reconciliation and the audit trail.

### Hacienda tests

```bash
npx tsx server/scripts/hacienda-selftest.ts ./out          # builds + signs a tiquete, factura and nota de crédito (offline)
npx tsx server/scripts/hacienda-mock.ts 4199               # local stand-in for Hacienda's IDP and API de Recepción
# fresh database, pointed at the mock:
PORT=4100 PGLITE_DIR=./data/test-hk HACIENDA_IDP_URL=http://localhost:4199/token \
  HACIENDA_API_URL=http://localhost:4199/recepcion/v1/ HACIENDA_POLL_MS=1000 HACIENDA_RETRY_BASE_S=1 npm start -w server
node server/scripts/hacienda-e2e.mjs http://localhost:4100 http://localhost:4199   # 43 checks
# Cubo replacement (manual invoices, USD, supplier invoices, Cloudbeds, QuickBooks): also set
#   HACIENDA_TC_URL=…/tc HACIENDA_CABYS_URL=…/cabys CLOUDBEDS_API_URL=…/cloudbeds QB_AUTH_URL=…/qb/auth QB_TOKEN_URL=…/qb/token
#   QB_API_URL=…/qb JWT_SECRET=e2e-secret QB_CLOSE_DAY_OFFSET=0   (all on http://localhost:4199)
node server/scripts/cubo-e2e.mjs http://localhost:4100 http://localhost:4199       # 61 checks
```

## Single hotel mode

By default the system runs for one business, **Hotel Rio Lindo**: public sign-up is closed (on an empty database `/register` is a one-time setup of the owner account), there is no platform super admin (any left over from SaaS mode is disabled at startup) and the app is branded *Rio Lindo POS*. Set `MULTI_TENANT=true` to run it as a multi-business SaaS again.

## Costa Rica electronic invoicing (Hacienda v4.4)

Back Office → **Hacienda**.

* **Every sale** issues a *tiquete electrónico* (04). Its consecutivo (`001-00001-04-0000000001`) and 50-digit clave are reserved inside the sale transaction and printed on the receipt immediately.
* **Factura electrónica** (01): tick *Factura electrónica* on the POS payment screen and enter the customer's identification (física 9 digits, jurídica 10, DIMEX 11–12, NITE 10), name and e-mail. The details are saved on the customer for next time. For a sale that already has a tiquete, open the receipt → *Factura electrónica (datos del cliente)*: the tiquete is annulled with a nota de crédito and a factura is issued in its place.
* **Refunds** issue a *nota de crédito electrónica* (03) that references the original tiquete/factura (code 01 for a full refund, 06 for a partial return).
* A background queue signs each document (XAdES-EPES with the *llave criptográfica*), sends it to Hacienda's *API de Recepción*, and checks the result. Network failures are retried with back-off, so the POS never waits for Hacienda. Offline sales are issued with *situación 3* when they sync.
* Rejected documents and errors appear in Hacienda → Comprobantes, with Hacienda's message, and as a notification. *Reintentar* resends a document after a fix (e.g. a missing CABYS code). *Reemitir* issues a new document with a new clave.
* Accepted facturas are e-mailed to the customer with the PDF, the XML and Hacienda's response when SMTP is configured (see `server/.env.example`).
* **PDF** of every document (Emitidos → PDF, receipt → PDF): emisor/receptor, lines, otros cargos, totals with the amount in words, notes, legal text and a QR code that opens the public PDF (`APP_URL` / Render's URL).
* **Nueva factura**: manual factura or tiquete for rooms, events, tours and services outside the POS, in **colones or dollars** (Hacienda/BCCR daily exchange rate, or a fixed rate in settings), cash or credit with a term, notes. *Anular* issues the full nota de crédito.
* **Recibidos (proveedores)**: supplier XMLs arrive by upload or from the invoices mailbox (IMAP, checked every 10 minutes). *Responder* sends the signed **Mensaje Receptor** (aceptado / parcial / rechazado) and records accepted invoices as expenses (optionally automatically).
* **Numeración**: set the terminal and the next number per document type, so numbering continues after the one used in Cubo without collisions.
* **CABYS search** (Hacienda catalogue) next to every CABYS field.

**Integrations** (Back Office → Integrations):
* **Cloudbeds**: API key + lodging CABYS. Each checked-out reservation becomes a factura (guest/company with a Costa Rican cédula in Cloudbeds) or a tiquete, in the property currency; totals that don't match Cloudbeds are held for review.
* **QuickBooks Online**: Intuit app Client ID/Secret → *Conectar* (register the shown redirect URI in the Intuit app) → map accounts. Each closed day is posted as a balanced journal entry from the documents Hacienda accepted; accepted supplier invoices are posted as bills (expense + IVA credit).

**Accounting** (Back Office → Accounting; permissions `accounting.view` / `accounting.manage`, given to the Accountant role) — the built-in alternative to QuickBooks:
* Costa Rican chart of accounts (editable). Journal entries are created automatically every 5 minutes, one per source: POS sales and refunds (payment method → cash / card clearing / bank, IVA, 10 % service, tips, cost of sales), manual and Cloudbeds invoices (credit invoices open a receivable), supplier invoices accepted in Hacienda → Recibidos (expense by category, IVA credit, payable with the XML's plazo), hand-entered expenses, approved payroll periods (salaries, employer CCSS %, net pay, CCSS, vales) and payroll payments. When a source changes (rejected, voided, payroll reopened) its entry is reversed and re-posted; the ledger is never edited in place.
* Receivables / payables with payments in CRC or USD (exchange difference booked automatically), ageing and opening balances.
* Banks: import the bank's CSV statement, automatic matching (same amount ±5 days), manual matching, and entries for fees or interest from a statement line.
* Reports: P&L (monthly columns), balance sheet, trial balance, general ledger, cash flow (direct method), IVA summary for the D-104. All exportable (CSV / Excel / PDF).
* Closing: monthly lock, USD revaluation with automatic reversal, year-end close to retained earnings.
* Tests: `node server/scripts/accounting-e2e.mjs http://localhost:4100` (46 checks; same env as the Cubo tests).

**Setup:** enter the emisor details (razón social, cédula, actividad económica, provincia/cantón/distrito, e-mail), the ATV API user and password, and upload the `.p12` key with its PIN. Use *Probar conexión y firma*, then activate in **Pruebas** (sandbox) first. Switch to **Producción** only after documents are accepted in sandbox. Each product needs a 13-digit **CABYS** code, set on the product, its category, or as the default. The secrets are stored encrypted with a key derived from `JWT_SECRET`.

## Payroll Management System

Back Office → **Payroll** (`/backoffice/payroll`), built from `Payroll Management System – Detailed PRD.pdf` and the `26 RL PAYROLL.xlsx` workbook. It has its own sidebar: dashboard, employees, departments & positions, attendance, payroll periods (calculation, approval, payments, payslips, comparison), advances & deductions, overtime/holidays/vacation, CAJA, aguinaldo, payments, payslips & email, reports, Cashbook vs QuickBooks reconciliation, settings & audit log, and *My payslips* for employees.

**Calculation engine:** `shared/payroll.ts` (used by the server and by the browser's *Simulate* sandbox). It supports both salary structures: hourly (hours × rate) and monthly (quincenal = monthly ÷ 2, gross = quincenal × hours ÷ 96). Overtime, holiday, vacation, bonus, CAJA (a % of earnings or fixed insurance salary), accounts (*cuentas*) %, vales and adjustments are all handled. Every rate lives in effective-dated **rule versions** (Payroll → Settings). The defaults come from the newest workbook sheet: 96 h, CAJA 10.83 %, Seguro Fijo 10.67 %, overtime × 1.5, accounts 60 %. They are **observed spreadsheet values, not confirmed legal rules**, and need the owner's confirmation before production.

```bash
npx tsx server/scripts/payroll-selftest.ts     # engine vs 11 employees of the workbook (sheets 1, 4, 8, 11)
# with a server on a fresh database (PORT=4100 PGLITE_DIR=./data/test-payroll npm start -w server):
node server/scripts/payroll-e2e.mjs http://localhost:4100   # 67 checks of the PRD acceptance criteria
```

Key rules enforced:

* **Salaries are effective-dated.** Each payroll stores a snapshot of salary, department, bank and rules, so a new salary never changes payroll already processed.
* **Statuses:** Draft → Attendance pending → Calculation pending → Under review → Approved → Partially paid → Paid → Closed. Approved payroll is locked. Reopening needs `payroll.approve` and a reason, and is refused while payments exist.
* **Pre-approval validation** blocks on errors (missing rate, negative net, duplicate cédula, advance recovery above the balance, unapproved advance). It also warns about: no hours, high deductions, missing bank details, unapproved overtime, salary changes, and more than 30 % variation vs the previous payroll.
* **Manual changes** to calculated amounts need a reason and keep the original value. Recoveries of advances (vales) never exceed the outstanding balance and are posted to the advance ledger on approval. Payments support partial payments, USD at the historical rate and bulk batches.
* **Roles** created for every business: Payroll Admin, HR Manager, Payroll Accountant, Department Manager (attendance for the departments they manage, no salary amounts), Auditor, Employee (own payslips). Only the owner, or a role with `payroll.approve`, can approve.
* **Payslip PDFs** are generated on the server (jsPDF) in Spanish/English. E-mail uses the SMTP settings above, with a queue, three retries and a delivery log.

## Project layout

```
shared/pricing.ts          pricing, discounts, inclusive/exclusive tax, GST split, permission list
server/src/
  schema.sql               all tables (tenant-isolated by business_id / store_id)
  auth.ts                  JWT sessions, device tokens, PIN hashing, RBAC + per-user overrides, manager approvals
  stock.ts                 stock engine (recipes/composites, movements, low-stock and negative-stock detection)
  routes/auth.ts           register, login, PIN login, devices, approvals, display pairing
  routes/catalog.ts        categories, taxes, modifiers, products/variants, bulk ops, CSV import, barcodes
  routes/sales.ts          POS catalog, checkout, refunds, open tickets, merge/split, kitchen orders
  routes/inventory.ts      stock, adjustments + approval, counts, transfers, production, suppliers, POs
  routes/people.ts         customers, loyalty, gift cards, employees, roles, time clock, payroll, shifts, cash
  routes/reports.ts        summary, sales by item/category/employee/payment/hour/day/store, tax, P&L, kitchen
  routes/settings.ts       business, stores, payment types, discounts, tables, notifications, audit, backup, super admin
web/src/
  backoffice/              admin app (dashboard, reports, items, inventory, purchases, customers, employees, cash, settings, audit)
  pos/                     POS terminal (register, payments, tickets, tables, shift, offline queue)
  kds/  display/           kitchen display, customer display, public receipt
```

## PRD coverage

**Implemented**

- **Ecosystem:** Back Office, POS, KDS, Customer Display and the owner dashboard (responsive, usable on phones) share one API and database, with live updates.
- **Roles & permissions:** Super Admin, Owner, Store Manager, Cashier, Inventory Manager, Kitchen Staff and Accountant roles. Roles are editable, and each user can have individual allow/deny overrides. Users can be assigned to specific stores. Manager PIN override covers discounts, price changes, voids and refunds.
- **POS:** product grid, categories, favorites, search, USB/Bluetooth scanner (keyboard wedge), camera scanning (BarcodeDetector), weighted scale barcodes, variants, modifiers with min/max rules, notes, custom price, item/order discounts and coupons, GST, service charge, hold/save/resume tickets, merge and split tickets, customer attach, keyboard shortcuts, dark/light mode.
- **Payments:** cash, card, UPI (with scan-to-pay QR), bank, gift card, store credit, loyalty points and custom types. Split payments, change calculation, per-store payment types.
- **Receipts:** 80mm thermal and A4 tax invoice, logo, GSTIN, CGST/SGST/IGST breakdown, barcode, reprint marked DUPLICATE, refund receipts, WhatsApp/email share, signed digital receipt link.
- **Refunds:** full, partial and item-level refunds with a reason and approval. Money goes back to the original methods and stock is returned. Loyalty points, gift cards and store credit are reversed.
- **Catalog:** standard, variant, composite/recipe, weighted, service and digital items. Cost, price, wholesale price and per-store price override. Bulk activate/category/tax/price %, CSV import/export, EAN-13 barcode generation, images.
- **Inventory:** real-time stock per store, full movement history, adjustments (damage/loss/theft/expiry/wastage/internal use) with approval, barcode-assisted counts with variance, transfers (request → approve → dispatch → partial receive with discrepancy), production batches with costing, low/out/negative stock alerts, valuation and potential profit.
- **Purchasing:** suppliers with GSTIN and outstanding balance. POs move draft → sent → partial → received and update stock, cost and supplier balance. Supplier payments can come from the cash drawer.
- **Employees:** profiles, PIN and password, clock in/out with breaks, manager corrections, payroll prep (hours, overtime at 1.5×, late arrivals, export), login history.
- **Shifts & cash:** opening cash, pay in/out, expenses, deposits, expected vs actual cash, discrepancy alerts, shift report.
- **CRM & loyalty:** customer profiles, segments (new/regular/VIP/inactive/birthday), purchase and points history, earn/redeem rules, minimum redemption, expiry job, manual adjustments, loyalty card scan.
- **Gift cards:** issue, top-up, partial redemption, expiry, transaction history.
- **Restaurant:** dine-in/takeaway/delivery/pickup, tables by area with available/occupied/reserved status, table tickets, kitchen routing per category station (Kitchen/Bar), KDS with timers, colour-coded delays, rush priority, item check-off, recall, sound alerts and "order ready" notification on the POS. Kitchen ticket printing per station.
- **Reports:** dashboard and 14 reports with date presets and custom ranges, store/all-stores filter, CSV/Excel/PDF (print) export. Gross, net and collected figures reconcile with transactions; the e2e tests verify this.
- **Multi-store:** stores limited by plan, store-specific stock, prices, staff, GST mode and receipt numbering; consolidated customers; store comparison.
- **Offline:** catalog and customers cached in IndexedDB; cash/card/UPI sales queued offline with idempotent `client_uuid`; automatic sync with retry; sync status panel; offline sales that drive stock negative are flagged to managers.
- **Security & audit:** every sensitive action is audited (who/what/when/IP), device registration and revocation, tenant isolation on every query, signed receipt links, super admin can suspend businesses.

**Not yet implemented (later PRD phases or needing third-party services)**

- Flutter Android app (PRD Phase 6). The PWA runs on Android and iPad in the meantime.
- Email/SMS/WhatsApp *automated* notifications (in-app notifications only; receipts are shared through the device's WhatsApp/email apps), and two-factor authentication.
- Payment gateway adapters, e-commerce APIs, webhooks and API keys, accounting export, Loyverse data migration beyond item CSV import (PRD Phase 7).
- Direct ESC/POS/Bluetooth printer drivers and printer status. Printing uses the OS print dialog/driver.
- Time-based promotions, multiple selectable price lists, partial payments/layaway, batch/expiry-date stock lots, reserved quantities, payroll approval workflow, subscription billing.
- Redis (not needed at this scale; Socket.IO runs in-process).

**Known trade-offs**

- PIN sign-in needs a connection. Employees already signed in keep selling offline.
- To let offline sales sync, the server accepts offline-flagged sales at the prices the POS recorded. A determined employee could abuse that flag to bypass the price-change permission. Every such sale is marked `offline` in receipts and reports for review.
- Store-level tax rules use the store's GST mode. Tax rates themselves are defined per business.
