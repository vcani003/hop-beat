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
export function distanceToZone(
  p: { x: number; y: number },
  zone: Zone,
  aspect: number,
): number {
  const dx = p.x - zone.cx;
  const dy = (p.y - zone.cy) / aspect;
  return Math.hypot(dx, dy);
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
