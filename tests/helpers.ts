import type { FieldPoint, LandmarkName, PoseSnapshot } from '../src/pose/poseTypes.ts';
import { LANDMARK_NAMES } from '../src/pose/poseTypes.ts';

/**
 * Build a PoseSnapshot with only the landmarks a test cares about. Everything
 * else is parked off-field with zero visibility, so it cannot accidentally
 * trigger anything. Spec §18 wants gameplay tests that never touch a camera.
 */
export function snapshot(
  timestampMs: number,
  parts: Partial<Record<LandmarkName, Partial<FieldPoint>>>,
): PoseSnapshot {
  const landmarks = {} as Record<LandmarkName, FieldPoint>;
  for (const name of LANDMARK_NAMES) {
    landmarks[name] = { x: -1, y: -1, visibility: 0 };
  }
  for (const [name, value] of Object.entries(parts)) {
    landmarks[name as LandmarkName] = {
      x: 0.5,
      y: 0.5,
      visibility: 1,
      ...value,
    };
  }
  return { timestampMs, landmarks };
}
