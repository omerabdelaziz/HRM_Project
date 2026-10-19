import type { Request } from 'express';
import { Db, prisma, Prisma } from './prisma';

interface AuditEntry {
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

const SENSITIVE_KEYS = ['passwordHash', 'mfaSecretEnc', 'bankAccountEnc', 'ibanEnc', 'nationalIdEnc', 'tokenHash'];

function scrub(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(
    JSON.stringify(value, (k, v) => (SENSITIVE_KEYS.includes(k) ? (v ? '[encrypted]' : v) : v)),
  ) as Prisma.InputJsonValue;
}

export async function audit(entry: AuditEntry, db: Db = prisma) {
  await db.auditLog.create({
    data: {
      userId: entry.userId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      before: scrub(entry.before),
      after: scrub(entry.after),
      ip: entry.ip ?? null,
    },
  });
}

/** Only the fields that changed, for compact UPDATE entries. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    const bv = before[key];
    const av = after[key];
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      b[key] = bv;
      a[key] = av;
    }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}

/** Client IP as resolved by Express from the trusted proxy hop ('trust proxy'); the raw X-Forwarded-For header can be forged. */
export const ipOf = (req: Request) => req.ip ?? null;
