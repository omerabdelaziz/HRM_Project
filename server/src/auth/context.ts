import { prisma, Prisma } from '../lib/prisma';
import { DataScope, PermissionCode, SCOPE_RANK } from './permissions';
import { policy } from '../config/env';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  sessionId: string;
  employeeId: string | null;
  companyId: string | null; // the user's own company (via employee record)
  branchId: string | null;
  departmentId: string | null;
  roles: string[];
  permissions: Set<PermissionCode>;
  scope: DataScope;
  /** Company restriction coming from role assignments; null = unrestricted. */
  companyIds: string[] | null;
  locale: string;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  /** One of the user's roles requires MFA (Role.requireMfa). */
  mfaRequiredByRole: boolean;
  /** Company selected in the UI (X-Company-Id header), used when a request names no company. */
  preferredCompanyId?: string;
  _employeeWhere?: Prisma.EmployeeWhereInput;
}

export async function loadAuthUser(userId: string, sessionId: string): Promise<AuthUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      employee: { select: { companyId: true, branchId: true, departmentId: true } },
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
    },
  });
  if (!user || !user.isActive) return null;

  const permissions = new Set<PermissionCode>();
  let scope: DataScope = 'SELF';
  let unrestricted = false;
  const companyIds = new Set<string>();
  for (const ur of user.roles) {
    for (const rp of ur.role.permissions) permissions.add(rp.permission.code as PermissionCode);
    const s = ur.role.dataScope as DataScope;
    if (SCOPE_RANK[s] > SCOPE_RANK[scope]) scope = s;
    if (ur.companyId) companyIds.add(ur.companyId);
    else unrestricted = true;
  }

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    sessionId,
    employeeId: user.employeeId,
    companyId: user.employee?.companyId ?? null,
    branchId: user.employee?.branchId ?? null,
    departmentId: user.employee?.departmentId ?? null,
    roles: user.roles.map((r) => r.role.code),
    permissions,
    scope,
    companyIds: unrestricted ? null : [...companyIds],
    locale: user.locale,
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
    mfaRequiredByRole: user.roles.some((ur) => ur.role.requireMfa),
  };
}

export function hasPermission(user: AuthUser, ...codes: PermissionCode[]) {
  return codes.some((c) => user.permissions.has(c));
}

/** Permissions that make an account administrative (and subject to the MFA requirement). */
export const ADMIN_PERMISSIONS: PermissionCode[] = ['user.manage', 'role.manage', 'settings.manage', 'payroll.approve', 'payroll.pay'];

/**
 * The user must enrol MFA before using the app: one of their roles requires it (Settings → Roles), or the
 * deployment-wide policy requires it for administrative permissions (MFA_REQUIRED_FOR_ADMINS).
 */
export function mfaSetupRequired(user: AuthUser) {
  if (user.mfaEnabled) return false;
  return user.mfaRequiredByRole || (policy.mfaRequiredForAdmins && hasPermission(user, ...ADMIN_PERMISSIONS));
}
