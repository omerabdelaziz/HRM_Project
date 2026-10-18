import { z } from 'zod';
import { createRouter, dateString, idParam, paged, pageQuery, paging } from '../../lib/http';
import { prisma, Prisma } from '../../lib/prisma';
import { hasPermission } from '../../auth/context';
import { resolveCompanyId, assertCompanyAccess } from '../../auth/scope';
import { badRequest, notFound } from '../../lib/errors';
import { audit, ipOf } from '../../lib/audit';
import { toDateOnly } from '../../lib/dates';
import { APPROVER_TYPES, decide, REQUEST_TYPES } from './engine';

const r = createRouter('/api/approvals', 'Approvals');
export default r;

const requestInclude = {
  requester: { select: { id: true, displayName: true } },
  employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true, firstNameAr: true, lastNameAr: true } },
} satisfies Prisma.ApprovalRequestInclude;

r.get(
  '/inbox',
  { summary: 'Requests waiting for my decision', permission: 'approval.act', query: pageQuery.extend({ requestType: z.enum(REQUEST_TYPES).optional() }) },
  async ({ user, query }) => {
    const where: Prisma.ApprovalRequestWhereInput = {
      status: 'PENDING',
      tasks: { some: { assigneeId: user.id, status: 'OPEN' } },
      ...(query.requestType ? { requestType: query.requestType } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.approvalRequest.findMany({ where, include: requestInclude, orderBy: { createdAt: 'asc' }, ...paging(query) }),
      prisma.approvalRequest.count({ where }),
    ]);
    // OPEN tasks only ever exist for a request's current step: deciding a step supersedes the rest.
    return paged(items, total, query);
  },
);

r.get('/inbox/count', { summary: 'Number of requests waiting for my decision' }, async ({ user }) => ({
  count: await prisma.approvalRequest.count({ where: { status: 'PENDING', tasks: { some: { assigneeId: user.id, status: 'OPEN' } } } }),
}));

r.get(
  '/requests',
  {
    summary: 'Approval requests: my own, ones I acted on, or all (with approval.read.all)',
    query: pageQuery.extend({
      view: z.enum(['mine', 'handled', 'all']).default('mine'),
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
      requestType: z.enum(REQUEST_TYPES).optional(),
      companyId: z.string().uuid().optional(),
    }),
  },
  async ({ user, query }) => {
    const where: Prisma.ApprovalRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.requestType ? { requestType: query.requestType } : {}),
    };
    if (query.view === 'mine') where.requesterId = user.id;
    else if (query.view === 'handled') where.actions = { some: { actorId: user.id, decision: { in: ['APPROVED', 'REJECTED'] } } };
    else {
      if (!hasPermission(user, 'approval.read.all')) throw badRequest('You can only view your own requests');
      where.companyId = await resolveCompanyId(user, query.companyId);
    }
    if (query.search) where.title = { contains: query.search, mode: 'insensitive' };
    const [items, total] = await Promise.all([
      prisma.approvalRequest.findMany({ where, include: requestInclude, orderBy: { createdAt: 'desc' }, ...paging(query) }),
      prisma.approvalRequest.count({ where }),
    ]);
    return paged(items, total, query);
  },
);

r.get('/requests/:id', { summary: 'Request detail with full approval history', params: idParam }, async ({ user, params }) => {
  const req = await prisma.approvalRequest.findUnique({
    where: { id: params.id },
    include: {
      ...requestInclude,
      definition: { include: { steps: { orderBy: { order: 'asc' } } } },
      actions: { include: { actor: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'asc' } },
      tasks: { include: { assignee: { select: { id: true, displayName: true } } }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!req) throw notFound('Approval request');
  const involved = req.requesterId === user.id || req.tasks.some((t) => t.assigneeId === user.id);
  if (!involved && !hasPermission(user, 'approval.read.all')) throw notFound('Approval request');
  const canAct = req.status === 'PENDING' && req.tasks.some((t) => t.assigneeId === user.id && t.status === 'OPEN' && t.stepOrder === req.currentStep);
  return { ...req, canAct };
});

const decisionBody = z.object({ comment: z.string().trim().max(2000).optional() });

r.post('/requests/:id/approve', { summary: 'Approve the current step', permission: 'approval.act', params: idParam, body: decisionBody }, async ({ user, params, body }) =>
  decide(params.id, user.id, 'APPROVED', body.comment),
);

r.post('/requests/:id/reject', { summary: 'Reject the request (comment required)', permission: 'approval.act', params: idParam, body: decisionBody }, async ({ user, params, body }) =>
  decide(params.id, user.id, 'REJECTED', body.comment),
);

r.post(
  '/bulk',
  {
    summary: 'Approve or reject several requests at once',
    permission: 'approval.act',
    body: z.object({ ids: z.array(z.string().uuid()).min(1).max(100), decision: z.enum(['APPROVED', 'REJECTED']), comment: z.string().max(2000).optional() }),
  },
  async ({ user, body }) => {
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of body.ids) {
      try {
        await decide(id, user.id, body.decision, body.comment);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: (e as Error).message });
      }
    }
    return { results };
  },
);

// ── Delegations ──

r.get('/delegations', { summary: 'My approval delegations (given and received)', permission: 'approval.act' }, async ({ user }) =>
  prisma.approvalDelegation.findMany({
    where: { OR: [{ fromUserId: user.id }, { toUserId: user.id }] },
    include: { fromUser: { select: { id: true, displayName: true } }, toUser: { select: { id: true, displayName: true } } },
    orderBy: { startDate: 'desc' },
  }),
);

r.post(
  '/delegations',
  {
    summary: 'Delegate my approvals to another user for a date range',
    permission: 'approval.act',
    status: 201,
    body: z.object({ toUserId: z.string().uuid(), startDate: dateString, endDate: dateString, requestTypes: z.array(z.enum(REQUEST_TYPES)).default([]) }),
  },
  async ({ req, user, body }) => {
    if (body.toUserId === user.id) throw badRequest('You cannot delegate to yourself');
    if (body.endDate < body.startDate) throw badRequest('End date must be on or after start date');
    const target = await prisma.user.findUnique({ where: { id: body.toUserId } });
    if (!target?.isActive) throw badRequest('The selected user is not active');
    const d = await prisma.approvalDelegation.create({
      data: { fromUserId: user.id, toUserId: body.toUserId, startDate: toDateOnly(body.startDate), endDate: toDateOnly(body.endDate), requestTypes: body.requestTypes },
    });
    await audit({ userId: user.id, action: 'CREATE', entity: 'ApprovalDelegation', entityId: d.id, after: d, ip: ipOf(req) });
    return d;
  },
);

r.delete('/delegations/:id', { summary: 'Revoke a delegation I created', permission: 'approval.act', params: idParam }, async ({ user, params }) => {
  const d = await prisma.approvalDelegation.findUnique({ where: { id: params.id } });
  if (!d || d.fromUserId !== user.id) throw notFound('Delegation');
  await prisma.approvalDelegation.update({ where: { id: params.id }, data: { isActive: false } });
});

// ── Workflow definitions ──

export const workflowRouter = createRouter('/api/workflows', 'Workflow configuration');
const w = workflowRouter;

const stepSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    approverType: z.enum(APPROVER_TYPES),
    roleCode: z.string().nullish(),
    userId: z.string().uuid().nullish(),
    minAmount: z.coerce.number().nonnegative().nullish(),
    escalateAfterHours: z.number().int().positive().nullish(),
    escalateToType: z.enum(APPROVER_TYPES).nullish(),
    escalateToRoleCode: z.string().nullish(),
    escalateToUserId: z.string().uuid().nullish(),
    allowSelfApproval: z.boolean().default(false),
  })
  .refine((s) => s.approverType !== 'ROLE' || !!s.roleCode, { message: 'roleCode is required for ROLE approvers', path: ['roleCode'] })
  .refine((s) => s.approverType !== 'USER' || !!s.userId, { message: 'userId is required for USER approvers', path: ['userId'] });

const definitionSchema = z.object({
  companyId: z.string().uuid().optional(),
  requestType: z.enum(REQUEST_TYPES),
  name: z.string().trim().min(1).max(150),
  isActive: z.boolean().default(true),
  priority: z.number().int().default(0),
  conditions: z
    .object({
      minAmount: z.number().optional(),
      maxAmount: z.number().optional(),
      leaveTypeCodes: z.array(z.string()).optional(),
      departmentIds: z.array(z.string().uuid()).optional(),
      branchIds: z.array(z.string().uuid()).optional(),
    })
    .nullish(),
  steps: z.array(stepSchema).min(1).max(10),
});

w.get('/', { summary: 'List workflow definitions', permission: ['workflow.manage', 'approval.read.all'], query: z.object({ companyId: z.string().uuid().optional() }) }, async ({ user, query }) => {
  const companyId = await resolveCompanyId(user, query.companyId);
  return prisma.workflowDefinition.findMany({
    where: { companyId },
    include: { steps: { orderBy: { order: 'asc' } } },
    orderBy: [{ requestType: 'asc' }, { priority: 'desc' }],
  });
});

w.post('/', { summary: 'Create a workflow definition', permission: 'workflow.manage', body: definitionSchema, status: 201 }, async ({ req, user, body }) => {
  const companyId = await resolveCompanyId(user, body.companyId);
  const def = await prisma.workflowDefinition.create({
    data: {
      companyId,
      requestType: body.requestType,
      name: body.name,
      isActive: body.isActive,
      priority: body.priority,
      conditions: body.conditions ?? Prisma.JsonNull,
      steps: { create: body.steps.map((s, i) => ({ ...s, order: i + 1 })) },
    },
    include: { steps: { orderBy: { order: 'asc' } } },
  });
  await audit({ userId: user.id, action: 'CREATE', entity: 'WorkflowDefinition', entityId: def.id, after: def, ip: ipOf(req) });
  return def;
});

w.put('/:id', { summary: 'Replace a workflow definition (in-flight requests keep their current step)', permission: 'workflow.manage', params: idParam, body: definitionSchema }, async ({ req, user, params, body }) => {
  const before = await prisma.workflowDefinition.findUnique({ where: { id: params.id }, include: { steps: true } });
  if (!before) throw notFound('Workflow');
  await assertCompanyAccess(user, before.companyId);
  const def = await prisma.$transaction(async (tx) => {
    await tx.workflowStep.deleteMany({ where: { definitionId: params.id } });
    return tx.workflowDefinition.update({
      where: { id: params.id },
      data: {
        requestType: body.requestType,
        name: body.name,
        isActive: body.isActive,
        priority: body.priority,
        conditions: body.conditions ?? Prisma.JsonNull,
        steps: { create: body.steps.map((s, i) => ({ ...s, order: i + 1 })) },
      },
      include: { steps: { orderBy: { order: 'asc' } } },
    });
  });
  await audit({ userId: user.id, action: 'UPDATE', entity: 'WorkflowDefinition', entityId: def.id, before, after: def, ip: ipOf(req) });
  return def;
});

w.delete('/:id', { summary: 'Deactivate a workflow definition', permission: 'workflow.manage', params: idParam }, async ({ req, user, params }) => {
  const before = await prisma.workflowDefinition.findUnique({ where: { id: params.id } });
  if (!before) throw notFound('Workflow');
  await assertCompanyAccess(user, before.companyId);
  await prisma.workflowDefinition.update({ where: { id: params.id }, data: { isActive: false } });
  await audit({ userId: user.id, action: 'DEACTIVATE', entity: 'WorkflowDefinition', entityId: params.id, ip: ipOf(req) });
});
