-- CreateEnum
CREATE TYPE "PensionScheme" AS ENUM ('NONE', 'GPSSA_OLD', 'GPSSA_NEW', 'ADPF_OLD', 'ADPF_NEW');

-- AlterEnum
ALTER TYPE "PayComponentType" ADD VALUE 'INFORMATION';

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "pensionScheme" "PensionScheme" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "PayComponent" ADD COLUMN     "pensionable" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PayrollSettings" ADD COLUMN     "pensionRules" JSONB;

-- ── Data ──────────────────────────────────────────────────────────────
-- Fixed monthly allowances that form the pension "contribution salary" (basic is always included).
UPDATE "PayComponent"
SET "pensionable" = true
WHERE "type" = 'EARNING'
  AND ("code" IN ('HOUSING', 'COLA', 'COST_OF_LIVING', 'SOCIAL', 'SOCIAL_ALLOWANCE', 'CHILDREN', 'CHILDREN_ALLOWANCE')
       OR lower("name") LIKE '%housing%' OR lower("name") LIKE '%cost of living%' OR lower("name") LIKE '%children%' OR lower("name") LIKE '%social allowance%');

-- Existing UAE nationals keep paying pension under the new engine: registrations from 2 Oct 2023 use the
-- new GPSSA scheme. HR must review Abu Dhabi nationals who belong to ADPF (not derivable from data).
UPDATE "Employee"
SET "pensionScheme" = CASE WHEN "hireDate" >= DATE '2023-10-02' THEN 'GPSSA_NEW'::"PensionScheme" ELSE 'GPSSA_OLD'::"PensionScheme" END
WHERE "nationality" = 'AE' AND "deletedAt" IS NULL;

-- The statutory engine now calculates pension; retire the old percentage-of-basic components so pension
-- is never charged twice. Payslips of past runs keep their stored lines.
UPDATE "PayComponent"
SET "isActive" = false
WHERE "code" IN ('PENSION_EE', 'PENSION_ER');
