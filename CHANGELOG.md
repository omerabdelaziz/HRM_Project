# Changelog

## Unreleased — QA fixes (branch `qa-fixes`)

### Phase 1 — Critical bugs (payroll, validation, attendance)

**1.1 Pension (GPSSA / ADPF) on the contribution salary**
- Pension is now calculated by a statutory engine (`server/src/modules/payroll/pension.ts`) on the *contribution salary*: basic salary plus fixed monthly allowances flagged **pensionable** (housing, cost of living, social/children). Overtime, one-off bonuses and adjustments are excluded. Example: Fatima Al Zaabi (basic 27,000 + housing 9,000) now contributes 1,800 instead of 1,350.
- New employee field **Pension scheme**: `NONE`, `GPSSA_OLD` (5%), `GPSSA_NEW` (11%, registered on/after 2 Oct 2023), `ADPF_OLD`, `ADPF_NEW`. Defaults: UAE nationals by hire date; everyone else `NONE`. A scheme other than `NONE` is rejected for non-UAE nationals.
- Employer share 15%. For GPSSA private-sector employees with a contribution salary under AED 20,000, the employer pays 12.5% and the 2.5% government subsidy is shown as a separate **information** line (excluded from net pay and employer cost).
- Configurable rules (Payroll → Calculation rules → Pension): minimum base (AED 3,000), per-scheme employee rate and cap (GPSSA old 50,000; GPSSA new 70,000; ADPF old 50,000; ADPF new 100,000), employer rate, subsidy rate and threshold, private-sector switch.
- New pay component flag **Pensionable**; new payslip line type `INFORMATION`.
- Recalculating a draft run uses the new logic; approved/paid runs cannot be recalculated and keep their stored lines.

**1.2 Overtime eligibility and night overtime**
- `JobGrade.overtimeEligible` (default true; Manager/Director/Executive grades set to false by migration). Employees inherit it and can be overridden per employee.
- Payroll pays no overtime to ineligible employees (e.g. the CEO). The API refuses overtime requests for them and the request dialog shows a warning.
- Night overtime: configurable multiplier (default 1.5×) and window (22:00–04:00). The night part of working-day overtime is recorded on the attendance record (`nightOvertimeMinutes`) and paid on a separate `OT_NIGHT` line. Weekend and holiday rates take precedence.

**1.3 Employee validation**
- Shared rules (`shared/validation.ts`, used by API and web form): date of birth not in the future; minimum age at hire date (company setting, default 18, legal floor 15); Emirates ID format `784-YYYY-NNNNNNN-C` with Luhn checksum, accepted with or without dashes and stored normalised (applies to the Emirates ID type, or to UAE nationals when no ID type is set); phone numbers validated and stored in E.164 (default region AE); names capitalised on save without breaking "Al Mansoori", "bin", "bint" or mixed-case names.
- Nationality is now a searchable ISO 3166 country picker; profiles show the nationality name ("Jordanian" / "أردني") instead of the code.
- Branch, Department and Position are required when creating an employee (form, API and Excel import).
- A warning (not a block) when the manager is in a different department and does not manage it or a parent department.
- All field errors are returned and highlighted at once, with a "Please fix the highlighted fields" toast. Duplicate messages use friendly labels ("National ID").
- Incidental fix: the company **Probation months** setting was silently ignored by the API; it is now saved.

**1.4 Attendance close-day job**
- The job now closes **every unclosed working day** since the company's `attendanceLastClosedDate` (catching up after missed runs) and runs hourly. It is idempotent.
- Per employee and shift: no punch on a working day without leave or holiday → **Absent**; a check-in without a check-out once the employee's own shift has ended (+4 h grace) → **Missed punch**. Overnight shifts still in progress are deferred to the next run.
- Records created by the system use source **System** (`SYSTEM`); existing system-generated absence/leave records are relabelled.

**Migrations**: `qa_pension`, `qa_overtime_eligibility`, `qa_employee_validation`, `qa_attendance_close`.

**Manual steps**
- Review UAE nationals' pension schemes after migrating: existing nationals are set to GPSSA old/new by hire date; Abu Dhabi nationals who belong to ADPF must be switched manually.
- Confirm the pension rates and caps in Payroll → Calculation rules with GPSSA/ADPF before the next payroll.
- Existing phone numbers are not rewritten; they are normalised the next time the record is saved.

### Phase 2 — Workflow & security

**2.1 Fallback approver instead of auto-approve**
- Requests that no active workflow covers are no longer approved silently. They go to the company's **fallback approver** role (default HR Administrator; Super Administrators if nobody holds it), and the history names who received them. If nobody can approve, the request stays pending with a note and can be decided by override.
- Automatic approval is now an explicit opt-in per request type (Workflows → *When no workflow applies*); every automatic approval is recorded in the history. The Workflows page shows, for each request type, whether it is covered, partly covered (conditional workflows) or falls back.

**2.2 Escalation**
- New approver/escalation target **Manager's manager**; escalation can also target a specific user.
- The "escalate after N hours" timer counts business hours only: company working days, excluding company-wide holidays (Friday 16:47 + 24 h → Monday 16:47 with a Saturday–Sunday weekend).
- Escalation adds the target as an approver of the current step (the original approvers keep their task), notifies them and names them in the history. If the target resolves to nobody, the fallback approver is used. A step with an escalation threshold must now name a target.

**2.3 Approval override**
- New permission `approval.override` (granted to Super Admin and HR Admin). Holders can approve or reject the current step of any pending request in their companies, from the request page. A comment is mandatory; the decision is recorded as `OVERRIDE_APPROVE` / `OVERRIDE_REJECT` in the request history and the audit log. Later workflow steps still apply. Payroll overrides also require `payroll.approve`; overriding your own request is refused.
- Overridden requests appear under *Handled by me*.

**2.4 Audit trail**
- `*Hash` fields are never stored in or returned from audit entries; `*Enc` fields appear only as "[protected]" (so you can see *that* a national ID or IBAN changed). Older entries are cleaned when read; stored rows are not modified (they are immutable).
- Every entry records the client IP and the browser user agent, including entries written deep inside services.
- The audit screen lists every action that occurs (including `UPLOAD` and the override actions), uses friendly record, action and field names in English and Arabic, and shows a before/after diff table with the raw JSON in a collapsible section.
- `nationalIdHash` already used HMAC-SHA256 keyed with `DATA_HASH_KEY`; a new script `npm run rehash:national-ids -w server [-- --dry]` recomputes the hashes after the key is rotated.

**2.5 MFA by role and invitations**
- Roles have a **Require two-factor authentication** switch (Settings → Roles). On by default for Super Admin, HR Admin, HR Manager, Payroll Officer and Finance Officer; their holders must enrol at their next sign-in.
- With email configured, a new user account (from Users or when creating an employee with a login) receives a single-use **invitation link valid for 72 hours** to set their own password; admins can resend it. Without email, the one-time temporary password is shown as before.

**Migration**: `qa_workflow_security` (company fallback role and auto-approve list, `Role.requireMfa`, `UserInvite`, `AuditLog.userAgent`, the `approval.override` permission).

**Manual steps**
- After migrating, users holding the five roles above are asked to set up an authenticator app at their next sign-in (including the demo accounts). Turn the switch off per role if that is not wanted yet.
- Configure `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`MAIL_FROM` to enable invitations, and make sure the first `CLIENT_ORIGIN` is the public URL of the web app (it is used in the link).
- `DATA_HASH_KEY` must be a long random secret (32 bytes, base64). If you rotate it, run `npm run rehash:national-ids -w server` straight away so duplicate detection keeps working.
- Review Workflows → *When no workflow applies*: request types without a workflow (e.g. Expense, Document) now wait for the fallback approver; tick them under auto-approve only if that is really intended.
