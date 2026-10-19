import { describe, expect, it } from 'vitest';
import {
  refreshTtlSeconds,
  signAccessToken,
  signAdminAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyAdminAccessToken,
  verifyRefreshToken,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './jwt.js';
import { AppError } from './errors.js';
import jwt from 'jsonwebtoken';
import { env } from '@/config/env.js';

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

  describe('issuer / audience', () => {
    const legacy = (payload: object, secret: string) =>
      jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: 600 });

    it('signs iss + aud per token kind', () => {
      const decoded = jwt.decode(
        signAccessToken({ sub: 'u', phone: '+996700111222', roles: ['passenger'] }),
      ) as jwt.JwtPayload;
      expect(decoded.iss).toBe(JWT_ISSUER);
      expect(decoded.aud).toBe(JWT_AUDIENCE.access);
    });

    it('a legacy access token without iss/aud → TOKEN_EXPIRED (client refreshes)', () => {
      const token = legacy({ sub: 'u', phone: 'x', roles: [], kind: 'access' }, env.JWT_ACCESS_SECRET);
      expect(() => verifyAccessToken(token)).toThrow(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
    });

    it('a legacy refresh token without iss/aud is still accepted', () => {
      const token = legacy({ sub: 'u', tokenId: 't', kind: 'refresh' }, env.JWT_REFRESH_SECRET);
      expect(verifyRefreshToken(token).tokenId).toBe('t');
    });

    it('a wrong audience is rejected even on refresh tokens', () => {
      const token = jwt.sign({ sub: 'u', tokenId: 't', kind: 'refresh' }, env.JWT_REFRESH_SECRET, {
        algorithm: 'HS256',
        expiresIn: 600,
        issuer: JWT_ISSUER,
        audience: 'someone-else',
      });
      expect(() => verifyRefreshToken(token)).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }));
    });
  });
});
