/**
 * Present hand tracking as a PoseSnapshot.
 *
 * The engine, the zone tracker, the judge and the scorer all consume
 * PoseSnapshot and none of them import MediaPipe — that boundary was set in
 * MVP 0. Adapting hands to fit it means a hands mode plays the SAME charts
 * through the SAME judgment as the body mode, which is the only way a
 * comparison between them means anything.
 *
 * The hands occupy the `leftWrist` / `rightWrist` slots because those are what
 * the tracker watches. The name is now slightly wrong — the point is the palm,
 * not the wrist — but inventing a parallel limb vocabulary to fix a name would
 * fork the engine for no gain.
 */
import type { FieldPoint, LandmarkName, PoseSnapshot } from './poseTypes.ts';
import { LANDMARK_NAMES } from './poseTypes.ts';
import type { HandSnapshot } from './handTypes.ts';

const ABSENT: FieldPoint = { x: -1, y: -1, visibility: 0 };

export function handsToPoseSnapshot(
  timestampMs: number,
  hands: readonly HandSnapshot[],
): PoseSnapshot {
  const landmarks = {} as Record<LandmarkName, FieldPoint>;
  // Everything the hand model cannot see is explicitly absent rather than
  // absent-by-omission, so a mode that wrongly depends on a body landmark
  // fails visibly instead of reading a stale zero.
  for (const name of LANDMARK_NAMES) landmarks[name] = { ...ABSENT };

  for (const hand of hands) {
    const slot: LandmarkName = hand.handedness === 'left' ? 'leftWrist' : 'rightWrist';
    // Two hands classified the same way: keep the more confident one rather
    // than letting the later one silently win.
    const existing = landmarks[slot];
    if (existing.visibility > 0 && existing.visibility >= hand.handednessScore) continue;
    landmarks[slot] = { ...hand.hit, visibility: Math.max(hand.handednessScore, 0.5) };
  }

  return { timestampMs, landmarks };
}
