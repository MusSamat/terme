import { z } from 'zod';
import { MeetingPoint, PlaceFilterQuery, PlaceId } from '@/modules/cities/cities.schemas.js';

// TZ §10.1 constants:
//   departure: not less than 30 min from now, not more than 60 days ahead
//   price: 50–10_000 сом per seat
//   seats: 1–7 (tighter than driver's vehicle capacity, which is validated
//          against driver_profile.seats_count at service level)
//   horizon rules validated in service because they depend on "now"

// One preference key set for create, patch and the search filters
// (no_smoking → smoking=false, pets → animals=true, women_only).
export const TripPreferences = z
  .object({
    clean: z.boolean(),
    music: z.boolean(),
    smoking: z.boolean(),
    ac: z.boolean(),
    animals: z.boolean(),
    quiet: z.boolean(),
    chat: z.boolean(),
    women_only: z.boolean(),
  })
  .partial();

// Extra route points (any region): pickupCityIds = where the driver can still
// board passengers (origin side), dropoffCityIds = where the driver can drop
// passengers (destination side). Existence is validated at the service level.
const RouteStops = z.array(PlaceId).max(5).default([]);

export const TripCreateBody = z
  .object({
    originCityId: PlaceId,
    destinationCityId: PlaceId,
    // Exact boarding / drop-off spot inside the settlement (map pin). Shown on
    // the map so passengers in a big city can pick the nearest driver.
    originPoint: MeetingPoint.optional(),
    destinationPoint: MeetingPoint.optional(),
    // Which of the user's cars rides this trip; omitted → newest car.
    carId: z.string().uuid().optional(),
    pickupCityIds: RouteStops,
    dropoffCityIds: RouteStops,
    departureAt: z.string().datetime({ offset: true }),
    // Optional «выезд примерно до» — trip departs between departureAt and this.
    departureWindowEnd: z.string().datetime({ offset: true }).optional(),
    departureFlexible: z.boolean().default(false),
    seatsTotal: z.coerce.number().int().min(1).max(7),
    pricePerSeat: z.coerce.number().int().min(50).max(10_000),
    priceNegotiable: z.boolean().default(false),
    luggage: z.enum(['yes', 'small', 'no']).default('no'),
    // Full key set the clients actually send (web maps no_smoking→smoking,
    // pets→animals). Unknown keys used to be silently stripped, which left
    // trips without the data the search filters need.
    preferences: TripPreferences.default({}),
    comment: z.string().trim().max(300).optional(),
  })
  .refine((v) => v.originCityId !== v.destinationCityId, {
    message: 'origin and destination must differ',
    path: ['destinationCityId'],
  })
  .refine(
    (v) => {
      if (!v.departureWindowEnd) return true;
      const start = Date.parse(v.departureAt);
      const end = Date.parse(v.departureWindowEnd);
      // Window must end after it starts and stay within the same 24h.
      return end > start && end - start <= 24 * 60 * 60 * 1000;
    },
    { message: 'departureWindowEnd must be after departureAt (max 24h)', path: ['departureWindowEnd'] },
  );

export type TripCreateInput = z.infer<typeof TripCreateBody>;

export const TripIdParam = z.object({ id: z.string().uuid() });

// Per-day trip counts for the route (calendar availability in the date picker).
export const TripCalendarQuery = z.object({
  from_id: PlaceId,
  to_id: PlaceId,
});

export const TripSearchQuery = z.object({
  ...PlaceFilterQuery,
  date: z.string().datetime({ offset: true }).optional(),
  seats: z.coerce.number().int().min(1).max(4).default(1),
  min_price: z.coerce.number().int().min(0).optional(),
  max_price: z.coerce.number().int().min(0).optional(),
  only_verified: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  min_rating: z.coerce.number().min(0).max(5).optional(),
  women_only: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  no_smoking: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  pets: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  luggage: z.enum(['yes', 'small', 'no']).optional(),
  // airport = transfers to / from an airport; intercity = everything else.
  kind: z.enum(['intercity', 'airport']).optional(),
  // nearest = by distance from (near_lat, near_lng) to the boarding point.
  sort: z.enum(['time', 'price_asc', 'rating_desc', 'nearest']).default('time'),
  // Plain uuid, 'nb_'-prefixed uuid when paginating the nearby (radius) tier,
  // or 'o_<offset>' for sort=nearest.
  cursor: z
    .string()
    .regex(/^((nb_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|o_\d{1,4})$/i)
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type TripSearchInput = z.infer<typeof TripSearchQuery>;

export const TripPatchBody = z
  .object({
    pricePerSeat: z.coerce.number().int().min(50).max(10_000).optional(),
    priceNegotiable: z.boolean().optional(),
    comment: z.string().trim().max(300).nullable().optional(),
    luggage: z.enum(['yes', 'small', 'no']).optional(),
    // Merged into the stored preferences (keys omitted here are kept).
    preferences: TripPreferences.optional(),
    originPoint: MeetingPoint.nullable().optional(),
    destinationPoint: MeetingPoint.nullable().optional(),
    // Allowing departureAt shift within a small window would be nice UX — but
    // TZ §10 doesn't explicitly permit or forbid it. Keeping this out of MVP
    // so we don't have to re-validate the one-trip-per-day constraint and
    // notify booked passengers. Driver must cancel + republish to change date.
  })
  .strict();

export type TripPatchInput = z.infer<typeof TripPatchBody>;

// Manual seat adjust («занято по телефону» / «место освободилось») — call-first
// reality: deals happen over the phone, the driver keeps availability honest.
export const SeatsAdjustBody = z.object({
  delta: z.union([z.literal(1), z.literal(-1)]),
});
export type SeatsAdjustInput = z.infer<typeof SeatsAdjustBody>;

// DELETE /trips/:id — optional free-text reason shown to booked passengers.
export const TripCancelBody = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const MyTripsQuery = z.object({
  tab: z.enum(['active', 'in_transit', 'past', 'cancelled']).default('active'),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type MyTripsInput = z.infer<typeof MyTripsQuery>;

export const PriceSuggestionQuery = z.object({
  from_id: PlaceId,
  to_id: PlaceId,
});

export const IdempotencyHeader = z.object({
  'idempotency-key': z.string().uuid(),
});
