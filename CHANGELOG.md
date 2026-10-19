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
