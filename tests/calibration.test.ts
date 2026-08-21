import { describe, expect, it } from 'vitest';
import { applyCalibration, calibrationFromPose, describeCalibration } from '../src/game/calibration.ts';
import { defaultZones } from '../src/game/zones.ts';
import { snapshot } from './helpers.ts';

const ASPECT = 16 / 9;

/** A person standing square to the camera, centred at `centreX`. */
const standing = (
  timestampMs: number,
  { centreX = 0.5, shoulderWidth = 0.16, shoulderY = 0.35, hipY = 0.62, visibility = 1 } = {},
) =>
  snapshot(timestampMs, {
    leftShoulder: { x: centreX - shoulderWidth / 2, y: shoulderY, visibility },
    rightShoulder: { x: centreX + shoulderWidth / 2, y: shoulderY, visibility },
    leftHip: { x: centreX - shoulderWidth / 3, y: hipY, visibility },
    rightHip: { x: centreX + shoulderWidth / 3, y: hipY, visibility },
  });

describe('calibrationFromPose', () => {
  it('returns null when nobody is in view', () => {
    expect(calibrationFromPose([snapshot(0, {})], ASPECT)).toBeNull();
  });

  it('returns null rather than guessing from low-confidence landmarks', () => {
    expect(calibrationFromPose([standing(0, { visibility: 0.2 })], ASPECT)).toBeNull();
  });

  it('ignores a frame where the shoulders have collapsed together', () => {
    expect(calibrationFromPose([standing(0, { shoulderWidth: 0.001 })], ASPECT)).toBeNull();
  });

  it('centres the field on the player, not on the screen', () => {
    const left = calibrationFromPose([standing(0, { centreX: 0.3 })], ASPECT)!;
    expect(left.centreX).toBeCloseTo(0.3);
  });

  it('scales the field with the player, so standing further back shrinks it', () => {
    const near = calibrationFromPose([standing(0, { shoulderWidth: 0.24 })], ASPECT)!;
    const far = calibrationFromPose([standing(0, { shoulderWidth: 0.10 })], ASPECT)!;
    expect(far.halfWidth).toBeLessThan(near.halfWidth);
  });

  /** One bad frame must not drag the whole field with it. */
  it('uses medians, so a single misplaced shoulder cannot move the field', () => {
    const good = [standing(0), standing(33), standing(66), standing(132)];
    const withOutlier = [...good, standing(99, { centreX: 0.05, shoulderWidth: 0.5 })];
    const clean = calibrationFromPose(good, ASPECT)!;
    const noisy = calibrationFromPose(withOutlier, ASPECT)!;
    expect(noisy.centreX).toBeCloseTo(clean.centreX, 2);
    expect(noisy.halfWidth).toBeCloseTo(clean.halfWidth, 2);
  });

  it('spans from above the shoulders to below the hips', () => {
    const cal = calibrationFromPose([standing(0, { shoulderY: 0.35, hipY: 0.62 })], ASPECT)!;
    expect(cal.centreY).toBeGreaterThan(0.35);
    expect(cal.centreY).toBeLessThan(0.62);
    expect(cal.halfHeight).toBeGreaterThan(0.1);
  });
});

describe('applyCalibration', () => {
  it('leaves zones untouched when there is no calibration', () => {
    expect(applyCalibration(defaultZones(), null)).toEqual(defaultZones());
  });

  /**
   * The reported bug, as a test: a player standing left of centre could not
   * reach the bottom-right target. After calibration every zone must sit
   * inside their reach.
   */
  it('brings every zone inside the reach of an off-centre player', () => {
    const cal = calibrationFromPose(
      [standing(0, { centreX: 0.36, shoulderWidth: 0.13 })],
      ASPECT,
    )!;
    const zones = applyCalibration(defaultZones(), cal);

    for (const zone of zones) {
      const dx = Math.abs(zone.cx - cal.centreX);
      const dy = Math.abs(zone.cy - cal.centreY);
      expect(dx, `${zone.id} horizontal`).toBeLessThanOrEqual(cal.halfWidth + 1e-9);
      expect(dy, `${zone.id} vertical`).toBeLessThanOrEqual(cal.halfHeight + 1e-9);
    }
  });

  it('moves the whole layout with the player', () => {
    const centred = applyCalibration(defaultZones(), calibrationFromPose([standing(0, { centreX: 0.5 })], ASPECT));
    const shifted = applyCalibration(defaultZones(), calibrationFromPose([standing(0, { centreX: 0.35 })], ASPECT));
    for (let i = 0; i < centred.length; i++) {
      expect(shifted[i].cx).toBeCloseTo(centred[i].cx - 0.15, 5);
    }
  });

  it('scales target size with the field, not with the room', () => {
    const near = applyCalibration(defaultZones(), calibrationFromPose([standing(0, { shoulderWidth: 0.24 })], ASPECT));
    const far = applyCalibration(defaultZones(), calibrationFromPose([standing(0, { shoulderWidth: 0.10 })], ASPECT));
    expect(far[0].radius).toBeLessThan(near[0].radius);
  });

  it('keeps zones on screen even for a player standing at the edge', () => {
    const cal = calibrationFromPose([standing(0, { centreX: 0.9, shoulderWidth: 0.2 })], ASPECT)!;
    for (const zone of applyCalibration(defaultZones(), cal)) {
      expect(zone.cx).toBeGreaterThanOrEqual(0);
      expect(zone.cx).toBeLessThanOrEqual(1);
      expect(zone.cy).toBeGreaterThanOrEqual(0);
      expect(zone.cy).toBeLessThanOrEqual(1);
    }
  });

  it('preserves zone identity and ordering', () => {
    const cal = calibrationFromPose([standing(0)], ASPECT);
    expect(applyCalibration(defaultZones(), cal).map((z) => z.id)).toEqual(
      defaultZones().map((z) => z.id),
    );
  });
});

describe('describeCalibration', () => {
  it('says so plainly when uncalibrated', () => {
    expect(describeCalibration(null)).toMatch(/not calibrated/);
  });

  it('reports the fitted width', () => {
    const cal = calibrationFromPose([standing(0)], ASPECT)!;
    expect(describeCalibration(cal)).toMatch(/% of frame width/);
  });
});
