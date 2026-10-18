# Production readiness checklist

## Security
- [ ] Generate fresh `JWT_SECRET`, `DATA_ENCRYPTION_KEY` and `DATA_HASH_KEY` for production; never reuse development values
- [ ] Store `DATA_ENCRYPTION_KEY` in a secrets manager, with an offline copy, separate from database backups
- [ ] Serve only over HTTPS (required for the `Secure` refresh cookie); enable HSTS at the proxy
- [ ] Set `CLIENT_ORIGIN` to the production URL only
- [ ] Seed **without** `--demo`; change the first administrator's password and enable two-step verification
- [ ] Require two-step verification for Super Administrator, HR Administrator, Payroll and Finance users
- [ ] Review role permissions and data scopes; remove unused roles
- [ ] Use a PostgreSQL account that owns only the HRMS database; restrict network access to the database
- [ ] Run `npm audit` and review findings; pin and patch dependencies regularly
- [ ] Commission an external penetration test before go-live

## Data and configuration
- [ ] Company regional settings: currency, time zone, weekend, fiscal year, numbering, probation
- [ ] Branches, departments (with managers), positions and budgeted headcount, grades
- [ ] Shifts (one marked default), public holidays for the year, attendance policy
- [ ] Leave types matching your policy and local labor law
- [ ] Pay components and payroll rules **validated by your payroll/legal advisor** (pension, social insurance, tax, end of service)
- [ ] Approval workflows for leave, corrections, overtime, salary changes and payroll
- [ ] Import employees (dry-run first), then salary structures
- [ ] Run a **parallel payroll** for at least one month and reconcile against the current system

## Operations
- [ ] Process manager with automatic restart; `ENABLE_SCHEDULER=true` on exactly one instance
- [ ] Health check on `GET /api/system/health` wired to monitoring/alerting
- [ ] Centralized logs (JSON from pino on stdout) with retention
- [ ] `BACKUP_DIR` and `STORAGE_DIR` copied off-server daily; `pg_dump` available (`PG_BIN_DIR`)
- [ ] Restore rehearsed into a scratch database
- [ ] SMTP configured and a test notification received
- [ ] Separate test environment with its own database for UAT
- [ ] Audit and backup retention values approved by your compliance team

## Verification
- [ ] `npm run typecheck` and `npm test` pass on the release commit
- [ ] Smoke test each role: employee, manager, HR, payroll, finance, auditor
- [ ] Arabic/RTL walkthrough of the main screens
- [ ] Load test with realistic data volumes (employees × days of attendance)
