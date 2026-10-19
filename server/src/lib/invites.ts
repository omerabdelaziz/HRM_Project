import { prisma, Tx } from './prisma';
import { randomToken, sha256 } from './crypto';
import { env } from '../config/env';
import { mailPolicy, sendMail } from './mailer';
import { emailHtml } from './brand';
import { hashPassword } from '../auth/passwords';

export const INVITE_TTL_HOURS = 72;

/**
 * Creates a one-time invitation for a user (any earlier unused invitation stops working) and emails the link.
 * Returns null when email is not configured: the caller then falls back to a temporary password.
 */
export async function inviteUser(tx: Tx, user: { id: string; email: string; displayName: string }, createdById: string | null) {
  if (!mailPolicy.configured) return null;
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3_600_000);
  await tx.userInvite.updateMany({ where: { userId: user.id, usedAt: null }, data: { expiresAt: new Date() } });
  await tx.userInvite.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt, createdById } });
  const link = `${env.CLIENT_ORIGIN.split(',')[0]}/accept-invite?token=${encodeURIComponent(token)}`;
  const text = `Hello ${user.displayName},\n\nAn Aziz HRM account has been created for you (${user.email}).\nSet your password with this link: ${link}\n\nThe link expires in ${INVITE_TTL_HOURS} hours and can be used once.`;
  await sendMail({ to: user.email, subject: 'Your Aziz HRM account', text, html: emailHtml('Welcome to Aziz HRM', text) });
  return { expiresAt, token };
}

/** A password nobody knows, for accounts that are activated through an invitation. */
export const unusablePasswordHash = () => hashPassword(randomToken(48));

export async function findValidInvite(token: string) {
  const invite = await prisma.userInvite.findUnique({ where: { tokenHash: sha256(token) }, include: { user: { select: { id: true, email: true, displayName: true, isActive: true } } } });
  if (!invite || invite.usedAt || invite.expiresAt < new Date() || !invite.user.isActive) return null;
  return invite;
}
