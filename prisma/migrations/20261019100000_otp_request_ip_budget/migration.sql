-- H1/M5: OTP cost + lockout protection.
-- request_ip: who asked for the code (NULL = Telegram bot). The daily cap is
-- counted per (phone, ip) with a higher absolute per-phone ceiling.
ALTER TABLE "otp_codes" ADD COLUMN "request_ip" VARCHAR(45);

-- Global / foreign daily send budgets count otp_codes by created_at only.
CREATE INDEX "otp_codes_created_at_idx" ON "otp_codes" ("created_at");
