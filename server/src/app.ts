import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import path from 'node:path';
import fs from 'node:fs';
import { env, isProd, isTest, policy } from './config/env';
import { logger } from './lib/logger';
import { buildOpenApiDocument } from './lib/openapi';
import { errorHandler, notFoundHandler } from './middleware/error';

import authRoutes from './modules/auth/routes';
import orgRoutes from './modules/org/routes';
import employeeRoutes from './modules/employees/routes';
import attendanceRoutes, { shiftRouter } from './modules/attendance/routes';
import leaveRoutes from './modules/leave/routes';
import approvalRoutes, { workflowRouter } from './modules/workflow/routes';
import payrollRoutes from './modules/payroll/routes';
import dashboardRoutes from './modules/dashboard/routes';
import reportRoutes, { savedReportsRouter } from './modules/reports/routes';
import notificationRoutes, { announcementsRouter } from './modules/notifications/routes';
import { auditRouter, rolesRouter, usersRouter } from './modules/admin/routes';
import systemRoutes from './modules/system/routes';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(isProd ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    next();
  });
  app.use(cors({ origin: env.CLIENT_ORIGIN.split(','), credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  if (!isTest) {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/system/health' } }));
  }
  // API responses hold personal data: keep them out of shared and browser caches (routes may override).
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const limiter = (windowMin: number, limit: number, message: string, skip?: (req: express.Request) => boolean) =>
    rateLimit({
      windowMs: windowMin * 60_000, limit, standardHeaders: 'draft-7', legacyHeaders: false,
      skip: (req) => isTest || (skip?.(req) ?? false),
      message: { error: { code: 'RATE_LIMITED', message } },
    });
  app.use('/api', limiter(1, 600, 'Too many requests. Try again shortly.'));
  app.use('/api/auth/login', limiter(15, 30, 'Too many sign-in attempts. Try again later.'));
  app.use('/api/auth/refresh', limiter(15, 120, 'Too many requests. Try again later.'));
  app.use(['/api/auth/mfa', '/api/auth/change-password'], limiter(15, 10, 'Too many attempts. Try again later.', (req) => req.method === 'GET'));
  const exportLimiter = limiter(1, 30, 'Too many exports. Try again shortly.');
  app.get(['/api/employees/export', '/api/reports/:key', '/api/payroll/runs/:id/register', '/api/payroll/runs/:id/bank-file'], exportLimiter);
  app.post('/api/employees/import', exportLimiter);
  app.use('/api', limiter(15, 60, 'Too many uploads. Try again later.', (req) => !req.is('multipart/form-data')));

  for (const r of [
    authRoutes, orgRoutes, employeeRoutes, attendanceRoutes, shiftRouter, leaveRoutes, approvalRoutes, workflowRouter,
    payrollRoutes, dashboardRoutes, reportRoutes, savedReportsRouter, notificationRoutes, announcementsRouter,
    usersRouter, rolesRouter, auditRouter, systemRoutes,
  ]) {
    app.use(r.basePath, r.router);
  }

  if (policy.apiDocs) {
    const openapi = buildOpenApiDocument();
    app.get('/api/openapi.json', (_req, res) => res.json(openapi));
    // Swagger UI ships inline styles, so it gets its own, slightly looser policy.
    const docsCsp: express.RequestHandler = (_req, res, next) => {
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
      next();
    };
    app.use('/api/docs', docsCsp, swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'Aziz HRM API' }));
  }
  app.use('/api', notFoundHandler);

  // In production the API also serves the built front end.
  const clientDist = path.resolve(process.cwd(), '../client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
