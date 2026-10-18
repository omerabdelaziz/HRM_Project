import type { Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { createRouter } from '../../lib/http';
import { prisma } from '../../lib/prisma';
import { env, isProd } from '../../config/env';
import { decrypt, encrypt, randomToken, sha256 } from '../../lib/crypto';
import { badRequest, unauthorized } from '../../lib/errors';
import { signAccessToken } from '../../middleware/auth';
import { audit, ipOf } from '../../lib/audit';
import { hashPassword, passwordSchema } from '../../auth/passwords';

const r = createRouter('/api/auth', 'Authentication');
export default r;

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const REFRESH_COOKIE = 'hrms_rt';

function setRefreshCookie(res: Response, value: string) {
  res.cookie(REFRESH_COOKIE, value, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}

async function startSession(res: Response, userId: string, ip: string | null, userAgent?: string) {
  const token = randomToken();
  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      ip,
      userAgent: userAgent?.slice(0, 300),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    },
  });
  setRefreshCookie(res, `${session.id}.${token}`);
  return { accessToken: signAccessToken({ sub: userId, sid: session.id }), sessionId: session.id };
}

r.post(
  '/login',
  {
    summary: 'Sign in with email and password (and MFA code when enabled)',
    public: true,
    body: z.object({
      email: z.string().email().toLowerCase(),
      password: z.string().min(1),
      mfaCode: z.string().regex(/^\d{6}$/).optional(),
    }),
  },
  async ({ req, res, body }) => {
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    const ip = ipOf(req);
    const fail = async (reason: string) => {
      await audit({ userId: user?.id, action: 'LOGIN_FAILED', entity: 'User', entityId: user?.id, after: { reason, email: body.email }, ip });
      throw unauthorized('Invalid email or password');
    };
    if (!user || !user.isActive) return fail('unknown or inactive');
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw unauthorized(`Account locked after repeated failed sign-ins. Try again after ${user.lockedUntil.toISOString()}`);
    }
    const ok = await bcrypt.compare(body.password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: failed >= MAX_FAILED ? 0 : failed,
          lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        },
      });
      return fail('bad password');
    }
    if (user.mfaEnabled) {
      if (!body.mfaCode) return { mfaRequired: true };
      const secret = decrypt(user.mfaSecretEnc);
      if (!secret || !authenticator.check(body.mfaCode, secret)) return fail('bad mfa code');
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    const { accessToken } = await startSession(res, user.id, ip, req.headers['user-agent']);
    await audit({ userId: user.id, action: 'LOGIN', entity: 'User', entityId: user.id, ip });
    return { accessToken, mustChangePassword: user.mustChangePassword };
  },
);

r.post('/refresh', { summary: 'Exchange the refresh cookie for a new access token', public: true }, async ({ req, res }) => {
  const raw: string | undefined = req.cookies?.[REFRESH_COOKIE];
  if (!raw || !raw.includes('.')) throw unauthorized('No session');
  const [sid, token] = raw.split('.', 2);
  const session = await prisma.session.findUnique({ where: { id: sid }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt < new Date() || !session.user.isActive) {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    throw unauthorized('Session has ended');
  }
  if (session.tokenHash !== sha256(token)) {
    // A rotated-out token was replayed: assume theft and end the session.
    await prisma.session.update({ where: { id: sid }, data: { revokedAt: new Date() } });
    await audit({ userId: session.userId, action: 'SESSION_REUSE_DETECTED', entity: 'Session', entityId: sid, ip: ipOf(req) });
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    throw unauthorized('Session has ended');
  }
  const next = randomToken();
  await prisma.session.update({ where: { id: sid }, data: { tokenHash: sha256(next), lastUsedAt: new Date() } });
  setRefreshCookie(res, `${sid}.${next}`);
  return { accessToken: signAccessToken({ sub: session.userId, sid }) };
});

r.post('/logout', { summary: 'End the current session' }, async ({ res, user }) => {
  await prisma.session.update({ where: { id: user.sessionId }, data: { revokedAt: new Date() } });
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
});

r.get('/me', { summary: 'Current user, roles, permissions and employee summary' }, async ({ user }) => {
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: {
      id: true, email: true, displayName: true, locale: true, theme: true, mfaEnabled: true, mustChangePassword: true,
      employee: {
        select: {
          id: true, employeeNo: true, firstName: true, lastName: true, firstNameAr: true, lastNameAr: true, photoPath: true,
          companyId: true, company: { select: { name: true, nameAr: true, baseCurrency: true, timezone: true, dateFormat: true, locale: true } },
          department: { select: { name: true, nameAr: true } }, position: { select: { title: true, titleAr: true } },
          _count: { select: { reports: true } },
        },
      },
    },
  });
  return { ...u, roles: user.roles, permissions: [...user.permissions], scope: user.scope };
});

r.patch(
  '/preferences',
  {
    summary: 'Update language and theme preferences',
    body: z.object({ locale: z.enum(['en', 'ar']).optional(), theme: z.enum(['light', 'dark', 'system']).optional() }),
  },
  async ({ user, body }) => prisma.user.update({ where: { id: user.id }, data: body, select: { locale: true, theme: true } }),
);

r.post(
  '/change-password',
  {
    summary: 'Change own password (ends all other sessions)',
    body: z.object({ currentPassword: z.string(), newPassword: passwordSchema }),
  },
  async ({ req, user, body }) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await bcrypt.compare(body.currentPassword, u.passwordHash))) throw badRequest('Current password is incorrect');
    if (body.currentPassword === body.newPassword) throw badRequest('New password must differ from the current one');
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date(), mustChangePassword: false },
      }),
      prisma.session.updateMany({ where: { userId: user.id, id: { not: user.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await audit({ userId: user.id, action: 'PASSWORD_CHANGED', entity: 'User', entityId: user.id, ip: ipOf(req) });
  },
);

r.post('/mfa/setup', { summary: 'Start MFA enrollment: returns a TOTP secret and QR code' }, async ({ user }) => {
  const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { mfaEnabled: true } });
  if (current.mfaEnabled) throw badRequest('MFA is already enabled. Disable it first to enroll a new device.');
  const secret = authenticator.generateSecret();
  await prisma.user.update({ where: { id: user.id }, data: { mfaSecretEnc: encrypt(secret) } });
  const otpauth = authenticator.keyuri(user.email, 'Aziz HRM', secret);
  return { secret, otpauth, qrDataUrl: await QRCode.toDataURL(otpauth) };
});

r.post(
  '/mfa/enable',
  { summary: 'Confirm MFA enrollment with a code from the authenticator app', body: z.object({ code: z.string().regex(/^\d{6}$/) }) },
  async ({ req, user, body }) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const secret = decrypt(u.mfaSecretEnc);
    if (!secret) throw badRequest('Start MFA setup first');
    if (!authenticator.check(body.code, secret)) throw badRequest('The code is not valid. Check your device time and try again.');
    await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: true } });
    await audit({ userId: user.id, action: 'MFA_ENABLED', entity: 'User', entityId: user.id, ip: ipOf(req) });
  },
);

r.post(
  '/mfa/disable',
  { summary: 'Disable MFA (requires password)', body: z.object({ password: z.string() }) },
  async ({ req, user, body }) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await bcrypt.compare(body.password, u.passwordHash))) throw badRequest('Password is incorrect');
    await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecretEnc: null } });
    await audit({ userId: user.id, action: 'MFA_DISABLED', entity: 'User', entityId: user.id, ip: ipOf(req) });
  },
);

r.get('/sessions', { summary: 'List own active sessions' }, async ({ user }) => {
  const sessions = await prisma.session.findMany({
    where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, ip: true, userAgent: true, createdAt: true, lastUsedAt: true },
    orderBy: { lastUsedAt: 'desc' },
  });
  return sessions.map((s) => ({ ...s, current: s.id === user.sessionId }));
});

r.delete('/sessions/:id', { summary: 'Sign out one of own sessions', params: z.object({ id: z.string().uuid() }) }, async ({ user, params }) => {
  await prisma.session.updateMany({ where: { id: params.id, userId: user.id }, data: { revokedAt: new Date() } });
});
