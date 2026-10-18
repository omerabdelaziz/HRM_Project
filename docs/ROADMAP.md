# Roadmap

Phases 1–3 of the specification are implemented and tested. This is what remains, in the specification's order. The foundations they need already exist: approval request types, notification types, document storage, the report framework, the permission catalog and data scopes.

## Phase 4 — Talent and self-service extensions
- **Recruitment / ATS**: vacancies linked to positions and budget, applications and CV upload, pipeline stages, interviews and feedback, offers through the existing `JOB_OFFER` workflow, convert a candidate into an employee (reusing `createEmployee`), searchable candidate database
- **Onboarding**: checklist templates, tasks assigned to HR/IT/Finance/managers, document collection, probation review and confirmation (the probation-ending reminder already exists)
- **Performance**: goals/KPIs, review cycles (annual, quarterly, probation), self- and manager assessments, rating summaries
- **Training**: programs, enrollment, attendance, completion, certificates, costs, skills and gap analysis
- **Self-service**: HR inquiries / service requests with status tracking, a policy document library

## Phase 5 — Employee lifecycle and finance
- **Benefits and compensation reviews**: benefit plans and eligibility, medical insurance tracking, review cycles feeding the existing salary-change workflow
- **Expenses**: categories and limits, receipts, `EXPENSE` workflow, payment status, payroll integration through run adjustments
- **Documents and letters**: templates for employment, salary and experience certificates; contract renewals
- **Offboarding**: resignation requests (`RESIGNATION` workflow), notice periods, exit interviews, asset handover, access revocation checklist, final settlement (configurable end-of-service rules)
- **Employee relations**: grievances, disciplinary cases, warnings and investigations with restricted access

## Phase 6 — Analytics and hardening (partly done)
Done: executive dashboard, 12 reports with export, saved and scheduled reports, audit, backups, rate limiting, MFA.

Remaining:
- Dashboard tiles for recruitment, training and performance (they slot into the existing `upcoming` block of `/api/dashboard`)
- SMS/WhatsApp notification channel
- SSO (SAML/OIDC)
- Background job queue for very large imports and payroll runs (current limits: 5,000 rows per import file; payroll runs in a single 10-minute transaction)
- Arabic shaping in PDF payslips (needs an embedded Arabic font)
- Performance testing and indexing review at scale
- Frontend end-to-end tests (e.g. Playwright)

## Known limitations
- Payslip PDFs are English-only: the built-in PDF fonts can't render Arabic.
- Attendance-correction times are entered in the browser's time zone; this matches the company time zone for single-region deployments.
- Email is sent fire-and-forget after the database change; a failed send is logged, not retried.
