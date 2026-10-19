import { z } from 'zod';

export const UpdateMeBody = z.object({
  name: z.string().trim().min(2).max(50).optional(),
  surname: z.string().trim().max(100).optional(),
  preferredMode: z.enum(['passenger', 'driver']).optional(),
  language: z.enum(['ru', 'kg']).optional(),
  bio: z.string().trim().max(300).optional(),
  // avatar_url is never set directly — use POST /users/avatar instead.
  termsAccepted: z.literal(true).optional(),
  notificationsEnabled: z.boolean().optional(),
});

export const UserIdParam = z.object({
  id: z.string().uuid(),
});

export const RatingsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().uuid().optional(),
});

export const LikesQuery = z.object({
  type: z.enum(['trip', 'passenger_request']),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().uuid().optional(),
});

export type UpdateMeInput = z.infer<typeof UpdateMeBody>;
export type RatingsQueryInput = z.infer<typeof RatingsQuery>;
export type LikesQueryInput = z.infer<typeof LikesQuery>;
