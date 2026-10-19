import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import multer, { type FileFilterCallback } from 'multer';
import type { Request, RequestHandler } from 'express';
import { env, isTest } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { Errors } from '@/lib/errors.js';

/**
 * Upload layer for the MVP disk-store. TZ §4.1 + §9.3:
 *   • Only image/jpeg and image/png
 *   • Max 5 MB
 *   • MIME + magic bytes both checked (defence in depth — clients can lie about
 *     the Content-Type; magic bytes are the authoritative signal)
 *   • Stored under FILES_DIR/<year>/<month>/<sha256(random).ext> — flat enough to
 *     browse but partitioned so a single dir never grows unbounded
 *
 * Later (Stage 2) this swaps to an S3-compatible store without touching call sites.
 */

const MAX_BYTES = env.MAX_UPLOAD_MB * 1024 * 1024;

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png']);

// Magic byte signatures.
//   JPEG: FF D8 FF
//   PNG:  89 50 4E 47 0D 0A 1A 0A
export function detectImageMime(buffer: Buffer): 'image/jpeg' | 'image/png' | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  return null;
}

/**
 * Read intrinsic pixel dimensions straight from the image header — no decode,
 * no third-party dependency (TZ stack is fixed; no new npm packages). Supports
 * the only two formats we accept: PNG (IHDR) and JPEG (Start-Of-Frame marker).
 * Returns null if the header can't be parsed.
 */
export function readImageDimensions(buffer: Buffer): { width: number; height: number } | null {
  // PNG: 8-byte signature, then IHDR chunk → width@16, height@20 (big-endian).
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // JPEG: scan segments for a Start-Of-Frame marker (SOF0–SOF15, excluding the
  // non-frame C4/C8/CC). SOF layout: FFCx, len(2), precision(1), height(2), width(2).
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1]!;
      // Standalone markers carry no length payload — skip 2 bytes.
      if (
        marker === 0xd8 ||
        marker === 0xd9 ||
        (marker >= 0xd0 && marker <= 0xd7) ||
        marker === 0x01
      ) {
        offset += 2;
        continue;
      }
      const segLen = buffer.readUInt16BE(offset + 2);
      const isSOF =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + segLen;
    }
  }
  return null;
}

/**
 * Enforce TZ §9.1/§9.3 minimum dimensions on document photos (800×600). An
 * unreadable header is rejected rather than silently passed — a "JPEG" with no
 * Start-Of-Frame isn't a usable document scan.
 */
export function assertMinDimensions(
  file: Express.Multer.File,
  minWidth: number,
  minHeight: number,
): void {
  const dims = readImageDimensions(file.buffer);
  if (!dims) {
    throw Errors.validation({ reason: 'unreadable_image_dimensions' });
  }
  // Orientation-agnostic: an 800×600 requirement must accept a 600×800
  // portrait shot — compare the sorted dimensions, not width/height literally.
  const [dimMin, dimMax] = [Math.min(dims.width, dims.height), Math.max(dims.width, dims.height)];
  const [reqMin, reqMax] = [Math.min(minWidth, minHeight), Math.max(minWidth, minHeight)];
  if (dimMax < reqMax || dimMin < reqMin) {
    throw Errors.validation({
      reason: 'image_too_small',
      width: dims.width,
      height: dims.height,
      min_width: minWidth,
      min_height: minHeight,
    });
  }
}

const fileFilter = (_req: Request, file: Express.Multer.File, cb: FileFilterCallback): void => {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    cb(Errors.validation({ reason: 'unsupported_mime', mimetype: file.mimetype }));
    return;
  }
  cb(null, true);
};

// Use memory storage so magic-byte validation happens *before* writing to disk —
// no partially-persisted payload if a malicious upload sneaks past the MIME check.
export const uploadMemory = multer({
  storage: multer.memoryStorage(),
  // M7: bound the non-file parts too (field count, part count, field size).
  limits: { fileSize: MAX_BYTES, files: 10, fields: 30, parts: 40, fieldSize: 64 * 1024 },
  fileFilter,
});

export interface StoredFile {
  path: string; // DB-friendly relative path (what we write into *_path columns)
  absPath: string; // on-disk absolute path
  mime: 'image/jpeg' | 'image/png';
  size: number;
  sha256: string;
}

export async function persistImage(
  file: Express.Multer.File,
  category: string,
): Promise<StoredFile> {
  const detected = detectImageMime(file.buffer);
  if (!detected) {
    throw Errors.validation({ reason: 'bad_magic_bytes' });
  }
  if (detected !== file.mimetype) {
    // MIME lied — treat as malicious.
    throw Errors.validation({
      reason: 'mime_mismatch',
      declared: file.mimetype,
      actual: detected,
    });
  }

  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');

  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const ext = detected === 'image/png' ? 'png' : 'jpg';
  // Random component prevents enumeration; sha256 prefix gives a stable content
  // address for deduplication at the application level if we want it later.
  const token = crypto.randomBytes(12).toString('base64url');
  const filename = `${sha256.slice(0, 16)}-${token}.${ext}`;

  const relDir = path.posix.join(category, yyyy, mm);
  const relPath = path.posix.join(relDir, filename);

  const absDir = path.join(env.FILES_DIR, relDir);
  const absPath = path.join(env.FILES_DIR, relPath);

  await fs.mkdir(absDir, { recursive: true });
  await fs.writeFile(absPath, file.buffer, { mode: 0o640 });

  return { path: relPath, absPath, mime: detected, size: file.size, sha256 };
}

export async function removeImage(relPath: string | null | undefined): Promise<void> {
  if (!relPath) return;
  const abs = path.join(env.FILES_DIR, relPath);
  await fs.unlink(abs).catch(() => undefined); // idempotent — swallow ENOENT
}

// Identity documents and complaint evidence are never public: their URLs carry
// a short-lived HMAC signature (works in a plain <img src>, no auth header).
// Avatars and car photos stay public.
const PRIVATE_DIRS = new Set(['driver_license', 'car_passport', 'selfie', 'complaint_attachments']);
const SIGNED_URL_TTL_SEC = 15 * 60;

function isPrivate(relPath: string): boolean {
  return PRIVATE_DIRS.has(relPath.split('/')[0] ?? '');
}

if (!env.FILES_SIGNING_SECRET && !isTest) {
  logger.warn('FILES_SIGNING_SECRET unset — signing private file URLs with JWT_ACCESS_SECRET');
}
const filesSigningSecret = env.FILES_SIGNING_SECRET ?? env.JWT_ACCESS_SECRET;

function fileSignature(relPath: string, exp: number): string {
  return crypto
    .createHmac('sha256', filesSigningSecret)
    .update(`file:${relPath}:${exp}`)
    .digest('base64url');
}

export function toFileUrl(relPath: string | null | undefined): string | null {
  if (!relPath) return null;
  if (!isPrivate(relPath)) return `${env.BASE_URL}/${relPath}`;
  const exp = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SEC;
  return `${env.BASE_URL}/${relPath}?exp=${exp}&sig=${fileSignature(relPath, exp)}`;
}

/** Mounted before express.static: private files need a valid, unexpired signature. */
export const privateFileGuard: RequestHandler = (req, res, next) => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(req.path);
  } catch {
    res.status(404).end();
    return;
  }
  // Judge the path express.static will actually serve: dot segments and encoded
  // separators (/avatars/..%2fselfie/…) must not smuggle a private file out.
  const normalized = path.posix.normalize(decoded);
  if (normalized !== decoded || decoded.includes('\\') || decoded.includes('%')) {
    res.status(404).end();
    return;
  }
  const relPath = normalized.replace(/^\/+/, '');
  if (!isPrivate(relPath)) return next();
  const exp = Number(req.query['exp']);
  const sig = typeof req.query['sig'] === 'string' ? req.query['sig'] : '';
  const expected = fileSignature(relPath, exp);
  const valid =
    Number.isFinite(exp) &&
    exp > Date.now() / 1000 &&
    sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!valid) {
    res.status(404).end();
    return;
  }
  res.setHeader('Cache-Control', 'private, no-store');
  next();
};
