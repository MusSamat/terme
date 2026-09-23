import * as Sentry from '@sentry/node';
import { env } from '@/config/env.js';
import { logger } from '@/lib/logger.js';

// Sentry is fully DSN-gated: with SENTRY_DSN empty (dev / CI / tests) init() is a
// no-op and captureException() below silently returns, so there is zero behaviour
// change and no network I/O. Enable it only by setting SENTRY_DSN in prod/staging.
let initialised = false;

/** Initialise Sentry once at startup, only when a DSN is configured. */
export function initSentry(): void {
  if (initialised || !env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    // Error tracking only — no performance tracing for the MVP.
    tracesSampleRate: 0,
  });
  initialised = true;
  logger.info('Sentry initialised');
}

export function sentryEnabled(): boolean {
  return initialised;
}

/** Capture an exception when Sentry is active; inert otherwise. */
export function captureException(err: unknown): void {
  if (!initialised) return;
  Sentry.captureException(err);
}
