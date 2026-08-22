/**
 * The only file in the project that imports MediaPipe.
 *
 * How the pieces fit together:
 *
 *   FilesetResolver  locates the WebAssembly runtime — the actual inference
 *                    engine, compiled from C++ and shipped as ~12 MB of .wasm.
 *                    JavaScript could not run this model fast enough; WASM can.
 *
 *   .task model      a bundle containing BlazePose's two neural networks: a
 *                    detector that finds a person, and a landmark model that
 *                    places 33 points on them. After the first detection the
 *                    runtime TRACKS between frames and skips re-detection,
 *                    which is why VIDEO mode is much faster than calling the
 *                    image API repeatedly.
 *
 *   delegate         where the maths runs. 'GPU' compiles the model to WebGL
 *                    shaders; 'CPU' uses SIMD-accelerated WASM. GPU is usually
 *                    faster but not always — measure, do not assume.
 */
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { PoseSnapshot } from './poseTypes.ts';
import { toPoseSnapshot, type RawLandmark } from './transforms.ts';
import { MEDIAPIPE_WASM_PATH, poseModelUrl } from '../assets.ts';

export type ModelVariant = 'lite' | 'full';
export type Delegate = 'GPU' | 'CPU';

export interface PoseProviderOptions {
  modelVariant: ModelVariant;
  delegate: Delegate;
}

/**
 * Where a frame's timestamp came from, in descending order of trust.
 *
 *   captureTime       when the sensor saw the frame. The number we want.
 *                     Not exposed by every platform — notably absent on macOS.
 *   presentationTime  when the browser submitted the frame for composition.
 *                     Close to capture for a live camera; can lag badly for a
 *                     synthetic or backed-up stream.
 *   callback          the rVFC callback time. A floor, not a measurement.
 *   now               no per-frame metadata at all; rAF fallback path.
 */
export type FrameClockSource = 'captureTime' | 'presentationTime' | 'callback' | 'now';

export interface PoseFrame {
  snapshot: PoseSnapshot;
  /** Wall-clock time inside detectForVideo. The number to watch. */
  inferenceMs: number;
  /** How stale the snapshot already is by the time we can act on it. */
  pipelineLatencyMs: number;
  /**
   * True when the frame timestamp is not plausibly a recent camera frame.
   * Surfaced rather than silently corrected: a bad clock must be visible,
   * because everything MVP 1 judges will be measured against it.
   */
  timestampSuspect: boolean;
  /** False when nobody is in view — landmarks will all be zero-visibility. */
  detected: boolean;
}

/** Beyond this, a frame timestamp is not describing a live camera. */
const IMPLAUSIBLE_FRAME_AGE_MS = 500;

/** A video element that may support per-frame callbacks. */
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
  processingDuration?: number;
  captureTime?: number;
}

export class MediaPipePoseProvider {
  private landmarker: PoseLandmarker | null = null;
  private running = false;
  private frameHandle: number | null = null;
  private rafHandle: number | null = null;
  private video: FrameCallbackVideo | null = null;
  private mirrored = true;
  /** MediaPipe requires strictly increasing timestamps in VIDEO mode. */
  private lastSentTimestamp = -1;

  /** True when the browser gave us real per-camera-frame callbacks. */
  usesFrameCallback = false;

  /** Which clock the current frame timestamps come from. Reported in the HUD. */
  frameClockSource: FrameClockSource = 'now';

  private options: PoseProviderOptions;

  private constructor(options: PoseProviderOptions) {
    this.options = options;
  }

  static async create(options: PoseProviderOptions): Promise<MediaPipePoseProvider> {
    const provider = new MediaPipePoseProvider(options);
    await provider.load();
    return provider;
  }

  private async load(): Promise<void> {
    // Both paths are vendored into public/ by scripts/fetch-assets.mjs, so
    // startup never waits on a CDN.
    const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_PATH);
    this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: poseModelUrl(this.options.modelVariant),
        delegate: this.options.delegate,
      },
      runningMode: 'VIDEO',
      // One player. Spec §19 rules out multiplayer, and every extra pose is
      // another full landmark pass.
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    });
  }

  setMirrored(mirrored: boolean): void {
    this.mirrored = mirrored;
  }

  /**
   * Begin inference against a playing <video>.
   *
   * The loop is driven by `requestVideoFrameCallback`, which fires once per
   * DECODED CAMERA FRAME rather than once per display refresh. That matters:
   * running inference on a 60 Hz rAF against a 30 fps camera would burn half
   * the CPU re-analysing frames we have already seen. Where it is unavailable
   * we fall back to rAF and simply accept that cost.
   */
  start(video: HTMLVideoElement, onFrame: (frame: PoseFrame) => void): void {
    this.video = video as FrameCallbackVideo;
    this.running = true;
    this.lastSentTimestamp = -1;
    this.usesFrameCallback = typeof this.video.requestVideoFrameCallback === 'function';

    if (this.usesFrameCallback) {
      const step = (now: number, metadata: VideoFrameCallbackMetadata) => {
        if (!this.running || !this.video) return;

        // Pick the most trustworthy clock this platform actually provides, and
        // record which one it was. Guessing here would quietly poison every
        // timing measurement downstream.
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

  private process(frameTimeMs: number, onFrame: (frame: PoseFrame) => void): void {
    const video = this.video;
    if (!this.landmarker || !video || video.videoWidth === 0) return;

    // Strictly increasing, integer milliseconds. A repeated timestamp makes the
    // WASM graph throw, and clocks can tie at sub-millisecond resolution.
    const mpTimestamp = Math.max(Math.round(frameTimeMs), this.lastSentTimestamp + 1);
    this.lastSentTimestamp = mpTimestamp;

    const started = performance.now();
    let raw: RawLandmark[] = [];
    try {
      this.landmarker.detectForVideo(video, mpTimestamp, (result) => {
        raw = (result.landmarks[0] ?? []) as RawLandmark[];
      });
    } catch (err) {
      console.error('[pose] inference failed', err);
      return;
    }
    const finished = performance.now();

    const pipelineLatencyMs = finished - frameTimeMs;

    onFrame({
      snapshot: toPoseSnapshot(raw, frameTimeMs, this.mirrored),
      inferenceMs: finished - started,
      pipelineLatencyMs,
      timestampSuspect:
        pipelineLatencyMs < 0 || pipelineLatencyMs > IMPLAUSIBLE_FRAME_AGE_MS,
      detected: raw.length > 0,
    });
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

  /** Release the WASM graph. Forgetting this leaks a GPU context per reload. */
  close(): void {
    this.stop();
    this.landmarker?.close();
    this.landmarker = null;
  }
}
