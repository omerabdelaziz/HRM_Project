-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "minEmployeeAge" INTEGER NOT NULL DEFAULT 18;

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "nationalIdType" TEXT;
