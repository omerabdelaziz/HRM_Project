import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';

/** Per-request values available anywhere in the call chain (used by the audit log). */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = () => storage.getStore();

/** Captures the client IP (as resolved through the trusted proxy) and user agent for the request. */
export const requestContextMiddleware: RequestHandler = (req, _res, next) => {
  storage.run({ ip: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 500) ?? null }, next);
};
