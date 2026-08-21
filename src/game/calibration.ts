/**
 * Fitting the play field to the player.
 *
 * Spec §3 anchors targets to stable normalised screen coordinates, and §6 puts
 * them in the corners of the 0–1 field. That is right for a rhythm game — a
 * target that moves is a target you cannot learn — but it quietly assumes the
 * player's reach covers the whole frame, and it does not.
 *
 * Where you stand, how tall you are, how wide the lens is and whether you are
 * centred all change which corners you can actually get to. The reported
 * symptom was precise: "even though I'm far back enough I have trouble hitting
 * the bottom right", and "I extend my arm to reach and it doesn't always
 * reach". Those are not tracking failures. The target was outside the player.
 *
 * So the field is fitted to the body ONCE, before the song starts, and then
 * frozen. Targets stay screen-anchored while playing — they simply sit inside
 * a rectangle the player can reach.
 *
 * The measurement is anatomical rather than a reach test: shoulder width is a
 * reliable proxy for arm length, so the box can be derived from a person
 * standing still instead of asking them to windmill at the camera first.
 */
import type { PoseSnapshot } from '../pose/poseTypes.ts';
import type { Zone } from './zones.ts';

export interface FieldCalibration {
  /** Centre of the reachable box, in field space. */
  centreX: number;
  centreY: number;
  /** Half-extent of the box. Zone corners land on these. */
  halfWidth: number;
  halfHeight: number;
}

/**
 * How far the play field extends from the body centre, in shoulder widths.
 *
 * A person's arm span is close to their height, and roughly 2.6 shoulder
 * widths from fingertip to fingertip. Targets sit inside that rather than at
 * its limit — a corner that needs a fully locked-out arm is reachable in
 * theory and miserable in practice.
 */
const REACH_X_IN_SHOULDERS = 1.15;
const REACH_UP_IN_SHOULDERS = 0.95;
const REACH_DOWN_IN_SHOULDERS = 1.05;

/** Below this the pose is too uncertain to calibrate from. */
const MIN_VISIBILITY = 0.5;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

/**
 * Derive a reachable box from a handful of pose samples.
 *
 * Medians rather than means: a single frame where the model puts a shoulder in
 * the wrong place would drag an average, and the whole field with it.
 *
 * @param aspect width / height of the play field, needed because vertical
 *   reach is a horizontal measurement rotated ninety degrees, and field space
 *   is not square.
 * @returns null when no sample was usable — the caller should keep the
 *   uncalibrated layout rather than guess.
 */
export function calibrationFromPose(
  samples: readonly PoseSnapshot[],
  aspect: number,
): FieldCalibration | null {
  const centresX: number[] = [];
  const shoulderYs: number[] = [];
  const hipYs: number[] = [];
  const widths: number[] = [];

  for (const snapshot of samples) {
    const ls = snapshot.landmarks.leftShoulder;
    const rs = snapshot.landmarks.rightShoulder;
    const lh = snapshot.landmarks.leftHip;
    const rh = snapshot.landmarks.rightHip;
    if (
      ls.visibility < MIN_VISIBILITY ||
      rs.visibility < MIN_VISIBILITY ||
      lh.visibility < MIN_VISIBILITY ||
      rh.visibility < MIN_VISIBILITY
    ) {
      continue;
    }

    const width = Math.abs(ls.x - rs.x);
    // A shoulder width near zero means the player is edge-on or the model has
    // collapsed the two points together; either way it is not a scale.
    if (width < 0.02) continue;

    centresX.push((ls.x + rs.x) / 2);
    shoulderYs.push((ls.y + rs.y) / 2);
    hipYs.push((lh.y + rh.y) / 2);
    widths.push(width);
  }

  if (widths.length === 0) return null;

  const shoulderWidth = median(widths);
  const centreX = median(centresX);
  const shoulderY = median(shoulderYs);
  const hipY = median(hipYs);

  // Vertical extents are computed in field-X units and converted, so the box
  // describes a shape that is symmetric in PIXELS rather than in coordinates.
  const upY = shoulderY - (shoulderWidth * REACH_UP_IN_SHOULDERS) / aspect;
  const downY = hipY + (shoulderWidth * REACH_DOWN_IN_SHOULDERS) / aspect;

  return {
    centreX,
    centreY: (upY + downY) / 2,
    halfWidth: shoulderWidth * REACH_X_IN_SHOULDERS,
    halfHeight: (downY - upY) / 2,
  };
}

/**
 * Map zones from the default 0–1 layout into the calibrated box.
 *
 * A zone at field x 0.2 sits 30% of the way from the box's centre to its left
 * edge, wherever that box happens to be. Radius scales with the box so the
 * targets stay the same size relative to the player rather than to the room.
 */
export function applyCalibration(
  zones: readonly Zone[],
  calibration: FieldCalibration | null,
): Zone[] {
  if (!calibration) return zones.map((z) => ({ ...z }));

  const { centreX, centreY, halfWidth, halfHeight } = calibration;
  // The uncalibrated layout spans 0.2–0.8, so half of its own width is 0.3.
  const scale = halfWidth / 0.3;

  return zones.map((zone) => ({
    ...zone,
    cx: clamp01(centreX + (zone.cx - 0.5) * scale),
    // The default layout puts zones at y 0.24 and 0.66 — centred on 0.45, with
    // a half-extent of 0.21.
    cy: clamp01(centreY + (zone.cy - 0.45) * (halfHeight / 0.21)),
    radius: zone.radius * scale,
  }));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** A short, human-readable description for the calibration UI. */
export function describeCalibration(calibration: FieldCalibration | null): string {
  if (!calibration) return 'not calibrated — using the default layout';
  const widthPct = (calibration.halfWidth * 2 * 100).toFixed(0);
  return `field fitted to ${widthPct}% of frame width, centred on you`;
}
