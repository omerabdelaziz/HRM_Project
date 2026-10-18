# Aziz HRM — Architecture

## Overview

```
Browser (React SPA, en/ar, RTL)
   │  HTTPS, JSON, Bearer access token (15 min) + httpOnly refresh cookie (7 days, rotated)
   ▼
Express API ── zod validation ── permission check ── data-scope filter ── module service
   │                                                                     │
   │                                     Prisma (transactions, row locks) ▼
   │                                                               PostgreSQL
   │                                                   (+ SQL triggers guarding payroll & audit)
   └── in-process scheduler: escalations, nightly attendance close, reminders,
       scheduled reports, backups, retention
```

One deployable Node process serves the API, the built web app and the API docs. The scheduler can be switched off (`ENABLE_SCHEDULER=false`) on extra API replicas so only one instance runs jobs.

## Modules (`server/src/modules`)

| Module | Responsibilities |
|---|---|
| `auth` | Login with lockout (5 failures → 15 min), optional TOTP MFA, refresh-token rotation with reuse detection, sessions, password change, preferences |
| `org` | Companies (regional settings, numbering, probation), branches, departments (tree), positions (budgeted headcount), grades, cost centers, categories, employment types, org chart, workforce planning |
| `employees` | Profiles, sequential employee numbers, duplicate detection, encryption of sensitive fields, history (hire, transfer, promotion, manager/status/salary changes), documents, photos, separation, Excel import/export |
| `attendance` | Work calendar (shift → rotating assignment → default shift; weekends; holidays), punches (web, mobile with geofence, devices), day calculation, corrections, overtime, nightly close |
| `leave` | Leave types/policies, entitlement (annual/monthly/none, proration, carry-forward), balances, validation, requests, cancellation, calendar |
| `workflow` | Generic approval engine and its configuration, delegations, inbox |
| `payroll` | Pay components, rules, currencies/FX, salary structures, runs, calculation engine, locks, reconciliation, payslips/PDF, bank file, register |
| `dashboard`, `reports` | KPIs and charts; 12 report definitions with JSON/Excel/CSV/PDF output, saved and scheduled reports |
| `notifications`, `admin`, `system` | Notification center and email, announcements; users, roles, audit log; health and maintenance jobs |

Each route is declared once with `createRouter` (`lib/http.ts`), which wires authentication, permission checks and zod validation **and** registers the endpoint in the OpenAPI document.

## Security model

- **Permissions** (`auth/permissions.ts`): ~40 fine-grained codes such as `employee.salary.read` or `payroll.approve`. Ten system roles ship by default; administrators can edit them or create custom roles. Super Administrator always has every permission.
- **Data scope** per role: `SELF`, `TEAM` (direct and indirect reports), `DEPARTMENT` (managed departments and sub-departments), `BRANCH`, `COMPANY`, `ALL`. A user's widest scope applies, and anyone with reports always sees their team. Every list and lookup is filtered by `employeeScope()`, and records outside it return 404 so their existence isn't revealed.
- **Company restriction**: role assignments may be limited to one company. The UI's company switcher sends `X-Company-Id`, which is honored only when the user may access that company.
- **Sensitive data**: national ID, IBAN, bank account and MFA secrets are encrypted with AES-256-GCM. National IDs also carry an HMAC so duplicates can be detected without decrypting. Users without `employee.sensitive.read` get `null`; employees see their own values masked.
- **Separation of duties**: an approval step never assigns the requester (unless the step explicitly allows it). Payroll is therefore prepared by one person and approved by another.
- **Audit**: creates, updates (with field-level before/after), deletes, approvals, exports, downloads of confidential files, logins and failed logins are written to `AuditLog`. A database trigger blocks `UPDATE` on audit rows; retention deletes only rows older than `AUDIT_RETENTION_DAYS`.
- **Transport and headers**: helmet, a strict CORS origin, rate limits (600 req/min per IP; 30 login attempts per 15 min), refresh cookie `httpOnly` + `SameSite=Strict` + `Secure` in production, JSON body limit 2 MB, upload type whitelist and a 15 MB limit, path-traversal-safe storage.

## Approval engine (`modules/workflow/engine.ts`)

- A **workflow definition** belongs to a company and a request type (`LEAVE`, `ATTENDANCE_CORRECTION`, `OVERTIME`, `PAYROLL`, `SALARY_CHANGE`, `TRANSFER`, `RESIGNATION`, `EXPENSE`, `JOB_OFFER`, `DOCUMENT`). It can have conditions (amount range, leave type codes, departments, branches) and a priority; the highest-priority match is used.
- **Steps** run in order. The approver can be the direct manager, department manager, branch manager, anyone with a role, or a specific user. A step can require a minimum amount (e.g. HR only for leave over 5 days) and escalate after N hours.
- If a step has no eligible approver it falls back to HR administrators, otherwise it is skipped. Both outcomes are recorded.
- **Delegations** add the delegate's task alongside the original approver for the period.
- Decisions lock the request row (`SELECT … FOR UPDATE`) and run the module's handler (`onApproved`/`onRejected`/`onCancelled`) **in the same transaction**, so for example a leave balance and its approval can never disagree.
- With no active workflow the request is approved automatically, and the history says so.

## Payroll engine (`modules/payroll/calc.ts`)

A pure function with no I/O, unit-tested on its own. The service gathers inputs per employee:

1. Salary structures effective in the period, split into segments when the salary changes mid-month, limited to the employment window (hire/separation).
2. Approved unpaid leave days, absences, late minutes, and overtime by day type (working/weekend/holiday; approved overtime only when the policy requires approval).
3. Global components (statutory items) filtered by eligibility, plus run adjustments.

Calculation follows the configured rules: the proration basis (fixed 30, calendar days or working days), the rate base (basic, or basic + flagged allowances), overtime multipliers, deduction switches, and rounding. It supports fixed amounts, % of basic, % of gross (after attendance deductions), progressive brackets on basic/gross/taxable, min/max clamps, base caps, and employer contributions. **Nothing statutory is hard-coded.**

Lifecycle: `DRAFT → CALCULATED → PENDING_APPROVAL → APPROVED (locked) → PAID`, with `CANCELLED` from draft/calculated and **reopen** from approved only (reason required, audited, requires a fresh approval).

Integrity controls:

- `reconcile()` independently re-sums lines → payslips → run totals before submission and again at approval.
- `assertPayrollOpen()` blocks attendance edits, corrections, overtime, leave cancellation and salary changes that fall inside an approved/paid period.
- SQL triggers (migration `payroll_controls`) refuse to modify or delete payslips and lines of approved/paid runs, to change locked totals, to delete approved runs, or to reopen a paid run.
- A partial unique index allows only one active run per company, month and branch scope.

## Data model highlights

- All date-only fields use PostgreSQL `DATE` and are handled as UTC midnight. Instants (punches) are `timestamptz` and are interpreted in the branch or company time zone.
- Money is `Decimal(14,2)`. Calculations use `Prisma.Decimal` (decimal.js), never floating point.
- History is append-only (`EmployeeHistory`, `PayrollRunEvent`, `ApprovalAction`, `AuditLog`). Employees are soft-deleted (`deletedAt`) and only when no approved payroll references them; otherwise they must be separated.
- Snapshots: payslips store the employee's name, organization and encrypted bank details as they were at calculation time, so later edits don't change historic payslips.

## Front end

- Lazy-loaded routes, each guarded by permission (`App.tsx`). The sidebar shows only what the user can open.
- Server state via TanStack Query; a shared `usePaged` hook gives every list server-side pagination, sorting and search.
- Locale-aware formatting (`lib/format.ts`): Latin digits in both languages, the company time zone for instants, UTC for date-only values, and the company currency.
- RTL uses logical Tailwind utilities (`ms-`, `pe-`, `start-`, `border-s`); direction-sensitive icons flip.
- Charts follow a validated colorblind-safe palette (slot 1 = brand royal blue) with separate light and dark steps (`index.css`), and every chart has a table view.
- Feedback goes through one notification system (`lib/toast.tsx`); see [BRAND.md](BRAND.md).
