import { describe, expect, it } from 'vitest';
import { POSE_LANDMARKS } from '../src/pose/poseTypes.ts';
import {
  isInFrame,
  toFieldSpace,
  toPixels,
  toPoseSnapshot,
  type RawLandmark,
} from '../src/pose/transforms.ts';

const raw = (x: number, y: number, visibility = 1): RawLandmark => ({ x, y, z: 0, visibility });

/** 33 landmarks, each encoding its own index so mapping errors are visible. */
const rawPose = (): RawLandmark[] =>
  Array.from({ length: 33 }, (_, i) => raw(i / 100, 1 - i / 100, 0.9));

describe('toFieldSpace', () => {
  it('is the identity on x when not mirrored', () => {
    expect(toFieldSpace(raw(0.2, 0.7), false)).toEqual({ x: 0.2, y: 0.7, visibility: 1 });
  });

  it('flips x when mirrored', () => {
    expect(toFieldSpace(raw(0.2, 0.7), true).x).toBeCloseTo(0.8);
  });

  it('never touches y — gravity is not mirrored', () => {
    expect(toFieldSpace(raw(0.2, 0.7), true).y).toBe(0.7);
  });

  it('is its own inverse', () => {
    const once = toFieldSpace(raw(0.31, 0.42), true);
    const twice = toFieldSpace({ ...once, z: 0 }, true);
    expect(twice.x).toBeCloseTo(0.31);
  });

  it('carries visibility through untouched', () => {
    expect(toFieldSpace(raw(0.5, 0.5, 0.23), true).visibility).toBe(0.23);
  });
});

describe('anatomical left/right vs screen left/right', () => {
  /**
   * The bug this test exists to prevent: a player faces the camera and raises
   * their own left hand. Because the camera sees them face-on, that hand
   * appears on the RIGHT side of the raw image. Mirroring must put it back on
   * the LEFT of the screen, where the player sees their own hand — while the
   * landmark stays named `leftWrist` throughout.
   */
  it('puts the player’s left wrist on the left of a mirrored screen', () => {
    const pose = rawPose();
    pose[POSE_LANDMARKS.leftWrist] = raw(0.75, 0.4); // right side of raw image

    const mirrored = toPoseSnapshot(pose, 0, true);
    expect(mirrored.landmarks.leftWrist.x).toBeCloseTo(0.25); // left of screen

    const unmirrored = toPoseSnapshot(pose, 0, false);
    expect(unmirrored.landmarks.leftWrist.x).toBeCloseTo(0.75);
  });
});

describe('toPoseSnapshot', () => {
  it('maps MediaPipe indices onto the right names', () => {
    const snap = toPoseSnapshot(rawPose(), 1234, false);
    expect(snap.landmarks.nose.x).toBeCloseTo(0);
    expect(snap.landmarks.leftWrist.x).toBeCloseTo(POSE_LANDMARKS.leftWrist / 100);
    expect(snap.landmarks.rightWrist.x).toBeCloseTo(POSE_LANDMARKS.rightWrist / 100);
    expect(snap.landmarks.rightFootIndex.x).toBeCloseTo(0.32);
  });

  it('preserves the timestamp it was given', () => {
    expect(toPoseSnapshot(rawPose(), 1234, false).timestampMs).toBe(1234);
  });

  it('yields zero-visibility placeholders when the model returns nothing', () => {
    const snap = toPoseSnapshot([], 0, true);
    expect(snap.landmarks.leftWrist).toEqual({ x: 0, y: 0, visibility: 0 });
  });
});

describe('isInFrame', () => {
  it('accepts points on the boundary', () => {
    expect(isInFrame({ x: 0, y: 0, visibility: 1 })).toBe(true);
    expect(isInFrame({ x: 1, y: 1, visibility: 1 })).toBe(true);
  });

  it('rejects landmarks MediaPipe extrapolated past the frame', () => {
    expect(isInFrame({ x: -0.05, y: 0.5, visibility: 1 })).toBe(false);
    expect(isInFrame({ x: 0.5, y: 1.2, visibility: 1 })).toBe(false);
  });
});

describe('toPixels', () => {
  it('scales field space onto a canvas', () => {
    expect(toPixels({ x: 0.5, y: 0.25 }, 1280, 720)).toEqual({ x: 640, y: 180 });
  });
});
