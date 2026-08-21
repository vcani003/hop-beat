import type { Delegate, FrameClockSource, ModelVariant } from '../pose/MediaPipePoseProvider.ts';

/** Everything the operator can change while standing in front of the camera. */
export interface Settings {
  modelVariant: ModelVariant;
  delegate: Delegate;
  mirrored: boolean;
  showVideo: boolean;
  showSkeleton: boolean;
  /** Multiplier applied to every zone's default radius. */
  zoneScale: number;
  minVisibility: number;
  exitRadiusScale: number;
  exitGraceMs: number;
  refractoryMs: number;
  requireInFrame: boolean;
}

/**
 * Tuned on real hardware and confirmed in play, not chosen on paper.
 *
 * Chatter is suppressed by hysteresis, which constrains how far a wrist must
 * travel to LEAVE a zone. The re-entry lockout is kept near zero: it
 * constrains time instead, so every millisecond of it is a millisecond in
 * which a genuine fast repeat cannot land. An earlier configuration had these
 * the other way round and silently ate half of all repeat hits above 120 BPM.
 * See docs/DECISIONS.md.
 *
 * `showVideo` is off because the skeleton alone turned out to be enough to
 * play by — spec open question #10, answered.
 */
export const DEFAULT_SETTINGS: Settings = {
  modelVariant: 'lite',
  delegate: 'CPU',
  mirrored: true,
  showVideo: false,
  showSkeleton: true,
  zoneScale: 0.65,
  minVisibility: 0.4,
  exitRadiusScale: 1.25,
  exitGraceMs: 40,
  refractoryMs: 20,
  requireInFrame: true,
};

/** A 5 Hz snapshot of the hot loop, safe to hand to React. */
export interface TelemetryView {
  poseHz: number;
  renderFps: number;
  inferenceMeanMs: number;
  inferenceP95Ms: number;
  latencyMeanMs: number;
  latencyP95Ms: number;
  detected: boolean;
  totalEnters: number;
  cameraLabel: string;
  cameraWidth: number;
  cameraHeight: number;
  cameraFps: number;
  usesFrameCallback: boolean;
  frameClockSource: FrameClockSource;
  /** Fraction of recent frames whose timestamp looked implausible. 0–1. */
  suspectRatio: number;
}

export const EMPTY_TELEMETRY: TelemetryView = {
  poseHz: 0,
  renderFps: 0,
  inferenceMeanMs: 0,
  inferenceP95Ms: 0,
  latencyMeanMs: 0,
  latencyP95Ms: 0,
  detected: false,
  totalEnters: 0,
  cameraLabel: '',
  cameraWidth: 0,
  cameraHeight: 0,
  cameraFps: 0,
  usesFrameCallback: false,
  frameClockSource: 'now',
  suspectRatio: 0,
};

export interface LogEntry {
  id: number;
  type: 'ZONE_ENTER' | 'ZONE_EXIT' | 'ZONE_BLOCKED';
  zoneId: string;
  limb: string;
  timestampMs: number;
  dwellMs?: number;
  reason?: 'refractory' | 'visibility';
  remainingMs?: number;
  /** Age of the camera frame when the event was produced. */
  latencyMs: number;
}
