import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { createDriverService, type SubmissionFiles } from './drivers.service.js';
import { DriverReuploadQuery, DriverVerificationBody, type DriverVerificationInput } from './drivers.schemas.js';
import { validate } from '@/middleware/validate.js';
import { asyncHandler } from '@/middleware/errorHandler.js';
import { requireAuth, requireRole } from '@/middleware/auth.js';
import { uploadMemory } from '@/lib/uploads.js';
import { Errors } from '@/lib/errors.js';

const REQUIRED_PHOTO_FIELDS = ['license', 'license_back', 'car_passport', 'car_passport_back', 'car_photo', 'selfie'] as const;

export function createDriversRouter(prisma: PrismaClient): Router {
  const router = Router();
  const service = createDriverService(prisma);

  // Submit all four photos + data in a single multipart request.
  router.post(
    '/verification',
    requireAuth,
    uploadMemory.fields([
      { name: 'license', maxCount: 1 },
      { name: 'license_back', maxCount: 1 },
      { name: 'car_passport', maxCount: 1 },
      { name: 'car_passport_back', maxCount: 1 },
      { name: 'car_photo', maxCount: 1 },
      { name: 'selfie', maxCount: 1 },
    ]),
    validate({ body: DriverVerificationBody }),
    asyncHandler(async (req, res) => {
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      if (!files) throw Errors.validation({ reason: 'missing_files' });

      const picked: Partial<SubmissionFiles> = {};
      for (const name of REQUIRED_PHOTO_FIELDS) {
        const arr = files[name];
        if (!arr || arr.length === 0) {
          throw Errors.validation({ reason: 'missing_file', field: name });
        }
        picked[name] = arr[0];
      }

      const result = await service.submitVerification(
        req.user!.id,
        req.body as DriverVerificationInput,
        picked as SubmissionFiles,
      );
      res.status(201).json(result);
    }),
  );

  router.get(
    '/verification/status',
    requireAuth,
    asyncHandler(async (req, res) => {
      const status = await service.getStatus(req.user!.id);
      res.json(status);
    }),
  );

  router.post(
    '/verification/upload',
    requireAuth,
    uploadMemory.single('file'),
    validate({ query: DriverReuploadQuery }),
    asyncHandler(async (req, res) => {
      if (!req.file) throw Errors.validation({ reason: 'missing_file', field: 'file' });
      const { category } = req.query as { category: 'license' | 'car_passport' | 'car_photo' | 'selfie' };
      const result = await service.reuploadDocument(req.user!.id, category, req.file);
      res.json(result);
    }),
  );

  // Verified drivers may update their car photo without re-submitting verification.
  // Car info (make/model/plate) stays immutable — set during verification from tech passport.
  router.patch(
    '/car-photo',
    requireAuth,
    requireRole('driver'),
    uploadMemory.single('file'),
    asyncHandler(async (req, res) => {
      if (!req.file) throw Errors.validation({ reason: 'missing_file', field: 'file' });
      const result = await service.updateCarPhoto(req.user!.id, req.file);
      res.json(result);
    }),
  );

  router.get(
    '/me/stats',
    requireAuth,
    requireRole('driver'),
    asyncHandler(async (req, res) => {
      const stats = await service.getOwnStats(req.user!.id);
      res.json(stats);
    }),
  );

  return router;
}
