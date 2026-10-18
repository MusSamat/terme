import { describe, expect, it } from 'vitest';
import { estimateDurationMin, lookupRoute } from './routes.js';

describe('route reference', () => {
  it('is symmetric (A→B == B→A)', () => {
    const ab = lookupRoute('Бишкек', 'Ош');
    const ba = lookupRoute('Ош', 'Бишкек');
    expect(ab).not.toBeNull();
    expect(ab).toEqual(ba);
  });

  it('knows launch routes', () => {
    expect(lookupRoute('Бишкек', 'Ош')?.durationMin).toBe(600);
    expect(lookupRoute('Бишкек', 'Каракол')?.durationMin).toBe(360);
    expect(lookupRoute('Бишкек', 'Нарын')?.durationMin).toBe(300);
  });

  it('uses the reference table for known pairs', () => {
    const bishkek = { nameRu: 'Бишкек', lat: 42.87, lng: 74.6 };
    const osh = { nameRu: 'Ош', lat: 40.52, lng: 72.8 };
    expect(estimateDurationMin(bishkek, osh)).toBe(600);
  });

  it('estimates unknown pairs from coordinates (road factor, 60 km/h)', () => {
    const a = { nameRu: 'A', lat: 42.0, lng: 74.0 };
    const b = { nameRu: 'B', lat: 42.0, lng: 75.0 }; // ≈ 82.6 km straight
    expect(estimateDurationMin(a, b)).toBe(115);
    expect(estimateDurationMin(a, { nameRu: 'C', lat: 42.0, lng: 74.01 })).toBe(30);
  });

  it('falls back without coordinates', () => {
    const a = { nameRu: 'A', lat: null, lng: null };
    expect(estimateDurationMin(a, a)).toBe(240);
    expect(estimateDurationMin(a, a, 999)).toBe(999);
  });
});
