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
import { attachStream, CameraError, startCamera, stopCamera, type CameraInfo } from './camera.ts';
import type { PoseSnapshot } from './poseTypes.ts';
import { DEFAULT_TRACKER_CONFIG, ZoneTracker, type ZoneEvent } from '../game/ZoneTracker.ts';
import type { Zone } from '../game/zones.ts';
import { defaultZones } from '../game/zones.ts';
import { RateCounter, RollingStat } from '../debug/telemetry.ts';
import { EMPTY_TELEMETRY, type Settings, type TelemetryView } from '../ui/types.ts';

export type PipelineStatus = 'idle' | 'loading' | 'running' | 'error';

export interface PipelineError {
  message: string;
  hint: string;
}

/** Called on every pose frame, with whatever zone events it produced. */
export type FrameHandler = (events: readonly ZoneEvent[], frame: PoseFrame) => void;

export function scaledZones(scale: number): Zone[] {
  return defaultZones().map((z) => ({ ...z, radius: z.radius * scale }));
}

/**
 * @param zonesRef owned by the CALLER. Zones are a game concept, not a pose
 * concept, and passing them in also lets a consumer define its judgment
 * callbacks before this hook runs — otherwise the callbacks would close over a
 * ref this hook had not returned yet.
 */
export function usePosePipeline(
  settings: Settings,
  zonesRef: React.RefObject<Zone[]>,
  onFrame: FrameHandler,
) {
  const [status, setStatus] = useState<PipelineStatus>('idle');
  const [error, setError] = useState<PipelineError | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryView>(EMPTY_TELEMETRY);

  const videoRef = useRef<HTMLVideoElement>(null);
  const providerRef = useRef<MediaPipePoseProvider | null>(null);
  const cameraRef = useRef<CameraInfo | null>(null);
  const trackerRef = useRef(new ZoneTracker());
  const settingsRef = useRef(settings);
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

    const video = videoRef.current;
    const aspect =
      video && video.clientHeight > 0 ? video.clientWidth / video.clientHeight : 16 / 9;

    const events = trackerRef.current.update(frame.snapshot, zonesRef.current, aspect);
    handlerRef.current(events, frame);
  }, [zonesRef]);

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

  const start = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const camera = await startCamera();
      cameraRef.current = camera;

      const video = videoRef.current!;
      await attachStream(video, camera.stream);

      const provider = await MediaPipePoseProvider.create({
        modelVariant: settingsRef.current.modelVariant,
        delegate: settingsRef.current.delegate,
      });
      provider.setMirrored(settingsRef.current.mirrored);
      providerRef.current = provider;

      trackerRef.current.reset();
      provider.start(video, handlePoseFrame);
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
  }, [handlePoseFrame, teardown]);

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
      const provider = await MediaPipePoseProvider.create({
        modelVariant: settingsRef.current.modelVariant,
        delegate: settingsRef.current.delegate,
      });
      provider.setMirrored(settingsRef.current.mirrored);
      providerRef.current = provider;
      trackerRef.current.reset();
      provider.start(videoRef.current, handlePoseFrame);
      setStatus('running');
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Failed to reload the model.',
        hint: 'Try the CPU delegate — some GPUs reject the WebGL backend.',
      });
      setStatus('error');
    }
  }, [handlePoseFrame]);

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
