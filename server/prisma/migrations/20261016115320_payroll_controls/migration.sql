-- DropIndex
DROP INDEX "PayrollRun_companyId_year_month_branchId_key";

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "probationMonths" INTEGER NOT NULL DEFAULT 3;

-- AlterTable
ALTER TABLE "SalaryStructure" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SavedReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'xlsx',
    "schedule" TEXT,
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavedReport_userId_idx" ON "SavedReport"("userId");

-- CreateIndex
CREATE INDEX "PayrollRun_companyId_year_month_idx" ON "PayrollRun"("companyId", "year", "month");

-- ───────────── Payroll integrity controls (not expressible in the Prisma schema) ─────────────

-- At most one non-cancelled run per company, month and branch scope (NULL branch = company-wide).
CREATE UNIQUE INDEX "PayrollRun_active_period_key"
  ON "PayrollRun" ("companyId", "year", "month", COALESCE("branchId", ''))
  WHERE "status" <> 'CANCELLED';

-- Approved and paid payroll is immutable: payslip figures and lines cannot be changed or deleted.
-- Only the payment status of a payslip may change (paid / on hold).
CREATE OR REPLACE FUNCTION hrms_guard_payslip() RETURNS trigger AS $$
DECLARE
  run_status text;
BEGIN
  SELECT status INTO run_status FROM "PayrollRun" WHERE id = COALESCE(OLD."runId", NEW."runId");
  IF run_status IN ('APPROVED', 'PAID') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Payslips of an approved payroll cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    IF NEW."grossEarnings" IS DISTINCT FROM OLD."grossEarnings"
       OR NEW."totalDeductions" IS DISTINCT FROM OLD."totalDeductions"
       OR NEW."netPay" IS DISTINCT FROM OLD."netPay"
       OR NEW."employerCost" IS DISTINCT FROM OLD."employerCost"
       OR NEW."basicSalary" IS DISTINCT FROM OLD."basicSalary"
       OR NEW."employeeId" IS DISTINCT FROM OLD."employeeId"
       OR NEW."runId" IS DISTINCT FROM OLD."runId" THEN
      RAISE EXCEPTION 'Payslips of an approved payroll cannot be modified' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hrms_guard_payslip
  BEFORE UPDATE OR DELETE ON "Payslip"
  FOR EACH ROW EXECUTE FUNCTION hrms_guard_payslip();

CREATE OR REPLACE FUNCTION hrms_guard_payslip_line() RETURNS trigger AS $$
DECLARE
  run_status text;
BEGIN
  SELECT r.status INTO run_status
    FROM "Payslip" p JOIN "PayrollRun" r ON r.id = p."runId"
   WHERE p.id = COALESCE(NEW."payslipId", OLD."payslipId");
  IF run_status IN ('APPROVED', 'PAID') THEN
    RAISE EXCEPTION 'Payslip lines of an approved payroll cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hrms_guard_payslip_line
  BEFORE INSERT OR UPDATE OR DELETE ON "PayslipLine"
  FOR EACH ROW EXECUTE FUNCTION hrms_guard_payslip_line();

-- Approved/paid runs cannot be deleted, and their totals cannot change while locked.
-- (Reopening moves the status back to DRAFT first, which is permitted and audited.)
CREATE OR REPLACE FUNCTION hrms_guard_payroll_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('APPROVED', 'PAID') THEN
      RAISE EXCEPTION 'Approved payroll runs cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('APPROVED', 'PAID') AND NEW.status = OLD.status AND (
       NEW."totalGross" IS DISTINCT FROM OLD."totalGross"
    OR NEW."totalNet" IS DISTINCT FROM OLD."totalNet"
    OR NEW."totalDeductions" IS DISTINCT FROM OLD."totalDeductions"
    OR NEW."employeeCount" IS DISTINCT FROM OLD."employeeCount") THEN
    RAISE EXCEPTION 'Totals of an approved payroll run cannot be modified' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'PAID' AND NEW.status <> 'PAID' THEN
    RAISE EXCEPTION 'A paid payroll run cannot be reopened' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hrms_guard_payroll_run
  BEFORE UPDATE OR DELETE ON "PayrollRun"
  FOR EACH ROW EXECUTE FUNCTION hrms_guard_payroll_run();

-- The audit trail is append-only except for retention purges of old rows.
CREATE OR REPLACE FUNCTION hrms_guard_audit() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Audit log entries cannot be modified' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hrms_guard_audit
  BEFORE UPDATE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION hrms_guard_audit();
