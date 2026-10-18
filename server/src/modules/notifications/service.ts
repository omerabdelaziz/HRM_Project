import { prisma, Db } from '../../lib/prisma';
import { sendMail } from '../../lib/mailer';
import { env } from '../../config/env';
import { emailHtml } from '../../lib/brand';

export const NOTIFICATION_TYPES = [
  'APPROVAL_PENDING',
  'APPROVAL_DECIDED',
  'APPROVAL_ESCALATED',
  'LEAVE',
  'ATTENDANCE',
  'PAYROLL',
  'DOCUMENT_EXPIRY',
  'CONTRACT_EXPIRY',
  'ANNOUNCEMENT',
  'SYSTEM',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

interface NotifyInput {
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
}

/** Creates in-app notifications and sends emails, honoring each user's preferences. */
export async function notify(userIds: string[], input: NotifyInput, db: Db = prisma) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  const [prefs, users] = await Promise.all([
    db.notificationPreference.findMany({ where: { userId: { in: ids }, type: input.type } }),
    db.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true, email: true } }),
  ]);
  const prefOf = (id: string) => prefs.find((p) => p.userId === id) ?? { inApp: true, email: true };

  const inApp = users.filter((u) => prefOf(u.id).inApp);
  if (inApp.length) {
    await db.notification.createMany({
      data: inApp.map((u) => ({ userId: u.id, type: input.type, title: input.title, body: input.body, link: input.link })),
    });
  }
  const emailTo = users.filter((u) => prefOf(u.id).email).map((u) => u.email);
  if (emailTo.length) {
    const url = input.link ? `${env.CLIENT_ORIGIN}${input.link}` : env.CLIENT_ORIGIN;
    // Fire and forget: email delivery must never block or roll back business transactions.
    void Promise.all(
      emailTo.map((to) =>
        sendMail({ to, subject: input.title, text: `${input.body ?? input.title}\n\nOpen in Aziz HRM: ${url}`, html: emailHtml(input.title, input.body ?? '', url) }),
      ),
    );
  }
}

export async function userIdsWithRole(roleCodes: string[], companyId?: string) {
  const rows = await prisma.userRole.findMany({
    where: {
      role: { code: { in: roleCodes } },
      user: { isActive: true },
      ...(companyId ? { OR: [{ companyId: null }, { companyId }] } : {}),
    },
    select: { userId: true },
  });
  return [...new Set(rows.map((r) => r.userId))];
}
