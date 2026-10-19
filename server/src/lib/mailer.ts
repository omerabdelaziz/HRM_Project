import nodemailer from 'nodemailer';
import { env, isTest } from '../config/env';
import { logger } from './logger';
import { emailHtml } from './brand';

const transport = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : null;

export interface Mail {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer }[];
}

export async function sendMail(mail: Mail) {
  if (isTest) return;
  if (!transport) {
    logger.debug({ to: mail.to, subject: mail.subject }, 'Email (SMTP not configured, not sent)');
    return;
  }
  try {
    await transport.sendMail({ from: env.MAIL_FROM, ...mail });
  } catch (err) {
    logger.error({ err, to: mail.to, subject: mail.subject }, 'Failed to send email');
  }
}

/** Tells the account owner about a security change, so a takeover does not go unnoticed. */
export async function notifySecurityChange(email: string, what: string, ip: string | null) {
  const body = `${what} on your Aziz HRM account${ip ? ` from IP ${ip}` : ''} at ${new Date().toUTCString()}.\nIf this was not you, contact your administrator immediately.`;
  await sendMail({ to: email, subject: `Aziz HRM security notice: ${what}`, text: body, html: emailHtml(`Security notice: ${what}`, body) });
}
