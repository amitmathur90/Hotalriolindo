# Hacienda engine — internal API (ITS POS backend)

All routes are under `/api/hacienda` unless noted. They require a session token (`Authorization: Bearer …`), are scoped to the
authenticated business, are rate-limited (600 requests/minute per user) and are written to the audit log when they change data.
Secrets (API password, `.p12`, PIN) are never returned. These are ITS POS routes, not Hacienda endpoints.

Permissions: **settings.manage** = merchant administrator · **pos.sell** = cashier · **reports.view / accounting.view** = read
documents and reports · **pos.refund / accounting.manage** = adjustment documents.

## Company, credentials, branches

| Method & route | Permission | Purpose |
|---|---|---|
| `GET /settings` | settings.manage | Company identity, environment, credential/certificate status, what is still missing |
| `PUT /settings` | settings.manage | Update company fields, API user/password (encrypted), terminal, fixed USD rate, Registro 8707, mailbox; `{enabled}` activates |
| `POST /settings/certificate` | settings.manage | Upload the `.p12` (base64) + PIN; validates the key, expiry and that it belongs to the cédula |
| `POST /settings/test` | settings.manage | Gets a token from Hacienda's IDP and signs/verifies a test document |
| `GET /branches` | settings.manage | Stores (sucursal number, activity) and POS devices (terminal) |
| `PUT /branches/:storeId` | settings.manage | `{hacienda_branch, hacienda_activity}` — branch number locked once it has documents |
| `PUT /terminals/:deviceId` | settings.manage | `{hacienda_terminal}` — unique per store |
| `GET /sequences` · `PUT /sequences` | settings.manage | Current numbers; set the next number per branch/terminal/type (never below a used one) |

## CABYS

| Method & route | Permission | Purpose |
|---|---|---|
| `GET /cabys?q=…` / `?codigo=…` | any user | Search: local official catalogue when imported, otherwise Hacienda's public CABYS API |
| `GET /cabys/catalogue` | any user | Active catalogue version, import date, number of codes |
| `POST /cabys/import` | settings.manage | `{file: {name, content(base64)}, version}` — Excel (.xlsx) or CSV from BCCR/Hacienda |
| `GET /cabys/products` | products.manage | Mapping report: products without a code, using the default/category code or a code missing from the catalogue |
| `PUT /api/products/:id/cabys` (also `/api/hacienda/products/:id/cabys`) | products.manage | `{cabys, unit}` — validated against the catalogue, kept in history |
| `GET /products/:id/cabys-history` | products.manage | Mapping changes |

## Documents

| Method & route | Permission | Purpose |
|---|---|---|
| `POST /api/sales` (POS) | pos.sell | A completed sale reserves its tiquete / factura in the same transaction (`einvoice: {type:'FE', receptor}` for a factura) |
| `POST /documents` | pos.sell | `{sale_id, doc_type, receptor}` — create the document of a sale that has none (idempotent per sale) |
| `POST /invoices` | pos.sell | Manual factura / tiquete (rooms, events, services), CRC or USD, credit terms; `idempotency_key` optional |
| `GET /documents` | reports.view | Filters `from,to,status (comma list),doc_type,source,currency,store_id,q`, pagination `limit,offset` |
| `GET /documents/:id` | reports.view / pos.sell | Detail + lifecycle events + e-mails + related documents |
| `GET /documents/:id/status` | reports.view / pos.sell | Current status only |
| `GET /documents/:id/xml?kind=unsigned\|signed\|response` | reports.view / pos.sell | Original XML, signed XML, Hacienda's response (download is audited) |
| `GET /documents/:id/pdf?format=a4\|80mm\|58mm` | reports.view / pos.sell | PDF / thermal receipt |
| `POST /documents/:id/retry` | settings.manage / reports.view | Rebuild (never submitted) or re-check (possibly received) after reconciliation |
| `POST /documents/:id/reissue` | settings.manage | New clave for a rejected / failed document |
| `POST /credit-notes` | pos.refund / accounting.manage | `{document_id, reason, lines?}` — without lines = full anulación (code 01) |
| `POST /debit-notes` | pos.refund / accounting.manage | `{document_id, reason, lines}` |
| `POST /documents/:id/annul` | pos.refund | Shortcut for a full credit note of a manual / Cloudbeds document |
| `POST /documents/:id/email` | pos.sell | Resend (PDF + XML + response); never changes the Hacienda status |
| `POST /sales/:id/factura` | pos.sell | Replace a sale's tiquete by a factura (nota de crédito + factura) |

## Received documents (suppliers)

`GET /received`, `POST /received/import`, `POST /received/check-inbox`, `POST /received/:id/decide` (`05` accept, `06` partial,
`07` reject → signed Mensaje Receptor), `GET /received/:id/pdf`, `GET /received/:id/xml?kind=mensaje|response`.

## Dashboard and reports

| Route | Purpose |
|---|---|
| `GET /dashboard?from&to` | Counts by status and type, totals (CRC), tax by rate, 14-day error trend, health (credentials, certificate days left, queue) |
| `GET /reports/sales?from&to&group=day\|month&store_id&doc_type&status` | Electronic sales |
| `GET /reports/taxes?from&to&store_id` | Base and IVA by rate, exempt, other charges |
| `GET /reports/errors?from&to` | Validation failures, credential errors, refused submissions, rejections |
| `GET /fx` | Today's USD rate (Hacienda/BCCR or fixed) |

## Status model

`pending` (queued) → `validation_failed` | `signed` → `sent` (submitted) → `processing` → `accepted` | `rejected`;
plus `error` (refused at reception), `auth_error` (credentials) and `manual_review` (outcome cannot be determined).
HTTP 201/202 from Hacienda only means *submitted*; *accepted* is recorded only from Hacienda's final answer.
