import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import { badRequest } from './errors';

export const storageRoot = path.resolve(env.STORAGE_DIR);
fs.mkdirSync(storageRoot, { recursive: true });

/** Allowed file kinds: MIME type and the extension files of that kind are stored with. */
const KINDS = {
  pdf: { mime: 'application/pdf', ext: '.pdf' },
  png: { mime: 'image/png', ext: '.png' },
  jpeg: { mime: 'image/jpeg', ext: '.jpg' },
  webp: { mime: 'image/webp', ext: '.webp' },
  doc: { mime: 'application/msword', ext: '.doc' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' },
  xls: { mime: 'application/vnd.ms-excel', ext: '.xls' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
  csv: { mime: 'text/csv', ext: '.csv' },
} as const;
export type FileKind = keyof typeof KINDS;

export const IMAGE_KINDS: FileKind[] = ['png', 'jpeg', 'webp'];
export const DOCUMENT_KINDS = Object.keys(KINDS) as FileKind[];

const startsWith = (buf: Buffer, bytes: number[], offset = 0) => bytes.every((b, i) => buf[offset + i] === b);

/**
 * Identifies a file by its content (magic bytes), not by its name or the browser's Content-Type.
 * The declared type is only used to tell apart formats that share a container (legacy .doc/.xls).
 */
export function detectKind(buf: Buffer, declaredMime: string): FileKind | null {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp'; // RIFF....WEBP
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    // Office Open XML is a zip; its entry names are stored uncompressed.
    if (buf.includes('word/document.xml')) return 'docx';
    if (buf.includes('xl/workbook.xml')) return 'xlsx';
    return null;
  }
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    if (declaredMime === KINDS.doc.mime) return 'doc';
    if (declaredMime === KINDS.xls.mime) return 'xls';
    return null;
  }
  if (declaredMime === KINDS.csv.mime || declaredMime === 'application/vnd.ms-excel') {
    const head = buf.subarray(0, 8192);
    if (head.includes(0)) return null; // binary
    if (/<\s*(!doctype|html|script|svg|\?xml)/i.test(head.toString('utf8'))) return null;
    return 'csv';
  }
  return null;
}

const ALLOWED_MIME = new Set<string>(Object.values(KINDS).map((k) => k.mime));

const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) return cb(badRequest(`File type ${file.mimetype} is not allowed`));
    cb(null, true);
  },
});

/**
 * Accepts one optional file in `field` and verifies its content is one of `kinds`.
 * Afterwards `req.file.mimetype` is the detected type, safe to store and serve.
 */
export function uploadFile(field: string, kinds: FileKind[] = DOCUMENT_KINDS): RequestHandler[] {
  const verify: RequestHandler = (req, _res, next) => {
    if (!req.file) return next();
    const kind = detectKind(req.file.buffer, req.file.mimetype);
    if (!kind || !kinds.includes(kind)) {
      return next(badRequest(`The file content is not an allowed type (${kinds.map((k) => KINDS[k].ext.slice(1)).join(', ')})`));
    }
    req.file.mimetype = KINDS[kind].mime;
    next();
  };
  return [multerUpload.single(field), verify];
}

const extOfMime = (mime: string) => Object.values(KINDS).find((k) => k.mime === mime)?.ext ?? '';
const mimeOfExt = (ext: string) => Object.values(KINDS).find((k) => k.ext === ext.toLowerCase())?.mime;

/** Writes an uploaded (verified) file under a random name; the extension comes from the verified type. */
export function saveFile(folder: string, data: Buffer, mime: string) {
  const rel = path.posix.join(folder, `${crypto.randomUUID()}${extOfMime(mime)}`);
  const abs = path.join(storageRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return rel;
}

export function resolveStored(rel: string) {
  const abs = path.resolve(storageRoot, rel);
  if (!abs.startsWith(storageRoot + path.sep)) throw badRequest('Invalid path');
  return abs;
}

/**
 * Sends a stored file with an explicit type and, unless it is an image shown inline, as a download.
 * The sandbox CSP stops anything that slipped through from running script on our origin.
 */
export function sendStored(res: Response, rel: string, opts: { mime?: string | null; fileName?: string; inlineImage?: boolean } = {}) {
  const abs = resolveStored(rel);
  const mime = opts.mime && ALLOWED_MIME.has(opts.mime) ? opts.mime : mimeOfExt(path.extname(abs)) ?? 'application/octet-stream';
  const inline = opts.inlineImage && mime.startsWith('image/');
  const name = opts.fileName ? (path.extname(opts.fileName) ? opts.fileName : opts.fileName + path.extname(abs)) : path.basename(abs);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Disposition', inline ? 'inline' : `attachment; filename="${encodeURIComponent(name)}"`);
  res.sendFile(abs);
}

export function deleteStored(rel: string) {
  try {
    fs.unlinkSync(resolveStored(rel));
  } catch {
    /* already gone */
  }
}
