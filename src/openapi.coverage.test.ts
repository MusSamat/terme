import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { testPrisma } from '../tests/setup.js';
import { createApp } from '@/server.js';
import { openapiDocument } from '@/openapi.js';

// OpenAPI COVERAGE drift-guard (complements openapi.test.ts, which snapshots the
// spec's own surface). This test proves the *hand-authored* spec still describes
// every route the Express app actually mounts.
//
// Approach: enumerate the real mounted routes by walking `app._router.stack`
// (the most robust source — it can't drift from the code the way a maintained
// list would), normalise them to spec-style paths, and diff against the paths
// declared in `openapiDocument`.
//
// The spec is known to be ~half-complete today (passenger-requests, cars,
// loyalty, presence, whatsapp, and much of admin/auth were never backfilled).
// Backfilling is out of scope and risky, so this test is GREEN NOW by asserting
// only that no NEW gap appears beyond the frozen allowlist below — and it FAILS
// the moment a newly-added route is forgotten in the spec, or a listed gap gets
// fixed (so the allowlist can shrink). It also fails on stale spec paths that no
// longer map to a route.
//
// To shrink the allowlist: add the endpoint to src/openapi.ts, then delete its
// line here. To silence a brand-new legitimate gap: add it here with a reason.

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** `:id` → `{id}`; drop a trailing slash (Express `/trips/` vs spec `/trips`). */
function normalizePath(p: string): string {
  const withBraces = p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return withBraces.length > 1 ? withBraces.replace(/\/+$/, '') : withBraces;
}

/**
 * Recursively collect "METHOD /path" entries from an Express router stack.
 * Nested routers expose their mount path only via `layer.regexp`; we parse the
 * standard Express serialisation `^\/mount\/?(?=\/|$)` to recover it.
 */
function collectRoutes(
  stack: Array<Record<string, unknown>>,
  prefix: string,
  out: Set<string>,
): void {
  for (const layer of stack) {
    const route = layer.route as { path?: string; methods?: Record<string, boolean> } | undefined;
    if (route?.path && route.methods) {
      const full = normalizePath(prefix + route.path);
      for (const m of HTTP_METHODS) {
        if (route.methods[m]) out.add(`${m.toUpperCase()} ${full}`);
      }
      continue;
    }
    const handle = layer.handle as { stack?: Array<Record<string, unknown>> } | undefined;
    if (layer.name === 'router' && handle?.stack) {
      const regexp = layer.regexp as (RegExp & { fast_slash?: boolean }) | undefined;
      let mount = '';
      if (regexp && !regexp.fast_slash) {
        const m = regexp.source.match(/^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)/);
        if (m?.[1]) mount = '/' + m[1].replace(/\\\//g, '/');
      }
      collectRoutes(handle.stack, prefix + mount, out);
    }
  }
}

function mountedV1Routes(app: Express): Set<string> {
  const all = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Express omits _router from its public types
  const stack = (app as any)._router.stack as Array<Record<string, unknown>>;
  collectRoutes(stack, '', all);
  // Keep only the versioned surface (drop /health, /openapi.json) and strip /v1
  // so entries line up with openapiDocument paths (declared without the prefix).
  const v1 = new Set<string>();
  for (const entry of all) {
    if (entry.includes(' /v1/')) v1.add(entry.replace(' /v1/', ' /'));
  }
  return v1;
}

function specRoutes(): Set<string> {
  const out = new Set<string>();
  const paths = openapiDocument.paths as Record<string, Record<string, unknown>>;
  for (const [p, ops] of Object.entries(paths)) {
    if (p === '/health') continue;
    for (const m of Object.keys(ops)) {
      if ((HTTP_METHODS as readonly string[]).includes(m)) {
        out.add(`${m.toUpperCase()} ${normalizePath(p)}`);
      }
    }
  }
  return out;
}

// ─── Frozen known-gaps allowlist (72 routes) ─────────────────────────────────
// Routes mounted today but intentionally NOT yet in openapi.ts. Shrink this as
// the spec is backfilled; never grow it silently — a new entry means a new
// endpoint shipped without docs.
const KNOWN_GAPS: readonly string[] = [
  'DELETE /admin/car-brands/{id}',
  'DELETE /admin/car-colors/{id}',
  'DELETE /admin/car-models/{id}',
  'DELETE /cars/{id}',
  'DELETE /passenger-requests/{id}',
  'DELETE /passenger-requests/{id}/like',
  'GET /admin/car-brands',
  'GET /admin/car-colors',
  'GET /admin/car-models',
  'GET /admin/requests',
  'GET /admin/requests/{id}',
  'GET /admin/trips',
  'GET /admin/trips/{id}',
  'GET /admin/whatsapp/conversations',
  'GET /admin/whatsapp/conversations/{id}/messages',
  'GET /auth/telegram/bot-login/status',
  'GET /auth/telegram/link/status',
  'GET /cars',
  'GET /cars/catalog/brands',
  'GET /cars/catalog/brands/{id}/models',
  'GET /cars/catalog/colors',
  'GET /chats/summaries',
  'GET /chats/unread-counts',
  'GET /cities/popular-routes',
  'GET /loyalty/status',
  'GET /loyalty/transactions',
  'GET /passenger-requests',
  'GET /passenger-requests/calendar',
  'GET /passenger-requests/my',
  'GET /passenger-requests/{id}',
  'GET /passenger-requests/{id}/responses',
  'GET /presence/online',
  'GET /trips/calendar',
  'GET /users/me/likes',
  'GET /whatsapp/webhook',
  'PATCH /admin/car-brands/{id}',
  'PATCH /admin/car-colors/{id}',
  'PATCH /admin/car-models/{id}',
  'PATCH /admin/requests/{id}/cancel',
  'PATCH /chats/{booking_id}/read-all',
  'PATCH /drivers/car-photo',
  'PATCH /notifications/read-all',
  'PATCH /passenger-requests/{id}',
  'PATCH /trips/{id}/complete',
  'POST /admin/car-brands',
  'POST /admin/car-colors',
  'POST /admin/car-models',
  'POST /admin/whatsapp/conversations/{id}/reply',
  'POST /auth/admin/change-password',
  'POST /auth/admin/refresh',
  'POST /auth/check-phone',
  'POST /auth/phone/reset-password',
  'POST /auth/register',
  'POST /auth/telegram/bot-login/claim',
  'POST /auth/telegram/bot-login/init',
  'POST /auth/telegram/link/init',
  'POST /auth/telegram/otp/send',
  'POST /cars',
  'POST /passenger-requests',
  'POST /passenger-requests/{id}/contact',
  'POST /passenger-requests/{id}/like',
  'POST /passenger-requests/{id}/respond',
  'POST /passenger-requests/{id}/respond/{responseId}/accept',
  'POST /passenger-requests/{id}/respond/{responseId}/decline',
  'POST /passenger-requests/{id}/view',
  'POST /presence/ping',
  'POST /trips/{id}/contact',
  'POST /trips/{id}/seats',
  'POST /trips/{id}/view',
  'POST /users/me/phone/from-telegram',
  'POST /users/me/phone/send-otp',
  'POST /whatsapp/webhook',
];

describe('OpenAPI coverage drift-guard', () => {
  let mounted: Set<string>;
  let spec: Set<string>;

  beforeAll(() => {
    // createApp only stores the prisma ref in the route factories — no DB call
    // happens at construction, so this is safe without a live connection.
    const app = createApp(testPrisma);
    mounted = mountedV1Routes(app);
    spec = specRoutes();
  });

  it('no NEW route is missing from the spec beyond the frozen known-gaps list', () => {
    const allow = new Set(KNOWN_GAPS);
    const newlyMissing = [...mounted].filter((r) => !spec.has(r) && !allow.has(r)).sort();
    expect(
      newlyMissing,
      `Routes mounted but absent from src/openapi.ts. Add them to the spec, `
        + `or (if intentional) to KNOWN_GAPS in this file:\n${newlyMissing.join('\n')}`,
    ).toEqual([]);
  });

  it('every known gap is still a real mounted route (shrink the list once documented)', () => {
    // A gap that is no longer missing means the spec was backfilled OR the route
    // was removed — either way its line here is stale and should be deleted.
    const stale = KNOWN_GAPS.filter((r) => !mounted.has(r) || spec.has(r)).sort();
    expect(
      stale,
      `These KNOWN_GAPS entries are stale (now documented or route gone) — `
        + `remove them from KNOWN_GAPS:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('every spec path maps to a real mounted route (no stale/renamed endpoints)', () => {
    const orphanSpec = [...spec].filter((r) => !mounted.has(r)).sort();
    expect(
      orphanSpec,
      `Spec declares endpoints with no matching mounted route (renamed/removed?):\n`
        + orphanSpec.join('\n'),
    ).toEqual([]);
  });
});
