import { describe, expect, it } from 'vitest';
import { resolveHandedness } from '../src/pose/HandTrackingProvider.ts';
import { handsToPoseSnapshot } from '../src/pose/handsToPose.ts';

/**
 * Handedness is the same trap as anatomical left/right in transforms.ts: get
 * it wrong and everything still works, left and right are simply swapped, and
 * it surfaces only as a chart demanding the wrong hand.
 */
describe('resolveHandedness', () => {
  it('is stable for a mirrored preview, which is what the player sees', () => {
    expect(resolveHandedness('Left', true)).toBe('left');
    expect(resolveHandedness('Right', true)).toBe('right');
  });

  it('inverts when the preview is not mirrored', () => {
    expect(resolveHandedness('Left', false)).toBe('right');
    expect(resolveHandedness('Right', false)).toBe('left');
  });

  it('is case-insensitive about the label', () => {
    expect(resolveHandedness('left', true)).toBe('left');
    expect(resolveHandedness('LEFT', true)).toBe('left');
  });

  it('never returns undefined for a missing label', () => {
    expect(['left', 'right']).toContain(resolveHandedness(undefined, true));
    expect(['left', 'right']).toContain(resolveHandedness('', false));
  });

  it('always disagrees with itself across the mirror', () => {
    for (const label of ['Left', 'Right']) {
      expect(resolveHandedness(label, true)).not.toBe(resolveHandedness(label, false));
    }
  });
});

describe('handsToPoseSnapshot', () => {
  const hand = (handedness: 'left' | 'right', x: number, y: number, score = 0.9) => ({
    handedness,
    handednessScore: score,
    points: [],
    hit: { x, y, visibility: 1 },
    gesture: null,
    gestureScore: 0,
  });

  it('puts each hand in the slot the tracker watches', () => {
    const snap = handsToPoseSnapshot(1234, [hand('left', 0.2, 0.3), hand('right', 0.8, 0.3)]);
    expect(snap.timestampMs).toBe(1234);
    expect(snap.landmarks.leftWrist).toMatchObject({ x: 0.2, y: 0.3 });
    expect(snap.landmarks.rightWrist).toMatchObject({ x: 0.8, y: 0.3 });
  });

  /**
   * A mode that wrongly depends on a body landmark should fail visibly, not
   * read a plausible-looking zero.
   */
  it('marks every body landmark explicitly absent', () => {
    const snap = handsToPoseSnapshot(0, [hand('left', 0.2, 0.3)]);
    expect(snap.landmarks.leftShoulder.visibility).toBe(0);
    expect(snap.landmarks.leftHip.visibility).toBe(0);
    expect(snap.landmarks.rightWrist.visibility).toBe(0);
  });

  it('keeps the more confident of two hands classified the same way', () => {
    const snap = handsToPoseSnapshot(0, [
      hand('left', 0.2, 0.3, 0.55),
      hand('left', 0.9, 0.9, 0.95),
    ]);
    expect(snap.landmarks.leftWrist.x).toBe(0.9);
  });

  it('produces a usable snapshot from no hands at all', () => {
    const snap = handsToPoseSnapshot(0, []);
    expect(snap.landmarks.leftWrist.visibility).toBe(0);
    expect(Object.keys(snap.landmarks).length).toBeGreaterThan(30);
  });
});
