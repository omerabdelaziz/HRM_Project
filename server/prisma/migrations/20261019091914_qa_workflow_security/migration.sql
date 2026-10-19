-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "userAgent" TEXT;

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "autoApproveRequestTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "workflowFallbackRole" TEXT NOT NULL DEFAULT 'HR_ADMIN';

-- AlterTable
ALTER TABLE "Role" ADD COLUMN     "requireMfa" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "UserInvite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserInvite_tokenHash_key" ON "UserInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "UserInvite_userId_idx" ON "UserInvite"("userId");

-- AddForeignKey
ALTER TABLE "UserInvite" ADD CONSTRAINT "UserInvite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Data ──────────────────────────────────────────────────────────────
-- MFA is required by default for administrative and payroll roles (they enrol at their next sign-in).
UPDATE "Role" SET "requireMfa" = true
WHERE "code" IN ('SUPER_ADMIN', 'HR_ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER', 'FINANCE_OFFICER');

-- New permission: act on any pending approval (comment required, logged as an override).
INSERT INTO "Permission" ("id", "code", "module", "description")
VALUES (gen_random_uuid()::text, 'approval.override', 'workflow', 'Approve or reject any pending request as an override')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "Role" r CROSS JOIN "Permission" p
WHERE r."code" IN ('SUPER_ADMIN', 'HR_ADMIN') AND p."code" = 'approval.override'
ON CONFLICT DO NOTHING;
