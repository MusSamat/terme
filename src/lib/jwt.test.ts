import { describe, expect, it } from 'vitest';
import {
  refreshTtlSeconds,
  signAccessToken,
  signAdminAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyAdminAccessToken,
  verifyRefreshToken,
} from './jwt.js';
import { AppError } from './errors.js';

describe('jwt', () => {
  it('signs and verifies an access token', () => {
    const token = signAccessToken({
      sub: '00000000-0000-0000-0000-000000000001',
      phone: '+996700111222',
      roles: ['passenger'],
    });
    const decoded = verifyAccessToken(token);
    expect(decoded.sub).toBe('00000000-0000-0000-0000-000000000001');
    expect(decoded.roles).toEqual(['passenger']);
  });

  it('refuses to verify an access token as refresh', () => {
    const token = signAccessToken({
      sub: 'u',
      phone: '+996700111222',
      roles: ['passenger'],
    });
    expect(() => verifyRefreshToken(token)).toThrow(AppError);
  });

  it('signs and verifies a refresh token', () => {
    const ttl = refreshTtlSeconds();
    expect(ttl).toBeGreaterThan(60 * 60);
    const token = signRefreshToken({ sub: 'u1', tokenId: 't1' }, ttl);
    const decoded = verifyRefreshToken(token);
    expect(decoded.tokenId).toBe('t1');
  });

  it('isolates admin token kind', () => {
    const adminToken = signAdminAccessToken({
      sub: 'a1',
      email: 'x@y.z',
      role: 'admin',
    });
    expect(() => verifyAccessToken(adminToken)).toThrow(AppError);
    const decoded = verifyAdminAccessToken(adminToken);
    expect(decoded.role).toBe('admin');
  });

  it('throws TOKEN_EXPIRED for an expired token', () => {
    // Sign with a negative TTL — library accepts numeric expiresIn in seconds.
    const token = signRefreshToken({ sub: 'u', tokenId: 't' }, -1);
    expect(() => verifyRefreshToken(token)).toThrow(/expired/i);
  });

  it('refresh TTL is the 30-day inactivity window (v2.1 §7.3)', () => {
    expect(refreshTtlSeconds()).toBe(30 * 24 * 60 * 60);
  });
});
