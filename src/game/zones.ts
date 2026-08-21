/**
 * The four screen-anchored target zones. Spec §6.
 *
 *   (0,0) ───────────────────────────── (1,0)
 *     │       [UPPER LEFT] [UPPER RIGHT]  │
 *     │                                   │
 *     │                PLAYER             │
 *     │                                   │
 *     │       [LOWER LEFT] [LOWER RIGHT]  │
 *   (0,1) ───────────────────────────── (1,1)
 *
 * Zones live in field space, so they are resolution-independent: the same map
 * plays identically on a laptop panel and a projector.
 */
import type { FieldPoint } from '../pose/poseTypes.ts';

export const ZONE_IDS = ['upperLeft', 'upperRight', 'lowerLeft', 'lowerRight'] as const;
export type ZoneId = (typeof ZONE_IDS)[number];

export interface Zone {
  id: ZoneId;
  label: string;
  /** Centre in field space. */
  cx: number;
  cy: number;
  /**
   * Radius measured in field-space X units. Y is aspect-corrected at test time
   * so the zone is a true circle on screen — see distanceToZone.
   */
  radius: number;
  /** Debug-draw colour, borrowed from the concept mockup. */
  colour: string;
}

/**
 * Starting positions, taken from docs/concept-mockup.png. Deliberately
 * adjustable at runtime: spec open question #3 asks how large a zone must be to
 * feel intentional rather than frustrating, and that is answered by standing in
 * front of a camera and moving a slider, not by picking a number now.
 */
export function defaultZones(): Zone[] {
  return [
    { id: 'upperLeft',  label: 'UPPER LEFT',  cx: 0.20, cy: 0.24, radius: 0.075, colour: '#8b5cf6' },
    { id: 'upperRight', label: 'UPPER RIGHT', cx: 0.80, cy: 0.24, radius: 0.075, colour: '#38bdf8' },
    { id: 'lowerLeft',  label: 'LOWER LEFT',  cx: 0.20, cy: 0.66, radius: 0.075, colour: '#f5c451' },
    { id: 'lowerRight', label: 'LOWER RIGHT', cx: 0.80, cy: 0.66, radius: 0.075, colour: '#f472b6' },
  ];
}

/**
 * Distance from a point to a zone centre, in field-space X units.
 *
 * The subtlety: field space is normalised 0–1 on BOTH axes, but the screen is
 * not square. On a 16:9 display, moving 0.1 in x covers roughly 1.78x as many
 * pixels as moving 0.1 in y. A naive sqrt(dx² + dy²) therefore describes an
 * ellipse on screen — a zone that is easier to hit vertically than
 * horizontally, for no reason the player could ever guess.
 *
 * Scaling dy by 1/aspect converts the vertical offset into the same units as
 * the horizontal one, so the zone is round where it counts: on the screen.
 *
 * @param aspect width / height of the play field.
 */
/**
 * A named, fixed set of targets belonging to a game mode. Spec §24.
 *
 * The layout is the thing that stays put. A mode may define a different one —
 * six targets, floor positions for footwork, a wide layout for projection —
 * but every layout inherits §24's rule: its coordinates are fixed, and the
 * player is positioned to them rather than the other way round.
 *
 * Beatmaps name the layout they were authored against, because a chart written
 * for four corners is not automatically playable on six targets.
 */
export interface TargetLayout {
  id: string;
  name: string;
  /** Fresh zones each call, so a caller can never mutate the canonical set. */
  build: () => Zone[];
}

export const CORNERS_4: TargetLayout = {
  id: 'corners4',
  name: 'Four corners',
  build: defaultZones,
};

export const TARGET_LAYOUTS: readonly TargetLayout[] = [CORNERS_4];

export const DEFAULT_LAYOUT_ID = CORNERS_4.id;

export function findLayout(id: string | undefined): TargetLayout {
  return TARGET_LAYOUTS.find((l) => l.id === id) ?? CORNERS_4;
}

export function distanceToZone(
  p: { x: number; y: number },
  zone: Zone,
  aspect: number,
): number {
  const dx = p.x - zone.cx;
  const dy = (p.y - zone.cy) / aspect;
  return Math.hypot(dx, dy);
}

export interface SegmentHit {
  /** Closest approach of the swept path to the zone centre, in field-X units. */
  distance: number;
  /** Where along the path that happened. 0 = start, 1 = end. */
  t: number;
}

/**
 * Closest approach of a MOVING landmark to a zone.
 *
 * Testing where a wrist *is* misses where it *went*. Pose arrives at roughly
 * 26–30 Hz, so consecutive samples are ~35 ms apart, and a fast arm extension
 * covers real distance in that time — easily more than a zone's diameter. The
 * hand passes clean through the target and every sampled position is outside
 * it, so a hit that visibly happened never registers.
 *
 * Sweeping the segment between the previous and current sample fixes that, and
 * `t` additionally says WHEN along the path the closest approach occurred,
 * which lets the entry be timestamped by interpolation rather than rounded up
 * to the frame that noticed it.
 */
export function sweptDistanceToZone(
  from: { x: number; y: number },
  to: { x: number; y: number },
  zone: Zone,
  aspect: number,
): SegmentHit {
  // Work in aspect-corrected space so "closest" means closest on screen.
  const ax = from.x - zone.cx;
  const ay = (from.y - zone.cy) / aspect;
  const bx = to.x - zone.cx;
  const by = (to.y - zone.cy) / aspect;

  const vx = bx - ax;
  const vy = by - ay;
  const lengthSq = vx * vx + vy * vy;

  // No movement between samples: the segment collapses to a point.
  if (lengthSq === 0) return { distance: Math.hypot(ax, ay), t: 1 };

  const raw = -(ax * vx + ay * vy) / lengthSq;
  const t = Math.min(1, Math.max(0, raw));
  return { distance: Math.hypot(ax + t * vx, ay + t * vy), t };
}

/**
 * Is this landmark inside the zone right now?
 *
 * `radiusScale` exists for hysteresis: the tracker asks with 1.0 to decide
 * "has it entered" and with something larger to decide "has it left". A point
 * that has to travel further to leave than it did to arrive cannot rattle
 * across the boundary. See ZoneTracker.
 */
export function isInsideZone(
  p: FieldPoint,
  zone: Zone,
  aspect: number,
  radiusScale = 1,
): boolean {
  return distanceToZone(p, zone, aspect) <= zone.radius * radiusScale;
}
