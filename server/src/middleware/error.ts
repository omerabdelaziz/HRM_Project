import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Some fields are invalid',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const fields = ((err.meta?.target as string[] | undefined) ?? []).filter((f) => !/^(companyId|employeeId|runId|userId)$/.test(f));
      const label = (f: string) => f.replace(/Id$/, '').replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^./, (c) => c.toUpperCase());
      const what = fields.length ? fields.map(label).join(' and ') : 'This value';
      return res.status(409).json({
        error: {
          code: 'DUPLICATE',
          message: `${what} is already in use. Please choose a different value.`,
          details: fields.map((f) => ({ path: f, message: 'Already in use' })),
        },
      });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
    }
    if (err.code === 'P2003') {
      return res.status(409).json({
        error: { code: 'IN_USE', message: 'This record is referenced by other records and cannot be changed this way' },
      });
    }
  }
  // Integrity triggers in the database (see migration "payroll_controls") raise P0001.
  if (err instanceof Prisma.PrismaClientKnownRequestError || err instanceof Prisma.PrismaClientUnknownRequestError) {
    const m = /((?:Payslips?|Payslip lines|Approved payroll|Totals of an approved|A paid payroll|Audit log)[^"\n]*?cannot be [a-z ]+)/.exec(err.message);
    if (m) return res.status(422).json({ error: { code: 'LOCKED', message: m[1] } });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: { code: 'UPLOAD_ERROR', message: err.message } });
  }
  if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  }
  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'An unexpected error occurred' } });
}
