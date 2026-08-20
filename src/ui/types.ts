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

export const DEFAULT_SETTINGS: Settings = {
  modelVariant: 'lite',
  delegate: 'GPU',
  mirrored: true,
  showVideo: true,
  showSkeleton: true,
  zoneScale: 1,
  minVisibility: 0.5,
  exitRadiusScale: 1.3,
  exitGraceMs: 80,
  refractoryMs: 0,
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
  type: 'ZONE_ENTER' | 'ZONE_EXIT';
  zoneId: string;
  limb: string;
  timestampMs: number;
  dwellMs?: number;
  /** Age of the camera frame when the event was produced. */
  latencyMs: number;
}
