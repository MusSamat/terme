import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { testPrisma } from '../../../tests/setup.js';
import { CITY } from '../../../tests/cities.js';
import { createApp } from '@/server.js';

let app: Express;
beforeEach(() => {
  app = createApp(testPrisma);
});

const search = (q: string) => request(app).get(`/v1/cities?q=${encodeURIComponent(q)}&limit=5`);
const names = (res: request.Response) =>
  (res.body.data as Array<{ nameRu: string }>).map((c) => c.nameRu);

describe('GET /v1/cities — SOATE directory autocomplete', () => {
  it('finds a settlement by RU name, prefix hits first, with raion / oblast for homonyms', async () => {
    const res = await search('кара-су');
    expect(res.status).toBe(200);
    expect(names(res)[0]).toBe('Кара-Суу');
    const village = (res.body.data as Array<{ type: string; raion: unknown; oblast: unknown }>)[0]!;
    expect(village.oblast).toBeTruthy();
  });

  it('matches Kyrgyz spelling and folds ө/ү/ң («озгон» → Узген / Өзгөн)', async () => {
    const res = await search('озгон');
    expect(res.body.data[0]).toMatchObject({ nameRu: 'Узген', nameKg: 'Өзгөн' });
  });

  it('understands Latin and the wrong keyboard layout', async () => {
    expect(names(await search('bishkek'))).toContain('Бишкек');
    expect(names(await search(',birtr'))).toContain('Бишкек');
  });

  it('finds Манас by its former name, with or without Дж', async () => {
    expect(names(await search('Жалал-Абад'))).toContain('Манас');
    expect(names(await search('Джалал-Абад'))).toContain('Манас');
  });

  it('never returns admin units or inactive places', async () => {
    await testPrisma.city.update({ where: { id: CITY['Токмок'] }, data: { isActive: false } });
    try {
      const res = await search('токмок');
      expect(names(res)).not.toContain('Токмок');
      const types = (await search('район')).body.data.map((c: { type: string }) => c.type);
      expect(types).not.toContain('raion');
    } finally {
      await testPrisma.city.update({ where: { id: CITY['Токмок'] }, data: { isActive: true } });
    }
  });

  it('without q returns the most prominent places first', async () => {
    const res = await request(app).get('/v1/cities?limit=2');
    expect(res.body.data.map((c: { type: string }) => c.type)).toEqual(['capital', 'capital']);
  });
});

describe('GET /v1/cities/popular-routes', () => {
  it('carries Kyrgyz names next to the Russian ones', async () => {
    const res = await request(app).get('/v1/cities/popular-routes');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const r of res.body.data) {
      expect(typeof r.fromKg).toBe('string');
      expect(typeof r.toKg).toBe('string');
    }
  });
});

describe('GET /v1/cities/nearest', () => {
  it('maps a GPS point to the settlement it is in', async () => {
    const res = await request(app).get('/v1/cities/nearest?lat=42.874&lng=74.612');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: CITY['Бишкек'], nameRu: 'Бишкек' });
  });

  it('rejects points outside Kyrgyzstan (400)', async () => {
    const res = await request(app).get('/v1/cities/nearest?lat=55.75&lng=37.6');
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/cities/:id/spots', () => {
  it('offers meeting points inside Бишкек, none for a village', async () => {
    const res = await request(app).get(`/v1/cities/${CITY['Бишкек']}/spots`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { nameRu: string }) => s.nameRu)).toContain('Западный автовокзал');
    const asanbay = await request(app).get(`/v1/cities/${CITY['Бишкек']}/spots?q=асанбай`);
    expect(asanbay.body.data).toEqual([expect.objectContaining({ kind: 'area', nameRu: 'Асанбай' })]);
    const none = await request(app).get(`/v1/cities/${CITY['Кант']}/spots`);
    expect(none.body.data).toEqual([]);
  });
});

describe('GET /v1/map', () => {
  it('validates the viewport', async () => {
    const res = await request(app).get('/v1/map?kind=trips&bbox=1,2,3&zoom=10');
    expect(res.status).toBe(400);
  });
});
