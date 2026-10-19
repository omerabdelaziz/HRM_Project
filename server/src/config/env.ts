import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4100),
  DATABASE_URL: z.string().min(1),
  CLIENT_ORIGIN: z.string().default('http://localhost:5310'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),
  /** A session with no API activity for this long must sign in again. */
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).default(120),
  /** Users holding administrative permissions must enrol MFA before using the app. Defaults to on in production. */
  MFA_REQUIRED_FOR_ADMINS: z.enum(['true', 'false']).optional(),
  /** Serve Swagger UI and openapi.json. Defaults to off in production. */
  ENABLE_API_DOCS: z.enum(['true', 'false']).optional(),
  DATA_ENCRYPTION_KEY: z.string().min(1, 'DATA_ENCRYPTION_KEY is required (32 bytes, base64)'),
  DATA_HASH_KEY: z.string().min(1, 'DATA_HASH_KEY is required'),
  STORAGE_DIR: z.string().default('./storage'),
  BACKUP_DIR: z.string().default('./backups'),
  BACKUP_RETENTION_DAYS: z.coerce.number().default(14),
  AUDIT_RETENTION_DAYS: z.coerce.number().default(2555),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  MAIL_FROM: z.string().default('Aziz HRM <no-reply@example.com>'),
  ENABLE_SCHEDULER: bool,
  PG_BIN_DIR: z.string().optional().default(''),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Mutable so tests can switch policies on. */
export const policy = {
  mfaRequiredForAdmins: env.MFA_REQUIRED_FOR_ADMINS ? env.MFA_REQUIRED_FOR_ADMINS === 'true' : isProd,
  apiDocs: env.ENABLE_API_DOCS ? env.ENABLE_API_DOCS === 'true' : !isProd,
};
