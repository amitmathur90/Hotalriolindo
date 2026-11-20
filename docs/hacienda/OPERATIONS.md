# Hacienda engine — deployment and operations

## Components

| Piece | Where |
|---|---|
| Engine code | `server/src/hacienda/` — `codes.ts` (clave, consecutivo, catalogues), `xml.ts` (v4.4 XML), `xsd.ts` + `xsd/v4.4/` (official schemas), `sign.ts` (XAdES-EPES), `client.ts` (IDP + recepción), `service.ts` (lifecycle, queue), `cabys.ts`, `pdf.ts`, `received.ts`, `fx.ts` |
| API | `server/src/routes/hacienda.ts` (see `API.md`) |
| Data | PostgreSQL tables `hacienda_settings`, `hacienda_sequences`, `e_documents`, `e_document_events`, `e_document_emails`, `received_documents`, `cabys_versions`, `cabys_codes`, `product_cabys_history` |
| Workers | In the API process: document queue every 15 s, Mensaje Receptor queue every 15 s, certificate check every 6 h, mailbox every 10 min |

The schema is created/migrated automatically at start-up (idempotent SQL). Run **one** API instance (the queues assume a single
worker); scale vertically.

## Environment variables

| Variable | Use |
|---|---|
| `DATABASE_URL` | PostgreSQL (Render internal URL) |
| `JWT_SECRET` | Sessions **and** the key that encrypts the Hacienda password, `.p12` and PIN. Changing it makes the stored credentials unreadable: re-enter them. |
| `APP_URL` | Public URL used in QR codes / e-mail links (Render sets `RENDER_EXTERNAL_URL` automatically) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | E-mailing documents |
| `HACIENDA_POLL_MS` (15000), `HACIENDA_RETRY_BASE_S` (15), `HACIENDA_HTTP_TIMEOUT_MS` (30000), `HACIENDA_MAX_RECONCILE` (20) | Queue tuning |
| `HACIENDA_IDP_URL`, `HACIENDA_API_URL`, `HACIENDA_TC_URL`, `HACIENDA_CABYS_URL` | Override Hacienda endpoints (tests only) |

## Backups and retention

* Use a PostgreSQL plan with daily backups and point-in-time recovery (Render **Basic** plan or higher; the free plan has none).
* Electronic documents, signed XML and Hacienda responses are never deleted by the application. Keep database backups for the
  legally required period (Código de Normas y Procedimientos Tributarios: at least 5 years — confirm with the accountant).
* Owners can also download a JSON export (Settings → Security & backup); it includes documents, events and accounting.
* **Restore test (quarterly):** restore the latest backup into a new database, start a second instance with `DATABASE_URL`
  pointing at it and `SEED_DEMO=false`, and check: Hacienda → Emitidos shows recent documents, a document's XML downloads and
  its SHA-256 matches `signed_hash`.

## Monitoring

Hacienda → **Resumen** shows the health panel: credentials, certificate days left, queue size and age, last acceptance, and
the 14-day error trend. Notifications (bell) are raised for rejected / failed documents, credential problems and when the
certificate expires within 30 days.

## Runbook

| Situation | What happens | Action |
|---|---|---|
| Internet or Hacienda down | Sales continue; documents stay **En cola / Enviado**; retries back off up to 1 h | Nothing. When service returns they are sent. If down for days, follow Hacienda's contingency rules. |
| Send timed out | Document marked *ambiguous*; the next run asks Hacienda for its status. Found → follow it; not found → the **same** signed XML (same clave) is resent | None. After 20 checks without an answer → **Revisión manual**. |
| **Error de credenciales** | Hacienda's IDP refused the user/password | Generate a new API password in ATV, enter it in Configuración. Waiting documents resume immediately. |
| **Validación fallida** | XML failed the official XSD, a CABYS code is missing/obsolete, or the key expired. Nothing was signed or sent | Fix the cause (product CABYS, receptor data, certificate), then *Reintentar* (same clave). |
| **Rechazado** | Hacienda's final answer is a rejection (reason stored) | Correct and *Reemitir* (new clave). For POS sales, the paid sale is untouched. |
| **Error de envío** | Hacienda refused the submission at reception (structure) | Fix and *Reintentar*, or *Reemitir*. |
| **Revisión manual** | Outcome unknown after many checks / Hacienda processing error | Check the clave in ATV ("Consulta de comprobantes"). *Consultar estado* re-asks Hacienda. |
| Certificate expiring | Notification 30 days before, weekly | Download the new `.p12` in ATV, upload it in Configuración. |
| Hacienda publishes v4.5 | — | Add `server/src/hacienda/xsd/v4.5/`, update `xml.ts` for new fields, bump `SCHEMA_VERSION`/`RULES_VERSION`, run `hacienda-e2e`, `cubo-e2e` and `hacienda-prd-e2e` against the sandbox before deploying. Documents keep the version they were issued with. |

## Tests

```bash
npx tsx server/scripts/hacienda-mock.ts 4199 ./out        # stand-in for Hacienda (and Cloudbeds/QuickBooks)
# API on a fresh database pointed at the mock (see README for all variables), then:
node server/scripts/hacienda-e2e.mjs      http://localhost:4100 http://localhost:4199   # 43 checks
node server/scripts/cubo-e2e.mjs          http://localhost:4100 http://localhost:4199   # 61 checks
node server/scripts/hacienda-prd-e2e.mjs  http://localhost:4100 http://localhost:4199   # 43 checks (HACIENDA_HTTP_TIMEOUT_MS=2000)
```

Before production: run the same flows against Hacienda's **sandbox** with the merchant's test credentials for several weeks
(PRD §14.4) and obtain the regulatory sign-off (PRD §12).
