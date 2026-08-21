/**
 * Guiding the PLAYER into position — not the targets.
 *
 * Spec §3 is unambiguous: "Screen-anchored targets. Targets belong to stable
 * normalized screen coordinates. The player moves into them."
 *
 * An earlier version of this file did the reverse, fitting the four targets to
 * whoever was standing there. That is wrong for reasons that go well beyond
 * tidiness:
 *
 *   - Targets you cannot learn. Muscle memory is most of what a rhythm game
 *     trades in, and it needs the upper-left target to be in the same place
 *     today as it was yesterday.
 *   - A chart's difficulty stops meaning anything, because the distance
 *     between two notes depends on who is playing.
 *   - Two people cannot compare scores on the same map.
 *
 * So the targets are fixed, and this module answers a different question:
 * standing where they are, can the player reach them — and if not, what should
 * they do about it?
 *
 * The key physical insight is that reach in SCREEN space depends on distance
 * from the camera. Stand close and your arms span most of the frame; stand far
 * and they span very little. So "I cannot reach the corners" is nearly always
 * solved by stepping closer, and the opposite problem — body cropped out of
 * frame — by stepping back. There is a sweet spot, and this finds it.
 */
import type { PoseSnapshot } from '../pose/poseTypes.ts';
import type { Zone, ZoneId } from './zones.ts';

/**
 * How far a person can comfortably reach from the centre of their chest, in
 * shoulder widths.
 *
 * Fingertip-to-fingertip span is roughly 2.6 shoulder widths, giving about 1.3
 * from the middle. Targets should not require a locked-out arm, so this asks
 * for a little less than the anatomy allows.
 */
const REACH_IN_SHOULDERS = 1.15;

/** Below this the landmark is not trustworthy enough to advise on. */
const MIN_VISIBILITY = 0.5;

/** How far off centre before it is worth mentioning, in field-X units. */
const OFF_CENTRE_TOLERANCE = 0.07;

export type PositionProblem =
  | 'noPose'
  | 'noHands'
  | 'tooFar'
  | 'tooClose'
  | 'offCentreLeft'
  | 'offCentreRight'
  | 'none';

export interface PositionCheck {
  /** Every fixed target is comfortably reachable from where the player is. */
  ok: boolean;
  problem: PositionProblem;
  /** What the player should do, in plain language. */
  guidance: string;
  reachable: ZoneId[];
  unreachable: ZoneId[];
  /** Reach divided by what the furthest target demands. 1.0 is exactly enough. */
  reachRatio: number;
  /** Where the player's chest is, in field space. For drawing. */
  centre: { x: number; y: number } | null;
  /** Comfortable reach radius, in field-X units. For drawing. */
  reachRadius: number;
}

const NO_POSE: PositionCheck = {
  ok: false,
  problem: 'noPose',
  guidance: 'Step into view so the camera can see your upper body.',
  reachable: [],
  unreachable: [],
  reachRatio: 0,
  centre: null,
  reachRadius: 0,
};

/**
 * Can the player reach the fixed targets from where they are standing?
 *
 * @param aspect width / height of the play field, so vertical distances are
 *   compared in the same units as horizontal ones.
 */
/**
 * Positioning for a mode that tracks hands and nothing else.
 *
 * The shoulder-based check below cannot run here: a hands-only backend reports
 * no torso at all, so it would report "no pose" forever and leave the player
 * unable to confirm anything. That was a real bug, and the fix is not a second
 * geometry estimate — it is to stop estimating.
 *
 * Reachability is DEMONSTRATED instead, by touching each target. That is
 * strictly better evidence than any calculation from body proportions, because
 * it is the actual thing we wanted to know.
 */
export function checkHandPosition(
  snapshot: PoseSnapshot | null,
  zones: readonly Zone[],
  touched: ReadonlySet<string>,
): PositionCheck {
  const left = snapshot?.landmarks.leftWrist;
  const right = snapshot?.landmarks.rightWrist;
  const handsSeen =
    (left && left.visibility >= MIN_VISIBILITY ? 1 : 0) +
    (right && right.visibility >= MIN_VISIBILITY ? 1 : 0);

  const reachable = zones.filter((z) => touched.has(z.id)).map((z) => z.id);
  const unreachable = zones.filter((z) => !touched.has(z.id)).map((z) => z.id);
  const done = unreachable.length === 0;

  return {
    ok: done,
    problem: done ? 'none' : handsSeen === 0 ? 'noHands' : 'tooFar',
    guidance: done
      ? 'All four touched — you can reach everything from here.'
      : handsSeen === 0
        ? 'Hold your hands up where the camera can see them.'
        : `Touch each target to confirm you can reach it — ${reachable.length} of ${zones.length} done.`,
    reachable,
    unreachable,
    reachRatio: zones.length === 0 ? 1 : reachable.length / zones.length,
    centre: null,
    reachRadius: 0,
  };
}

export function checkPosition(
  snapshot: PoseSnapshot | null,
  zones: readonly Zone[],
  aspect: number,
): PositionCheck {
  if (!snapshot) return NO_POSE;

  const ls = snapshot.landmarks.leftShoulder;
  const rs = snapshot.landmarks.rightShoulder;
  if (ls.visibility < MIN_VISIBILITY || rs.visibility < MIN_VISIBILITY) return NO_POSE;

  const shoulderWidth = Math.abs(ls.x - rs.x);
  if (shoulderWidth < 0.02) return NO_POSE;

  const centreX = (ls.x + rs.x) / 2;
  // Reach pivots around the chest rather than the shoulder line — a target
  // below the hips is not as far away as measuring from the collarbone implies.
  const centreY = (ls.y + rs.y) / 2 + shoulderWidth * 0.35 / aspect;
  const reachRadius = shoulderWidth * REACH_IN_SHOULDERS;

  const reachable: ZoneId[] = [];
  const unreachable: ZoneId[] = [];
  let furthest = 0;

  for (const zone of zones) {
    const dx = zone.cx - centreX;
    const dy = (zone.cy - centreY) / aspect;
    const distance = Math.hypot(dx, dy);
    furthest = Math.max(furthest, distance);
    if (distance <= reachRadius) reachable.push(zone.id);
    else unreachable.push(zone.id);
  }

  const reachRatio = furthest === 0 ? 1 : reachRadius / furthest;
  const offCentre = centreX - 0.5;

  // Being cropped by the frame is a worse problem than being off centre, and
  // stepping back fixes it — so it is checked first.
  const shouldersOutOfFrame = ls.x < 0.02 || ls.x > 0.98 || rs.x < 0.02 || rs.x > 0.98;
  if (shouldersOutOfFrame || shoulderWidth > 0.55) {
    return {
      ok: false,
      problem: 'tooClose',
      guidance: 'Step back — you are too close for the camera to see all of you.',
      reachable,
      unreachable,
      reachRatio,
      centre: { x: centreX, y: centreY },
      reachRadius,
    };
  }

  if (Math.abs(offCentre) > OFF_CENTRE_TOLERANCE) {
    // Mirrored preview: moving "left" means left as the player sees themselves.
    const problem: PositionProblem = offCentre > 0 ? 'offCentreRight' : 'offCentreLeft';
    return {
      ok: false,
      problem,
      guidance:
        offCentre > 0
          ? 'Move a little to your left to centre yourself.'
          : 'Move a little to your right to centre yourself.',
      reachable,
      unreachable,
      reachRatio,
      centre: { x: centreX, y: centreY },
      reachRadius,
    };
  }

  if (unreachable.length > 0) {
    return {
      ok: false,
      problem: 'tooFar',
      guidance: 'Step closer to the camera — you cannot reach every target from there.',
      reachable,
      unreachable,
      reachRatio,
      centre: { x: centreX, y: centreY },
      reachRadius,
    };
  }

  return {
    ok: true,
    problem: 'none',
    guidance: 'Good spot — you can reach all four.',
    reachable,
    unreachable,
    reachRatio,
    centre: { x: centreX, y: centreY },
    reachRadius,
  };
}
