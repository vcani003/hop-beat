/**
 * MVP 1 — the game.
 *
 * One loop drives everything, in a deliberate order:
 *
 *   1. clock.tick()          bring playback time up to date
 *   2. engine.update()       retire notes whose window has closed
 *   3. renderer.render()     draw against that single, consistent timestamp
 *
 * Input arrives on its own schedule from the pose pipeline and is judged the
 * moment it lands, using the camera-frame timestamp it carries — not the time
 * the loop happens to run next. Spec §7: the playback clock is authoritative,
 * and pose rate is nobody's business but the pose provider's.
 *
 * React renders the shell and, at 5 Hz, the score. Everything the player feels
 * is drawn by PixiJS.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameClock } from '../game/engine/GameClock.ts';
import { GameEngine, type JudgmentEvent } from '../game/engine/GameEngine.ts';
import { DEFAULT_WINDOWS } from '../game/engine/NoteJudge.ts';
import {
  accuracy,
  grade,
  initialScoreState,
  meanAbsDeltaMs,
  meanDeltaMs,
  suggestedOffsetMs,
  type ScoreState,
} from '../game/engine/ScoreSystem.ts';
import { beatmapDurationMs, type Beatmap } from '../game/maps/schema.ts';
import { chartForTrack, LOCAL_TRACKS, WARMUP_MAP, type LocalTrack } from '../game/maps/library.ts';
import { ClickTrackAdapter } from '../playback/ClickTrackAdapter.ts';
import { LocalAudioAdapter } from '../playback/LocalAudioAdapter.ts';
import type { PlaybackAdapter } from '../playback/PlaybackAdapter.ts';
import { GameRenderer } from '../render/pixi/GameRenderer.ts';
import { scaledZones, usePosePipeline } from '../pose/usePosePipeline.ts';
import { applyCalibration, calibrationFromPose, describeCalibration, type FieldCalibration } from '../game/calibration.ts';
import type { Zone } from '../game/zones.ts';
import type { PoseSnapshot } from '../pose/poseTypes.ts';
import { loadSettings, saveSettings } from './settingsStorage.ts';
import { navigate } from './useHashRoute.ts';
import type { Settings } from './types.ts';
import type { ZoneEvent } from '../game/ZoneTracker.ts';

/**
 * Setup happens once, then songs are played from a menu that never
 * recalibrates. Fitting the field is about where the PLAYER is, not about
 * which track is queued — making it a per-song step charged everyone four
 * seconds for information that had not changed.
 */
type Phase = 'intro' | 'arming' | 'calibrating' | 'menu' | 'playing' | 'paused' | 'results';

/**
 * How long to watch the player before fitting the field to them.
 *
 * Longer than it needs to be, on purpose. The player presses Play at the
 * keyboard and then walks back into shot, and a fit measured during that walk
 * describes someone standing a foot from the lens. The first stretch is
 * discarded for exactly that reason.
 */
const CALIBRATION_MS = 4000;
const CALIBRATION_SETTLE_MS = 2000;

/** Published to React at 5 Hz. The hot loop never touches this. */
interface HudView {
  score: ScoreState;
  playbackTimeMs: number;
  durationMs: number;
  lastJudgment: string | null;
  driftMs: number;
}

const EMPTY_HUD: HudView = {
  score: initialScoreState(),
  playbackTimeMs: 0,
  durationMs: 0,
  lastJudgment: null,
  driftMs: 0,
};

export default function PlayScreen() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [phase, setPhase] = useState<Phase>('intro');
  const [hud, setHud] = useState<HudView>(EMPTY_HUD);
  const [trackId, setTrackId] = useState<string>('warmup');
  const [grid, setGrid] = useState<{ bpm: number; firstBeatMs: number } | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  /**
   * Kept separate from fatalError because it must be visible DURING play. A
   * renderer that fails leaves the engine running and the screen empty, which
   * is the most confusing possible failure to hit in silence.
   */
  const [rendererError, setRendererError] = useState<string | null>(null);

  const track: LocalTrack | undefined = LOCAL_TRACKS.find((t) => t.id === trackId);

  /**
   * The chart is derived from the tempo grid, so correcting a bad tempo
   * estimate re-pins every note without re-authoring the pattern.
   */
  const map: Beatmap = useMemo(() => {
    if (!track) return WARMUP_MAP;
    return chartForTrack(track, grid ?? undefined);
  }, [track, grid]);

  // Declared before the callbacks that read it, and before the pose hook that
  // is handed it — ordering here is load-bearing, not stylistic.
  const stageRef = useRef<HTMLDivElement>(null);
  const zonesRef = useRef<Zone[]>(scaledZones(settings.zoneScale));
  const calibrationRef = useRef<FieldCalibration | null>(null);
  const calibrationSamplesRef = useRef<PoseSnapshot[]>([]);
  const collectingRef = useRef(false);
  const [calibrationLabel, setCalibrationLabel] = useState<string>(describeCalibration(null));

  /**
   * Aspect of the play field. Measured from the stage, which is what the Pixi
   * renderer sizes itself to — so geometry, hit-testing and drawing all agree.
   */
  const fieldAspect = useCallback(() => {
    const stage = stageRef.current;
    return stage && stage.clientHeight > 0 ? stage.clientWidth / stage.clientHeight : 16 / 9;
  }, []);

  /** Re-derive the zone layout whenever the size setting or the fit changes. */
  const rebuildZones = useCallback(() => {
    zonesRef.current = applyCalibration(
      scaledZones(settings.zoneScale),
      calibrationRef.current,
    );
  }, [settings.zoneScale]);

  useEffect(() => {
    rebuildZones();
  }, [rebuildZones]);

  const rendererRef = useRef<GameRenderer | null>(null);
  const adapterRef = useRef<PlaybackAdapter | null>(null);
  const clockRef = useRef<GameClock | null>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const rafRef = useRef<number | null>(null);
  const phaseRef = useRef<Phase>('menu');
  const lastJudgmentRef = useRef<string | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  /** Feed judgments to the renderer immediately — never through React. */
  const presentJudgments = useCallback((judgments: readonly JudgmentEvent[]) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const now = performance.now();
    for (const judgment of judgments) {
      const zone = zonesRef.current.find((z) => z.id === judgment.zone);
      renderer.showJudgment(judgment.judgment, zone, now);
      lastJudgmentRef.current = judgment.judgment;
    }
  }, []);

  /** The pose pipeline calls this on every frame it produces. */
  const onPoseFrame = useCallback(
    (events: readonly ZoneEvent[], frame: { snapshot: PoseSnapshot; detected: boolean }) => {
      if (collectingRef.current && frame.detected) {
        calibrationSamplesRef.current.push(frame.snapshot);
        // Re-fit live so the player can watch the targets settle onto them
        // rather than discovering the result after the music starts.
        if (calibrationSamplesRef.current.length % 5 === 0) {
          const live = calibrationFromPose(calibrationSamplesRef.current, fieldAspect());
          if (live) {
            calibrationRef.current = live;
            rebuildZones();
          }
        }
      }
      const engine = engineRef.current;
      if (!engine || phaseRef.current !== 'playing' || events.length === 0) return;
      presentJudgments(engine.handleZoneEvents(events));
    },
    [presentJudgments, rebuildZones, fieldAspect],
  );

  const pose = usePosePipeline(settings, zonesRef, fieldAspect, onPoseFrame);
  const { snapshotRef, detectedRef, videoRef, renderRate } = pose;

  // ---- PixiJS lifecycle ----
  useEffect(() => {
    let cancelled = false;
    const renderer = new GameRenderer();
    const container = stageRef.current;
    if (!container) return;

    renderer
      .init(container)
      .then(() => {
        if (cancelled) {
          renderer.destroy();
          return;
        }
        rendererRef.current = renderer;
      })
      .catch((err: unknown) => {
        setRendererError(
          err instanceof Error
            ? `The graphics renderer failed to start: ${err.message}`
            : 'The graphics renderer failed to start.',
        );
      });

    return () => {
      cancelled = true;
      rendererRef.current = null;
      renderer.destroy();
    };
  }, []);

  // ---- the loop ----
  useEffect(() => {
    const step = () => {
      const now = performance.now();
      const clock = clockRef.current;
      const engine = engineRef.current;

      if (clock && engine && phaseRef.current === 'playing') {
        clock.tick();
        presentJudgments(engine.update());

        // The song is over once every note has settled and playback has run
        // past the final one. Both conditions matter: a chart can finish
        // before its audio does.
        if (engine.isComplete()) {
          setPhase('results');
        }
      }

      const renderer = rendererRef.current;
      if (renderer) {
        renderer.render({
          zones: zonesRef.current,
          notes: engine ? engine.getNotes() : [],
          playbackTimeMs: clock ? clock.rawTimeMs() : 0,
          snapshot: snapshotRef.current,
          poseVisible: detectedRef.current,
          nowMs: now,
          showSkeleton: settings.showSkeleton,
        });
        renderRate.current.tick(now);
      }

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [presentJudgments, zonesRef, snapshotRef, detectedRef, renderRate, settings.showSkeleton]);

  // ---- the cold path ----
  useEffect(() => {
    if (phase !== 'playing' && phase !== 'paused') return;
    const id = window.setInterval(() => {
      const engine = engineRef.current;
      const clock = clockRef.current;
      if (!engine || !clock) return;
      setHud({
        score: engine.getScore(),
        playbackTimeMs: clock.rawTimeMs(),
        durationMs: beatmapDurationMs(map),
        lastJudgment: lastJudgmentRef.current,
        driftMs: clock.stats().driftMs,
      });
    }, 200);
    return () => window.clearInterval(id);
  }, [phase, map]);

  const teardownSong = useCallback(() => {
    adapterRef.current?.dispose();
    adapterRef.current = null;
    clockRef.current = null;
    engineRef.current = null;
    rendererRef.current?.clearEffects();
    lastJudgmentRef.current = null;
  }, []);

  const startSong = useCallback(async () => {
    setFatalError(null);
    teardownSong();

    const playback = map.song.playback;
    let adapter: PlaybackAdapter;

    try {
      if (playback.provider === 'localAudio') {
        const local = new LocalAudioAdapter(playback.src!);
        await local.ready();
        adapter = local;
      } else {
        adapter = new ClickTrackAdapter({
          bpm: playback.bpm ?? map.analysis.bpm,
          beatsPerBar: playback.beatsPerBar ?? 4,
          bars: playback.bars ?? 16,
          leadInBars: 1,
        });
      }
    } catch (err) {
      setFatalError(err instanceof Error ? err.message : 'Could not load that track.');
      setPhase('menu');
      return;
    }

    adapterRef.current = adapter;
    const clock = new GameClock(adapter, { offsetMs: settings.audioOffsetMs });
    clockRef.current = clock;
    engineRef.current = new GameEngine(clock, map, { windows: DEFAULT_WINDOWS });

    try {
      await adapter.play();
      clock.reset();
      setPhase('playing');
    } catch (err) {
      setFatalError(err instanceof Error ? err.message : 'Could not start audio.');
      setPhase('menu');
    }
  }, [map, settings.audioOffsetMs, teardownSong]);

  /**
   * Watch the player for a moment and fit the play field to their reach.
   *
   * Targets are screen-anchored during play, as spec §3 requires — this only
   * decides WHERE on screen they sit, once, before the music starts. Without it
   * a corner can simply be outside the player's arms, which reads as the
   * tracker failing when nothing is wrong with it.
   */
  const calibrate = useCallback(async () => {
    setPhase('calibrating');
    calibrationSamplesRef.current = [];
    collectingRef.current = true;

    // Let the player get into position, then throw that stretch away and keep
    // only what was measured once they had settled.
    await new Promise((resolve) => setTimeout(resolve, CALIBRATION_SETTLE_MS));
    calibrationSamplesRef.current = [];
    await new Promise((resolve) => setTimeout(resolve, CALIBRATION_MS - CALIBRATION_SETTLE_MS));
    collectingRef.current = false;

    const fitted = calibrationFromPose(calibrationSamplesRef.current, fieldAspect());

    // Keep the previous fit if this attempt saw nothing usable, rather than
    // throwing away a good calibration because the player stepped out of shot.
    if (fitted) calibrationRef.current = fitted;
    setCalibrationLabel(describeCalibration(calibrationRef.current));
    rebuildZones();
  }, [rebuildZones, fieldAspect]);

  /** One-time setup: camera, then fit the field, then hand over to the menu. */
  const setUp = useCallback(async () => {
    setPhase('arming');
    if (pose.status !== 'running') await pose.start();
    if (pose.status === 'error') {
      setPhase('intro');
      return;
    }
    await calibrate();
    setPhase('menu');
  }, [pose, calibrate]);

  /** Re-fit without leaving the menu, for when the player has moved. */
  const refit = useCallback(async () => {
    await calibrate();
    setPhase('menu');
  }, [calibrate]);

  const pause = useCallback(() => {
    adapterRef.current?.pause();
    clockRef.current?.tick();
    setPhase('paused');
  }, []);

  const resume = useCallback(async () => {
    await adapterRef.current?.play();
    clockRef.current?.sync();
    setPhase('playing');
  }, []);

  /**
   * Auto-pause when the tab goes away.
   *
   * requestAnimationFrame stops firing in a hidden tab, but the audio clock
   * does not stop — so without this the song plays on while nothing is judged,
   * and every note passed in the meantime lands as a miss the instant the
   * player comes back. Spec §14 makes the same point about a buffering player:
   * judgment must never advance against a game nobody is watching.
   */
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden && phaseRef.current === 'playing') {
        adapterRef.current?.pause();
        clockRef.current?.tick();
        setPhase('paused');
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const quit = useCallback(() => {
    teardownSong();
    setPhase('menu');
    setHud(EMPTY_HUD);
  }, [teardownSong]);

  /** Replaying goes straight back into the song — the fit still holds. */
  const retry = useCallback(() => {
    void startSong();
  }, [startSong]);

  useEffect(() => teardownSong, [teardownSong]);

  const score = hud.score;
  const live = phase === 'playing' || phase === 'paused';
  const progress = hud.durationMs > 0 ? Math.min(1, Math.max(0, hud.playbackTimeMs / hud.durationMs)) : 0;

  return (
    <div className="play">
      <div className="play__stage" ref={stageRef}>
        <video
          ref={videoRef}
          className={[
            'stage__video',
            settings.mirrored ? 'stage__video--mirrored' : '',
            settings.showVideo ? 'stage__video--dim' : 'stage__video--hidden',
          ].join(' ')}
          playsInline
          muted
        />
        {rendererError && (
          <div className="play__rendererror">
            {rendererError}
            <br />
            Reload the page — this is usually a lost WebGL context.
          </div>
        )}

        {live && (
          <>
            <div className="play__hud">
              <div className="play__score mono">{score.score.toLocaleString()}</div>
              {score.combo > 1 && (
                <div className="play__combo mono">
                  {score.combo}<span>x</span>
                </div>
              )}
              <div className="play__accuracy mono">{(accuracy(score) * 100).toFixed(1)}%</div>
            </div>

            <div className="play__progress">
              <div className="play__progressfill" style={{ width: `${progress * 100}%` }} />
            </div>

            <button className="play__pause" onClick={phase === 'paused' ? resume : pause}>
              {phase === 'paused' ? '▶' : '❚❚'}
            </button>
          </>
        )}

        {phase === 'paused' && (
          <div className="play__overlay">
            <div className="play__panel">
              <h2>Paused</h2>
              <p className="play__hint">
                Judgment is frozen — notes cannot expire while the song is stopped.
              </p>
              <button className="button--primary" onClick={resume}>Resume</button>
              <button onClick={quit}>Quit to menu</button>
            </div>
          </div>
        )}

        {/*
          Deliberately NOT a full-screen overlay: the targets are moving onto
          the player right now, and hiding them behind a scrim would make the
          one useful thing on screen invisible.
        */}
        {phase === 'calibrating' && (
          <div className="play__calibrating">
            <h2>Get into position</h2>
            <p className="play__hint">
              Step back until your shoulders are clearly in frame. The targets are
              moving to where your arms can reach — watch them settle.
            </p>
            <div className="calbar"><div className="calbar__fill" /></div>
          </div>
        )}

        {(phase === 'intro' || phase === 'arming') && (
          <div className="play__overlay">
            <div className="play__panel">
              <h1 className="stage__title">hop<span>//</span>beat</h1>
              <p className="play__hint">
                A webcam turns your body into the controller. Set up once, then play
                anything — the fit stays until you move.
              </p>
              {fatalError && <div className="error"><div className="error__title">{fatalError}</div></div>}
              {pose.error && (
                <div className="error">
                  <div className="error__title">{pose.error.message}</div>
                  <div className="error__hint">{pose.error.hint}</div>
                </div>
              )}
              <button
                className="button--primary"
                onClick={setUp}
                disabled={phase === 'arming'}
              >
                {phase === 'arming' ? 'Starting camera…' : 'Start camera'}
              </button>
              <div className="play__links">
                <button className="button--quiet" onClick={() => navigate('/debug')}>
                  MVP 0 debug view
                </button>
                <button className="button--quiet" onClick={() => navigate('/spec')}>
                  Spec progress
                </button>
              </div>
            </div>
          </div>
        )}

        {phase === 'menu' && (
          <div className="play__overlay">
            <div className="play__panel">
              <div className="songselect">
                <button
                  className={`songselect__item ${trackId === 'warmup' ? 'is-active' : ''}`}
                  onClick={() => setTrackId('warmup')}
                >
                  <span className="songselect__title">Warm-up</span>
                  <span className="songselect__meta">120 BPM click · no audio file</span>
                </button>
                {LOCAL_TRACKS.map((t) => (
                  <button
                    key={t.id}
                    className={`songselect__item ${trackId === t.id ? 'is-active' : ''}`}
                    onClick={() => { setTrackId(t.id); setGrid(null); }}
                  >
                    <span className="songselect__title">{t.title}</span>
                    <span className="songselect__meta">
                      {t.artist} · {Math.round(t.bpm)} BPM · {Math.round(t.durationMs / 1000)}s
                    </span>
                  </button>
                ))}
              </div>

              <p className="play__hint">
                {map.notes.length} notes · {map.analysis.bpm.toFixed(1)} BPM
                {track ? ' · tempo is estimated — correct it below if the notes drift out of time.' : ''}
              </p>

              {track && (
                <div className="tempofix">
                  <label className="field__label">
                    <span>tempo</span>
                    <span className="field__value mono">{(grid?.bpm ?? track.bpm).toFixed(2)} BPM</span>
                  </label>
                  <div className="tempofix__row">
                    <button onClick={() => setGrid({ bpm: (grid?.bpm ?? track.bpm) / 2, firstBeatMs: grid?.firstBeatMs ?? track.firstBeatMs })}>÷2</button>
                    <button onClick={() => setGrid({ bpm: (grid?.bpm ?? track.bpm) * 2, firstBeatMs: grid?.firstBeatMs ?? track.firstBeatMs })}>×2</button>
                    <button onClick={() => setGrid(null)}>reset</button>
                  </div>
                  <label className="field__label" style={{ marginTop: 8 }}>
                    <span>first beat</span>
                    <span className="field__value mono">{Math.round(grid?.firstBeatMs ?? track.firstBeatMs)} ms</span>
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={2000}
                    step={10}
                    value={grid?.firstBeatMs ?? track.firstBeatMs}
                    onChange={(e) => setGrid({ bpm: grid?.bpm ?? track.bpm, firstBeatMs: Number(e.target.value) })}
                  />
                  <p className="field__help">
                    A tempo estimator landing an octave out is routine. If the notes feel
                    twice as fast as the music, halve it.
                  </p>
                </div>
              )}
              <p className="play__hint">
                Hit each target when the shrinking ring meets it. Stand back far enough
                that your head and hips are both in frame.
              </p>
              {fatalError && <div className="error"><div className="error__title">{fatalError}</div></div>}

              <button className="button--primary" onClick={() => void startSong()}>
                Play
              </button>

              <div className="menufit">
                <span className="menufit__label">{calibrationLabel}</span>
                <button className="button--quiet" onClick={() => void refit()}>
                  Re-fit
                </button>
              </div>

              <label className="checkbox" style={{ justifyContent: 'center' }}>
                <input
                  type="checkbox"
                  checked={settings.showVideo}
                  onChange={(e) => setSettings((prev) => ({ ...prev, showVideo: e.target.checked }))}
                />
                show camera
              </label>

              <div className="play__links">
                <button className="button--quiet" onClick={() => navigate('/debug')}>
                  MVP 0 debug view
                </button>
                <button className="button--quiet" onClick={() => navigate('/spec')}>
                  Spec progress
                </button>
              </div>
            </div>
          </div>
        )}

        {phase === 'results' && (
          <div className="play__overlay">
            <div className="play__panel play__panel--results">
              <p className="results__label mono">RESULTS</p>
              <div className="results__grade">{grade(score)}</div>
              <div className="results__score mono">{score.score.toLocaleString()}</div>

              <div className="results__grid">
                <div><span className="results__k">PERFECT</span><span className="results__v mono" style={{ color: 'var(--good)' }}>{score.counts.PERFECT}</span></div>
                <div><span className="results__k">GOOD</span><span className="results__v mono" style={{ color: 'var(--gold)' }}>{score.counts.GOOD}</span></div>
                <div><span className="results__k">MISS</span><span className="results__v mono" style={{ color: 'var(--bad)' }}>{score.counts.MISS}</span></div>
                <div><span className="results__k">MAX COMBO</span><span className="results__v mono">{score.maxCombo}</span></div>
                <div><span className="results__k">ACCURACY</span><span className="results__v mono">{(accuracy(score) * 100).toFixed(1)}%</span></div>
                <div>
                  <span className="results__k">MEAN ERROR</span>
                  <span className="results__v mono">
                    {meanAbsDeltaMs(score) === null ? '—' : `${meanAbsDeltaMs(score)!.toFixed(0)} ms`}
                  </span>
                </div>
              </div>

              <button className="button--primary" onClick={retry}>Play again</button>
              <button onClick={quit}>Menu</button>
            </div>
          </div>
        )}
      </div>

      <aside className="play__side">
        <h2 className="panel__heading">Calibration</h2>
        <div className="field">
          <label className="field__label">
            <span>audio offset</span>
            <span className="field__value mono">{settings.audioOffsetMs > 0 ? '+' : ''}{settings.audioOffsetMs} ms</span>
          </label>
          <input
            type="range"
            min={-200}
            max={200}
            step={5}
            value={settings.audioOffsetMs}
            onChange={(e) => {
              const audioOffsetMs = Number(e.target.value);
              setSettings((s) => ({ ...s, audioOffsetMs }));
              clockRef.current?.setOffsetMs(audioOffsetMs);
            }}
          />
          <p className="field__help">
            Shifts every note's judged time. If you consistently read as <strong>late</strong>,
            increase it — the number is compensating for delay between your hand moving and
            the game seeing it.
          </p>
        </div>

        {live && (
          <>
            <div className="row"><span className="row__label">timing bias</span>
              <span className="row__value mono">
                {meanDeltaMs(score) === null
                  ? '—'
                  : `${meanDeltaMs(score)! > 0 ? '+' : ''}${meanDeltaMs(score)!.toFixed(0)} ms ${meanDeltaMs(score)! > 0 ? 'late' : 'early'}`}
              </span></div>
            <div className="row"><span className="row__label">spread</span>
              <span className="row__value mono">{meanAbsDeltaMs(score) === null ? '—' : `${meanAbsDeltaMs(score)!.toFixed(0)} ms`}</span></div>
            <div className="row"><span className="row__label">clock drift</span>
              <span className="row__value mono">{hud.driftMs.toFixed(1)} ms</span></div>
            <div className="row"><span className="row__label">pose</span>
              <span className="row__value mono">{pose.telemetry.poseHz.toFixed(0)} Hz</span></div>
            <div className="row"><span className="row__label">input latency</span>
              <span className="row__value mono">{pose.telemetry.latencyMeanMs.toFixed(0)} ms</span></div>
          </>
        )}

        {(() => {
          const suggestion = suggestedOffsetMs(score, settings.audioOffsetMs);
          if (suggestion === null || suggestion === settings.audioOffsetMs) return null;
          return (
            <button
              style={{ marginTop: 10 }}
              onClick={() => {
                setSettings((s) => ({ ...s, audioOffsetMs: suggestion }));
                clockRef.current?.setOffsetMs(suggestion);
              }}
            >
              Set offset to {suggestion > 0 ? '+' : ''}{suggestion} ms
            </button>
          );
        })()}

        <p className="hint" style={{ marginTop: 12 }}>
          <strong>Bias</strong> is which way you are off, and the offset slider cancels
          it. <strong>Spread</strong> is how tight you are — a large spread with a small
          bias means the windows are hard, not miscalibrated.
        </p>

        <h2 className="panel__heading" style={{ marginTop: 18 }}>View</h2>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.showVideo}
            onChange={(e) => setSettings((prev) => ({ ...prev, showVideo: e.target.checked }))}
          />
          show camera
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.showSkeleton}
            onChange={(e) => setSettings((prev) => ({ ...prev, showSkeleton: e.target.checked }))}
          />
          show skeleton
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.mirrored}
            onChange={(e) => setSettings((prev) => ({ ...prev, mirrored: e.target.checked }))}
          />
          mirror
        </label>

        <h2 className="panel__heading" style={{ marginTop: 18 }}>Field</h2>
        <p className="hint">{calibrationLabel}</p>
        <button
          style={{ marginTop: 8 }}
          disabled={pose.status !== 'running' || phase === 'calibrating' || phase === 'playing'}
          onClick={() => void refit()}
        >
          Re-fit to me
        </button>
        <p className="hint" style={{ marginTop: 8 }}>
          If a corner is hard to reach, move to where you want to stand and re-fit.
          Targets stay put while a song plays — only this decides where they sit.
        </p>
      </aside>
    </div>
  );
}
