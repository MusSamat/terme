import type { Request, RequestHandler, Response, CookieOptions } from 'express';
import { env, isProd } from '@/config/env.js';

/**
 * HttpOnly refresh-token cookies for the Web + Admin clients (TZ §5/§26.1:
 * "Refresh token · Web — HttpOnly + Secure + SameSite=Strict cookie").
 *
 * Mobile / Mini App keep sending the refresh token in the request body
 * (channel = 'mobile'); only requests with channel = 'web' use the cookie.
 *
 * Reading is done by hand (parse the Cookie header) so we don't pull in a new
 * dependency — cookie-parser is not in the approved stack.
 */

export const REFRESH_COOKIE = {
  user: 'terme_rt',
  admin: 'terme_admin_rt',
  // Scope the cookie to the auth endpoints only — it is never sent to the rest
  // of the API (which authenticates with the in-memory access token).
  path: '/v1/auth',
} as const;

// Dev tunnels (two *.trycloudflare.com hosts) put the web client and the API on
// different sites — browsers drop SameSite=Lax/Strict cookies there, killing the
// silent refresh. For a secure cross-site request in dev, fall back to
// SameSite=None; Secure. Same-site dev (localhost→localhost) and prod unchanged.
function isCrossSiteSecure(req?: Request): boolean {
  if (!req?.headers.origin) return false;
  try {
    const originHost = new URL(req.headers.origin).hostname;
    return originHost !== req.hostname && req.protocol === 'https';
  } catch {
    return false;
  }
}

function baseOptions(req?: Request): CookieOptions {
  if (!isProd && isCrossSiteSecure(req)) {
    return { httpOnly: true, secure: true, sameSite: 'none', path: REFRESH_COOKIE.path };
  }
  return {
    httpOnly: true,
    secure: isProd, // dev runs on http://localhost
    sameSite: isProd ? 'strict' : 'lax',
    path: REFRESH_COOKIE.path,
  };
}

export function setRefreshCookie(res: Response, name: string, token: string, req?: Request): void {
  const maxAge =
    name === REFRESH_COOKIE.admin
      ? env.ADMIN_REFRESH_TTL_HOURS * 60 * 60 * 1000
      : env.JWT_REFRESH_INACTIVITY_DAYS * 24 * 60 * 60 * 1000;
  res.cookie(name, token, { ...baseOptions(req), maxAge });
}

export function clearRefreshCookie(res: Response, name: string, req?: Request): void {
  res.clearCookie(name, baseOptions(req));
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * Middleware for routers that return token pairs (auth, users). When the
 * request is channel='web', it moves any `refreshToken` from the JSON body into
 * an HttpOnly cookie so the token never reaches client-side JS. Admin routes
 * (path contains '/admin') get the admin-scoped cookie. No-op for mobile.
 */
export function webRefreshCookie(): RequestHandler {
  return (req, res, next) => {
    if ((req.body as { channel?: string } | undefined)?.channel !== 'web') return next();
    const cookieName = req.path.includes('/admin') ? REFRESH_COOKIE.admin : REFRESH_COOKIE.user;
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (body && typeof body === 'object' && 'refreshToken' in (body as object)) {
        const b = body as Record<string, unknown>;
        if (typeof b.refreshToken === 'string' && b.refreshToken) {
          setRefreshCookie(res, cookieName, b.refreshToken, req);
        }
        const { refreshToken: _omit, ...rest } = b;
        return originalJson(rest);
      }
      return originalJson(body);
    }) as typeof res.json;
    next();
  };
}
