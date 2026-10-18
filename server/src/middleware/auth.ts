import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { forbidden, unauthorized } from '../lib/errors';
import { AuthUser, hasPermission, loadAuthUser } from '../auth/context';
import { PermissionCode } from '../auth/permissions';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  mfa?: boolean;
}

export function signAccessToken(payload: AccessTokenPayload) {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: `${env.ACCESS_TOKEN_TTL_MIN}m`, issuer: 'hrms' });
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw unauthorized();
    let payload: AccessTokenPayload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET, { issuer: 'hrms' }) as AccessTokenPayload;
    } catch {
      throw unauthorized('Session expired or invalid token');
    }
    const session = await prisma.session.findUnique({ where: { id: payload.sid } });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.userId !== payload.sub) {
      throw unauthorized('Session has ended');
    }
    const user = await loadAuthUser(payload.sub, payload.sid);
    if (!user) throw unauthorized('Account disabled');
    const preferred = req.headers['x-company-id'];
    if (typeof preferred === 'string' && /^[0-9a-f-]{36}$/i.test(preferred)) user.preferredCompanyId = preferred;
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

export function requirePermission(...codes: PermissionCode[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!hasPermission(req.user, ...codes)) return next(forbidden());
    next();
  };
}
