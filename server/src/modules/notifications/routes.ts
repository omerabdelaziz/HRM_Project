import { z } from 'zod';
import { createRouter, idParam, paged, pageQuery, paging } from '../../lib/http';
import { prisma, Prisma } from '../../lib/prisma';
import { resolveCompanyId, assertCompanyAccess } from '../../auth/scope';
import { notFound } from '../../lib/errors';
import { audit, ipOf } from '../../lib/audit';
import { NOTIFICATION_TYPES, notify } from './service';

const r = createRouter('/api/notifications', 'Notifications');
export default r;

r.get('/', { summary: 'My notifications', query: pageQuery.extend({ unread: z.enum(['true', 'false']).optional() }) }, async ({ user, query }) => {
  const where: Prisma.NotificationWhereInput = { userId: user.id, ...(query.unread === 'true' ? { readAt: null } : {}) };
  const [items, total, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...paging(query) }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId: user.id, readAt: null } }),
  ]);
  return { ...paged(items, total, query), unread };
});

r.post('/:id/read', { summary: 'Mark one notification read', params: idParam }, async ({ user, params }) => {
  await prisma.notification.updateMany({ where: { id: params.id, userId: user.id, readAt: null }, data: { readAt: new Date() } });
});

r.post('/read-all', { summary: 'Mark all my notifications read' }, async ({ user }) => {
  await prisma.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
});

r.get('/preferences', { summary: 'My notification preferences per type' }, async ({ user }) => {
  const prefs = await prisma.notificationPreference.findMany({ where: { userId: user.id } });
  return NOTIFICATION_TYPES.map((type) => {
    const p = prefs.find((x) => x.type === type);
    return { type, inApp: p?.inApp ?? true, email: p?.email ?? true };
  });
});

r.put(
  '/preferences',
  { summary: 'Update my notification preferences', body: z.array(z.object({ type: z.enum(NOTIFICATION_TYPES), inApp: z.boolean(), email: z.boolean() })) },
  async ({ user, body }) => {
    await prisma.$transaction(
      body.map((p) =>
        prisma.notificationPreference.upsert({
          where: { userId_type: { userId: user.id, type: p.type } },
          create: { userId: user.id, ...p },
          update: { inApp: p.inApp, email: p.email },
        }),
      ),
    );
  },
);

// ── Announcements ──

export const announcementsRouter = createRouter('/api/announcements', 'Announcements');
const a = announcementsRouter;

a.get('/', { summary: 'Current announcements visible to me', query: z.object({ companyId: z.string().uuid().optional(), all: z.enum(['true', 'false']).optional() }) }, async ({ user, query }) => {
  const companyId = await resolveCompanyId(user, query.companyId);
  const now = new Date();
  const manage = user.permissions.has('announcement.manage') && query.all === 'true';
  const rows = await prisma.announcement.findMany({
    where: { companyId, ...(manage ? {} : { publishedAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }) },
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    take: 50,
  });
  if (manage) return rows;
  return rows.filter((row) => {
    const aud = row.audience as { branchIds?: string[]; departmentIds?: string[] } | null;
    if (!aud || (!aud.branchIds?.length && !aud.departmentIds?.length)) return true;
    return (!!user.branchId && !!aud.branchIds?.includes(user.branchId)) || (!!user.departmentId && !!aud.departmentIds?.includes(user.departmentId));
  });
});

const annBody = z.object({
  companyId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  audience: z.object({ branchIds: z.array(z.string().uuid()).default([]), departmentIds: z.array(z.string().uuid()).default([]) }).nullish(),
  publish: z.boolean().default(true),
  expiresAt: z.string().datetime({ offset: true }).nullish(),
});

a.post('/', { summary: 'Create (and optionally publish) an announcement', permission: 'announcement.manage', body: annBody, status: 201 }, async ({ req, user, body }) => {
  const companyId = await resolveCompanyId(user, body.companyId);
  const ann = await prisma.announcement.create({
    data: {
      companyId, title: body.title, body: body.body, audience: body.audience ?? Prisma.JsonNull,
      publishedAt: body.publish ? new Date() : null, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, createdById: user.id,
    },
  });
  if (body.publish) await broadcast(ann.id);
  await audit({ userId: user.id, action: 'CREATE', entity: 'Announcement', entityId: ann.id, after: ann, ip: ipOf(req) });
  return ann;
});

a.put('/:id', { summary: 'Edit or publish an announcement', permission: 'announcement.manage', params: idParam, body: annBody.partial() }, async ({ user, params, body }) => {
  const before = await prisma.announcement.findUnique({ where: { id: params.id } });
  if (!before) throw notFound('Announcement');
  await assertCompanyAccess(user, before.companyId);
  const publishNow = body.publish && !before.publishedAt;
  const ann = await prisma.announcement.update({
    where: { id: params.id },
    data: {
      title: body.title, body: body.body,
      audience: body.audience === undefined ? undefined : body.audience ?? Prisma.JsonNull,
      expiresAt: body.expiresAt === undefined ? undefined : body.expiresAt ? new Date(body.expiresAt) : null,
      publishedAt: publishNow ? new Date() : body.publish === false ? null : undefined,
    },
  });
  if (publishNow) await broadcast(ann.id);
  return ann;
});

a.delete('/:id', { summary: 'Delete an announcement', permission: 'announcement.manage', params: idParam }, async ({ req, user, params }) => {
  const before = await prisma.announcement.findUnique({ where: { id: params.id } });
  if (!before) throw notFound('Announcement');
  await assertCompanyAccess(user, before.companyId);
  await prisma.announcement.delete({ where: { id: params.id } });
  await audit({ userId: user.id, action: 'DELETE', entity: 'Announcement', entityId: params.id, before, ip: ipOf(req) });
});

async function broadcast(announcementId: string) {
  const ann = await prisma.announcement.findUniqueOrThrow({ where: { id: announcementId } });
  const aud = ann.audience as { branchIds?: string[]; departmentIds?: string[] } | null;
  const targeted = !!(aud && (aud.branchIds?.length || aud.departmentIds?.length));
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      employee: {
        companyId: ann.companyId,
        deletedAt: null,
        ...(targeted ? { OR: [{ branchId: { in: aud!.branchIds ?? [] } }, { departmentId: { in: aud!.departmentIds ?? [] } }] } : {}),
      },
    },
    select: { id: true },
  });
  await notify(users.map((x) => x.id), { type: 'ANNOUNCEMENT', title: ann.title, body: ann.body.slice(0, 300), link: '/announcements' });
}
