/**
 * The camera → MediaPipe → ZoneTracker pipeline, as a hook.
 *
 * Extracted so the MVP 0 debug view and the game screen drive one
 * implementation rather than two that slowly diverge. The consumer supplies a
 * callback and receives zone events; everything else — permissions, the WASM
 * graph, teardown, telemetry — is handled here.
 *
 * Spec §14 still governs: nothing in the hot path calls setState. Frames land
 * in refs, and a slow interval publishes a summary for display.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { MediaPipePoseProvider, type PoseFrame } from './MediaPipePoseProvider.ts';
import { HandTrackingProvider } from './HandTrackingProvider.ts';
import { handsToPoseSnapshot } from './handsToPose.ts';
import { requiresHands, type GameMode } from '../game/modes.ts';
import { attachStream, CameraError, startCamera, stopCamera, type CameraInfo } from './camera.ts';
import type { PoseSnapshot } from './poseTypes.ts';
import { DEFAULT_TRACKER_CONFIG, ZoneTracker, type ZoneEvent } from '../game/ZoneTracker.ts';
import type { Zone } from '../game/zones.ts';
import { CORNERS_4, type TargetLayout } from '../game/zones.ts';
import { RateCounter, RollingStat } from '../debug/telemetry.ts';
import { EMPTY_TELEMETRY, type Settings, type TelemetryView } from '../ui/types.ts';

export type PipelineStatus = 'idle' | 'loading' | 'running' | 'error';

export interface PipelineError {
  message: string;
  hint: string;
}

/** Called on every pose frame, with whatever zone events it produced. */
export type FrameHandler = (events: readonly ZoneEvent[], frame: PoseFrame) => void;

/** A layout's fixed targets at the player's chosen size. Spec §24. */
export function scaledZones(scale: number, layout: TargetLayout = CORNERS_4): Zone[] {
  return layout.build().map((z) => ({ ...z, radius: z.radius * scale }));
}

/**
 * @param zonesRef owned by the CALLER. Zones are a game concept, not a pose
 * concept, and passing them in also lets a consumer define its judgment
 * callbacks before this hook runs — otherwise the callbacks would close over a
 * ref this hook had not returned yet.
 * @param getAspect the play field's width/height. Also owned by the caller,
 * and for a sharper reason: zone geometry and hit-testing MUST agree on it. If
 * the tracker measured aspect from one element and the layout from another,
 * targets would be drawn in one place and judged in another.
 */
/**
 * Whatever a mode's tracking backend turns out to be, this is all the pipeline
 * needs from it.
 */
interface TrackingProvider {
  setMirrored(mirrored: boolean): void;
  stop(): void;
  close(): void;
  usesFrameCallback: boolean;
  frameClockSource: 'captureTime' | 'presentationTime' | 'callback' | 'now';
}

/**
 * @param mode decides which tracking model is loaded. Only the active mode's
 * model is fetched, so a body-only session never downloads the hand model.
 */
export function usePosePipeline(
  settings: Settings,
  zonesRef: React.RefObject<Zone[]>,
  getAspect: () => number,
  mode: GameMode,
  onFrame: FrameHandler,
) {
  const [status, setStatus] = useState<PipelineStatus>('idle');
  const [error, setError] = useState<PipelineError | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryView>(EMPTY_TELEMETRY);

  const videoRef = useRef<HTMLVideoElement>(null);
  const providerRef = useRef<TrackingProvider | null>(null);
  const cameraRef = useRef<CameraInfo | null>(null);
  const trackerRef = useRef(new ZoneTracker());
  const settingsRef = useRef(settings);
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  const snapshotRef = useRef<PoseSnapshot | null>(null);
  const detectedRef = useRef(false);

  // The handler changes identity every render; a ref keeps the pose callback
  // stable so inference is never restarted by an unrelated re-render. Updated
  // in an effect rather than during render — a ref write during render is not
  // safe under concurrent rendering, and one frame of staleness cannot matter
  // to a callback that only forwards events.
  const handlerRef = useRef(onFrame);
  useEffect(() => {
    handlerRef.current = onFrame;
  }, [onFrame]);

  const inferenceStat = useRef(new RollingStat(180));
  const latencyStat = useRef(new RollingStat(180));
  const suspectStat = useRef(new RollingStat(180));
  const poseRate = useRef(new RateCounter());
  const renderRate = useRef(new RateCounter());

  useEffect(() => {
    settingsRef.current = settings;
    trackerRef.current.setConfig({
      minVisibility: settings.minVisibility,
      exitRadiusScale: settings.exitRadiusScale,
      exitGraceMs: settings.exitGraceMs,
      refractoryMs: settings.refractoryMs,
      requireInFrame: settings.requireInFrame,
      reArmRadiusScale: DEFAULT_TRACKER_CONFIG.reArmRadiusScale,
      sweptCollision: settings.sweptCollision,
      maxSweepGapMs: DEFAULT_TRACKER_CONFIG.maxSweepGapMs,
    });
    providerRef.current?.setMirrored(settings.mirrored);
  }, [settings]);

  const handlePoseFrame = useCallback((frame: PoseFrame) => {
    const now = performance.now();
    snapshotRef.current = frame.snapshot;
    detectedRef.current = frame.detected;
    inferenceStat.current.push(frame.inferenceMs);
    latencyStat.current.push(frame.pipelineLatencyMs);
    suspectStat.current.push(frame.timestampSuspect ? 1 : 0);
    poseRate.current.tick(now);

    const events = trackerRef.current.update(frame.snapshot, zonesRef.current, getAspect());
    handlerRef.current(events, frame);
  }, [zonesRef, getAspect]);

  const teardown = useCallback(() => {
    providerRef.current?.close();
    providerRef.current = null;
    if (cameraRef.current) stopCamera(cameraRef.current.stream);
    cameraRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    trackerRef.current.reset();
    snapshotRef.current = null;
    detectedRef.current = false;
    inferenceStat.current.reset();
    latencyStat.current.reset();
    suspectStat.current.reset();
    poseRate.current.reset();
    renderRate.current.reset();
  }, []);

  /**
   * Build and start the backend this mode requires.
   *
   * Hands force the GPU delegate. Measured: pose + hand costs 15.5 ms on GPU
   * and 36 ms on CPU against a 33 ms budget, so on CPU a hands mode would
   * stutter rather than merely run slower. docs/TRACKING.md.
   */
  const startBackend = useCallback(
    async (video: HTMLVideoElement): Promise<TrackingProvider> => {
      if (requiresHands(modeRef.current)) {
        const provider = await HandTrackingProvider.create({ delegate: 'GPU' });
        provider.setMirrored(settingsRef.current.mirrored);
        provider.start(video, (frame) => {
          handlePoseFrame({
            snapshot: handsToPoseSnapshot(frame.timestampMs, frame.hands),
            inferenceMs: frame.inferenceMs,
            pipelineLatencyMs: frame.pipelineLatencyMs,
            timestampSuspect: frame.timestampSuspect,
            detected: frame.detected,
          });
        });
        return provider;
      }

      const provider = await MediaPipePoseProvider.create({
        modelVariant: settingsRef.current.modelVariant,
        delegate: settingsRef.current.delegate,
      });
      provider.setMirrored(settingsRef.current.mirrored);
      provider.start(video, handlePoseFrame);
      return provider;
    },
    [handlePoseFrame],
  );

  const start = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const camera = await startCamera();
      cameraRef.current = camera;

      const video = videoRef.current!;
      await attachStream(video, camera.stream);

      trackerRef.current.reset();
      providerRef.current = await startBackend(video);
      setStatus('running');
    } catch (err) {
      teardown();
      setError(
        err instanceof CameraError
          ? { message: err.message, hint: err.hint }
          : {
              message: err instanceof Error ? err.message : 'Failed to start.',
              hint: 'The pose model or WebAssembly runtime may be missing. Run: node scripts/fetch-assets.mjs',
            },
      );
      setStatus('error');
    }
  }, [startBackend, teardown]);

  const stop = useCallback(() => {
    teardown();
    setStatus('idle');
    setTelemetry(EMPTY_TELEMETRY);
  }, [teardown]);

  /** Rebuild the inference graph, keeping the same camera stream. */
  const reloadModel = useCallback(async () => {
    if (!videoRef.current || !providerRef.current) return;
    setStatus('loading');
    providerRef.current.close();
    inferenceStat.current.reset();
    latencyStat.current.reset();
    suspectStat.current.reset();
    poseRate.current.reset();
    try {
      trackerRef.current.reset();
      providerRef.current = await startBackend(videoRef.current);
      setStatus('running');
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Failed to reload the model.',
        hint: 'Try the CPU delegate — some GPUs reject the WebGL backend.',
      });
      setStatus('error');
    }
  }, [startBackend]);

  /** The cold path: publish a telemetry summary for display. */
  useEffect(() => {
    if (status !== 'running') return;
    const id = window.setInterval(() => {
      const now = performance.now();
      const camera = cameraRef.current;
      setTelemetry({
        poseHz: poseRate.current.rate(now),
        renderFps: renderRate.current.rate(now),
        inferenceMeanMs: inferenceStat.current.mean(),
        inferenceP95Ms: inferenceStat.current.percentile(0.95),
        latencyMeanMs: latencyStat.current.mean(),
        latencyP95Ms: latencyStat.current.percentile(0.95),
        detected: detectedRef.current,
        totalEnters: 0,
        cameraLabel: camera?.label ?? '',
        cameraWidth: camera?.width ?? 0,
        cameraHeight: camera?.height ?? 0,
        cameraFps: camera?.frameRate ?? 0,
        usesFrameCallback: providerRef.current?.usesFrameCallback ?? false,
        frameClockSource: providerRef.current?.frameClockSource ?? 'now',
        suspectRatio: suspectStat.current.mean(),
      });
    }, 200);
    return () => window.clearInterval(id);
  }, [status]);

  useEffect(() => teardown, [teardown]);

  return {
    status,
    error,
    telemetry,
    start,
    stop,
    reloadModel,
    videoRef,
    snapshotRef,
    detectedRef,
    trackerRef,
    providerRef,
    cameraRef,
    renderRate,
    setError,
  };
}
