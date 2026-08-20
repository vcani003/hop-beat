/**
 * Camera space -> field space. Pure functions, no DOM, no MediaPipe types.
 *
 * MediaPipe hands back "normalized" landmarks already in 0–1, but they are
 * normalized to the CAMERA IMAGE, which is not mirrored. A webcam preview shown
 * unmirrored feels wrong to move in: you reach left and the figure reaches
 * right. So we mirror for display — and the moment we do, the coordinate
 * transform has to be explicit and tested, or left/right bugs become permanent.
 * Spec §6.
 */
import type { FieldPoint, LandmarkName, PoseSnapshot } from './poseTypes.ts';
import { LANDMARK_NAMES, POSE_LANDMARKS } from './poseTypes.ts';

/** The shape MediaPipe gives us, restated so this module imports nothing. */
export interface RawLandmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

/**
 * Mirror a single landmark into field space.
 *
 * Mirroring is a horizontal flip: x -> 1 - x. y is untouched, because gravity
 * is not negotiable.
 *
 * The consequence worth internalising: after mirroring, the player's ANATOMICAL
 * left wrist sits on the LEFT of the screen, which is what a person expects
 * when they look at themselves. The landmark is still called `leftWrist`. The
 * name never changes; only where it lands does.
 */
export function toFieldSpace(landmark: RawLandmark, mirrored: boolean): FieldPoint {
  return {
    x: mirrored ? 1 - landmark.x : landmark.x,
    y: landmark.y,
    visibility: landmark.visibility,
  };
}

/**
 * Turn one MediaPipe result into a PoseSnapshot.
 *
 * `timestampMs` must be the camera frame's own time. Passing the time at which
 * inference *finished* would silently bake ~30 ms of lag into every future
 * timing judgment.
 */
export function toPoseSnapshot(
  raw: readonly RawLandmark[],
  timestampMs: number,
  mirrored: boolean,
): PoseSnapshot {
  const landmarks = {} as Record<LandmarkName, FieldPoint>;
  for (const name of LANDMARK_NAMES) {
    const lm = raw[POSE_LANDMARKS[name]];
    landmarks[name] = lm
      ? toFieldSpace(lm, mirrored)
      : { x: 0, y: 0, visibility: 0 };
  }
  return { timestampMs, landmarks };
}

/**
 * Is this point actually inside the camera's view?
 *
 * MediaPipe happily extrapolates landmarks past the frame edge — it will guess
 * where your hand went after it left the picture. Those guesses are not input.
 */
export function isInFrame(p: FieldPoint): boolean {
  return p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
}

/** Field space -> pixels, for drawing onto a canvas of a given size. */
export function toPixels(
  p: { x: number; y: number },
  width: number,
  height: number,
): { x: number; y: number } {
  return { x: p.x * width, y: p.y * height };
}
