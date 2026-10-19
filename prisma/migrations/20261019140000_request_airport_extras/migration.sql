-- Airport passenger requests: «Встретить с табличкой» and luggage pieces (0–5).
ALTER TABLE "passenger_requests"
  ADD COLUMN "meet_with_sign" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "luggage_count"  SMALLINT,
  ADD CONSTRAINT "passenger_requests_luggage_count_check"
    CHECK ("luggage_count" IS NULL OR "luggage_count" BETWEEN 0 AND 5);
