# QA fix plan

Branch: `qa-fixes` (starts from `962a819`, the checkpoint of the in-progress security/MFA work).

## 1. Repository map

| Concern | Where | Notes |
|---|---|---|
| Backend | `server/` Express 4 + TypeScript, routes declared with `createRouter` (`src/lib/http.ts`), which validates body/query/params with **zod** and registers OpenAPI | Errors: `src/lib/errors.ts` (`AppError`), `src/middleware/error.ts` |
| ORM / schema | Prisma 5, `server/prisma/schema.prisma`; migrations in `server/prisma/migrations` (2 so far, one with SQL integrity triggers) | New migrations via `prisma migrate dev --create-only`, then reviewed |
| Seed | `server/prisma/seed.ts` (reference data) + `server/prisma/demo.ts` (Acme Trading LLC, built through the real services) | |
| Jobs | `src/jobs/scheduler.ts` (node-cron, tracked in `BackgroundJob`) | Close-day 00:30 UTC, escalations every 15 min |
| Payroll engine | `src/modules/payroll/calc.ts` (pure), `service.ts` (context building, lifecycle) | Pension is currently two `PayComponent`s (`PENSION_EE` 5%, `PENSION_ER` 12.5%, `PERCENT_OF_BASIC`) |
| Attendance | `modules/attendance/{calc,calendar,service}.ts` | `processDay` closes one day; `source` is a free string |
| Workflow engine | `modules/workflow/engine.ts` (submit/advance/decide/escalate) + `routes.ts` | Handlers registered per request type |
| Audit | `src/lib/audit.ts` (`audit()`, `scrub()`), UI `client/src/pages/admin/Audit.tsx` | `AuditLog` has `ip`, no user agent |
| Crypto | `src/lib/crypto.ts` | AES-256-GCM + HMAC `keyedHash` |
| Auth / MFA | `modules/auth/routes.ts`, `auth/context.ts`, `config/env.ts` (`policy.mfaRequiredForAdmins`) | MFA enrolment page `client/src/pages/MfaSetup.tsx` |
| Leave | `modules/leave/{service,balances,routes}.ts` | |
| i18n | `client/src/lib/i18n.ts` (i18next), `client/src/locales/{en,ar}.json` | |
| Client | React 18 + Vite + Tailwind + TanStack Query + react-hook-form + zod | |
| Tests | Vitest + Supertest against real PostgreSQL (`TEST_DATABASE_URL`, port 5544); `server/tests/{unit,integration}` | Baseline: **118/118 passing** |

**There is no lint script or ESLint config in the repo.** The per-phase quality gate is therefore `npm run typecheck` (server + client, `tsc --noEmit`, strict) plus `npm test`. I am not adding a linter in this pass, because that would change tooling outside this scope; it is listed as a follow-up.

## 2. Decisions on ambiguous or incorrect items

| Item | Decision |
|---|---|
| **2.4 "nationalIdHash is plain SHA-256"** | **Not accurate.** `keyedHash()` has been `HMAC-SHA256(DATA_HASH_KEY)` since the initial commit, and every write path uses it. A re-hash migration would rewrite identical values, so I'm not adding one. The real defect is that `nationalIdHash` (and other `*Hash`/`*Enc` fields) appear in audit payloads. Fix: strip `*Hash`/`*Enc` at write time and also at read time in the audit API, so historical rows are covered without modifying stored data. I'm adding a `rehash-national-ids` script for **key rotation** (`DATA_HASH_KEY_PREVIOUS` → `DATA_HASH_KEY`), which is the legitimate need behind the request. |
| Pension engine | A dedicated statutory pension calculator, driven by the employee's `pensionScheme` and a `PensionSettings` table (rates, minimum base, caps, subsidy threshold). It is not an extension of generic `PayComponent` percentages, because schemes, caps and subsidy can't be expressed with the existing component fields. The seeded `PENSION_EE`/`PENSION_ER` components are deactivated by migration when a company has pension settings, so pension is never charged twice. |
| ADPF rates | ADPF old/new use the same contribution structure (employee 5% old / 11% new, employer 15%), and ADPF caps are configurable. Exact Abu Dhabi rates must be confirmed by the customer's payroll team; they're editable settings, not code. |
| GPSSA subsidy | The 2.5% government subsidy is applied only when scheme ∈ {GPSSA_OLD, GPSSA_NEW}, the employer is private sector (company setting, default true) and contribution salary < AED 20,000 (configurable). The employer line shows 12.5%, and a separate informational `PENSION_SUBSIDY` line shows the 2.5% covered by the government. |
| "Recalculate draft uses new logic; paid/locked unchanged" | The engine already refuses to calculate unless the run is `DRAFT`/`CALCULATED`, and DB triggers lock approved payslips. I'll add a test that proves paid runs keep their old pension lines. |
| Night overtime window crossing midnight | Night minutes = overlap of the overtime part of the punch interval with [22:00, 04:00) in the employee's time zone. The night multiplier replaces (doesn't stack on) the working-day multiplier. Weekend and holiday rates take precedence over night. |
| Overtime eligibility | `JobGrade.overtimeEligible` (default true). Migration sets false for grades whose name matches Manager, Director or Executive. `Employee.overtimeEligible` is nullable: null inherits from the grade, true/false overrides. |
| Min age | A company setting `minEmployeeAge` (default 18, minimum allowed 15). Under 18 needs the setting lowered **and** shows a warning about juvenile-employment restrictions. |
| Emirates ID | Validated when ID type = `EMIRATES_ID`, or when nationality = AE and no ID type is given. Stored normalised with dashes. A new optional field `nationalIdType`: EMIRATES_ID, PASSPORT, OTHER. |
| Name capitalisation | Title-case each word on save, but keep lower-case particles `bin`, `bint`, `ibn`, `abu`, `al`→"Al" (Gulf convention capitalises "Al"), and hyphen/apostrophe parts. It only changes names that are entirely upper- or lower-case, so deliberate mixed-case names (`McDonald`, `DeSouza`) are left alone. |
| `source = SYSTEM` | `AttendanceRecord.source` is a free string, so no DB enum change is needed. I'll add `SYSTEM` to the zod enum and to the client labels, and the close-day job writes it. |
| Fallback approver default | A company setting `fallbackApproverRole` (default `HR_ADMIN`), plus a per-workflow-definition flag `autoApprove` (explicit opt-in). The existing `FALLBACK_ROLES` behaviour for steps with no resolvable approver stays. |
| Business-hours SLA | Escalation "after N hours" counts only time on company working days (`Company.weekendDays`) that aren't company-wide holidays. Hours are counted around the clock on business days, which matches the acceptance test (Fri 16:47 + 24h → Mon 16:47). |
| Leave year split (3.2) | Two `LeaveRequest` rows linked by `splitGroupId`, one `ApprovalRequest` (on the first part) whose handlers approve or reject both together. |
| Phase 4 PDF in Arabic | Final settlement PDF uses pdfkit with an embedded Arabic-capable font; bidi shaping is limited, so I'll check how it renders and document it. |

## 3. Files per item

### Phase 1
- **1.1 Pension**: schema (`PayComponent.pensionable`, `Employee.pensionScheme`, `Employee.pensionRegisteredOn`, new `PensionSettings`), migration; `payroll/pension.ts` (new, pure), `payroll/calc.ts` (input + lines), `payroll/service.ts` (context), `payroll/routes.ts` (settings API), seed/demo; client `pages/payroll/Payroll.tsx` (settings), `EmployeeForm.tsx` (scheme), locales; tests `unit/pension.test.ts`, `integration/payroll.test.ts`.
- **1.2 Overtime**: schema (`JobGrade.overtimeEligible`, `Employee.overtimeEligible`, `PayrollSettings.nightOvertimeMultiplier/nightStart/nightEnd`), migration; `attendance/calc.ts` (night split), `AttendanceRecord.nightOvertimeMinutes`; `payroll/calc.ts`, `payroll/service.ts`; `attendance/service.ts` (request guard); `org/routes.ts` (grade flag); client Payroll rules, Organization grades, EmployeeForm, Attendance OT dialog; tests.
- **1.3 Validation**: new `shared/validation/` (Emirates ID Luhn, name casing, phone normalisation, age) imported by server and client; `employees/service.ts` (schema), `middleware/error.ts` (friendly labels for duplicates); client `EmployeeForm.tsx`, `components/ui/pickers.tsx` (country picker), `lib/countries.ts`; `libphonenumber-js` dependency; tests `unit/validation.test.ts`, `integration/employees-validation.test.ts`.
- **1.4 Close-day job**: schema `Company.attendanceLastClosedDate`; `attendance/service.ts` (`closePendingDays`, idempotent `processDay` with shift-end check), `jobs/scheduler.ts`; client labels; test `integration/attendance-close.test.ts`.

### Phase 2
- **2.1** `workflow/engine.ts`, schema (`WorkflowDefinition.autoApprove`, company setting), `workflow/routes.ts` (coverage endpoint), client `Workflows.tsx`.
- **2.2** `workflow/engine.ts` (`MANAGERS_MANAGER` target, add approver, history names), new `lib/business-time.ts`, client step editor; test with a frozen clock.
- **2.3** permission `approval.override`, `workflow/engine.ts` (`overrideDecision`), `workflow/routes.ts`, client `Approvals.tsx`/`ApprovalDetail.tsx`.
- **2.4** `lib/audit.ts` (scrub `*Hash`/`*Enc`, capture IP + user agent via `AsyncLocalStorage` request context), schema `AuditLog.userAgent`, `admin/routes.ts` (audit API strips, action filter), client `Audit.tsx` (diff view, friendly names), `scripts/rehash-national-ids.ts`.
- **2.5** schema (`Role.requireMfa`, `UserInvite`), `auth/routes.ts` (invite accept), `admin/routes.ts` (user create → invite), `lib/mailer.ts`, client `Users.tsx`, `AcceptInvite.tsx`, `Roles.tsx`.

### Phase 3
- `LeaveType.payTiers/carryForwardExpiryMonthDay/encashable/serviceBands/requiresRelationship/usableWithinDays`, `LeaveRequest.relationship/splitGroupId`; `leave/{service,balances}.ts`, payroll context (tiered sick/maternity pay), `LeaveCalendar.tsx`, seed defaults; tests.

### Phase 4
- 4.1 `modules/separation/` (gratuity calc, final settlement, clearance, PDF, workflow `FINAL_SETTLEMENT`), gratuity accrual report + dashboard card.
- 4.2 `payroll/wps.ts` (SIF EDR/SCR), settings + employee fields.
- 4.3 employee visa/ID fields → reminders, dashboard, report labels.
- 4.4 `docs/backlog.md`.

### Phase 5
- Client formatting helpers (`lib/format.ts`), approval titles built client-side from `summary`, Arabic person names, i18next plurals, leave policy table, settings deep link, workflow condition label, grouped notifications + filters, chart axis labels.

## 4. Quality gate per phase
`npm run typecheck` (server + client) and `npm test` (server, real Postgres). New tests are added for each fix.
