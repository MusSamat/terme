import { describe, expect, it } from 'vitest';
import { rankByTarget, suggestPickup, transferMinutes } from './airport.js';

describe('airport helpers', () => {
  it('travel time: km / 50 km/h rounded up to 15 min (min 15)', () => {
    expect(transferMinutes(0)).toBe(15);
    expect(transferMinutes(12.5)).toBe(15);
    expect(transferMinutes(25)).toBe(30);
    expect(transferMinutes(25.1)).toBe(45);
    expect(transferMinutes(60)).toBe(75);
  });

  it('pickup = departure − buffer (intl 150 / domestic 90) − travel', () => {
    const flight = new Date('2026-11-01T06:10:00+06:00');
    const bishkek = { lat: 42.8746, lng: 74.5698 };
    const manas = { lat: 43.0613, lng: 74.4776 };
    const intl = suggestPickup(bishkek, manas, flight, 'international');
    expect(intl.bufferMin).toBe(150);
    expect(intl.travelMin).toBe(30); // ~22 km
    expect(intl.pickupAt.toISOString()).toBe(new Date('2026-11-01T03:10:00+06:00').toISOString());
    const dom = suggestPickup(bishkek, manas, flight, 'domestic');
    expect(dom.bufferMin).toBe(90);
    expect(dom.pickupAt.getTime() - intl.pickupAt.getTime()).toBe(60 * 60_000);
  });

  it('ranks by |departure − target|, ±2h flagged near', () => {
    const t = (hm: string) => new Date(`2026-11-01T${hm}:00+06:00`);
    const rows = ['04:00', '09:00', '10:30', '13:00', '23:00'].map((hm) => ({ hm, at: t(hm) }));
    const ranked = rankByTarget(rows, (r) => r.at, t('10:00'));
    expect(ranked.map((x) => x.row.hm)).toEqual(['10:30', '09:00', '13:00', '04:00', '23:00']);
    expect(ranked.map((x) => x.near)).toEqual([true, true, false, false, false]);
  });
});
