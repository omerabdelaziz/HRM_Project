import crypto from 'node:crypto';
import { env } from '../config/env';

const key = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must decode to exactly 32 bytes');
const hashKey = Buffer.from(env.DATA_HASH_KEY, 'base64');

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encrypt(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decrypt(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const buf = Buffer.from(payload, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/** Deterministic keyed hash, used to detect duplicates of encrypted values. */
export function keyedHash(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/[\s-]/g, '').toUpperCase();
  return crypto.createHmac('sha256', hashKey).update(normalized).digest('hex');
}

export function sha256(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Shows only the last 4 characters, e.g. "•••• 1234". */
export function mask(value: string | null | undefined) {
  if (!value) return null;
  return `•••• ${value.slice(-4)}`;
}
