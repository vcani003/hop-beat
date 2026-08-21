import { describe, expect, it } from 'vitest';
import {
  clampZoneScale,
  handSpanSizing,
  MAX_ZONE_SCALE,
  MIN_ZONE_SCALE,
  stepZoneScale,
  zoneScaleForKey,
} from '../src/game/targetSizing.ts';
import { snapshot } from './helpers.ts';

const ASPECT = 16 / 9;

describe('clampZoneScale', () => {
  it('keeps size inside a usable range', () => {
    expect(clampZoneScale(0.01)).toBe(MIN_ZONE_SCALE);
    expect(clampZoneScale(99)).toBe(MAX_ZONE_SCALE);
    expect(clampZoneScale(1.2)).toBe(1.2);
  });
});

describe('stepZoneScale', () => {
  it('moves by one step at a time', () => {
    expect(stepZoneScale(1.0, 1)).toBeCloseTo(1.05);
    expect(stepZoneScale(1.0, -1)).toBeCloseTo(0.95);
  });

  it('stays on tidy increments however it started', () => {
    expect(stepZoneScale(0.6231, 1)).toBeCloseTo(0.65);
  });

  it('stops at the ends rather than running past them', () => {
    expect(stepZoneScale(MIN_ZONE_SCALE, -5)).toBe(MIN_ZONE_SCALE);
    expect(stepZoneScale(MAX_ZONE_SCALE, 5)).toBe(MAX_ZONE_SCALE);
  });
});

describe('zoneScaleForKey', () => {
  it('grows and shrinks on either key pair', () => {
    expect(zoneScaleForKey(']', 1.0)).toBeCloseTo(1.05);
    expect(zoneScaleForKey('=', 1.0)).toBeCloseTo(1.05);
    expect(zoneScaleForKey('[', 1.0)).toBeCloseTo(0.95);
    expect(zoneScaleForKey('-', 1.0)).toBeCloseTo(0.95);
  });

  it('ignores keys that mean nothing here', () => {
    for (const key of ['a', 'Enter', ' ', 'ArrowUp']) {
      expect(zoneScaleForKey(key, 1.0), key).toBeNull();
    }
  });
});

describe('handSpanSizing', () => {
  const hands = (leftX: number, rightX: number, leftY = 0.5, rightY = 0.5, visibility = 1) =>
    snapshot(0, {
      leftWrist: { x: leftX, y: leftY, visibility },
      rightWrist: { x: rightX, y: rightY, visibility },
    });

  it('reads nothing from a missing pose', () => {
    expect(handSpanSizing(null, ASPECT)).toBeNull();
  });

  it('reads nothing when a wrist is not confidently seen', () => {
    expect(handSpanSizing(hands(0.3, 0.7, 0.5, 0.5, 0.1), ASPECT)).toBeNull();
  });

  /**
   * The guard that stops this firing during ordinary play: arms at different
   * heights are reaching for something, not measuring something.
   */
  it('ignores hands that are not roughly level', () => {
    expect(handSpanSizing(hands(0.3, 0.7, 0.2, 0.9), ASPECT)).toBeNull();
  });

  it('accepts hands that are close enough to level', () => {
    expect(handSpanSizing(hands(0.3, 0.7, 0.5, 0.56), ASPECT)).not.toBeNull();
  });

  it('turns the span between the hands into the target diameter', () => {
    // A 0.15 span is a 0.075 radius, which is exactly scale 1.0.
    const sizing = handSpanSizing(hands(0.425, 0.575), ASPECT)!;
    expect(sizing.scale).toBeCloseTo(1.0, 2);
  });

  it('grows as the hands move apart', () => {
    const narrow = handSpanSizing(hands(0.45, 0.55), ASPECT)!;
    const wide = handSpanSizing(hands(0.3, 0.7), ASPECT)!;
    expect(wide.scale).toBeGreaterThan(narrow.scale);
  });

  it('is clamped to the same range as every other route in', () => {
    expect(handSpanSizing(hands(0.0, 1.0), ASPECT)!.scale).toBe(MAX_ZONE_SCALE);
    expect(handSpanSizing(hands(0.499, 0.501), ASPECT)!.scale).toBe(MIN_ZONE_SCALE);
  });

  it('reports the midpoint so the gesture can be drawn', () => {
    const sizing = handSpanSizing(hands(0.3, 0.7), ASPECT)!;
    expect(sizing.centre.x).toBeCloseTo(0.5);
    expect(sizing.spanX).toBeCloseTo(0.4);
  });

  it('does not care which hand is on which side', () => {
    const a = handSpanSizing(hands(0.3, 0.7), ASPECT)!;
    const b = handSpanSizing(hands(0.7, 0.3), ASPECT)!;
    expect(b.scale).toBeCloseTo(a.scale);
  });
});
