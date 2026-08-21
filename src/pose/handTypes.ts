/**
 * Hand tracking types. Spec §24 modes may require hands instead of, or as well
 * as, the body — see docs/TRACKING.md for what each backend costs.
 */
import type { FieldPoint } from './poseTypes.ts';

/**
 * MediaPipe's 21-point hand topology, named.
 *
 * Only the points this project uses are named; the rest are reachable by index
 * if a gesture ever needs them.
 */
export const HAND_LANDMARKS = {
  wrist: 0,
  thumbTip: 4,
  indexMcp: 5,
  indexTip: 8,
  middleMcp: 9,
  middleTip: 12,
  ringTip: 16,
  pinkyTip: 20,
} as const;

export type HandLandmarkName = keyof typeof HAND_LANDMARKS;

/** Which hand this is, from the PLAYER's point of view. */
export type Handedness = 'left' | 'right';

export interface HandSnapshot {
  handedness: Handedness;
  /** Confidence in the handedness call, 0–1. */
  handednessScore: number;
  /** All 21 points in field space, mirroring already applied. */
  points: FieldPoint[];
  /** The point used as the hit target. See HAND_HIT_POINT. */
  hit: FieldPoint;
  /** Gesture label from the recogniser, or null when it declined to classify. */
  gesture: string | null;
  gestureScore: number;
}

export interface HandsFrame {
  timestampMs: number;
  hands: HandSnapshot[];
}

/**
 * Which landmark counts as "where the hand is" for hitting a target.
 *
 * The middle-finger knuckle rather than a fingertip: it sits at the centre of
 * the palm, moves with the hand rather than with the fingers, and does not
 * shift when the player opens or closes their hand mid-song. A fingertip is
 * more precise about where it is and much less stable about what it means.
 */
export const HAND_HIT_POINT: HandLandmarkName = 'middleMcp';
