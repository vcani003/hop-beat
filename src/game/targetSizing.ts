/**
 * Changing target size without leaving the game.
 *
 * Spec §24 allows this explicitly: size is an accessibility and difficulty
 * setting, and adjusting it neither moves a target nor changes which layout is
 * in use. Position is not adjustable; size is.
 *
 * The reason it has to be reachable mid-play is the reported one — targets felt
 * a little small, and hunting through a settings panel while a song runs is not
 * a real option. So there are two ways in: a key, and a gesture.
 */
import type { PoseSnapshot } from '../pose/poseTypes.ts';

export const MIN_ZONE_SCALE = 0.5;
export const MAX_ZONE_SCALE = 2.0;
export const ZONE_SCALE_STEP = 0.05;

/** The radius the default layout uses at scale 1.0, in field-X units. */
const BASE_RADIUS = 0.075;

export function clampZoneScale(scale: number): number {
  return Math.min(MAX_ZONE_SCALE, Math.max(MIN_ZONE_SCALE, scale));
}

/** Nudge the size by whole steps, rounded so repeated presses stay tidy. */
export function stepZoneScale(scale: number, steps: number): number {
  const stepped = scale + steps * ZONE_SCALE_STEP;
  return clampZoneScale(Math.round(stepped / ZONE_SCALE_STEP) * ZONE_SCALE_STEP);
}

/**
 * Map a keypress to a size change, or null when the key means nothing here.
 *
 * `[` and `]` alongside `-` and `=` because the latter pair is awkward to find
 * without looking, and looking is the thing this exists to avoid.
 */
export function zoneScaleForKey(key: string, scale: number): number | null {
  if (key === '-' || key === '_' || key === '[') return stepZoneScale(scale, -1);
  if (key === '=' || key === '+' || key === ']') return stepZoneScale(scale, 1);
  return null;
}

export interface HandSpanSizing {
  /** Scale implied by how far apart the hands are held. */
  scale: number;
  /** Field-space midpoint between the hands, for drawing the indicator. */
  centre: { x: number; y: number };
  spanX: number;
}

/** Hands must be at least roughly level, or this is not a sizing gesture. */
const MAX_LEVEL_DIFFERENCE = 0.14;
const MIN_VISIBILITY = 0.5;

/**
 * Read a target size from how far apart the player is holding their hands.
 *
 * "Make them this big" is a gesture people already have, and it maps directly:
 * the distance between the wrists becomes the target DIAMETER, so what the
 * hands frame is what appears.
 *
 * Requiring the hands to be roughly level is what keeps this from firing
 * during ordinary movement — arms at different heights are reaching for
 * something, not measuring.
 *
 * @returns null when the pose is not making this gesture.
 */
export function handSpanSizing(
  snapshot: PoseSnapshot | null,
  aspect: number,
): HandSpanSizing | null {
  if (!snapshot) return null;

  const left = snapshot.landmarks.leftWrist;
  const right = snapshot.landmarks.rightWrist;
  if (left.visibility < MIN_VISIBILITY || right.visibility < MIN_VISIBILITY) return null;

  // Level in PIXELS, not in coordinates — the field is not square.
  const levelDifference = Math.abs(left.y - right.y) / aspect;
  if (levelDifference > MAX_LEVEL_DIFFERENCE) return null;

  const spanX = Math.abs(left.x - right.x);
  const diameter = spanX;
  const scale = clampZoneScale(diameter / 2 / BASE_RADIUS);

  return {
    scale,
    centre: { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 },
    spanX,
  };
}
