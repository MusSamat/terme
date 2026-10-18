-- Airport transfers: a ride to / from an airport place is kind='airport'.
-- Transfers run several times a day, so the one-trip-per-route-per-day rule
-- applies to intercity rides only. Passengers can give a flight number.
ALTER TABLE "trips"
  ADD COLUMN "kind" VARCHAR(10) NOT NULL DEFAULT 'intercity',
  ADD CONSTRAINT "trips_kind_check" CHECK ("kind" IN ('intercity', 'airport'));
ALTER TABLE "passenger_requests"
  ADD COLUMN "kind" VARCHAR(10) NOT NULL DEFAULT 'intercity',
  ADD COLUMN "flight_number" VARCHAR(10),
  ADD CONSTRAINT "passenger_requests_kind_check" CHECK ("kind" IN ('intercity', 'airport'));

UPDATE "trips" t SET "kind" = 'airport'
  FROM "cities" o, "cities" d
 WHERE o.id = t.origin_city_id AND d.id = t.destination_city_id
   AND 'airport' IN (o.type, d.type);
UPDATE "passenger_requests" r SET "kind" = 'airport'
  FROM "cities" o, "cities" d
 WHERE o.id = r.origin_city_id AND d.id = r.destination_city_id
   AND 'airport' IN (o.type, d.type);

DROP INDEX IF EXISTS "idx_trips_route_day_unique";
CREATE UNIQUE INDEX "idx_trips_route_day_unique"
  ON "trips" ("driver_id", "origin_city_id", "destination_city_id",
              ((departure_at AT TIME ZONE 'Asia/Bishkek')::date))
  WHERE "status" = 'active' AND "kind" = 'intercity';

-- «Аэропорт» feed: upcoming transfers by time.
CREATE INDEX "idx_trips_active_airport" ON "trips" ("departure_at") WHERE "status" = 'active' AND "kind" = 'airport';
CREATE INDEX "idx_requests_open_airport" ON "passenger_requests" ("departure_date") WHERE "status" = 'open' AND "kind" = 'airport';
