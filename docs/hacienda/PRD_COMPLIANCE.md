# ITS POS Hacienda Integration PRD v1.0 — compliance matrix

Status: ✅ implemented and covered by automated tests · ⚠️ partial / needs action outside the code · ❌ not implemented.
Tests: `hacienda-e2e` (43), `cubo-e2e` (61), `hacienda-prd-e2e` (43), `accounting-e2e` (46); generated XML is also validated
with an independent XSD 1.1 validator (Python `xmlschema`).

| PRD § | Requirement | Status | Where / notes |
|---|---|---|---|
| 1, 18 | Native engine, direct Hacienda, no CuboFE | ✅ | `server/src/hacienda/*` |
| 2.2 | FE 01, NC 03, TE 04 | ✅ | |
| 2.2 | ND 02 | ✅ | `POST /debit-notes`, own XSD |
| 2.2 | FEC 08, FEE 09, REP 10 | ❌ later phase | Doc type is extensible (`codes.ts` DOC_NAMES/ROOT/NAMESPACE + XSD folder) |
| 3 | Roles, server-side permissions, tenant scoping | ✅ | `requirePerm` on every route; every query filtered by `business_id`; cashiers cannot read credentials |
| 4 | Node/Express, PostgreSQL, workers | ✅ | Queue runs in-process with durable rows in PostgreSQL (no Redis needed for one instance) |
| 5.1 | Company, branches, terminals, activities | ✅ | Sucursal per store, terminal per POS device, activity per branch; change history in audit log |
| 5.2 | OAuth/OIDC token cache, renewal, test/prod, encrypted secrets, test screen | ✅ | `client.ts`, `secrets.ts` (AES-256-GCM); `auth_error` status |
| 5.3 | CABYS import, versioning, search, product mapping, flags, history, no silent inference | ✅ | `cabys.ts`; a merchant-configured *default* CABYS still exists and is flagged in the mapping report |
| 5.4 | Rates, inclusive/exclusive prices, discounts, service charge, line & document tax, rounding, currencies, rules version | ✅ | `xml.ts`; `rules_version` stored per document |
| 5.4 | Exemptions (exoneraciones) | ❌ | Not implemented (Exoneracion element); needed only for exempt customers |
| 5.5 | Notes reference the original, original preserved | ✅ | `createAdjustmentNote`; originals only get a link |
| 5.6 | v4.4 XML, XSD validation before signing, immutable snapshots + hashes, versioned schemas | ✅ | `xsd.ts` + `xsd/v4.4/`; `xml_unsigned`, `xml_signed`, `xml_hash`, `signed_hash`, `schema_version` |
| 5.7 | XAdES-EPES, cert validity check, verification before submit, cert metadata, renewal | ✅ | HSM / managed key storage not used (keys encrypted in the database) ⚠️ |
| 6 | POST /recepcion, GET /recepcion/{clave}, payload, base64, metadata | ✅ | Every attempt stored in `e_document_events` (HTTP status, message) |
| 6.2 | Status model; 201 ≠ accepted | ✅ | pending, validation_failed, signed, sent, processing, accepted, rejected, error, auth_error, manual_review |
| 7 | Clave 50 / consecutivo 20, atomic allocation, unique constraints, no reuse | ✅ | Sequence upsert in the sale transaction; unique (business, environment, consecutivo) and clave |
| 8 | Sale persisted first, idempotent document request, durable queue, back-off, reconcile ambiguous timeouts, no new clave on timeout | ✅ | `processDoc` (ambiguous → status query → resend same signed XML) |
| 8.2 | Legal continuity (contingencia) procedure | ⚠️ | Offline sales use situación 3; formal contingency procedure to confirm with the accountant |
| 9 | Data model | ✅ | Implemented with equivalent tables (see OPERATIONS.md); items/taxes are kept in the signed XML snapshot rather than separate tables |
| 10 | Internal API | ✅ | `docs/hacienda/API.md`; pagination, rate limit, audit |
| 11.1 | Dashboard | ✅ | Hacienda → Resumen |
| 11.2 | Document screen, history, downloads, retry, notes, resend | ✅ | Emitidos → detail |
| 11.3 | PDF A4 and 58/80 mm thermal, QR | ✅ | `pdf.ts` |
| 11.4 | E-mail with PDF + XML, logs, resend without status change | ✅ | `e_document_emails`; needs SMTP variables ⚠️ |
| 11.5 | Reports with filters and CSV/Excel export | ✅ | Hacienda → Reportes |
| 12 | HTTPS, encryption, RBAC, no secrets in logs, audit, cert monitoring | ✅ | |
| 12 | Backups + tested restore, retention | ⚠️ | Procedure in OPERATIONS.md; requires a paid PostgreSQL plan with backups |
| 12 | Regulatory gate (legal review, provider obligations) | ⚠️ | Outside the code: obtain tax/legal sign-off before production |
| 13 | Error handling scenarios | ✅ | See runbook |
| 14.1–14.3 | Unit, integration, POS & security tests | ✅ | Automated against a local Hacienda stand-in |
| 14.4 #3 | Accepted responses from Hacienda's **real** test environment | ❌ pending | Needs the merchant's sandbox credentials and `.p12` |
| 14.4 #13 | Regulatory and production credential sign-off | ❌ pending | Business decision |
| 16 | Source, migrations, guides, API & ops docs | ✅ | `docs/hacienda/` |
