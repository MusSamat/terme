import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { createApp } from '@/server.js';
import { createUser, jpegBuffer } from '../../../tests/factories.js';

let app: Express;
beforeEach(() => {
  app = createApp(testPrisma);
});

describe('GET /v1/users/me', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/v1/users/me');
    expect(res.status).toBe(401);
  });

  it('returns the caller profile when authenticated', async () => {
    const u = await createUser(testPrisma, { name: 'Asan', language: 'kg' });
    const res = await request(app)
      .get('/v1/users/me')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(u.id);
    expect(res.body.name).toBe('Asan');
    expect(res.body.language).toBe('kg');
    expect(res.body.phoneVerified).toBe(true);
  });

  it('hides rating when ratingCount < 3', async () => {
    const u = await createUser(testPrisma);
    // Default ratingCount=0, rating=0 → service should mask as null
    const res = await request(app)
      .get('/v1/users/me')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(res.body.rating).toBeNull();
  });
});

describe('PATCH /v1/users/me', () => {
  it('updates name + language + terms consent', async () => {
    const u = await createUser(testPrisma);
    const res = await request(app)
      .patch('/v1/users/me')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ name: 'New Name', language: 'kg', termsAccepted: true });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
    expect(res.body.language).toBe('kg');
    expect(res.body.termsAcceptedAt).not.toBeNull();
  });

  it('rejects invalid language', async () => {
    const u = await createUser(testPrisma);
    const res = await request(app)
      .patch('/v1/users/me')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ language: 'en' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /v1/users/me (soft delete)', () => {
  it('nullifies PII, revokes refresh, and blocks future auth', async () => {
    const u = await createUser(testPrisma, { name: 'ToDelete' });
    const del = await request(app)
      .delete('/v1/users/me')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(del.status).toBe(204);

    const row = await testPrisma.user.findUnique({ where: { id: u.id } });
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.name).toBe('Удалённый пользователь');
    expect(row!.phone.startsWith('+del:')).toBe(true);
    expect(row!.telegramId).toBeNull();

    // Subsequent auth check must fail — user effectively gone.
    const after = await request(app)
      .get('/v1/users/me')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(after.status).toBe(401);

    // Refresh tokens revoked
    const tokens = await testPrisma.refreshToken.findMany({ where: { userId: u.id } });
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);
  });
});

describe('GET /v1/users/:id (public)', () => {
  it('returns the public shape (no phone)', async () => {
    const target = await createUser(testPrisma, { name: 'Target' });
    const caller = await createUser(testPrisma);
    const res = await request(app)
      .get(`/v1/users/${target.id}`)
      .set('Authorization', `Bearer ${caller.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(target.id);
    expect(res.body.name).toBe('Target');
    expect(res.body.phone).toBeUndefined();
  });

  it('404 for soft-deleted user', async () => {
    const target = await createUser(testPrisma);
    await testPrisma.user.update({
      where: { id: target.id },
      data: { deletedAt: new Date() },
    });
    const caller = await createUser(testPrisma);
    const res = await request(app)
      .get(`/v1/users/${target.id}`)
      .set('Authorization', `Bearer ${caller.accessToken}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/users/avatar', () => {
  it('uploads a JPEG and sets avatarUrl', async () => {
    const u = await createUser(testPrisma);
    const res = await request(app)
      .post('/v1/users/avatar')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .attach('avatar', jpegBuffer(), { filename: 'me.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toMatch(/\/avatars\/\d{4}\/\d{2}\//);

    // DB stores relative path; API response returns the full URL.
    const row = await testPrisma.user.findUnique({ where: { id: u.id } });
    expect(res.body.avatarUrl).toContain(row!.avatarUrl!);
  });

  it('rejects a text/plain upload', async () => {
    const u = await createUser(testPrisma);
    const res = await request(app)
      .post('/v1/users/avatar')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .attach('avatar', Buffer.from('not an image'), {
        filename: 'x.txt',
        contentType: 'text/plain',
      });
    expect(res.status).toBe(400);
  });

  it('rejects a file where MIME says JPEG but magic bytes say otherwise', async () => {
    const u = await createUser(testPrisma);
    const res = await request(app)
      .post('/v1/users/avatar')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .attach('avatar', Buffer.from('<?php echo "hi"; ?>'), {
        filename: 'x.jpg',
        contentType: 'image/jpeg',
      });
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/cities', () => {
  it('returns active cities', async () => {
    await testPrisma.city.createMany({
      data: [
        { id: 9001, nameRu: 'Бишкек', nameKg: 'Бишкек', nameEn: 'Bishkek', type: 'city', regionId: 7, regionNameRu: 'Бишкек', regionNameKg: 'Бишкек', isActive: true, prompt: [] },
        { id: 9002, nameRu: 'Архив', nameKg: 'Архив', nameEn: 'Arkhiv', type: 'village', regionId: 1, regionNameRu: 'Чуйская область', regionNameKg: 'Чүй облусу', isActive: false, prompt: [] },
      ],
    });
    const res = await request(app).get('/v1/cities');
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { nameRu: string }) => c.nameRu)).toEqual(['Бишкек']);
  });
});
