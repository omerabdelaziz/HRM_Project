import { Router, type Request, type Response, type RequestHandler } from 'express';
import { z, ZodTypeAny } from 'zod';
import { registry } from './openapi';
import { authenticate, requirePermission } from '../middleware/auth';
import { PermissionCode } from '../auth/permissions';
import { AuthUser } from '../auth/context';
import { unauthorized } from './errors';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface RouteDef<B extends ZodTypeAny, Q extends ZodTypeAny, P extends ZodTypeAny> {
  summary: string;
  description?: string;
  /** Any one of these permissions grants access. */
  permission?: PermissionCode | PermissionCode[];
  /** Public routes skip authentication. */
  public?: boolean;
  body?: B;
  query?: Q;
  params?: P;
  status?: number;
  /** Extra middleware such as multer, run after auth. */
  middleware?: RequestHandler[];
  /** Response is a file/stream; handler writes to res itself. */
  raw?: boolean;
}

export interface Ctx<B, Q, P> {
  req: Request;
  res: Response;
  user: AuthUser;
  body: B;
  query: Q;
  params: P;
}

const asyncWrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) =>
    fn(req, res).catch(next);

/**
 * A router whose routes are declared once and both registered with Express and documented in OpenAPI.
 * Request body/query/params are validated with zod before the handler runs.
 */
export function createRouter(basePath: string, tag: string) {
  const router = Router();

  function add(method: Method) {
    return <B extends ZodTypeAny = z.ZodAny, Q extends ZodTypeAny = z.ZodAny, P extends ZodTypeAny = z.ZodAny>(
      path: string,
      def: RouteDef<B, Q, P>,
      handler: (ctx: Ctx<z.infer<B>, z.infer<Q>, z.infer<P>>) => Promise<unknown> | unknown,
    ) => {
      const chain: RequestHandler[] = [];
      if (!def.public) chain.push(authenticate);
      if (def.permission) {
        const perms = Array.isArray(def.permission) ? def.permission : [def.permission];
        chain.push(requirePermission(...perms));
      }
      if (def.middleware) chain.push(...def.middleware);
      chain.push(
        asyncWrap(async (req, res) => {
          if (!def.public && !req.user) throw unauthorized();
          const body = def.body ? def.body.parse(req.body ?? {}) : req.body;
          const query = def.query ? def.query.parse(req.query) : req.query;
          const params = def.params ? def.params.parse(req.params) : req.params;
          const result = await handler({ req, res, user: req.user as AuthUser, body, query, params });
          if (res.headersSent || def.raw) return;
          if (result === undefined) res.status(def.status ?? 204).end();
          else res.status(def.status ?? 200).json(result);
        }),
      );
      router[method](path, ...chain);

      const fullPath = (basePath + path).replace(/\/$/, '').replace(/:(\w+)/g, '{$1}');
      const paramNames = [...(basePath + path).matchAll(/:(\w+)/g)].map((m) => m[1]);
      const permText = def.permission
        ? `\n\nRequires permission: ${(Array.isArray(def.permission) ? def.permission : [def.permission]).join(' or ')}`
        : '';
      registry.registerPath({
        method,
        path: fullPath,
        tags: [tag],
        summary: def.summary,
        description: (def.description ?? '') + permText,
        security: def.public ? [] : [{ bearerAuth: [] }],
        request: {
          params:
            (def.params as unknown as z.AnyZodObject) ??
            (paramNames.length ? z.object(Object.fromEntries(paramNames.map((n) => [n, z.string()]))) : undefined),
          query: def.query instanceof z.ZodObject ? def.query : undefined,
          body: def.body ? { content: { 'application/json': { schema: def.body } } } : undefined,
        },
        responses: {
          [def.status ?? 200]: { description: 'Success' },
          400: { description: 'Validation error' },
          401: { description: 'Not authenticated' },
          403: { description: 'Missing permission' },
        },
      });
    };
  }

  return {
    router,
    basePath,
    get: add('get'),
    post: add('post'),
    put: add('put'),
    patch: add('patch'),
    delete: add('delete'),
  };
}

// ── Common schemas ──

export const idParam = z.object({ id: z.string().uuid() });
export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const optionalId = z.string().uuid().nullish();

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
  sort: z.string().optional(),
  search: z.string().trim().optional(),
});

export function paging(q: { page: number; pageSize: number }) {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

/** Parses "field:asc|desc" against a whitelist into a Prisma orderBy. */
export function sortBy(sort: string | undefined, allowed: string[], fallback: Record<string, 'asc' | 'desc'>) {
  if (!sort) return fallback;
  const [field, dir] = sort.split(':');
  if (!allowed.includes(field)) return fallback;
  const direction = dir === 'desc' ? 'desc' : 'asc';
  // Support one level of nesting, e.g. department.name
  const parts = field.split('.');
  return parts.length === 2 ? { [parts[0]]: { [parts[1]]: direction } } : { [field]: direction };
}

export function paged<T>(items: T[], total: number, q: { page: number; pageSize: number }) {
  return { items, total, page: q.page, pageSize: q.pageSize, pageCount: Math.ceil(total / q.pageSize) };
}
