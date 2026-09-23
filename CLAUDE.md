# CLAUDE.md — Terme Platform
# Merge of: behavioral guidelines + project-specific rules
# Goal: минимум токенов, максимум точности, ноль галлюцинаций

---

## 0. Перед любым кодом — стоп

Перед реализацией явно назови:
- Что именно ты меняешь и почему
- Какой файл, какая функция, какая строка
- Какие допущения делаешь

Если задача неясна — **спроси один вопрос**. Не угадывай.
Если есть два способа — назови оба, жди выбора.

---

## 1. Стек — не изобретай

### Backend (`/backend`)
```
Node.js 20 LTS + TypeScript (strict: true)
Express.js 4.x          — HTTP сервер
Prisma 5.x              — ORM, все запросы через него
PostgreSQL 16           — единственная БД
Socket.IO 4.x           — WebSocket (отдельный процесс от API)
Zod 3.x                 — валидация входящих данных
jsonwebtoken 9.x        — JWT подпись/верификация (наши токены)
jose                    — верификация внешних JWT (Google/Apple JWKS)
bcryptjs                — хеши паролей и OTP (не нативный bcrypt)
otplib                  — TOTP для админов
grammy                  — Telegram Bot API
Pino 9.x                — логирование (JSON, structured)
node-cron 3.x           — cron jobs
fetch (нативный)        — внешние HTTP (WhatsApp Cloud API и др.); axios НЕ используется
Vitest                  — тесты
```

**Запрещено добавлять без явного запроса:**
- Redis (не в MVP)
- Bull/BullMQ (не в MVP)
- MinIO / S3 SDK (не в MVP)
- Kafka / RabbitMQ (не в MVP)
- любой новый npm пакет

### Mini App (`/mini-app`)
```
React 18 + TypeScript
Vite 5               — сборщик
Zustand              — state management
TanStack Query       — server state + кэш
react-hook-form      — формы
Zod                  — валидация форм
i18next              — локализация (ru | ky)
Tailwind CSS         — стили
axios                — HTTP
socket.io-client     — WebSocket
```

### Flutter (`/mobile`)
```
Flutter 3.x + Dart
Riverpod             — state management
go_router            — навигация
dio + retrofit       — HTTP
socket_io_client     — WebSocket
Hive                 — offline queue + кэш
flutter_secure_storage — токены
easy_localization    — ru | ky
flutter_map          — карты (OpenStreetMap)
image_picker + flutter_image_compress — фото документов
```

---

## 2. Архитектура — не нарушай

```
/backend
  /src
    /modules         — код по фичам: <name>/<name>.routes.ts + <name>.service.ts + <name>.schemas.ts
                       .routes.ts  — Express роутер (HTTP + Zod валидация, тонкий)
                       .service.ts — бизнес-логика + прямые Prisma запросы
                       .schemas.ts — Zod схемы входящих данных
    /middleware      — auth, rateLimit, validate, errorHandler, requestContext
    /lib             — утилиты (jwt, bcrypt, whatsapp, telegram, i18n, errors)
    /config          — env (Zod-валидированный process.env)
    /cron            — cron задачи (jobs/)
    /ws              — Socket.IO handlers (отдельный процесс)
    /locales         — ru.json, kg.json (тексты ошибок)
    server.ts        — createApp(prisma, notifier, bot): монтирует все роутеры
    openapi.ts       — hand-authored OpenAPI спека
  prisma/
    schema.prisma
    migrations/

/mini-app
  /src
    /api             — axios инстанс + все запросы
    /store           — Zustand stores
    /hooks           — кастомные хуки
    /pages           — экраны
    /components      — переиспользуемые компоненты
    /lib             — утилиты (deferredAction, auth, etc.)
    /locales         — ru.json, ky.json

/mobile
  /lib
    /api             — dio клиент + retrofit
    /providers       — Riverpod providers
    /models          — data классы
    /screens         — экраны
    /widgets         — переиспользуемые виджеты
    /l10n            — ru.json, ky.json
```

**Правило слоёв (Controller/Repository слоёв НЕТ):**
- Route (`*.routes.ts`) → Service (`*.service.ts`). Роутер парсит/валидирует
  req (Zod) и зовёт сервис; сервис держит бизнес-логику и сам ходит в Prisma.
- Service НЕ знает про `req`/`res` — принимает уже распарсенные аргументы.
- DI через фабрики: `create<X>Service(prisma, ...)` и `create<X>Router(...)`,
  всё собирается в `createApp()` (`server.ts`). Никаких глобальных синглтонов.
- Prisma-запросы живут в сервисе (отдельного repository-слоя нет).

---

## 3. Работа с кодом — хирургически

**Трогай только то что попросили.**

При редактировании:
- Не улучшай соседний код
- Не рефакторь то что не сломано
- Соблюдай существующий стиль файла
- Если заметил мёртвый код — упомяни, не удаляй

Твои изменения создали orphans → удали их.
Чужие orphans → не трогай.

**Тест:** каждая изменённая строка напрямую связана с задачей.

---

## 4. База данных — правила

```sql
-- Все PK — UUID
id UUID DEFAULT gen_random_uuid() PRIMARY KEY

-- Все timestamps — UTC
created_at TIMESTAMPTZ DEFAULT NOW()

-- Soft delete
deleted_at TIMESTAMPTZ NULL  -- NULL = не удалён

-- Никогда не делай raw SQL если можно через Prisma
-- Никогда не делай N+1 запросы — используй include/select
```

**Race condition на seats_available — всегда SELECT FOR UPDATE:**
```typescript
// ПРАВИЛЬНО
await prisma.$transaction(async (tx) => {
  const trip = await tx.$queryRaw`
    SELECT * FROM trips WHERE id = ${tripId} FOR UPDATE
  `;
  // проверка и обновление внутри транзакции
});

// НЕПРАВИЛЬНО — без блокировки
const trip = await prisma.trip.findUnique({ where: { id: tripId } });
await prisma.trip.update(...); // race condition!
```

---

## 5. Auth — строгие правила

```
Access token:  15 минут (JWT_ACCESS_TTL_MIN), в памяти (не localStorage)
Refresh token: продлевается при активности, разлогин через 30 дней без входа
OTP:           bcrypt(code) в БД, НЕ plain text
OTP-канал:     WhatsApp (шаблон terme_otp) — lib/whatsapp.sendWhatsappOtp.
               НЕ отправляется при повторном входе (phone+password), только при
               регистрации / привязке / смене номера.
Telegram Mini App: вход по подписанному initData — POST /auth/telegram
               (провизорный токен, если телефон ещё не привязан).
```

**Token Reuse Detection — grace-окно + revoke-all вне него (auth.session.ts):**
```typescript
// При /auth/refresh, если refresh-токен уже ротирован (used):
//   • в пределах GRACE_MS (60s) → ретрай/гонка клиента: вернуть ТУ ЖЕ ранее
//     выданную пару из кэша (по rotatedTokenId), НЕ минтить новую и НЕ
//     разлогинивать (иначе ложные логауты при двойном запросе клиента).
//   • вне grace-окна → реальный reuse украденного токена: revoke ВСЕХ refresh
//     токенов пользователя + 401 { code: 'TOKEN_REUSE_DETECTED' } + лог-событие.
// Клиенты (web/mobile) обязаны трактовать TOKEN_REUSE_DETECTED как форс-логаут.
```

**Deferred Action — sessionStorage, TTL 15 минут:**
```typescript
// Ключ: kosho_deferred_action
// При неавторизованном защищённом действии → сохранить → редирект на логин
// После входа → прочитать → выполнить → удалить
```

---

## 6. API — соглашения

```
Base URL:     /v1  (см. server.ts; /health — вне версии)
Авторизация:  Authorization: Bearer <access_token>
Ошибки:       { error: { code: "UPPER_SNAKE", message: "...", message_kg?, details?, request_id } }
Пагинация:    cursor-based: ?cursor=xxx&limit=20
Идемпотент:   Idempotency-Key header для POST /trips, POST /bookings
Даты:         ISO 8601 UTC везде
```

**Формат ошибки — всегда так:**
```typescript
// src/lib/errors.ts — сигнатура: AppError(code, messageFallback, details?).
// HTTP-статус берётся из таблицы кодов, локализация — через locales/*.json.
// Обычно зовём готовый хелпер из Errors, а не конструктор напрямую:
throw Errors.seatsNotAvailable();           // 409, SEATS_NOT_AVAILABLE
throw new AppError('CONFLICT', 'Мест больше нет', { tripId });  // если нужен свой message
```

---

## 7. Локализация — обязательно

```typescript
// ПРАВИЛЬНО — ключи в файлах
t('trips.create.title')

// НЕПРАВИЛЬНО — хардкод строк
"Создать поездку"

// Структура ключей — макс 3 уровня
// common.buttons.submit
// trips.create.title
// errors.SEATS_NOT_AVAILABLE
```

Локали: `ru` и `kg` (см. lib/i18n.ts; legacy-тег `ky` в Accept-Language
маппится на `kg`). Файл `src/locales/ky.json` — устаревший, не используется.

Backend: `src/locales/{ru,kg}.json` хранят только тексты ошибок (`errors.<CODE>`),
резолвятся в errorHandler по Accept-Language. При добавлении нового текста:
1. Добавь ключ в `locales/ru.json`
2. Добавь ключ в `locales/kg.json` (можно заглушку = ru текст)

---

## 8. Тесты — минимально необходимые

**Пиши тест до кода (или сразу после — не через неделю).**

```typescript
// Обязательно тестировать:
// - Happy path основного флоу
// - Race condition (seats_available)
// - Auth middleware (401 без токена, 403 без прав)
// - Rate limiting (429 при превышении)
// - OTP: неверный код, истёкший, превышение попыток

// Не тестировать:
// - Prisma internals
// - Express роутинг
// - Очевидные геттеры/сеттеры
```

---

## 9. Экономия токенов — главное правило

**Не пиши если не просили:**
- Не добавляй комментарии к очевидному коду
- Не пиши README если не просили
- Не создавай типы для одноразовых объектов
- Не добавляй console.log в продакшн код (только Pino)
- Не дублируй типы — переиспользуй Prisma generated types

**Размер функции:**
- Если функция > 50 строк → скорее всего её надо разбить
- Если файл > 200 строк → спроси нужно ли разбивать

**При ответе:**
- Показывай только изменённые части файла (не весь файл)
- Используй `// ... existing code ...` для пропуска
- Если изменение < 10 строк — не нужен diff, просто код

---

## 10. Чеклист перед сдачей кода

```
[ ] TypeScript strict: нет any, нет ts-ignore без объяснения
[ ] Zod валидация на всех входящих данных (уровень *.routes.ts)
[ ] Ошибки через AppError / Errors.* (не throw new Error("string"))
[ ] Логирование через Pino (не console.log)
[ ] Новые ключи локализации добавлены в ru.json и kg.json
[ ] Prisma-вызовы только в *.service.ts (роутер не ходит в Prisma напрямую)
[ ] Новый эндпоинт добавлен в src/openapi.ts (или в KNOWN_GAPS теста покрытия)
[ ] Транзакция там где нужна атомарность
[ ] Rate limit проверен для новых публичных эндпоинтов
[ ] idempotency_key на POST /trips и POST /bookings
[ ] Тест написан для основного флоу
```

---

## 11. Что НЕ делать никогда

```
❌ prisma.trip.findMany() без WHERE — полный скан таблицы
❌ Хранить OTP plain text — только bcrypt hash
❌ JWT секрет захардкодить — только из process.env
❌ console.log в продакшн коде — только pino logger
❌ any в TypeScript без комментария почему
❌ Новый npm пакет без явного запроса
❌ Менять schema.prisma без создания миграции
❌ Прямой SQL без параметров — SQL injection
❌ sessionStorage для refresh токена — только memory/secure storage
❌ Слать OTP (WhatsApp) при повторном входе — вход по phone+password без OTP
```

---

## 12. Быстрый справочник команд

```bash
# Backend — корень ЭТОГО репозитория (mini-app и mobile — отдельные репо)
npx prisma migrate dev --name "описание"   # новая миграция
npx prisma generate                         # regenerate client
npx prisma studio                           # GUI для БД
npm run dev                                 # запуск dev
npm test                                    # тесты

# Mini App
cd mini-app
npm run dev                                 # Vite dev server
npm run build                               # production build

# Flutter
cd mobile
flutter run -d chrome                       # web (для UI разработки)
flutter run -d <device_id>                  # на устройстве
flutter pub get                             # установить зависимости
```
