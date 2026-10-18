import { z } from 'zod';
import { createRouter, idParam, paged, pageQuery, paging } from '../../lib/http';
import { prisma, Prisma } from '../../lib/prisma';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { audit, ipOf } from '../../lib/audit';
import { randomToken } from '../../lib/crypto';
import { hashPassword } from '../../auth/passwords';
import { ALL_PERMISSIONS, PERMISSIONS } from '../../auth/permissions';
import { AuthUser } from '../../auth/context';
import { accessibleCompanyIds } from '../../auth/scope';

// ── Users ──

export const usersRouter = createRouter('/api/users', 'Users');
const u = usersRouter;

const tempPassword = () => `${randomToken(9)}7k`;

function guardSuperAdmin(actor: AuthUser, roleCodes: string[]) {
  if (roleCodes.includes('SUPER_ADMIN') && !actor.roles.includes('SUPER_ADMIN')) {
    throw forbidden('Only a Super Administrator can grant the Super Administrator role');
  }
}

async function guardTarget(actor: AuthUser, userId: string) {
  const target = await prisma.user.findUnique({ where: { id: userId }, include: { roles: { include: { role: true } } } });
  if (!target) throw notFound('User');
  if (target.roles.some((r) => r.role.code === 'SUPER_ADMIN') && !actor.roles.includes('SUPER_ADMIN')) {
    throw forbidden('Only a Super Administrator can modify a Super Administrator');
  }
  return target;
}

u.get(
  '/',
  { summary: 'List user accounts', permission: 'user.manage', query: pageQuery.extend({ roleCode: z.string().optional(), active: z.enum(['true', 'false']).optional() }) },
  async ({ user, query }) => {
    const companies = await accessibleCompanyIds(user);
    const where: Prisma.UserWhereInput = {
      ...(user.scope === 'ALL' ? {} : { OR: [{ employee: { companyId: { in: companies } } }, { roles: { some: { companyId: { in: companies } } } }] }),
      ...(query.search ? { AND: [{ OR: [{ email: { contains: query.search, mode: 'insensitive' } }, { displayName: { contains: query.search, mode: 'insensitive' } }] }] } : {}),
      ...(query.roleCode ? { roles: { some: { role: { code: query.roleCode } } } } : {}),
      ...(query.active ? { isActive: query.active === 'true' } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true, email: true, displayName: true, isActive: true, mfaEnabled: true, lastLoginAt: true, lockedUntil: true, createdAt: true,
          employee: { select: { id: true, employeeNo: true, companyId: true } },
          roles: { select: { companyId: true, role: { select: { id: true, code: true, name: true } } } },
        },
        orderBy: { displayName: 'asc' },
        ...paging(query),
      }),
      prisma.user.count({ where }),
    ]);
    return paged(items, total, query);
  },
);

const userBody = z.object({
  email: z.string().email().toLowerCase(),
  displayName: z.string().trim().min(1).max(150),
  employeeId: z.string().uuid().nullish(),
  roleCodes: z.array(z.string()).min(1),
  companyId: z.string().uuid().nullish(),
  isActive: z.boolean().default(true),
});

u.post('/', { summary: 'Create a user account (returns a one-time temporary password)', permission: 'user.manage', body: userBody, status: 201 }, async ({ req, user, body }) => {
  guardSuperAdmin(user, body.roleCodes);
  const roles = await prisma.role.findMany({ where: { code: { in: body.roleCodes } } });
  if (roles.length !== body.roleCodes.length) throw badRequest('One or more roles do not exist');
  if (body.companyId && !(await accessibleCompanyIds(user)).includes(body.companyId)) throw forbidden();
  if (body.employeeId && (await prisma.user.findUnique({ where: { employeeId: body.employeeId } }))) throw conflict('This employee already has a user account');
  const password = tempPassword();
  const created = await prisma.user.create({
    data: {
      email: body.email, displayName: body.displayName, employeeId: body.employeeId ?? null, isActive: body.isActive,
      passwordHash: await hashPassword(password), mustChangePassword: true,
      roles: { create: roles.map((r) => ({ roleId: r.id, companyId: body.companyId ?? null })) },
    },
    select: { id: true, email: true, displayName: true },
  });
  await audit({ userId: user.id, action: 'CREATE', entity: 'User', entityId: created.id, after: { ...created, roles: body.roleCodes }, ip: ipOf(req) });
  return { ...created, temporaryPassword: password };
});

u.put('/:id', { summary: 'Update a user account and its roles', permission: 'user.manage', params: idParam, body: userBody.partial().omit({ email: true }) }, async ({ req, user, params, body }) => {
  const target = await guardTarget(user, params.id);
  if (params.id === user.id && body.isActive === false) throw badRequest('You cannot deactivate your own account');
  if (body.roleCodes) guardSuperAdmin(user, body.roleCodes);
  const updated = await prisma.$transaction(async (tx) => {
    if (body.roleCodes) {
      const roles = await tx.role.findMany({ where: { code: { in: body.roleCodes } } });
      if (roles.length !== body.roleCodes.length) throw badRequest('One or more roles do not exist');
      if (params.id === user.id && target.roles.some((r) => r.role.code === 'SUPER_ADMIN') && !body.roleCodes.includes('SUPER_ADMIN')) {
        throw badRequest('You cannot remove your own Super Administrator role');
      }
      await tx.userRole.deleteMany({ where: { userId: params.id } });
      await tx.userRole.createMany({ data: roles.map((r) => ({ userId: params.id, roleId: r.id, companyId: body.companyId ?? null })) });
    }
    const res = await tx.user.update({
      where: { id: params.id },
      data: { displayName: body.displayName, isActive: body.isActive, employeeId: body.employeeId },
      select: { id: true, email: true, displayName: true, isActive: true },
    });
    if (body.isActive === false) await tx.session.updateMany({ where: { userId: params.id, revokedAt: null }, data: { revokedAt: new Date() } });
    return res;
  });
  await audit({ userId: user.id, action: 'UPDATE', entity: 'User', entityId: params.id, before: { isActive: target.isActive, roles: target.roles.map((r) => r.role.code) }, after: { ...body }, ip: ipOf(req) });
  return updated;
});

u.post('/:id/reset-password', { summary: 'Reset a password (returns a one-time temporary password)', permission: 'user.manage', params: idParam }, async ({ req, user, params }) => {
  await guardTarget(user, params.id);
  const password = tempPassword();
  await prisma.$transaction([
    prisma.user.update({ where: { id: params.id }, data: { passwordHash: await hashPassword(password), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null } }),
    prisma.session.updateMany({ where: { userId: params.id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await audit({ userId: user.id, action: 'RESET_PASSWORD', entity: 'User', entityId: params.id, ip: ipOf(req) });
  return { temporaryPassword: password };
});

u.post('/:id/unlock', { summary: 'Unlock an account locked by failed sign-ins', permission: 'user.manage', params: idParam }, async ({ req, user, params }) => {
  await guardTarget(user, params.id);
  await prisma.user.update({ where: { id: params.id }, data: { failedLoginCount: 0, lockedUntil: null } });
  await audit({ userId: user.id, action: 'UNLOCK', entity: 'User', entityId: params.id, ip: ipOf(req) });
});

u.post('/:id/reset-mfa', { summary: 'Remove MFA from an account (lost device)', permission: 'user.manage', params: idParam }, async ({ req, user, params }) => {
  await guardTarget(user, params.id);
  await prisma.user.update({ where: { id: params.id }, data: { mfaEnabled: false, mfaSecretEnc: null } });
  await audit({ userId: user.id, action: 'RESET_MFA', entity: 'User', entityId: params.id, ip: ipOf(req) });
});

// ── Roles ──

export const rolesRouter = createRouter('/api/roles', 'Roles & permissions');
const ro = rolesRouter;

ro.get('/permissions', { summary: 'Permission catalog', permission: ['role.manage', 'user.manage'] }, async () =>
  ALL_PERMISSIONS.map((code) => ({ code, module: PERMISSIONS[code][0], description: PERMISSIONS[code][1] })),
);

ro.get('/', { summary: 'List roles with their permissions', permission: ['role.manage', 'user.manage'] }, async () => {
  const roles = await prisma.role.findMany({ include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } }, orderBy: { name: 'asc' } });
  return roles.map((r) => ({ ...r, permissions: r.permissions.map((p) => p.permission.code) }));
});

const roleBody = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[A-Z0-9_]+$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).nullish(),
  dataScope: z.enum(['ALL', 'COMPANY', 'BRANCH', 'DEPARTMENT', 'TEAM', 'SELF']),
  permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])),
});

async function setPermissions(tx: Prisma.TransactionClient, roleId: string, codes: string[]) {
  const perms = await tx.permission.findMany({ where: { code: { in: codes } } });
  await tx.rolePermission.deleteMany({ where: { roleId } });
  await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId, permissionId: p.id })) });
}

ro.post('/', { summary: 'Create a custom role', permission: 'role.manage', body: roleBody, status: 201 }, async ({ req, user, body }) => {
  const role = await prisma.$transaction(async (tx) => {
    const created = await tx.role.create({ data: { code: body.code, name: body.name, description: body.description, dataScope: body.dataScope } });
    await setPermissions(tx, created.id, body.permissions);
    return created;
  });
  await audit({ userId: user.id, action: 'CREATE', entity: 'Role', entityId: role.id, after: body, ip: ipOf(req) });
  return role;
});

ro.put('/:id', { summary: 'Update a role and its permissions', permission: 'role.manage', params: idParam, body: roleBody.omit({ code: true }) }, async ({ req, user, params, body }) => {
  const before = await prisma.role.findUnique({ where: { id: params.id }, include: { permissions: { include: { permission: true } } } });
  if (!before) throw notFound('Role');
  if (before.code === 'SUPER_ADMIN') throw badRequest('The Super Administrator role always has every permission and cannot be edited');
  await prisma.$transaction(async (tx) => {
    await tx.role.update({ where: { id: params.id }, data: { name: body.name, description: body.description, dataScope: body.dataScope } });
    await setPermissions(tx, params.id, body.permissions);
  });
  await audit({ userId: user.id, action: 'UPDATE', entity: 'Role', entityId: params.id, before: { ...before, permissions: before.permissions.map((p) => p.permission.code) }, after: body, ip: ipOf(req) });
  return prisma.role.findUnique({ where: { id: params.id } });
});

ro.delete('/:id', { summary: 'Delete a custom role that is not assigned to anyone', permission: 'role.manage', params: idParam }, async ({ req, user, params }) => {
  const role = await prisma.role.findUnique({ where: { id: params.id }, include: { _count: { select: { users: true } } } });
  if (!role) throw notFound('Role');
  if (role.isSystem) throw badRequest('System roles cannot be deleted');
  if (role._count.users) throw conflict('This role is assigned to users. Remove it from them first.');
  await prisma.role.delete({ where: { id: params.id } });
  await audit({ userId: user.id, action: 'DELETE', entity: 'Role', entityId: params.id, before: role, ip: ipOf(req) });
});

// ── Audit log ──

export const auditRouter = createRouter('/api/audit', 'Audit');
auditRouter.get(
  '/',
  {
    summary: 'Search the audit trail',
    permission: 'audit.read',
    query: pageQuery.extend({ entity: z.string().optional(), entityId: z.string().optional(), userId: z.string().uuid().optional(), action: z.string().optional(), from: z.string().optional(), to: z.string().optional() }),
  },
  async ({ query }) => {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.entity ? { entity: query.entity } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}) } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({ where, include: { user: { select: { displayName: true, email: true } } }, orderBy: { createdAt: 'desc' }, ...paging(query) }),
      prisma.auditLog.count({ where }),
    ]);
    return paged(items, total, query);
  },
);
