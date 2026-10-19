import { forbidden } from '../lib/errors';
import { AuthUser } from './context';
import { DataScope, PermissionCode, SCOPE_RANK } from './permissions';

export interface GrantableRole {
  code: string;
  name: string;
  dataScope: string;
  permissions: { permission: { code: string } }[];
}

/** Include for loading roles in the shape the grant checks need. */
export const roleWithPermissions = { permissions: { include: { permission: { select: { code: true } } } } } as const;

/** True when the user's roles are not limited to particular companies and see every company. */
export const isUnrestricted = (user: AuthUser) => user.scope === 'ALL' && user.companyIds === null;

/**
 * A user can only hand out (or take over, by resetting credentials) access they hold themselves:
 * every permission of the role, and a data scope no wider than their own.
 * Super Administrators are exempt; only they can grant the Super Administrator role.
 */
export function assertCanGrantRoles(actor: AuthUser, roles: GrantableRole[], verb = 'grant') {
  if (actor.roles.includes('SUPER_ADMIN')) return;
  for (const role of roles) {
    if (role.code === 'SUPER_ADMIN') throw forbidden(`Only a Super Administrator can ${verb} the Super Administrator role`);
    const missing = role.permissions.map((p) => p.permission.code).filter((c) => !actor.permissions.has(c as PermissionCode));
    if (missing.length || SCOPE_RANK[role.dataScope as DataScope] > SCOPE_RANK[actor.scope]) {
      throw forbidden(`You cannot ${verb} the ${role.name} role because it includes access you do not have`);
    }
  }
}
