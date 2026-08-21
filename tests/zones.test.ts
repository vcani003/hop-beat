import { describe, expect, it } from 'vitest';
import {
  defaultZones,
  distanceToZone,
  isInsideZone,
  sweptDistanceToZone,
  CORNERS_4,
  findLayout,
  TARGET_LAYOUTS,
  ZONE_IDS,
  type Zone,
} from '../src/game/zones.ts';

const zone = (over: Partial<Zone> = {}): Zone => ({
  id: 'upperLeft',
  label: 'TEST',
  cx: 0.5,
  cy: 0.5,
  radius: 0.1,
  colour: '#fff',
  ...over,
});

describe('distanceToZone', () => {
  it('is plain euclidean distance on a square field', () => {
    expect(distanceToZone({ x: 0.8, y: 0.5 }, zone(), 1)).toBeCloseTo(0.3);
    expect(distanceToZone({ x: 0.5, y: 0.9 }, zone(), 1)).toBeCloseTo(0.4);
  });

  it('is zero at the centre', () => {
    expect(distanceToZone({ x: 0.5, y: 0.5 }, zone(), 16 / 9)).toBe(0);
  });

  /**
   * Aspect correction is the whole reason this function takes an `aspect`.
   * On a 16:9 field, one unit of normalised y is only 9/16 as many pixels as
   * one unit of normalised x, so a vertical offset must count for less.
   */
  it('discounts vertical offsets on a wide field', () => {
    const aspect = 16 / 9;
    const horizontal = distanceToZone({ x: 0.6, y: 0.5 }, zone(), aspect);
    const vertical = distanceToZone({ x: 0.5, y: 0.6 }, zone(), aspect);
    expect(horizontal).toBeCloseTo(0.1);
    expect(vertical).toBeCloseTo(0.1 * (9 / 16));
    expect(vertical).toBeLessThan(horizontal);
  });

  it('describes a circle in PIXELS, not in normalised units', () => {
    const aspect = 16 / 9;
    const z = zone();
    // A point offset purely vertically by radius * aspect sits exactly on the
    // boundary — the same pixel distance as a horizontal offset of radius.
    const onEdgeVertically = { x: z.cx, y: z.cy + z.radius * aspect };
    const onEdgeHorizontally = { x: z.cx + z.radius, y: z.cy };
    expect(distanceToZone(onEdgeVertically, z, aspect)).toBeCloseTo(z.radius);
    expect(distanceToZone(onEdgeHorizontally, z, aspect)).toBeCloseTo(z.radius);
  });
});

describe('isInsideZone', () => {
  const p = (x: number, y: number) => ({ x, y, visibility: 1 });

  it('includes the boundary', () => {
    expect(isInsideZone(p(0.6, 0.5), zone(), 1)).toBe(true);
  });

  it('excludes a point just outside', () => {
    expect(isInsideZone(p(0.601, 0.5), zone(), 1)).toBe(false);
  });

  it('grows the radius by radiusScale, for hysteresis', () => {
    expect(isInsideZone(p(0.62, 0.5), zone(), 1, 1)).toBe(false);
    expect(isInsideZone(p(0.62, 0.5), zone(), 1, 1.3)).toBe(true);
  });
});

describe('defaultZones', () => {
  const zones = defaultZones();

  it('defines exactly the four zones the spec names', () => {
    expect(zones.map((z) => z.id)).toEqual([...ZONE_IDS]);
  });

  it('places every zone fully inside the field', () => {
    for (const z of zones) {
      expect(z.cx - z.radius).toBeGreaterThan(0);
      expect(z.cx + z.radius).toBeLessThan(1);
      expect(z.cy).toBeGreaterThan(0);
      expect(z.cy).toBeLessThan(1);
    }
  });

  it('leaves the centre column clear for the player', () => {
    for (const z of zones) {
      expect(Math.abs(z.cx - 0.5)).toBeGreaterThan(0.2);
    }
  });

  it('never overlaps two zones, even at 1.3x exit radius', () => {
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        const a = zones[i];
        const b = zones[j];
        const gap = Math.hypot(a.cx - b.cx, a.cy - b.cy);
        expect(gap).toBeGreaterThan((a.radius + b.radius) * 1.3);
      }
    }
  });
});

describe('sweptDistanceToZone', () => {
  const p = (x: number, y: number) => ({ x, y });

  it('collapses to point distance when nothing moved', () => {
    const hit = sweptDistanceToZone(p(0.8, 0.5), p(0.8, 0.5), zone(), 1);
    expect(hit.distance).toBeCloseTo(0.3);
    expect(hit.t).toBe(1);
  });

  it('finds the centre crossing of a path that passes through', () => {
    const hit = sweptDistanceToZone(p(0.2, 0.5), p(0.8, 0.5), zone(), 1);
    expect(hit.distance).toBeCloseTo(0);
    expect(hit.t).toBeCloseTo(0.5);
  });

  it('reports where along the path the closest approach happened', () => {
    const hit = sweptDistanceToZone(p(0.5, 0.5), p(1.0, 0.5), zone(), 1);
    expect(hit.t).toBeCloseTo(0); // it starts at the centre and leaves
  });

  it('never reports a point beyond the ends of the segment', () => {
    // The centre is behind the start, so the closest reachable point is t=0.
    const hit = sweptDistanceToZone(p(0.6, 0.5), p(0.9, 0.5), zone(), 1);
    expect(hit.t).toBe(0);
    expect(hit.distance).toBeCloseTo(0.1);
  });

  it('applies aspect correction like the point-distance test does', () => {
    const aspect = 16 / 9;
    const still = sweptDistanceToZone(p(0.5, 0.6), p(0.5, 0.6), zone(), aspect);
    expect(still.distance).toBeCloseTo(distanceToZone(p(0.5, 0.6), zone(), aspect));
  });
});

describe('target layouts — spec §24', () => {
  /**
   * "Every layout ships with a test that all of its targets fit on screen."
   * A layout is a promise that these coordinates are playable; a target
   * hanging off the edge breaks that promise for every chart that names it.
   */
  it('keeps every target of every layout fully on screen', () => {
    for (const layout of TARGET_LAYOUTS) {
      for (const zone of layout.build()) {
        expect(zone.cx - zone.radius, `${layout.id}/${zone.id} left`).toBeGreaterThanOrEqual(0);
        expect(zone.cx + zone.radius, `${layout.id}/${zone.id} right`).toBeLessThanOrEqual(1);
        expect(zone.cy - zone.radius, `${layout.id}/${zone.id} top`).toBeGreaterThanOrEqual(0);
        expect(zone.cy + zone.radius, `${layout.id}/${zone.id} bottom`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('gives every layout a unique id', () => {
    const ids = TARGET_LAYOUTS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /** A caller must not be able to mutate the canonical layout. */
  it('hands out a fresh copy of the zones each time', () => {
    const first = CORNERS_4.build();
    first[0].cx = 0.999;
    expect(CORNERS_4.build()[0].cx).toBe(0.2);
  });

  it('falls back to four corners for an unknown or missing id', () => {
    expect(findLayout(undefined).id).toBe('corners4');
    expect(findLayout('does-not-exist').id).toBe('corners4');
    expect(findLayout('corners4')).toBe(CORNERS_4);
  });
});
