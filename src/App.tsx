/**
 * MVP 0 — prove the controller.
 *
 * The one question this build answers: can a normal webcam produce reliable,
 * low-latency zone-entry events? No music, no scoring, no art. Spec §15.
 *
 * The structural rule that shapes this file is spec §14: "Avoid React state
 * updates on every animation frame." So there are two clocks running here.
 *
 *   HOT PATH  — pose callback and requestAnimationFrame. Reads and writes refs,
 *               draws to canvas directly, and never calls setState. It runs
 *               tens of times a second and must not schedule React work.
 *
 *   COLD PATH — a 5 Hz interval that copies a summary out of those refs into
 *               React state for the HUD to render. A number on a debug panel
 *               does not need to be correct 60 times a second; a hit event does.
 *
 * Immediate feedback the player *feels* (the ring that fires on entry) is drawn
 * on the canvas, not rendered by React, so it is never behind the interaction.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { MediaPipePoseProvider, type PoseFrame } from './pose/MediaPipePoseProvider.ts';
import { attachStream, CameraError, startCamera, stopCamera, type CameraInfo } from './pose/camera.ts';
import type { PoseSnapshot } from './pose/poseTypes.ts';
import { defaultZones, type Zone } from './game/zones.ts';
import { DEFAULT_TRACKER_CONFIG, ZoneTracker } from './game/ZoneTracker.ts';
import { drawScene, isFlashAlive, resizeCanvas, type HitFlash } from './debug/DebugCanvas.ts';
import { RateCounter, RollingStat } from './debug/telemetry.ts';
import {
  buildSessionDocument,
  summarise,
  type RecordedEvent,
  type SessionSummary,
} from './debug/SessionRecorder.ts';
import ControlPanel from './ui/ControlPanel.tsx';
import DebugHud from './ui/DebugHud.tsx';
import EventLog from './ui/EventLog.tsx';
import SessionPanel from './ui/SessionPanel.tsx';
import { loadSettings, saveSettings } from './ui/settingsStorage.ts';
import { navigate } from './ui/useHashRoute.ts';
import {
  EMPTY_TELEMETRY,
  type LogEntry,
  type Settings,
  type TelemetryView,
} from './ui/types.ts';

type Status = 'idle' | 'loading' | 'running' | 'error';

const HUD_INTERVAL_MS = 200;
const MAX_LOG_ENTRIES = 40;
/** A ceiling on recorded events so a forgotten tab cannot grow without bound. */
const MAX_RECORDED_EVENTS = 20_000;
const EMPTY_SUMMARY = summarise([]);

function scaledZones(scale: number): Zone[] {
  return defaultZones().map((z) => ({ ...z, radius: z.radius * scale }));
}

export default function App() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  // Lazy initialiser: read stored tuning once, not on every render.
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [telemetry, setTelemetry] = useState<TelemetryView>(EMPTY_TELEMETRY);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [summary, setSummary] = useState<SessionSummary>(EMPTY_SUMMARY);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ---- hot-path state. Never rendered directly; never triggers React. ----
  const providerRef = useRef<MediaPipePoseProvider | null>(null);
  const cameraRef = useRef<CameraInfo | null>(null);
  const trackerRef = useRef(new ZoneTracker());
  const zonesRef = useRef<Zone[]>(scaledZones(settings.zoneScale));
  const settingsRef = useRef(settings);
  const snapshotRef = useRef<PoseSnapshot | null>(null);
  const detectedRef = useRef(false);
  const flashesRef = useRef<HitFlash[]>([]);
  const pendingLogRef = useRef<LogEntry[]>([]);
  /** The full session, kept out of React so recording costs nothing per frame. */
  const recordedRef = useRef<RecordedEvent[]>([]);
  const recordingDirtyRef = useRef(false);
  const logIdRef = useRef(0);
  const totalEntersRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const suspectStat = useRef(new RollingStat(180));
  const inferenceStat = useRef(new RollingStat(180));
  const latencyStat = useRef(new RollingStat(180));
  const poseRate = useRef(new RateCounter());
  const renderRate = useRef(new RateCounter());

  // Mirror settings into a ref so the hot path reads them without re-binding
  // the pose callback (which would restart inference on every slider drag).
  useEffect(() => {
    saveSettings(settings);
    settingsRef.current = settings;
    zonesRef.current = scaledZones(settings.zoneScale);
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

  /** The hot path. Called once per camera frame. */
  const onPoseFrame = useCallback((frame: PoseFrame) => {
    const now = performance.now();
    snapshotRef.current = frame.snapshot;
    detectedRef.current = frame.detected;
    inferenceStat.current.push(frame.inferenceMs);
    latencyStat.current.push(frame.pipelineLatencyMs);
    suspectStat.current.push(frame.timestampSuspect ? 1 : 0);
    poseRate.current.tick(now);

    const canvas = canvasRef.current;
    // Field aspect is the CANVAS aspect, not the camera's: the video is
    // object-fit: cover, so what the player sees is the canvas shape.
    const aspect = canvas && canvas.clientHeight > 0
      ? canvas.clientWidth / canvas.clientHeight
      : 16 / 9;

    const events = trackerRef.current.update(frame.snapshot, zonesRef.current, aspect);

    for (const event of events) {
      if (event.type === 'ZONE_ENTER') {
        flashesRef.current.push({ zoneId: event.zoneId, startedAt: now });
        totalEntersRef.current += 1;
      }
      // How old the camera frame already was when the event was produced. This
      // is the honest input-latency number MVP 1 will have to live with.
      const latencyMs = now - event.timestampMs;

      pendingLogRef.current.push({
        id: logIdRef.current++,
        type: event.type,
        zoneId: event.zoneId,
        limb: event.limb,
        timestampMs: event.timestampMs,
        dwellMs: event.dwellMs,
        reason: event.reason,
        remainingMs: event.remainingMs,
        latencyMs,
      });

      if (recordedRef.current.length < MAX_RECORDED_EVENTS) {
        recordedRef.current.push({ ...event, latencyMs });
        recordingDirtyRef.current = true;
      }
    }
  }, []);

  /** The render loop. Draws every display frame; touches no React state. */
  useEffect(() => {
    if (status !== 'running') return;

    const step = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        const { width, height } = resizeCanvas(canvas);
        const now = performance.now();
        flashesRef.current = flashesRef.current.filter((f) => isFlashAlive(f, now));
        if (ctx && width > 0 && height > 0) {
          drawScene(ctx, {
            width,
            height,
            aspect: width / height,
            zones: zonesRef.current,
            snapshot: snapshotRef.current,
            detected: detectedRef.current,
            activePairs: trackerRef.current.activePairs(),
            flashes: flashesRef.current,
            exitRadiusScale: settingsRef.current.exitRadiusScale,
            minVisibility: settingsRef.current.minVisibility,
            showSkeleton: settingsRef.current.showSkeleton,
            nowMs: now,
          });
        }
        renderRate.current.tick(now);
      }
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [status]);

  /** The cold path. 5 Hz is plenty for numbers a human is reading. */
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
        totalEnters: totalEntersRef.current,
        cameraLabel: camera?.label ?? '',
        cameraWidth: camera?.width ?? 0,
        cameraHeight: camera?.height ?? 0,
        cameraFps: camera?.frameRate ?? 0,
        usesFrameCallback: providerRef.current?.usesFrameCallback ?? false,
        frameClockSource: providerRef.current?.frameClockSource ?? 'now',
        suspectRatio: suspectStat.current.mean(),
      });

      if (pendingLogRef.current.length > 0) {
        const incoming = pendingLogRef.current;
        pendingLogRef.current = [];
        setLog((prev) => [...incoming.reverse(), ...prev].slice(0, MAX_LOG_ENTRIES));
      }

      // Re-derive the summary only when something was actually recorded.
      if (recordingDirtyRef.current) {
        recordingDirtyRef.current = false;
        setSummary(summarise(recordedRef.current));
      }
    }, HUD_INTERVAL_MS);

    return () => window.clearInterval(id);
  }, [status]);

  const teardown = useCallback(() => {
    providerRef.current?.close();
    providerRef.current = null;
    if (cameraRef.current) stopCamera(cameraRef.current.stream);
    cameraRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    trackerRef.current.reset();
    snapshotRef.current = null;
    detectedRef.current = false;
    flashesRef.current = [];
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
      totalEntersRef.current = 0;
      recordedRef.current = [];
      setSummary(EMPTY_SUMMARY);
      setLog([]);
      provider.start(video, onPoseFrame);
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
  }, [onPoseFrame, teardown]);

  const stop = useCallback(() => {
    teardown();
    setStatus('idle');
    setTelemetry(EMPTY_TELEMETRY);
  }, [teardown]);

  /**
   * Swapping model or delegate rebuilds the inference graph but keeps the same
   * camera stream — so the two can be compared back to back on the same body in
   * the same lighting, which is the only comparison worth anything.
   */
  const reloadModel = useCallback(async () => {
    if (status !== 'running' || !videoRef.current) return;
    setStatus('loading');
    providerRef.current?.close();
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
      provider.start(videoRef.current, onPoseFrame);
      setStatus('running');
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Failed to reload the model.',
        hint: 'Try the CPU delegate — some GPUs reject the WebGL backend.',
      });
      setStatus('error');
    }
  }, [status, onPoseFrame]);

  /**
   * Rebuild the inference graph when — and only when — the model identity
   * actually changes.
   *
   * This deliberately reads the change from committed state rather than firing
   * from the select's onChange: the settings effect above is what publishes
   * `settingsRef`, and any callback scheduled before that effect runs would
   * rebuild the graph from the PREVIOUS model. Effects run in declaration
   * order, so by the time this one fires the ref is already current.
   */
  const modelKeyRef = useRef(`${settings.modelVariant}:${settings.delegate}`);
  useEffect(() => {
    const key = `${settings.modelVariant}:${settings.delegate}`;
    if (key === modelKeyRef.current) return;
    modelKeyRef.current = key;
    void reloadModel();
  }, [settings.modelVariant, settings.delegate, reloadModel]);

  /**
   * Hand the recorded session to the user as a file.
   *
   * Everything needed to interpret the numbers travels with them — the tuning
   * that produced them and the machine that measured them — because a latency
   * figure without its model, delegate and camera format is not evidence of
   * anything.
   */
  const exportSession = useCallback(() => {
    const document_ = buildSessionDocument(
      recordedRef.current,
      settingsRef.current,
      {
        camera: cameraRef.current
          ? {
              label: cameraRef.current.label,
              width: cameraRef.current.width,
              height: cameraRef.current.height,
              frameRate: cameraRef.current.frameRate,
            }
          : null,
        frameClockSource: providerRef.current?.frameClockSource ?? null,
        usesFrameCallback: providerRef.current?.usesFrameCallback ?? false,
        poseHz: telemetry.poseHz,
        inferenceMeanMs: telemetry.inferenceMeanMs,
        inferenceP95Ms: telemetry.inferenceP95Ms,
        latencyMeanMs: telemetry.latencyMeanMs,
        latencyP95Ms: telemetry.latencyP95Ms,
        timestampSuspectRatio: telemetry.suspectRatio,
        userAgent: navigator.userAgent,
      },
      new Date().toISOString(),
    );

    const blob = new Blob([JSON.stringify(document_, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `hopbeat-mvp0-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [telemetry]);

  const clearSession = useCallback(() => {
    recordedRef.current = [];
    totalEntersRef.current = 0;
    trackerRef.current.reset();
    setSummary(EMPTY_SUMMARY);
    setLog([]);
  }, []);

  useEffect(() => teardown, [teardown]);

  const live = status === 'running';

  return (
    <div className="app">
      <div className="stage">
        <div className="stage__frame">
          <video
            ref={videoRef}
            className={[
              'stage__video',
              settings.mirrored ? 'stage__video--mirrored' : '',
              !settings.showVideo ? 'stage__video--hidden' : 'stage__video--dim',
            ].join(' ')}
            playsInline
            muted
          />
          <canvas ref={canvasRef} className="stage__canvas" />

          {live && (
            <div className="stage__badge mono">
              <span className={`dot ${telemetry.detected ? 'dot--on' : 'dot--off'}`} />
              {telemetry.detected ? 'TRACKING' : 'NO PERSON'}
              <span style={{ opacity: 0.4 }}>·</span>
              {telemetry.poseHz.toFixed(0)} Hz
            </div>
          )}

          {status !== 'running' && (
            <div className="stage__overlay">
              <div>
                <h1 className="stage__title">
                  hop<span>//</span>beat
                </h1>
                <p className="stage__sub">
                  MVP 0 — prove the controller. Stand back far enough that your head and
                  hips are both in frame, then move either wrist into the four corner
                  zones. Every entry and exit is timed and logged.
                </p>
                {status === 'error' && error && (
                  <div className="error" style={{ marginBottom: '1rem', textAlign: 'left' }}>
                    <div className="error__title">{error.message}</div>
                    <div className="error__hint">{error.hint}</div>
                  </div>
                )}
                <button
                  className="button--primary"
                  onClick={start}
                  disabled={status === 'loading'}
                  style={{ maxWidth: 260, margin: '0 auto' }}
                >
                  {status === 'loading' ? 'Loading model…' : 'Start camera'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <button onClick={live ? stop : start} disabled={status === 'loading'}>
          {status === 'loading' ? 'Loading…' : live ? 'Stop' : 'Start camera'}
        </button>

        <button className="button--quiet" onClick={() => navigate('/')}>
          ← Back to the game
        </button>

        <button className="button--quiet" onClick={() => navigate('/spec')}>
          Spec progress →
        </button>

        <DebugHud telemetry={telemetry} live={live} settings={settings} />

        <SessionPanel
          summary={summary}
          refractoryMs={settings.refractoryMs}
          onExport={exportSession}
          onClear={clearSession}
        />

        <div className="panel__section">
          <h2 className="panel__heading">Event log</h2>
          <EventLog entries={log} />
        </div>

        <ControlPanel
          settings={settings}
          onChange={setSettings}
          disabled={status === 'loading'}
        />
      </div>
    </div>
  );
}
