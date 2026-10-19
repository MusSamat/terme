import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError, Errors } from '@/lib/errors.js';
import { assertMinDimensions, persistImage, removeImage, toFileUrl } from '@/lib/uploads.js';
import type { DriverVerificationInput } from './drivers.schemas.js';

// TZ §9.1/§9.3 — document photos must be at least 800×600.
const DOC_MIN_WIDTH = 800;
const DOC_MIN_HEIGHT = 600;

/**
 * Driver verification flow — TZ §9.
 *
 * States:
 *   pending        — initial submission waiting for admin
 *   verified       — admin approved; user.roles now includes 'driver'
 *   rejected       — admin rejected with reason (driver may resubmit)
 *   docs_requested — admin asked for specific re-uploads
 *   suspended|blocked — reserved for ops actions (TZ §17)
 */

export type PhotoCategory =
  | 'license'
  | 'license_back'
  | 'car_passport'
  | 'car_passport_back'
  | 'car_photo'
  | 'selfie';

// Mapping between our input categories and the driver_profiles columns.
const CATEGORY_COLUMN: Record<PhotoCategory, keyof Prisma.DriverProfileUpdateInput> = {
  license: 'licensePhotoPath',
  license_back: 'licenseBackPath',
  car_passport: 'carPassportPath',
  car_passport_back: 'carPassportBackPath',
  car_photo: 'carPhotoPath',
  selfie: 'selfiePath',
};

export interface SubmissionFiles {
  license: Express.Multer.File;
  license_back: Express.Multer.File;
  car_passport: Express.Multer.File;
  car_passport_back: Express.Multer.File;
  car_photo: Express.Multer.File;
  selfie: Express.Multer.File;
}

export interface DriverService {
  submitVerification(
    userId: string,
    body: DriverVerificationInput,
    files: SubmissionFiles,
  ): Promise<{ status: string }>;
  getStatus(userId: string): Promise<DriverStatusView>;
  reuploadDocument(
    userId: string,
    category: PhotoCategory,
    file: Express.Multer.File,
  ): Promise<{ status: string }>;
  updateCarPhoto(userId: string, file: Express.Multer.File): Promise<{ carPhotoUrl: string }>;
  getOwnStats(userId: string): Promise<{
    totalTrips: number;
    rating: number | null;
    ratingCount: number;
    cancellations30d: number;
  }>;
}

export interface DriverStatusView {
  status: 'none' | 'pending' | 'verified' | 'rejected' | 'docs_requested' | 'suspended' | 'blocked';
  submittedAt: Date | null;
  verifiedAt: Date | null;
  rejectionReason: string | null;
  requestedDocs: string[];
  car: {
    make: string;
    model: string;
    year: number;
    color: string;
    plate: string;
    seats: number;
    photoUrl: string | null;
  } | null;
}

export function createDriverService(prisma: PrismaClient): DriverService {
  // ─── Submit ─────────────────────────────────────────────────────────
  async function submitVerification(
    userId: string,
    body: DriverVerificationInput,
    files: SubmissionFiles,
  ): Promise<{ status: string }> {
    // Validate all four document dimensions BEFORE any disk write — a failure
    // here must not leave orphaned blobs behind (TZ §9.1 min 800×600).
    // Each check is attributed: the client shows WHICH photo failed and
    // jumps straight to that wizard step.
    for (const key of ['license', 'license_back', 'car_passport', 'car_passport_back', 'car_photo', 'selfie'] as const) {
      try {
        assertMinDimensions(files[key], DOC_MIN_WIDTH, DOC_MIN_HEIGHT);
      } catch (e) {
        if (e instanceof AppError && e.details && typeof e.details === 'object') {
          throw new AppError(e.code, e.message, { ...e.details, field: key });
        }
        throw e;
      }
    }

    // Persist the four images first so we have their paths for the DB row.
    const [license, licenseBack, carPassport, carPassportBack, carPhoto, selfie] =
      await Promise.all([
        persistImage(files.license, 'driver_license'),
        persistImage(files.license_back, 'driver_license'),
        persistImage(files.car_passport, 'car_passport'),
        persistImage(files.car_passport_back, 'car_passport'),
        persistImage(files.car_photo, 'car_photo'),
        persistImage(files.selfie, 'selfie'),
      ]);

    // Old photo paths to clean up after a successful resubmission commit.
    let oldPhotoPaths: Array<string | null> = [];

    try {
      // TZ §9.1 "Транзакция: создание driver_profile со статусом pending."
      // The plate-uniqueness + state checks run inside the same transaction as
      // the write so two concurrent submissions can't both pass the check.
      await prisma.$transaction(async (tx) => {
        const plateOwner = await tx.driverProfile.findUnique({
          where: { carPlate: body.carPlate },
          select: { userId: true },
        });
        if (plateOwner && plateOwner.userId !== userId) {
          throw Errors.conflict('Этот номер уже зарегистрирован', {
            reason: 'plate_taken',
            field: 'carPlate',
          });
        }

        const existing = await tx.driverProfile.findUnique({ where: { userId } });
        // Moderation sanctions are final here: a resubmission would reset them
        // to 'pending' and launder the suspension / block.
        if (existing && ['suspended', 'blocked'].includes(existing.verificationStatus)) {
          throw Errors.verificationLocked({ current_status: existing.verificationStatus });
        }
        // Can't submit while already verified/pending (re-submit allowed after reject).
        if (existing && ['pending', 'verified'].includes(existing.verificationStatus)) {
          throw Errors.conflict('Заявка уже в работе либо одобрена', {
            reason: 'already_active',
            current_status: existing.verificationStatus,
          });
        }

        const now = new Date();
        const photoPaths = {
          licensePhotoPath: license.path,
          licenseBackPath: licenseBack.path,
          carPassportPath: carPassport.path,
          carPassportBackPath: carPassportBack.path,
          carPhotoPath: carPhoto.path,
          selfiePath: selfie.path,
        };

        if (existing) {
          // Resubmission after rejection — overwrite in place; remember old
          // blobs to remove after commit so disk doesn't leak.
          oldPhotoPaths = [
            existing.licensePhotoPath,
            existing.licenseBackPath,
            existing.carPassportPath,
            existing.carPassportBackPath,
            existing.carPhotoPath,
            existing.selfiePath,
          ];
          await tx.driverProfile.update({
            where: { userId },
            data: {
              carMake: body.carMake,
              carModel: body.carModel,
              carYear: body.carYear,
              carColor: body.carColor,
              carPlate: body.carPlate,
              seatsCount: body.seatsCount,
              ...photoPaths,
              verificationStatus: 'pending',
              rejectionReason: null,
              requestedDocs: { set: [] },
              submittedAt: now,
              verifiedAt: null,
              verifiedBy: null,
            },
          });
        } else {
          await tx.driverProfile.create({
            data: {
              carMake: body.carMake,
              carModel: body.carModel,
              carYear: body.carYear,
              carColor: body.carColor,
              carPlate: body.carPlate,
              seatsCount: body.seatsCount,
              ...photoPaths,
              verificationStatus: 'pending',
              submittedAt: now,
              user: { connect: { id: userId } },
            },
          });
        }
      });
    } catch (err) {
      // Roll back the freshly-written blobs if the transaction failed.
      await Promise.all([
        removeImage(license.path),
        removeImage(licenseBack.path),
        removeImage(carPassport.path),
        removeImage(carPassportBack.path),
        removeImage(carPhoto.path),
        removeImage(selfie.path),
      ]);
      throw err;
    }

    // Commit succeeded — clean up the replaced files (resubmission only).
    if (oldPhotoPaths.length) await Promise.all(oldPhotoPaths.map(removeImage));

    return { status: 'pending' };
  }

  // ─── Read status ────────────────────────────────────────────────────
  async function getStatus(userId: string): Promise<DriverStatusView> {
    const dp = await prisma.driverProfile.findUnique({ where: { userId } });
    if (!dp) {
      return {
        status: 'none',
        submittedAt: null,
        verifiedAt: null,
        rejectionReason: null,
        requestedDocs: [],
        car: null,
      };
    }
    return {
      status: dp.verificationStatus as DriverStatusView['status'],
      submittedAt: dp.submittedAt,
      verifiedAt: dp.verifiedAt,
      rejectionReason: dp.rejectionReason,
      requestedDocs: dp.requestedDocs,
      car: {
        make: dp.carMake,
        model: dp.carModel,
        year: dp.carYear,
        color: dp.carColor,
        plate: dp.carPlate,
        seats: dp.seatsCount,
        photoUrl: toFileUrl(dp.carPhotoPath),
      },
    };
  }

  // ─── Re-upload after docs_requested ─────────────────────────────────
  async function reuploadDocument(
    userId: string,
    category: PhotoCategory,
    file: Express.Multer.File,
  ): Promise<{ status: string }> {
    const dp = await prisma.driverProfile.findUnique({ where: { userId } });
    if (!dp) throw Errors.notFound('Verification request');

    if (dp.verificationStatus !== 'docs_requested') {
      throw Errors.conflict('Re-upload only allowed after admin requested documents', {
        current_status: dp.verificationStatus,
      });
    }
    if (!dp.requestedDocs.includes(category)) {
      throw Errors.validation({
        reason: 'category_not_requested',
        category,
        expected: dp.requestedDocs,
      });
    }

    assertMinDimensions(file, DOC_MIN_WIDTH, DOC_MIN_HEIGHT);
    const stored = await persistImage(file, category);

    // Remove from requestedDocs; if list is empty afterwards, flip back to pending.
    const remaining = dp.requestedDocs.filter((c) => c !== category);
    const oldPathField = CATEGORY_COLUMN[category] as keyof typeof dp;
    const oldPath = dp[oldPathField] as string | null | undefined;

    const updates: Prisma.DriverProfileUpdateInput = {
      [CATEGORY_COLUMN[category]]: stored.path,
      requestedDocs: { set: remaining },
    };
    if (remaining.length === 0) {
      updates.verificationStatus = 'pending';
      updates.submittedAt = new Date();
    }

    await prisma.driverProfile.update({ where: { userId }, data: updates });

    // Best-effort cleanup of the replaced file.
    if (oldPath && typeof oldPath === 'string') await removeImage(oldPath);

    return { status: remaining.length === 0 ? 'pending' : 'docs_requested' };
  }

  async function updateCarPhoto(
    userId: string,
    file: Express.Multer.File,
  ): Promise<{ carPhotoUrl: string }> {
    const dp = await prisma.driverProfile.findUnique({ where: { userId } });
    if (!dp) throw Errors.notFound('DriverProfile');
    if (dp.verificationStatus !== 'verified') {
      throw Errors.forbidden({ reason: 'not_verified', current_status: dp.verificationStatus });
    }

    const stored = await persistImage(file, 'car_photo');
    const oldPath = dp.carPhotoPath;

    await prisma.driverProfile.update({
      where: { userId },
      data: { carPhotoPath: stored.path },
    });

    if (oldPath) await removeImage(oldPath);

    return { carPhotoUrl: toFileUrl(stored.path) ?? stored.path };
  }

  async function getOwnStats(userId: string): Promise<{
    totalTrips: number;
    rating: number | null;
    ratingCount: number;
    cancellations30d: number;
  }> {
    const [user, dp] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.driverProfile.findUnique({ where: { userId } }),
    ]);
    if (!user || user.deletedAt) throw Errors.notFound('User');
    if (!dp) throw Errors.forbidden({ reason: 'not_a_driver' });
    return {
      totalTrips: dp.totalTrips,
      rating: user.ratingCount >= 3 ? Number(user.rating) : null,
      ratingCount: user.ratingCount,
      cancellations30d: dp.cancellations30d,
    };
  }

  return { submitVerification, getStatus, reuploadDocument, updateCarPhoto, getOwnStats };
}
