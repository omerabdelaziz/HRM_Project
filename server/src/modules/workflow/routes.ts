import { z } from 'zod';
import { createRouter, dateString, idParam, paged, pageQuery, paging } from '../../lib/http';
import { prisma, Prisma } from '../../lib/prisma';
import { hasPermission } from '../../auth/context';
import { accessibleCompanyIds, resolveCompanyId, assertCompanyAccess } from '../../auth/scope';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { audit, ipOf } from '../../lib/audit';
import { toDateOnly } from '../../lib/dates';
import { APPROVER_TYPES, decide, overrideDecision, REQUEST_TYPES } from './engine';

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
    else if (query.view === 'handled') where.actions = { some: { actorId: user.id, decision: { in: ['APPROVED', 'REJECTED', 'OVERRIDE_APPROVE', 'OVERRIDE_REJECT'] } } };
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
  const oversees = hasPermission(user, 'approval.read.all', 'approval.override') && (await accessibleCompanyIds(user)).includes(req.companyId);
  if (!involved && !oversees) throw notFound('Approval request');
  const canAct = req.status === 'PENDING' && req.tasks.some((t) => t.assigneeId === user.id && t.status === 'OPEN' && t.stepOrder === req.currentStep);
  const canOverride = req.status === 'PENDING' && req.requesterId !== user.id && oversees && mayOverride(user, req.requestType);
  return { ...req, canAct, canOverride };
});

/** Overrides need approval.override; payroll runs additionally need payroll.approve (segregation of duties). */
function mayOverride(user: Parameters<typeof hasPermission>[0], requestType: string) {
  return hasPermission(user, 'approval.override') && (requestType !== 'PAYROLL' || hasPermission(user, 'payroll.approve'));
}

const decisionBody = z.object({ comment: z.string().trim().max(2000).optional() });

r.post('/requests/:id/approve', { summary: 'Approve the current step', permission: 'approval.act', params: idParam, body: decisionBody }, async ({ user, params, body }) =>
  decide(params.id, user.id, 'APPROVED', body.comment),
);

r.post('/requests/:id/reject', { summary: 'Reject the request (comment required)', permission: 'approval.act', params: idParam, body: decisionBody }, async ({ user, params, body }) =>
  decide(params.id, user.id, 'REJECTED', body.comment),
);

r.post(
  '/requests/:id/override',
  {
    summary: 'Approve or reject the current step of any pending request as an HR/admin override (comment required, audited)',
    permission: 'approval.override',
    params: idParam,
    body: z.object({ decision: z.enum(['APPROVED', 'REJECTED']), comment: z.string().trim().min(1, 'validation.required').max(2000) }),
  },
  async ({ user, params, body }) => {
    const req = await prisma.approvalRequest.findUnique({ where: { id: params.id }, select: { companyId: true, requestType: true } });
    if (!req || !(await accessibleCompanyIds(user)).includes(req.companyId)) throw notFound('Approval request');
    if (!mayOverride(user, req.requestType)) throw forbidden('Overriding a payroll approval also requires the payroll approval permission');
    return overrideDecision(params.id, user.id, body.decision, body.comment);
  },
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
  .refine((s) => s.approverType !== 'USER' || !!s.userId, { message: 'userId is required for USER approvers', path: ['userId'] })
  .refine((s) => !s.escalateAfterHours || !!s.escalateToType, { message: 'Choose who the step escalates to', path: ['escalateToType'] })
  .refine((s) => s.escalateToType !== 'ROLE' || !!s.escalateToRoleCode, { message: 'escalateToRoleCode is required for ROLE escalation', path: ['escalateToRoleCode'] })
  .refine((s) => s.escalateToType !== 'USER' || !!s.escalateToUserId, { message: 'escalateToUserId is required for USER escalation', path: ['escalateToUserId'] });

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

const companyQuery = z.object({ companyId: z.string().uuid().optional() });

w.get(
  '/coverage',
  { summary: 'What happens to each request type: routed by a workflow, sent to the fallback approver, or auto-approved', permission: ['workflow.manage', 'approval.read.all'], query: companyQuery },
  async ({ user, query }) => {
    const companyId = await resolveCompanyId(user, query.companyId);
    const [company, defs] = await Promise.all([
      prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { workflowFallbackRole: true, autoApproveRequestTypes: true } }),
      prisma.workflowDefinition.findMany({ where: { companyId, isActive: true, steps: { some: {} } }, select: { requestType: true, conditions: true } }),
    ]);
    return REQUEST_TYPES.map((requestType) => {
      const mine = defs.filter((d) => d.requestType === requestType);
      // A workflow with conditions may not match every request; those requests fall through to the no-workflow path.
      const unconditional = mine.some((d) => !d.conditions || Object.keys(d.conditions as object).length === 0);
      const noWorkflow = company.autoApproveRequestTypes.includes(requestType) ? 'AUTO_APPROVE' : 'FALLBACK';
      return { requestType, workflows: mine.length, fullyCovered: unconditional, otherwise: noWorkflow, fallbackRole: company.workflowFallbackRole };
    });
  },
);

const settingsSchema = z.object({
  companyId: z.string().uuid().optional(),
  workflowFallbackRole: z.string().trim().min(1).max(50),
  autoApproveRequestTypes: z.array(z.enum(REQUEST_TYPES)).max(REQUEST_TYPES.length),
});

w.get('/settings', { summary: 'Fallback approver and auto-approve settings', permission: ['workflow.manage', 'approval.read.all'], query: companyQuery }, async ({ user, query }) => {
  const companyId = await resolveCompanyId(user, query.companyId);
  return prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { id: true, workflowFallbackRole: true, autoApproveRequestTypes: true } });
});

w.put('/settings', { summary: 'Update the fallback approver role and the request types approved automatically when no workflow applies', permission: 'workflow.manage', body: settingsSchema }, async ({ req, user, body }) => {
  const companyId = await resolveCompanyId(user, body.companyId);
  if (!(await prisma.role.findUnique({ where: { code: body.workflowFallbackRole } }))) throw badRequest('Unknown role');
  const before = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { workflowFallbackRole: true, autoApproveRequestTypes: true } });
  const after = await prisma.company.update({
    where: { id: companyId },
    data: { workflowFallbackRole: body.workflowFallbackRole, autoApproveRequestTypes: [...new Set(body.autoApproveRequestTypes)] },
    select: { id: true, workflowFallbackRole: true, autoApproveRequestTypes: true },
  });
  await audit({ userId: user.id, action: 'UPDATE', entity: 'WorkflowSettings', entityId: companyId, before, after, ip: ipOf(req) });
  return after;
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
