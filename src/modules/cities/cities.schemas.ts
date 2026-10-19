import { z } from 'zod';

// Settlement id from GET /v1/cities.
export const PlaceId = z.coerce.number().int().positive();

// Optional exact meeting point inside the chosen settlement (map pin + note).
// lat/lng come together or not at all.
export const MeetingPoint = z
  .object({
    lat: z.number().min(39).max(43.5),
    lng: z.number().min(69).max(81),
    address: z.string().trim().max(200).optional(),
  })
  .strict();
export type MeetingPointInput = z.infer<typeof MeetingPoint>;

// Shared list filters: ids are preferred; names (SEO route pages, the Telegram
// bot) are resolved to the most prominent matching settlement.
export const PlaceFilterQuery = {
  from_id: PlaceId.optional(),
  to_id: PlaceId.optional(),
  from_city: z.string().trim().min(1).max(150).optional(),
  to_city: z.string().trim().min(1).max(150).optional(),
  // Viewer position for sort=nearest (distance to the boarding point).
  near_lat: z.coerce.number().min(39).max(43.5).optional(),
  near_lng: z.coerce.number().min(69).max(81).optional(),
};

// Map viewport: west,south,east,north.
export const BBox = z
  .string()
  .transform((v) => v.split(',').map(Number))
  .refine(
    (a) => a.length === 4 && a.every(Number.isFinite) && a[0]! < a[2]! && a[1]! < a[3]!,
    'bbox must be "west,south,east,north"',
  )
  .transform(([west, south, east, north]) => ({ west: west!, south: south!, east: east!, north: north! }));

export const MapQuery = z.object({
  kind: z.enum(['trips', 'requests']),
  bbox: BBox,
  zoom: z.coerce.number().int().min(3).max(20),
  to_id: PlaceId.optional(),
  ride: z.enum(['intercity', 'airport']).optional(),
  date: z.string().datetime({ offset: true }).optional(),
});
export type MapQueryInput = z.infer<typeof MapQuery>;

// Every active listing of one route for the «Карта» tab (no viewport, no clustering).
export const MapRouteQuery = z
  .object({
    kind: z.enum(['trips', 'requests']),
    from_id: PlaceId,
    to_id: PlaceId,
    ride: z.enum(['intercity', 'airport']).optional(),
    date: z.string().datetime({ offset: true }).optional(),
  })
  .refine((v) => v.from_id !== v.to_id, { message: 'from_id and to_id must differ', path: ['to_id'] });
export type MapRouteQueryInput = z.infer<typeof MapRouteQuery>;
