import { z } from 'zod';

export const BookingCreateBody = z.object({
  tripId: z.string().uuid(),
  seatsCount: z.coerce.number().int().min(1).max(4), // TZ §5.5 CHECK(1..4)
  comment: z.string().trim().max(300).optional(),
});

// Optional for bookings (mobile doesn't send it yet); bounded to the column size.
export const BookingIdempotencyHeader = z.object({
  'idempotency-key': z.string().min(1).max(100).optional(),
});

export type BookingCreateInput = z.infer<typeof BookingCreateBody>;

export const BookingCancelBody = z
  .object({
    reasons: z.array(z.string().trim().max(100)).max(5).optional(),
  })
  .strict();

export type BookingCancelInput = z.infer<typeof BookingCancelBody>;

export const BookingRejectBody = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const BookingIdParam = z.object({ id: z.string().uuid() });

export const MyBookingsQuery = z.object({
  status: z
    .enum(['pending', 'accepted', 'rejected', 'cancelled', 'completed', 'expired'])
    .optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type MyBookingsInput = z.infer<typeof MyBookingsQuery>;

export const IncomingBookingsQuery = z.object({
  tripId: z.string().uuid().optional(),
  // pending = awaiting a decision (pending + viewed, the default); accepted =
  // confirmed passengers; all = both.
  status: z.enum(['pending', 'accepted', 'all']).default('pending'),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

type IncomingParsed = z.infer<typeof IncomingBookingsQuery>;
// status is optional for in-process callers (the bot) — defaults to 'pending'.
export type IncomingBookingsInput = Omit<IncomingParsed, 'status'> & { status?: IncomingParsed['status'] };
