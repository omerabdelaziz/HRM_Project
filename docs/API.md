# API

- **Interactive docs:** `http://<host>/api/docs` (Swagger UI; off in production unless `ENABLE_API_DOCS=true`)
- **OpenAPI document:** `GET /api/openapi.json`, also committed as [`docs/openapi.json`](openapi.json). Regenerate it with `npm run openapi --workspace server`. It covers 186 operations.

## Authentication

```http
POST /api/auth/login
Content-Type: application/json

{ "email": "admin@hrms.local", "password": "…", "mfaCode": "123456" }
```

The response is `{ "accessToken": "…", "mustChangePassword": false }`, or `{ "mfaRequired": true }` when MFA is on and no code was sent. It also sets the `hrms_rt` refresh cookie.

Send `Authorization: Bearer <accessToken>` with every call. When the access token expires (15 min), call `POST /api/auth/refresh` with the cookie to get a new one. The refresh token rotates on every use, and replaying an old one ends the session.

Optional header `X-Company-Id: <uuid>` selects the default company for users with access to several.

## Conventions

- JSON in and out. Dates are `YYYY-MM-DD`; instants are ISO 8601 with offset.
- Lists accept `page`, `pageSize` (≤ 500), `sort=field:asc|desc` and `search`, and return `{ items, total, page, pageSize, pageCount }`.
- Errors return `{ "error": { "code", "message", "details" } }`:

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` / `BAD_REQUEST` | `details` lists `{ path, message }` per field |
| 401 | `UNAUTHORIZED` | Missing, expired or revoked session |
| 403 | `FORBIDDEN` | Missing permission |
| 404 | `NOT_FOUND` | Unknown, or outside your data scope |
| 409 | `CONFLICT` / `DUPLICATE` | Duplicate employee, existing payroll run… (`details.confirmable` = may be overridden) |
| 422 | `BUSINESS_RULE` / `LOCKED` | Policy violation (balance, overlap, notice…) or locked payroll period |
| 429 | `RATE_LIMITED` | Too many requests |

- Every route's required permission is listed in its OpenAPI description.

## Main resources

| Area | Base path |
|---|---|
| Auth & account | `/api/auth` |
| Organization | `/api/org` (companies, branches, departments, positions, grades, cost-centers, categories, employment-types, chart, workforce) |
| Employees | `/api/employees` (+ `/import`, `/export`, `/:id/history`, `/:id/documents`, `/:id/separate`) |
| Attendance | `/api/attendance` (punch, records, summary, corrections, overtime, process-day, device/punches) |
| Shifts, holidays, policy | `/api/shifts` |
| Leave | `/api/leave` (types, balances, requests, preview, calendar) |
| Approvals | `/api/approvals` (inbox, requests, approve/reject, bulk, delegations) |
| Workflow configuration | `/api/workflows` |
| Payroll | `/api/payroll` (components, settings, currencies, exchange-rates, salaries, runs, payslips) |
| Dashboard & reports | `/api/dashboard`, `/api/reports/:key?format=json|xlsx|csv|pdf`, `/api/saved-reports` |
| Notifications | `/api/notifications`, `/api/announcements` |
| Administration | `/api/users`, `/api/roles`, `/api/audit`, `/api/system` |

## Attendance device integration

Generate a key under **Settings → Attendance policy → Attendance devices** (shown once; stored hashed). Then:

```http
POST /api/attendance/device/punches
X-Device-Key: <key>
Content-Type: application/json

{
  "companyCode": "ACME",
  "punches": [
    { "employeeNo": "ACM0001", "timestamp": "2026-03-02T09:01:00+04:00" },
    { "employeeNo": "ACM0001", "timestamp": "2026-03-02T18:04:00+04:00" }
  ]
}
```

Punches are sorted and processed in order: the first punch of a day is the check-in and the latest later punch is the check-out. Overnight shifts are handled. The response reports `accepted`, `rejected` and a per-punch result, so a device can retry only the failures. Up to 1,000 punches per call.

## Bulk import

`POST /api/employees/import` with multipart fields `file` (.xlsx) and `dryRun=true|false`. Download the template from `GET /api/employees/import/template`. All rows are validated first, and nothing is written unless every row is valid. Managers may reference rows earlier in the same file by employee number.
