-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "nightOvertimeMinutes" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "overtimeEligible" BOOLEAN;

-- AlterTable
ALTER TABLE "JobGrade" ADD COLUMN     "overtimeEligible" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "PayrollSettings" ADD COLUMN     "nightOvertimeEnd" TEXT NOT NULL DEFAULT '04:00',
ADD COLUMN     "nightOvertimeMultiplier" DECIMAL(5,2) NOT NULL DEFAULT 1.5,
ADD COLUMN     "nightOvertimeStart" TEXT NOT NULL DEFAULT '22:00';

-- ── Data ──────────────────────────────────────────────────────────────
-- Managerial, director and executive grades are not paid overtime.
UPDATE "JobGrade" SET "overtimeEligible" = false
WHERE "name" ~* '(manager|director|executive|chief|head of)';
