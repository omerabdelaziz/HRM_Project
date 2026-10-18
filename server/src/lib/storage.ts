import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { env } from '../config/env';
import { badRequest } from './errors';

export const storageRoot = path.resolve(env.STORAGE_DIR);
fs.mkdirSync(storageRoot, { recursive: true });

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
]);

/** In-memory upload (files are then written with saveFile under a generated name). */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) return cb(badRequest(`File type ${file.mimetype} is not allowed`));
    cb(null, true);
  },
});

export function saveFile(folder: string, originalName: string, data: Buffer) {
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '');
  const rel = path.posix.join(folder, `${crypto.randomUUID()}${ext}`);
  const abs = path.join(storageRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return rel;
}

export function resolveStored(rel: string) {
  const abs = path.resolve(storageRoot, rel);
  if (!abs.startsWith(storageRoot)) throw badRequest('Invalid path');
  return abs;
}

export function deleteStored(rel: string) {
  try {
    fs.unlinkSync(resolveStored(rel));
  } catch {
    /* already gone */
  }
}
