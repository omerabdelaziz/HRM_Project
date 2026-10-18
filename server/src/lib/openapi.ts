import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Aziz HRM API',
      version: '0.1.0',
      description:
        'REST API of Aziz HRM, the integrated human resources management system. Authenticate with POST /api/auth/login and send the access token as a Bearer token. Errors use the shape {"error": {"code", "message", "details"}}.',
    },
    servers: [{ url: '/' }],
  });
}
