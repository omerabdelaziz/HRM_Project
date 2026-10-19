import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { AppError, forbidden, unauthorized } from '../lib/errors';
import { AuthUser, hasPermission, loadAuthUser, mfaSetupRequired } from '../auth/context';
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

const JWT_OPTIONS = { algorithm: 'HS256', issuer: 'hrms', audience: 'hrms-api' } as const;

export function signAccessToken(payload: AccessTokenPayload) {
  return jwt.sign(payload, env.JWT_SECRET, { ...JWT_OPTIONS, expiresIn: `${env.ACCESS_TOKEN_TTL_MIN}m` });
}

/** Routes still usable while an account must change its password or enrol MFA. */
const SETUP_ROUTES = ['/api/auth/me', '/api/auth/logout', '/api/auth/preferences', '/api/auth/change-password'];
const MFA_SETUP_ROUTES = [...SETUP_ROUTES, '/api/auth/mfa/setup', '/api/auth/mfa/enable'];

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw unauthorized();
    let payload: AccessTokenPayload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET, { algorithms: [JWT_OPTIONS.algorithm], issuer: JWT_OPTIONS.issuer, audience: JWT_OPTIONS.audience }) as AccessTokenPayload;
    } catch {
      throw unauthorized('Session expired or invalid token');
    }
    const session = await prisma.session.findUnique({ where: { id: payload.sid } });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.userId !== payload.sub) {
      throw unauthorized('Session has ended');
    }
    const user = await loadAuthUser(payload.sub, payload.sid);
    if (!user) throw unauthorized('Account disabled');
    const path = req.originalUrl.split('?')[0].replace(/\/$/, '');
    if (user.mustChangePassword && !SETUP_ROUTES.includes(path)) {
      throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your temporary password before continuing');
    }
    if (mfaSetupRequired(user) && !MFA_SETUP_ROUTES.includes(path)) {
      throw new AppError(403, 'MFA_SETUP_REQUIRED', 'Set up two-factor authentication before continuing');
    }
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
