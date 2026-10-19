import type { Request } from 'express';
import { Db, prisma, Prisma } from './prisma';
import { requestContext } from './request-context';

interface AuditEntry {
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

const SECRET_KEYS = new Set(['passwordHash', 'tokenHash', 'mfaSecretEnc', 'deviceApiKeyHash']);

/**
 * Removes secrets from an audit payload: every `*Hash` field is dropped (keyed hashes of IDs can be
 * brute-forced) and every `*Enc` field is replaced by its plain name with a "[protected]" marker, so the
 * trail still shows *that* a national ID or bank detail changed without exposing it. Applied when entries
 * are written and again when they are read (older rows).
 */
export function sanitizeAuditPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAuditPayload);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k) || /Hash$/.test(k)) continue;
    if (/Enc$/.test(k)) {
      if (v !== null && v !== undefined) out[k.replace(/Enc$/, '')] = '[protected]';
      continue;
    }
    out[k] = sanitizeAuditPayload(v);
  }
  return out;
}

function scrub(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return sanitizeAuditPayload(JSON.parse(JSON.stringify(value))) as Prisma.InputJsonValue;
}

export async function audit(entry: AuditEntry, db: Db = prisma) {
  const ctx = requestContext();
  await db.auditLog.create({
    data: {
      userId: entry.userId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      before: scrub(entry.before),
      after: scrub(entry.after),
      // Every entry records where it came from, even when the caller did not pass the request.
      ip: entry.ip ?? ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
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
