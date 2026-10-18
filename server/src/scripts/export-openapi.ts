import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../app';
import { buildOpenApiDocument } from '../lib/openapi';

createApp(); // registers every route in the OpenAPI registry
const out = path.resolve(process.cwd(), '../docs/openapi.json');
fs.writeFileSync(out, JSON.stringify(buildOpenApiDocument(), null, 2));
console.log(`Wrote ${out}`);
process.exit(0);
