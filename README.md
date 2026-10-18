# Aziz HRM — Integrated Human Resources Management

Aziz HRM is a full-stack HR platform: employees and organization structure, attendance and shifts, leave, a configurable approval engine, payroll with locked periods, an executive dashboard, reports, notifications, audit trail, and English/Arabic (RTL) with light/dark themes.

| Layer | Technology |
|---|---|
| API | Node.js 20+ · TypeScript · Express · Prisma · PostgreSQL 14+ · zod validation · OpenAPI |
| Web | React 18 · Vite · Tailwind CSS · TanStack Query · i18next · Recharts |
| Tests | Vitest + Supertest against a real PostgreSQL test database |

## What's implemented

The project follows the phased plan in the specification. **Phases 1–3 are complete**; parts of Phase 6 (dashboard, reports, security hardening) are in place too. See [docs/ROADMAP.md](docs/ROADMAP.md) for what remains.

| Phase | Scope | Status |
|---|---|---|
| 1 | Authentication (lockout, optional TOTP MFA, rotating refresh tokens), RBAC with 10 roles + data scopes, companies, branches, departments, positions, grades, cost centers, employees (auto numbers, duplicate detection, encrypted IDs/bank details, history, documents, Excel import/export), org chart, workforce planning | ✅ |
| 2 | Shifts (fixed, flexible, overnight, rotating), holidays, web/mobile (geofenced)/device check-in, late/early/overtime calculation, corrections and overtime requests, nightly absence processing, leave types and policies, accrual and carry-forward, balances, overlap/notice/attachment rules, team calendar, **configurable multi-step approval engine** (delegation, escalation, amount limits) | ✅ |
| 3 | Pay components (fixed, % of basic/gross, progressive brackets, caps, eligibility, employer contributions), payroll rules, effective-dated salary structures with approval, payroll runs (calculate → submit → approve/lock → pay, controlled reopening), reconciliation, adjustments, payslip PDFs, bank transfer file, payroll register, multi-currency | ✅ |
| 6 (part) | Executive dashboard with filters, 12 reports with Excel/CSV/PDF export, saved + scheduled reports, notification center + email, announcements, audit log, backups, retention, API docs | ✅ |
| 4, 5 | Recruitment, onboarding, performance, training, benefits, expenses, letters/templates, offboarding, employee relations | ⏳ planned |

## Quick start (development)

Prerequisites: Node.js 20+ and PostgreSQL 14+.

```bash
npm install                                   # installs server and client workspaces
cp server/.env.example server/.env            # then fill in DATABASE_URL, secrets (see below)
npm run db:migrate                            # applies migrations
npm run db:seed --workspace server -- --demo   # reference data + admin + optional demo company
npm run dev:server                            # API on http://localhost:4100  (docs: /api/docs)
npm run dev:client                            # web on http://localhost:5310
```

Generate the secrets for `.env` with:

```bash
node -e "const c=require('crypto');console.log('JWT_SECRET='+c.randomBytes(48).toString('base64url'));console.log('DATA_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64'));console.log('DATA_HASH_KEY='+c.randomBytes(32).toString('base64'))"
```

> Keep `DATA_ENCRYPTION_KEY` safe and backed up: national IDs, bank details and MFA secrets are encrypted with it and cannot be recovered without it.

### Demo data

`npm run db:seed --workspace server -- --demo` creates *Acme Trading LLC* (UAE, AED, Asia/Dubai) with 40 employees, three branches, seven departments, shifts, holidays, leave types, pay components, approval workflows, ~6 weeks of attendance, leave requests and an approved, paid payroll for last month — all created through the real business services. Without `--demo`, only permissions, roles, currencies and the first administrator are created (production).

| Role | Email | Password |
|---|---|---|
| Super Administrator | admin@hrms.local | Admin@12345 |
| HR Manager | layla.haddad@acme.example | Demo@12345 |
| HR Administrator | maria.santos@acme.example | Demo@12345 |
| Payroll Officer | tariq.rahman@acme.example | Demo@12345 |
| Finance Officer | ahmed.khalil@acme.example | Demo@12345 |
| Department Manager (IT) | fatima.alzaabi@acme.example | Demo@12345 |
| Branch Manager (Abu Dhabi) | rahul.menon@acme.example | Demo@12345 |
| Auditor | hana.saleh@acme.example | Demo@12345 |
| Employee | james.carter@acme.example | Demo@12345 |

The seed prints the actual list when it finishes.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Server test suite (unit + integration). Wipes and rebuilds `TEST_DATABASE_URL`. |
| `npm run typecheck` | Type-checks server and client |
| `npm run build` | Bundles the API (`server/dist`) and the web app (`client/dist`) |
| `npm start --workspace server` | Runs the production bundle; also serves `client/dist` |
| `npm run db:migrate` / `db:deploy` | Create/apply migrations (dev) / apply migrations (prod) |
| `npm run openapi --workspace server` | Regenerates `docs/openapi.json` |
| `npm run backup --workspace server` | One-off `pg_dump` backup |

## Repository layout

```
server/
  prisma/            schema, migrations (incl. SQL integrity triggers), seed + demo data
  src/
    auth/            permission catalog, roles, data-scope resolution, passwords
    lib/             http router helper (validation + OpenAPI), crypto, dates, audit, storage, mail
    modules/         auth, org, employees, attendance, leave, workflow, payroll, dashboard,
                     reports, notifications, admin, system
    jobs/            scheduler (escalations, nightly attendance, reminders, backups, retention)
  tests/             unit/ (calculation engines) and integration/ (HTTP API against PostgreSQL)
client/
  src/components/    UI kit, charts, app shell
  src/pages/         one folder per module
  src/locales/       en.json, ar.json
docs/                architecture, deployment, API, user guide, checklist, roadmap, openapi.json
```

## Documentation

- [Brand and design system](docs/BRAND.md) — logo, colors, components, notifications
- [Architecture](docs/ARCHITECTURE.md) — modules, data model, security model, approval and payroll engines
- [Deployment](docs/DEPLOYMENT.md) — environments, configuration, backups and restore
- [API](docs/API.md) — conventions, authentication, device integration; interactive docs at `/api/docs`
- [User guide](docs/USER_GUIDE.md) — tasks by role
- [Production checklist](docs/PRODUCTION_CHECKLIST.md)
- [Roadmap](docs/ROADMAP.md)
