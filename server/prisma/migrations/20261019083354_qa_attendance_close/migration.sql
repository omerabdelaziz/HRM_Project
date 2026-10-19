-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "attendanceLastClosedDate" DATE;

-- ── Data ──────────────────────────────────────────────────────────────
-- Absence / leave records written by the system were labelled MANUAL; relabel them SYSTEM.
-- Real manual entries are audited and keep their label.
UPDATE "AttendanceRecord" r
SET "source" = 'SYSTEM'
WHERE r."source" = 'MANUAL'
  AND r."checkIn" IS NULL AND r."checkOut" IS NULL
  AND r."status" IN ('ABSENT', 'ON_LEAVE', 'HALF_DAY')
  AND (r."notes" IN ('No punches recorded', 'Leave') OR r."notes" LIKE 'Leave: %')
  AND NOT EXISTS (SELECT 1 FROM "AuditLog" a WHERE a."entity" = 'AttendanceRecord' AND a."entityId" = r."id");
