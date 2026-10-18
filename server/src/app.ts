import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import path from 'node:path';
import fs from 'node:fs';
import { env, isTest } from './config/env';
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

  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cors({ origin: env.CLIENT_ORIGIN.split(','), credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  if (!isTest) {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/system/health' } }));
  }

  const apiLimiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => isTest });
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => isTest, message: { error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again later.' } } });
  app.use('/api', apiLimiter);
  app.use('/api/auth/login', authLimiter);

  for (const r of [
    authRoutes, orgRoutes, employeeRoutes, attendanceRoutes, shiftRouter, leaveRoutes, approvalRoutes, workflowRouter,
    payrollRoutes, dashboardRoutes, reportRoutes, savedReportsRouter, notificationRoutes, announcementsRouter,
    usersRouter, rolesRouter, auditRouter, systemRoutes,
  ]) {
    app.use(r.basePath, r.router);
  }

  const openapi = buildOpenApiDocument();
  app.get('/api/openapi.json', (_req, res) => res.json(openapi));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'Aziz HRM API' }));
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
