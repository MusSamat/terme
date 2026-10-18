import { z } from 'zod';
import { MeetingPoint, PlaceFilterQuery, PlaceId } from '@/modules/cities/cities.schemas.js';

// «SU 1882», «KR 862» — airline code + number, normalised to upper case.
const FlightNumber = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2}\s?\d{1,4}[A-Z]?$/, 'flight number like SU 1882');

export const CreatePassengerRequestBody = z
  .object({
    originCityId: PlaceId,
    destinationCityId: PlaceId,
    // Where the passenger waits / wants to get off (map pin) — drivers in a
    // big city pick the closest passenger.
    originPoint: MeetingPoint.optional(),
    destinationPoint: MeetingPoint.optional(),
    // Airport transfers: the flight the passenger arrives / departs on.
    flightNumber: FlightNumber.optional(),
    seatsNeeded: z.coerce.number().int().min(1).max(8),
    departureDate: z.string().datetime({ offset: true }),
    flexible: z.boolean().default(false),
    comment: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.originCityId !== v.destinationCityId, {
    message: 'origin and destination must differ',
    path: ['destinationCityId'],
  });

export type CreatePassengerRequestInput = z.infer<typeof CreatePassengerRequestBody>;

// Owner edit of an open request (no price — a request has none; drivers offer it).
export const UpdatePassengerRequestBody = z
  .object({
    seatsNeeded: z.coerce.number().int().min(1).max(8).optional(),
    departureDate: z.string().datetime({ offset: true }).optional(),
    flexible: z.boolean().optional(),
    comment: z.string().trim().max(500).nullable().optional(),
    originPoint: MeetingPoint.nullable().optional(),
    destinationPoint: MeetingPoint.nullable().optional(),
    flightNumber: FlightNumber.nullable().optional(),
  })
  .strict();

export type UpdatePassengerRequestInput = z.infer<typeof UpdatePassengerRequestBody>;

export const ListRequestsQuery = z.object({
  ...PlaceFilterQuery,
  date: z.string().datetime({ offset: true }).optional(),
  seats: z.coerce.number().int().min(1).max(8).optional(),
  kind: z.enum(['intercity', 'airport']).optional(),
  // nearest = by distance from (near_lat, near_lng) to where the passenger waits.
  sort: z.enum(['time', 'nearest']).default('time'),
  // Plain uuid, 'nb_'-prefixed uuid when paginating the nearby (radius) tier,
  // or 'o_<offset>' for sort=nearest.
  cursor: z
    .string()
    .regex(/^((nb_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|o_\d{1,4})$/i)
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type ListRequestsInput = z.infer<typeof ListRequestsQuery>;

export const RequestIdParam = z.object({ id: z.string().uuid() });

// Per-day open-request counts for the route (calendar hints in the date picker).
export const RequestCalendarQuery = z.object({
  from_id: PlaceId,
  to_id: PlaceId,
});

export const RespondBody = z.object({
  // Same range as trips.price_per_seat — the accepted offer becomes a trip.
  price: z.number().int().min(50).max(10_000),
  departureTime: z.string().datetime({ offset: true }),
  message: z.string().trim().max(500).optional(),
});
export type RespondInput = z.infer<typeof RespondBody>;

export const ResponseIdParam = z.object({
  id: z.string().uuid(),
  responseId: z.string().uuid(),
});
