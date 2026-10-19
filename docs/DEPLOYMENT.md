# Deployment

## Environments

Use three separate databases and `.env` files that never share secrets:

| Environment | `NODE_ENV` | Database | Notes |
|---|---|---|---|
| Development | `development` | `hrms` | `npm run dev:server` + `npm run dev:client`; demo seed allowed |
| Test | `test` | `hrms_test` (`TEST_DATABASE_URL`) | Wiped and rebuilt by `npm test`; must differ from `DATABASE_URL` (enforced) |
| Production | `production` | dedicated instance | `npm run db:deploy`; seed **without** `--demo` |

## Configuration (`server/.env`)

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✔ | PostgreSQL connection string |
| `JWT_SECRET` | ✔ | ≥ 32 random characters |
| `DATA_ENCRYPTION_KEY` | ✔ | 32 random bytes, base64. **Back it up separately from database backups.** |
| `DATA_HASH_KEY` | ✔ | 32 random bytes, base64 (duplicate detection for national IDs) |
| `PORT` | | API port (default 4100) |
| `CLIENT_ORIGIN` | | Allowed browser origin(s), comma-separated; also used in email links |
| `ACCESS_TOKEN_TTL_MIN`, `REFRESH_TOKEN_TTL_DAYS` | | Session lifetimes (15 / 7) |
| `SESSION_IDLE_MINUTES` | | Sign out sessions idle this long (120) |
| `MFA_REQUIRED_FOR_ADMINS` | | Accounts with user, role, settings or payroll approve/pay permissions must enrol MFA before using the app. Default: on in production |
| `ENABLE_API_DOCS` | | Serve Swagger UI at `/api/docs` and `/api/openapi.json`. Default: off in production |
| `STORAGE_DIR` | | Uploaded documents and photos (default `./storage`) — put on persistent, backed-up storage |
| `BACKUP_DIR`, `BACKUP_RETENTION_DAYS` | | Nightly `pg_dump` location and retention (14 days) |
| `PG_BIN_DIR` | | Folder containing `pg_dump` if it isn't on `PATH` |
| `AUDIT_RETENTION_DAYS` | | Audit log retention (default 2555 ≈ 7 years) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | | Email; when `SMTP_HOST` is empty, emails are skipped (logged at debug level) |
| `ENABLE_SCHEDULER` | | `true` on exactly one instance |
| `LOG_LEVEL` | | `info` by default |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | | First administrator created by the seed (a random password is printed if omitted) |

## Production install

```bash
npm ci
npm run build                     # server/dist + client/dist
cd server
npm run db:deploy                 # apply migrations
npm run db:seed                   # permissions, roles, currencies, first admin (no demo data)
NODE_ENV=production node dist/index.js
```

Then sign in as the administrator, change the password, and in **Settings** create or edit the company (currency, time zone, weekend, numbering, probation), its branches and departments, shifts, holidays and leave policies. In **Payroll** set up pay components and rules, and in **Approval workflows** set up the workflows.

Run it under a process manager (systemd, PM2 or a container) behind a reverse proxy that terminates TLS. The refresh cookie is `Secure` in production, so **HTTPS is required**. Example nginx location:

```nginx
location / {
  proxy_pass http://127.0.0.1:4100;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 20m;
}
```

`trust proxy` is enabled, so rate limits and audit IPs use `X-Forwarded-For`. Health check: `GET /api/system/health`.

### Scaling

The API is stateless apart from `STORAGE_DIR`. For several replicas, put storage on shared persistent volume and set `ENABLE_SCHEDULER=true` on only one of them.

## Backups and restore

- Automatic: every night at 02:00 UTC, `pg_dump -Fc` into `BACKUP_DIR`; files older than `BACKUP_RETENTION_DAYS` are deleted. You can also trigger it under **System → Run now**, or with `npm run backup --workspace server`.
- Copy `BACKUP_DIR` **and** `STORAGE_DIR` off the server (object storage or a backup agent). Keep `DATA_ENCRYPTION_KEY` in a secrets manager; backups are useless for encrypted fields without it.
- Restore:

```bash
pg_restore --clean --if-exists -d "$DATABASE_URL" backups/hrms-YYYY-MM-DD-HH-MM.dump
```

Test a restore into a scratch database at least quarterly.

## Scheduled jobs (UTC)

| Time | Job |
|---|---|
| every 15 min | Approval escalations |
| 00:30 | Close yesterday's attendance (absences, missed punches), per company time zone |
| 01:00 | Deactivate users whose separation date has arrived |
| 02:00 | Database backup |
| 02:30 | Retention purge (audit, sessions, read notifications, job history) |
| 05:00 | Document, contract and probation reminders |
| 06:00 (weekdays) | Pending-approval reminders |
| 06:00 | Scheduled report delivery |

Every run is recorded in **System → Job history**.

## Upgrades

```bash
git pull && npm ci && npm run build
cd server && npm run db:deploy && npm run db:seed   # seed is idempotent; adds new permissions
# restart the process
```

## Development notes

- On Node 22.12+ the server runs tsx with `--no-experimental-require-module` (already in the npm scripts). This works around an esbuild/tsx issue with the `generator-function` package used by `exceljs`. The production bundle runs on plain `node` and isn't affected.
- Dev ports default to 4100 (API) and 5310 (web). Override with `PORT` in `server/.env`, and with `VITE_PORT` / `VITE_API_PROXY` for the client.
