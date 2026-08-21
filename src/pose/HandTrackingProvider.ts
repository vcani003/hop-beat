/**
 * Hand tracking via MediaPipe's Gesture Recognizer.
 *
 * Gesture Recognizer rather than Hand Landmarker because it measured *cheaper*
 * (7.8 vs 8.3 ms on GPU) while returning strictly more — the same 21 landmarks
 * per hand, plus a trained gesture classification. docs/TRACKING.md has the
 * tables.
 *
 * The model is loaded here and nowhere else, so a body-only mode never pays
 * for it. The JS costs nothing extra — MediaPipe ships as one pre-bundled file
 * that is already in the build — but the 8.4 MB model is fetched only when a
 * mode that needs hands actually starts.
 */
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision';
import type { Delegate, FrameClockSource } from './MediaPipePoseProvider.ts';
import type { FieldPoint } from './poseTypes.ts';
import {
  HAND_HIT_POINT,
  HAND_LANDMARKS,
  type Handedness,
  type HandsFrame,
  type HandSnapshot,
} from './handTypes.ts';

export interface HandProviderOptions {
  delegate: Delegate;
  maxHands?: number;
}

export interface HandFrame extends HandsFrame {
  inferenceMs: number;
  pipelineLatencyMs: number;
  timestampSuspect: boolean;
  detected: boolean;
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    cb: (now: number, metadata: VideoFrameCallbackMetadata) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

interface VideoFrameCallbackMetadata {
  presentationTime: number;
  expectedDisplayTime: number;
  mediaTime: number;
  presentedFrames: number;
  captureTime?: number;
}

const IMPLAUSIBLE_FRAME_AGE_MS = 500;

/**
 * Turn MediaPipe's handedness label into the player's own left and right.
 *
 * MediaPipe documents that handedness is decided *assuming the input image is
 * mirrored* — a selfie view. We feed it the raw camera image, which is not
 * mirrored, and mirror only for display. So its label is inverted relative to
 * the player, and mirroring the display inverts it back.
 *
 * Getting this wrong is invisible: everything works, left and right are simply
 * swapped, and it only shows up as a chart demanding the wrong hand. It is the
 * same trap as the anatomical-left confusion in transforms.ts, which is why it
 * lives in one named, tested function rather than inline.
 *
 * The polarity here follows MediaPipe's stated assumption and STILL NEEDS
 * CONFIRMING against a real hand — see docs/TRACKING.md.
 */
export function resolveHandedness(
  mediapipeLabel: string | undefined,
  mirrored: boolean,
): Handedness {
  const saysLeft = mediapipeLabel?.toLowerCase() === 'left';
  // Under MediaPipe's mirrored-input assumption its label already matches what
  // a player sees of themselves in a mirrored preview.
  return mirrored ? (saysLeft ? 'left' : 'right') : (saysLeft ? 'right' : 'left');
}

export class HandTrackingProvider {
  private recognizer: GestureRecognizer | null = null;
  private running = false;
  private frameHandle: number | null = null;
  private rafHandle: number | null = null;
  private video: FrameCallbackVideo | null = null;
  private mirrored = true;
  private lastSentTimestamp = -1;
  usesFrameCallback = false;
  frameClockSource: FrameClockSource = 'now';

  private constructor() {}

  static async create(options: HandProviderOptions): Promise<HandTrackingProvider> {
    const provider = new HandTrackingProvider();
    const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
    provider.recognizer = await GestureRecognizer.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: '/models/gesture_recognizer.task',
        delegate: options.delegate,
      },
      runningMode: 'VIDEO',
      numHands: options.maxHands ?? 2,
    });
    return provider;
  }

  setMirrored(mirrored: boolean): void {
    this.mirrored = mirrored;
  }

  start(video: HTMLVideoElement, onFrame: (frame: HandFrame) => void): void {
    this.video = video as FrameCallbackVideo;
    this.running = true;
    this.lastSentTimestamp = -1;
    this.usesFrameCallback = typeof this.video.requestVideoFrameCallback === 'function';

    if (this.usesFrameCallback) {
      const step = (now: number, metadata: VideoFrameCallbackMetadata) => {
        if (!this.running || !this.video) return;
        let frameTime: number;
        if (metadata.captureTime != null) {
          frameTime = metadata.captureTime;
          this.frameClockSource = 'captureTime';
        } else if (metadata.presentationTime != null) {
          frameTime = metadata.presentationTime;
          this.frameClockSource = 'presentationTime';
        } else {
          frameTime = now;
          this.frameClockSource = 'callback';
        }
        this.process(frameTime, onFrame);
        this.frameHandle = this.video.requestVideoFrameCallback!(step);
      };
      this.frameHandle = this.video.requestVideoFrameCallback!(step);
    } else {
      const step = () => {
        if (!this.running) return;
        this.frameClockSource = 'now';
        this.process(performance.now(), onFrame);
        this.rafHandle = requestAnimationFrame(step);
      };
      this.rafHandle = requestAnimationFrame(step);
    }
  }

  private process(frameTimeMs: number, onFrame: (frame: HandFrame) => void): void {
    const video = this.video;
    if (!this.recognizer || !video || video.videoWidth === 0) return;

    const mpTimestamp = Math.max(Math.round(frameTimeMs), this.lastSentTimestamp + 1);
    this.lastSentTimestamp = mpTimestamp;

    const started = performance.now();
    let hands: HandSnapshot[] = [];
    try {
      // Unlike PoseLandmarker there is no callback overload here; the result
      // is returned directly and owns no masks, so there is nothing to copy.
      hands = this.toHandSnapshots(this.recognizer.recognizeForVideo(video, mpTimestamp));
    } catch (err) {
      console.error('[hands] inference failed', err);
      return;
    }
    const finished = performance.now();
    const pipelineLatencyMs = finished - frameTimeMs;

    onFrame({
      timestampMs: frameTimeMs,
      hands,
      inferenceMs: finished - started,
      pipelineLatencyMs,
      timestampSuspect: pipelineLatencyMs < 0 || pipelineLatencyMs > IMPLAUSIBLE_FRAME_AGE_MS,
      detected: hands.length > 0,
    });
  }

  private toHandSnapshots(result: {
    landmarks: Array<Array<{ x: number; y: number; z: number; visibility?: number }>>;
    handedness: Array<Array<{ categoryName?: string; score?: number }>>;
    gestures: Array<Array<{ categoryName?: string; score?: number }>>;
  }): HandSnapshot[] {
    const snapshots: HandSnapshot[] = [];

    for (let i = 0; i < result.landmarks.length; i++) {
      const raw = result.landmarks[i];
      if (!raw?.length) continue;

      const points: FieldPoint[] = raw.map((p) => ({
        x: this.mirrored ? 1 - p.x : p.x,
        // Hand landmarks carry no per-point visibility, and a hand that was
        // returned at all was found. Treating them as confident keeps the
        // downstream gate meaningful for pose without silently rejecting hands.
        y: p.y,
        visibility: p.visibility ?? 1,
      }));

      const handedness = result.handedness[i]?.[0];
      const gesture = result.gestures[i]?.[0];

      snapshots.push({
        handedness: resolveHandedness(handedness?.categoryName, this.mirrored),
        handednessScore: handedness?.score ?? 0,
        points,
        hit: points[HAND_LANDMARKS[HAND_HIT_POINT]] ?? points[0],
        // "None" is the recogniser declining to classify, which is not a label.
        gesture: gesture?.categoryName && gesture.categoryName !== 'None'
          ? gesture.categoryName
          : null,
        gestureScore: gesture?.score ?? 0,
      });
    }

    return snapshots;
  }

  stop(): void {
    this.running = false;
    if (this.frameHandle !== null && this.video?.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this.frameHandle);
    }
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.frameHandle = null;
    this.rafHandle = null;
  }

  close(): void {
    this.stop();
    this.recognizer?.close();
    this.recognizer = null;
  }
}
