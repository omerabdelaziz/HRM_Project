import { prisma, Prisma, Tx } from '../../lib/prisma';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { notify } from '../notifications/service';
import { toDateOnly } from '../../lib/dates';
import { addBusinessHours, type BusinessCalendar } from '../../lib/business-time';

export const REQUEST_TYPES = [
  'LEAVE',
  'ATTENDANCE_CORRECTION',
  'OVERTIME',
  'PAYROLL',
  'SALARY_CHANGE',
  'TRANSFER',
  'RESIGNATION',
  'EXPENSE',
  'JOB_OFFER',
  'DOCUMENT',
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const APPROVER_TYPES = ['DIRECT_MANAGER', 'MANAGERS_MANAGER', 'DEPARTMENT_MANAGER', 'BRANCH_MANAGER', 'ROLE', 'USER'] as const;
export type ApproverType = (typeof APPROVER_TYPES)[number];

type ApprovalRequestRow = Prisma.ApprovalRequestGetPayload<object>;

export interface WorkflowHandler {
  /** Applies the business effect once every step has approved. Runs in the decision's transaction. */
  onApproved(tx: Tx, request: ApprovalRequestRow, actorId: string | null): Promise<void>;
  onRejected(tx: Tx, request: ApprovalRequestRow, actorId: string | null): Promise<void>;
  onCancelled?(tx: Tx, request: ApprovalRequestRow, actorId: string | null): Promise<void>;
  /** Front-end route showing the underlying record. */
  link?(request: ApprovalRequestRow): string;
}

const handlers = new Map<string, WorkflowHandler>();
export function registerWorkflowHandler(type: RequestType, handler: WorkflowHandler) {
  handlers.set(type, handler);
}
function handlerFor(type: string) {
  const h = handlers.get(type);
  if (!h) throw new Error(`No workflow handler registered for ${type}`);
  return h;
}

/** Roles whose holders receive requests that would otherwise have no eligible approver. */
const FALLBACK_ROLES = ['HR_ADMIN', 'SUPER_ADMIN'];

/** Approvers for requests that no workflow covers: holders of the company's fallback role (then super administrators). */
async function fallbackApprovers(tx: Tx, companyId: string, requesterId: string) {
  const company = await tx.company.findUnique({ where: { id: companyId }, select: { workflowFallbackRole: true } });
  for (const roles of [[company?.workflowFallbackRole ?? 'HR_ADMIN'], ['SUPER_ADMIN']]) {
    const ids = (await usersWithRoles(tx, roles, companyId)).filter((id) => id !== requesterId);
    if (ids.length) return { ids, role: roles[0] };
  }
  return { ids: [], role: company?.workflowFallbackRole ?? 'HR_ADMIN' };
}

export interface SubmitInput {
  companyId: string;
  requestType: RequestType;
  entityId: string;
  requesterId: string;
  employeeId?: string | null;
  title: string;
  summary?: Record<string, unknown>;
  amount?: number | null;
  /** Values matched against a definition's `conditions`. */
  context?: { leaveTypeCode?: string; departmentId?: string | null; branchId?: string | null };
}

interface Conditions {
  minAmount?: number;
  maxAmount?: number;
  leaveTypeCodes?: string[];
  departmentIds?: string[];
  branchIds?: string[];
}

function matches(cond: Conditions | null, input: SubmitInput) {
  if (!cond) return true;
  const amt = input.amount ?? 0;
  if (cond.minAmount != null && amt < cond.minAmount) return false;
  if (cond.maxAmount != null && amt > cond.maxAmount) return false;
  if (cond.leaveTypeCodes?.length && !cond.leaveTypeCodes.includes(input.context?.leaveTypeCode ?? '')) return false;
  if (cond.departmentIds?.length && !cond.departmentIds.includes(input.context?.departmentId ?? '')) return false;
  if (cond.branchIds?.length && !cond.branchIds.includes(input.context?.branchId ?? '')) return false;
  return true;
}

/**
 * Starts an approval for a record. If no workflow applies, the request goes to the company's fallback
 * approver role (default HR Administrator). It is approved automatically only when the request type is
 * explicitly listed in the company's auto-approve setting; both outcomes are recorded in the history.
 */
export async function submitForApproval(tx: Tx, input: SubmitInput) {
  const definitions = await tx.workflowDefinition.findMany({
    where: { companyId: input.companyId, requestType: input.requestType, isActive: true },
    include: { steps: { orderBy: { order: 'asc' } } },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  });
  const definition = definitions.find((d) => matches(d.conditions as Conditions | null, input)) ?? null;

  const request = await tx.approvalRequest.create({
    data: {
      companyId: input.companyId,
      requestType: input.requestType,
      entityId: input.entityId,
      definitionId: definition?.id,
      requesterId: input.requesterId,
      employeeId: input.employeeId ?? null,
      title: input.title,
      summary: (input.summary ?? undefined) as Prisma.InputJsonValue | undefined,
      amount: input.amount ?? undefined,
      status: 'PENDING',
      currentStep: 0,
    },
  });
  await tx.approvalAction.create({ data: { requestId: request.id, stepOrder: 0, actorId: input.requesterId, decision: 'SUBMITTED' } });

  if (!definition || !definition.steps.length) {
    const company = await tx.company.findUnique({ where: { id: input.companyId }, select: { autoApproveRequestTypes: true } });
    if (company?.autoApproveRequestTypes.includes(input.requestType)) {
      await tx.approvalAction.create({
        data: { requestId: request.id, stepOrder: 0, decision: 'APPROVED', comment: 'Approved automatically: this request type is configured to auto-approve when no workflow applies' },
      });
      return finalize(tx, request.id, 'APPROVED', null);
    }
    const fallback = await fallbackApprovers(tx, input.companyId, input.requesterId);
    if (!fallback.ids.length) {
      await tx.approvalAction.create({ data: { requestId: request.id, stepOrder: 1, decision: 'COMMENT', comment: 'No approval workflow is configured and no fallback approver exists; an administrator must decide this request' } });
      return tx.approvalRequest.update({ where: { id: request.id }, data: { currentStep: 1, stepEnteredAt: new Date() } });
    }
    const names = await displayNames(tx, fallback.ids);
    await tx.approvalAction.create({
      data: { requestId: request.id, stepOrder: 1, decision: 'COMMENT', comment: `No approval workflow is configured for this request type; routed to the fallback approver (${fallback.role}): ${names}` },
    });
    const pending = await tx.approvalRequest.update({ where: { id: request.id }, data: { currentStep: 1, stepEnteredAt: new Date() } });
    await assignTasks(tx, pending, 1, fallback.ids);
    return pending;
  }
  return advance(tx, request.id, 1);
}

async function displayNames(tx: Tx, userIds: string[]) {
  const users = await tx.user.findMany({ where: { id: { in: userIds } }, select: { displayName: true } });
  return users.map((u) => u.displayName).join(', ');
}

/** Moves the request to the first applicable step with order >= fromOrder, or completes it. */
async function advance(tx: Tx, requestId: string, fromOrder: number, actorId: string | null = null): Promise<ApprovalRequestRow> {
  const request = await tx.approvalRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { definition: { include: { steps: { orderBy: { order: 'asc' } } } } },
  });
  const steps = request.definition?.steps.filter((s) => s.order >= fromOrder) ?? [];

  for (const step of steps) {
    if (step.minAmount != null && Number(request.amount ?? 0) < Number(step.minAmount)) {
      await tx.approvalAction.create({ data: { requestId, stepOrder: step.order, decision: 'SKIPPED', comment: `${step.name}: below approval limit` } });
      continue;
    }
    let approvers = await resolveApprovers(tx, step.approverType as ApproverType, request, step.roleCode, step.userId);
    if (!step.allowSelfApproval) approvers = approvers.filter((id) => id !== request.requesterId);
    if (!approvers.length) {
      approvers = (await usersWithRoles(tx, FALLBACK_ROLES, request.companyId)).filter((id) => id !== request.requesterId);
      if (approvers.length) {
        await tx.approvalAction.create({ data: { requestId, stepOrder: step.order, decision: 'COMMENT', comment: `${step.name}: no approver found, routed to HR administrators` } });
      }
    }
    if (!approvers.length) {
      await tx.approvalAction.create({ data: { requestId, stepOrder: step.order, decision: 'SKIPPED', comment: `${step.name}: no eligible approver` } });
      continue;
    }
    await assignTasks(tx, request, step.order, approvers);
    return tx.approvalRequest.update({ where: { id: requestId }, data: { currentStep: step.order, stepEnteredAt: new Date() } });
  }
  return finalize(tx, requestId, 'APPROVED', actorId);
}

async function assignTasks(tx: Tx, request: ApprovalRequestRow, stepOrder: number, approverIds: string[]) {
  const today = toDateOnly(new Date());
  const delegations = await tx.approvalDelegation.findMany({
    where: { fromUserId: { in: approverIds }, isActive: true, startDate: { lte: today }, endDate: { gte: today } },
  });
  const tasks: { assigneeId: string; viaDelegationFromId: string | null }[] = approverIds.map((id) => ({ assigneeId: id, viaDelegationFromId: null }));
  for (const d of delegations) {
    if (d.requestTypes.length && !d.requestTypes.includes(request.requestType)) continue;
    if (d.toUserId === request.requesterId) continue;
    if (!tasks.some((t) => t.assigneeId === d.toUserId)) tasks.push({ assigneeId: d.toUserId, viaDelegationFromId: d.fromUserId });
  }
  await tx.approvalTask.createMany({ data: tasks.map((t) => ({ requestId: request.id, stepOrder, ...t })) });
  await notify(
    tasks.map((t) => t.assigneeId),
    { type: 'APPROVAL_PENDING', title: `Approval needed: ${request.title}`, body: 'A request is waiting for your decision.', link: `/approvals/${request.id}` },
    tx,
  );
}

async function finalize(tx: Tx, requestId: string, status: 'APPROVED' | 'REJECTED' | 'CANCELLED', actorId: string | null) {
  const request = await tx.approvalRequest.update({
    where: { id: requestId },
    data: { status, completedAt: new Date() },
  });
  await tx.approvalTask.updateMany({ where: { requestId, status: 'OPEN' }, data: { status: 'SUPERSEDED' } });
  const h = handlerFor(request.requestType);
  if (status === 'APPROVED') await h.onApproved(tx, request, actorId);
  else if (status === 'REJECTED') await h.onRejected(tx, request, actorId);
  else await (h.onCancelled ?? h.onRejected)(tx, request, actorId);

  if (actorId !== request.requesterId) {
    await notify(
      [request.requesterId],
      {
        type: 'APPROVAL_DECIDED',
        title: `${request.title}: ${status.toLowerCase()}`,
        body: `Your request was ${status.toLowerCase()}.`,
        link: h.link?.(request) ?? `/approvals/${request.id}`,
      },
      tx,
    );
  }
  return request;
}

export async function decide(requestId: string, actorId: string, decision: 'APPROVED' | 'REJECTED', comment?: string) {
  if (decision === 'REJECTED' && !comment?.trim()) throw badRequest('A comment is required when rejecting');
  return prisma.$transaction(async (tx) => {
    // Lock the request row so two approvers cannot decide the same step concurrently.
    await tx.$queryRaw`SELECT id FROM "ApprovalRequest" WHERE id = ${requestId} FOR UPDATE`;
    const request = await tx.approvalRequest.findUnique({ where: { id: requestId } });
    if (!request) throw notFound('Approval request');
    if (request.status !== 'PENDING') throw badRequest(`This request is already ${request.status.toLowerCase()}`);
    const task = await tx.approvalTask.findFirst({
      where: { requestId, stepOrder: request.currentStep, assigneeId: actorId, status: 'OPEN' },
    });
    if (!task) throw forbidden('You are not an approver for the current step of this request');

    await tx.approvalTask.update({ where: { id: task.id }, data: { status: 'DONE' } });
    await tx.approvalTask.updateMany({ where: { requestId, stepOrder: request.currentStep, status: 'OPEN' }, data: { status: 'SUPERSEDED' } });
    await tx.approvalAction.create({
      data: {
        requestId,
        stepOrder: request.currentStep,
        actorId,
        decision,
        comment: task.viaDelegationFromId ? `[on behalf via delegation] ${comment ?? ''}`.trim() : comment,
      },
    });
    await audit({ userId: actorId, action: decision === 'APPROVED' ? 'APPROVE' : 'REJECT', entity: request.requestType, entityId: request.entityId, after: { requestId, step: request.currentStep, comment } }, tx);

    if (decision === 'REJECTED') return finalize(tx, requestId, 'REJECTED', actorId);
    return advance(tx, requestId, request.currentStep + 1, actorId);
  });
}

/**
 * HR/admin override: decides the current step of any pending request without being an assignee.
 * A comment is mandatory; the decision is recorded as OVERRIDE_APPROVE / OVERRIDE_REJECT in the request
 * history and the audit log. Later steps (e.g. Finance for payroll) still apply after an approval.
 */
export async function overrideDecision(requestId: string, actorId: string, decision: 'APPROVED' | 'REJECTED', comment: string) {
  if (!comment?.trim()) throw badRequest('A comment is required for an override');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ApprovalRequest" WHERE id = ${requestId} FOR UPDATE`;
    const request = await tx.approvalRequest.findUnique({ where: { id: requestId } });
    if (!request) throw notFound('Approval request');
    if (request.status !== 'PENDING') throw badRequest(`This request is already ${request.status.toLowerCase()}`);
    if (request.requesterId === actorId) throw forbidden('You cannot override a decision on your own request');
    const action = decision === 'APPROVED' ? 'OVERRIDE_APPROVE' : 'OVERRIDE_REJECT';
    await tx.approvalTask.updateMany({ where: { requestId, stepOrder: request.currentStep, status: 'OPEN' }, data: { status: 'SUPERSEDED' } });
    await tx.approvalAction.create({ data: { requestId, stepOrder: request.currentStep, actorId, decision: action, comment: comment.trim() } });
    await audit({ userId: actorId, action, entity: request.requestType, entityId: request.entityId, after: { requestId, step: request.currentStep, comment: comment.trim() } }, tx);
    if (decision === 'REJECTED') return finalize(tx, requestId, 'REJECTED', actorId);
    return advance(tx, requestId, request.currentStep + 1, actorId);
  });
}

/** Cancels a pending request; only its requester (or the caller passing force for admin flows) may do so. */
export async function cancelRequest(tx: Tx, requestType: RequestType, entityId: string, actorId: string, opts: { force?: boolean; comment?: string } = {}) {
  const request = await tx.approvalRequest.findUnique({ where: { requestType_entityId: { requestType, entityId } } });
  if (!request) return null;
  if (request.status !== 'PENDING') throw badRequest(`This request is already ${request.status.toLowerCase()}`);
  if (!opts.force && request.requesterId !== actorId) throw forbidden('Only the requester can cancel this request');
  await tx.approvalAction.create({ data: { requestId: request.id, stepOrder: request.currentStep, actorId, decision: 'CANCELLED', comment: opts.comment } });
  return finalize(tx, request.id, 'CANCELLED', actorId);
}

// ── Approver resolution ──

async function userOfEmployee(tx: Tx, employeeId: string | null | undefined) {
  if (!employeeId) return [];
  const u = await tx.user.findFirst({ where: { employeeId, isActive: true }, select: { id: true } });
  return u ? [u.id] : [];
}

async function usersWithRoles(tx: Tx, roleCodes: string[], companyId: string) {
  const rows = await tx.userRole.findMany({
    where: { role: { code: { in: roleCodes } }, user: { isActive: true }, OR: [{ companyId: null }, { companyId }] },
    select: { userId: true },
  });
  return [...new Set(rows.map((r) => r.userId))];
}

export async function resolveApprovers(
  tx: Tx,
  type: ApproverType,
  request: Pick<ApprovalRequestRow, 'employeeId' | 'companyId'>,
  roleCode?: string | null,
  userId?: string | null,
): Promise<string[]> {
  const employee = request.employeeId
    ? await tx.employee.findUnique({
        where: { id: request.employeeId },
        select: {
          id: true,
          managerId: true,
          manager: { select: { managerId: true } },
          department: { select: { managerId: true, parent: { select: { managerId: true } } } },
          branch: { select: { managerId: true } },
        },
      })
    : null;

  switch (type) {
    case 'DIRECT_MANAGER':
      return userOfEmployee(tx, employee?.managerId);
    case 'MANAGERS_MANAGER':
      return userOfEmployee(tx, employee?.manager?.managerId);
    case 'DEPARTMENT_MANAGER': {
      let mgr = employee?.department?.managerId;
      if (mgr === employee?.id) mgr = employee?.department?.parent?.managerId ?? employee?.managerId;
      return userOfEmployee(tx, mgr);
    }
    case 'BRANCH_MANAGER': {
      const mgr = employee?.branch?.managerId;
      return userOfEmployee(tx, mgr === employee?.id ? employee?.managerId : mgr);
    }
    case 'ROLE':
      return roleCode ? usersWithRoles(tx, [roleCode], request.companyId) : [];
    case 'USER':
      return userId ? [userId] : [];
    default:
      return [];
  }
}

/** Company business calendar for SLA timers: working days and company-wide public holidays. */
async function businessCalendar(companyId: string): Promise<BusinessCalendar> {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { timezone: true, weekendDays: true } });
  const holidays = await prisma.holiday.findMany({ where: { companyId, branchId: null }, select: { date: true } });
  return { timeZone: company.timezone, weekendDays: company.weekendDays, holidays: new Set(holidays.map((h) => h.date.toISOString().slice(0, 10))) };
}

/** When a step's escalation is due: its threshold counted in business hours from when the step started. */
export async function escalationDueAt(companyId: string, stepEnteredAt: Date, hours: number) {
  return addBusinessHours(stepEnteredAt, hours, await businessCalendar(companyId));
}

/**
 * Escalates steps that waited longer than their threshold (business hours only). The escalation approvers
 * (manager's manager, a role or a user) are added to the step alongside the original approvers, notified,
 * and named in the request history. If the target resolves to nobody, the company's fallback approver is used.
 */
export async function processEscalations(now = new Date()) {
  const pending = await prisma.approvalRequest.findMany({
    where: { status: 'PENDING', definitionId: { not: null } },
    include: { definition: { include: { steps: true } }, actions: { where: { decision: 'ESCALATED' } } },
  });
  const calendars = new Map<string, BusinessCalendar>();
  let escalated = 0;
  for (const req of pending) {
    const step = req.definition?.steps.find((s) => s.order === req.currentStep);
    if (!step?.escalateAfterHours || !step.escalateToType) continue;
    if (req.actions.some((a) => a.stepOrder === req.currentStep)) continue;
    if (!calendars.has(req.companyId)) calendars.set(req.companyId, await businessCalendar(req.companyId));
    if (addBusinessHours(req.stepEnteredAt, step.escalateAfterHours, calendars.get(req.companyId)!) > now) continue;
    await prisma.$transaction(async (tx) => {
      let ids = (await resolveApprovers(tx, step.escalateToType as ApproverType, req, step.escalateToRoleCode, step.escalateToUserId)).filter((id) => id !== req.requesterId);
      let via = '';
      if (!ids.length) {
        const fallback = await fallbackApprovers(tx, req.companyId, req.requesterId);
        ids = fallback.ids;
        via = ' (escalation target not found; used the fallback approver)';
      }
      const existing = await tx.approvalTask.findMany({ where: { requestId: req.id, stepOrder: req.currentStep }, select: { assigneeId: true } });
      const fresh = ids.filter((id) => !existing.some((e) => e.assigneeId === id));
      if (fresh.length) {
        await tx.approvalTask.createMany({ data: fresh.map((assigneeId) => ({ requestId: req.id, stepOrder: req.currentStep, assigneeId })) });
      }
      const names = fresh.length ? await displayNames(tx, fresh) : 'no new approver (already assigned)';
      await tx.approvalAction.create({
        data: { requestId: req.id, stepOrder: req.currentStep, decision: 'ESCALATED', comment: `No decision after ${step.escalateAfterHours} business hours; escalated to ${names}${via}` },
      });
      await notify(fresh, { type: 'APPROVAL_ESCALATED', title: `Escalated: ${req.title}`, body: 'This request has been escalated to you.', link: `/approvals/${req.id}` }, tx);
    });
    escalated++;
  }
  return escalated;
}

/** Reminds approvers of tasks open longer than a day. */
export async function remindPendingApprovals() {
  const dayAgo = new Date(Date.now() - 86_400_000);
  const tasks = await prisma.approvalTask.findMany({
    where: { status: 'OPEN', createdAt: { lt: dayAgo }, request: { status: 'PENDING' } },
    select: { assigneeId: true },
  });
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.assigneeId, (counts.get(t.assigneeId) ?? 0) + 1);
  for (const [userId, n] of counts) {
    await notify([userId], { type: 'APPROVAL_PENDING', title: `You have ${n} pending approval${n > 1 ? 's' : ''}`, link: '/approvals' });
  }
  return counts.size;
}
