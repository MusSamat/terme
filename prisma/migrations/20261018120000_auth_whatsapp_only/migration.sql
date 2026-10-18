-- Sign-in: WhatsApp code (registration, mobile login, password reset) and
-- phone + password (web login). The Telegram bot links an account by a shared,
-- Telegram-verified contact (users.telegram_id). Telegram Mini App / OAuth /
-- bot web-login are gone, and so are their tables.

DROP TABLE IF EXISTS "auth_providers";
DROP TABLE IF EXISTS "telegram_bot_login_tokens";
DROP TABLE IF EXISTS "telegram_link_tokens";

-- Provisional (+prov:) accounts came only from Telegram/OAuth logins. They never
-- had a usable phone; tombstone them like a regular account deletion.
UPDATE "users"
   SET "deleted_at" = COALESCE("deleted_at", NOW()),
       "phone" = '+del:' || substr(md5("id"::text), 1, 12),
       "telegram_id" = NULL
 WHERE "phone" LIKE '+prov:%' OR "phone" LIKE '+tg:%';

UPDATE "users" SET "last_platform" = 'web' WHERE "last_platform" = 'mini';
