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
import { windowsFor } from '../game/engine/NoteJudge.ts';
import {
  accuracy,
  grade,
  initialScoreState,
  meanAbsDeltaMs,
  meanDeltaMs,
  suggestedOffsetMs,
  timingDiagnosis,
  type ScoreState,
} from '../game/engine/ScoreSystem.ts';
import { beatmapDurationMs, type Beatmap } from '../game/maps/schema.ts';
import { chartForTrack, LOCAL_TRACKS, WARMUP_MAP, type LocalTrack } from '../game/maps/library.ts';
import type { Difficulty } from '../game/maps/patterns.ts';
import { ClickTrackAdapter } from '../playback/ClickTrackAdapter.ts';
import { LocalAudioAdapter } from '../playback/LocalAudioAdapter.ts';
import type { PlaybackAdapter } from '../playback/PlaybackAdapter.ts';
import { GameRenderer } from '../render/pixi/GameRenderer.ts';
import { PlayRecorder } from '../debug/PlayRecorder.ts';
import { scaledZones, usePosePipeline } from '../pose/usePosePipeline.ts';
import { checkHandPosition, checkPosition, type PositionCheck } from '../game/positioning.ts';
import { findMode, GAME_MODES, requiresHands, VISIBLE_MODES } from '../game/modes.ts';
import { stepZoneScale, zoneScaleForKey } from '../game/targetSizing.ts';
import type { Zone } from '../game/zones.ts';
import { loadSettings, saveSettings } from './settingsStorage.ts';
import { navigate } from './useHashRoute.ts';
import type { Settings } from './types.ts';
import type { ZoneEvent } from '../game/ZoneTracker.ts';
import type { PoseSnapshot } from '../pose/poseTypes.ts';

/**
 * Setup happens once, then songs are played from a menu that never
 * recalibrates. Fitting the field is about where the PLAYER is, not about
 * which track is queued — making it a per-song step charged everyone four
 * seconds for information that had not changed.
 */
type Phase = 'intro' | 'arming' | 'calibrating' | 'menu' | 'playing' | 'paused' | 'results';

/** How often the positioning guide refreshes. Fast enough to feel responsive. */
const POSITION_CHECK_MS = 150;

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
  const [modeId, setModeId] = useState<string>(
    () => new URLSearchParams(window.location.search).get('mode') ?? 'body',
  );

  /**
   * Developer readouts are off unless asked for with ?debug=1.
   *
   * Clock drift, inference cost and timing bias are diagnostics for whoever is
   * building this. To a player they are noise at best and discouraging at
   * worst — a panel of numbers implies the game is something to be configured
   * rather than played. The MVP 0 view at /#/debug still has all of it.
   */
  const showDiagnostics = useMemo(
    () => new URLSearchParams(window.location.search).get('debug') === '1',
    [],
  );
  const mode = findMode(modeId);
  const [trackId, setTrackId] = useState<string>('warmup');
  const [difficulty, setDifficulty] = useState<Difficulty>('easy');
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
    return chartForTrack(track, { ...grid, difficulty });
  }, [track, grid, difficulty]);

  // Declared before the callbacks that read it, and before the pose hook that
  // is handed it — ordering here is load-bearing, not stylistic.
  const stageRef = useRef<HTMLDivElement>(null);

  /**
   * The four targets, at FIXED screen positions. Spec §3: the player moves
   * into them, never the other way round. Nothing here may relocate them —
   * only the size setting changes their geometry.
   */
  const zonesRef = useRef<Zone[]>(scaledZones(settings.zoneScale));
  useEffect(() => {
    zonesRef.current = scaledZones(settings.zoneScale, mode.layout);
  }, [settings.zoneScale, mode]);

  /**
   * A brief on-screen readout after a size change, so the player sees the new
   * value without looking away from the game.
   *
   * Held as state with a timer rather than compared against the clock during
   * render — reading Date.now() while rendering makes output depend on when
   * React happens to re-run the component.
   */
  const [sizeFlash, setSizeFlash] = useState<string | null>(null);
  const sizeFlashTimer = useRef<number | null>(null);
  // The key handler is installed once; markMoment is defined further down.
  const markMomentRef = useRef<() => void>(() => {});

  const flashSize = useCallback((scale: number) => {
    setSizeFlash(`${scale.toFixed(2)}×`);
    if (sizeFlashTimer.current !== null) window.clearTimeout(sizeFlashTimer.current);
    sizeFlashTimer.current = window.setTimeout(() => setSizeFlash(null), 1400);
  }, []);

  /** One step bigger or smaller, from a button or a key. */
  const nudgeSize = useCallback(
    (steps: number) => {
      setSettings((prev) => {
        const zoneScale = stepZoneScale(prev.zoneScale, steps);
        flashSize(zoneScale);
        return { ...prev, zoneScale };
      });
    },
    [flashSize],
  );

  /**
   * Live advice while the player finds a spot they can play from.
   *
   * Mirrored into a ref as well: the render loop needs it every frame and must
   * not read React state from inside requestAnimationFrame.
   */
  const [position, setPosition] = useState<PositionCheck | null>(null);
  /** Targets the player has actually touched during the positioning step. */
  const touchedRef = useRef<Set<string>>(new Set());
  const positionRef = useRef<PositionCheck | null>(null);
  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  /**
   * Aspect of the play field. Measured from the stage, which is what the Pixi
   * renderer sizes itself to — so geometry, hit-testing and drawing all agree.
   */
  const fieldAspect = useCallback(() => {
    const stage = stageRef.current;
    return stage && stage.clientHeight > 0 ? stage.clientWidth / stage.clientHeight : 16 / 9;
  }, []);

  const rendererRef = useRef<GameRenderer | null>(null);
  const adapterRef = useRef<PlaybackAdapter | null>(null);
  const clockRef = useRef<GameClock | null>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const rafRef = useRef<number | null>(null);
  const recorderRef = useRef(new PlayRecorder());
  const [markCount, setMarkCount] = useState(0);
  const phaseRef = useRef<Phase>('menu');
  const lastJudgmentRef = useRef<string | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
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
    (events: readonly ZoneEvent[], frame: { snapshot: PoseSnapshot }) => {
      if (phaseRef.current === 'playing' && clockRef.current) {
        recorderRef.current.sampleTrack(frame.snapshot, clockRef.current.rawTimeMs());
      }
      if (phaseRef.current === 'calibrating') {
        for (const event of events) {
          if (event.type === 'ZONE_ENTER') touchedRef.current.add(event.zoneId);
        }
      }
      const engine = engineRef.current;
      if (!engine || phaseRef.current !== 'playing' || events.length === 0) return;

      const judgments = engine.handleZoneEvents(events);
      presentJudgments(judgments);
      recorderRef.current.recordStrikes(
        events,
        judgments,
        clockRef.current?.rawTimeMs() ?? 0,
      );

      // Acknowledge strikes that matched no note. Silence would be
      // indistinguishable from the camera not having seen the hand at all.
      const claimed = new Set(judgments.map((j) => j.zone));
      const renderer = rendererRef.current;
      if (renderer) {
        const now = performance.now();
        for (const event of events) {
          if (event.type !== 'ZONE_ENTER' || claimed.has(event.zoneId)) continue;
          renderer.showStrike(
            zonesRef.current.find((z) => z.id === event.zoneId),
            now,
          );
        }
      }
    },
    [presentJudgments],
  );

  const pose = usePosePipeline(settings, zonesRef, fieldAspect, mode, onPoseFrame);
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
          unreachableZones:
            phaseRef.current === 'calibrating' ? (positionRef.current?.unreachable ?? []) : [],
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

    recorderRef.current.reset();
    setMarkCount(0);
    adapterRef.current = adapter;
    const clock = new GameClock(adapter, { offsetMs: settings.audioOffsetMs });
    clockRef.current = clock;
    engineRef.current = new GameEngine(clock, map, { windows: windowsFor(map.difficulty) });

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
  /**
   * Resize targets from anywhere, including mid-song.
   *
   * Spec §24 permits this — size is a difficulty and accessibility setting and
   * moves nothing. Hunting a settings panel while a song runs is not a real
   * option, which is the whole reason this is bound to a key.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (event.key === 'm' || event.key === 'M') {
        event.preventDefault();
        markMomentRef.current();
        return;
      }

      const next = zoneScaleForKey(event.key, settingsRef.current.zoneScale);
      if (next === null) return;
      event.preventDefault();
      setSettings((prev) => ({ ...prev, zoneScale: next }));
      flashSize(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flashSize]);

  /**
   * Mark the moment something felt wrong.
   *
   * A player cannot report a timestamp, but they can hit a key the instant
   * something feels off — which turns "somewhere in the song" into a point to
   * look at. This is the single most useful thing in the recording.
   */
  const markMoment = useCallback(() => {
    const clock = clockRef.current;
    if (!clock || phaseRef.current !== 'playing') return;
    recorderRef.current.mark(clock.rawTimeMs());
    setMarkCount(recorderRef.current.markCount());
    flashSize(-1); // reuse the readout slot
    setSizeFlash(`marked ${(clock.rawTimeMs() / 1000).toFixed(1)}s`);
  }, [flashSize]);

  useEffect(() => {
    markMomentRef.current = markMoment;
  }, [markMoment]);

  const downloadLog = useCallback(() => {
    const document_ = recorderRef.current.build(map, {
      recordedAtIso: new Date().toISOString(),
      mode: mode.id,
      difficulty: map.difficulty,
      zoneScale: settings.zoneScale,
      audioOffsetMs: settings.audioOffsetMs,
      minVisibility: settings.minVisibility,
      exitRadiusScale: settings.exitRadiusScale,
      poseHz: pose.telemetry.poseHz,
      inferenceMeanMs: pose.telemetry.inferenceMeanMs,
      inputLatencyMs: pose.telemetry.latencyMeanMs,
      frameClockSource: pose.telemetry.frameClockSource,
      timestampSuspectRatio: pose.telemetry.suspectRatio,
      userAgent: navigator.userAgent,
    });
    const blob = new Blob([JSON.stringify(document_, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `hopbeat-play-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [map, mode, settings, pose.telemetry]);

  /** Open the positioning step. The targets do not change; the advice does. */
  const startPositioning = useCallback(() => {
    touchedRef.current = new Set();
    setPhase('calibrating');
  }, []);

  const donePositioning = useCallback(() => {
    setPhase('menu');
  }, []);

  /**
   * Advise the player while they find a spot.
   *
   * This only ever READS the pose and the fixed zones. It has no way to move a
   * target even if it wanted to, which is the guarantee that matters here.
   */
  useEffect(() => {
    if (phase !== 'calibrating') return;
    const id = window.setInterval(() => {
      const snapshot = snapshotRef.current;
      const zones = zonesRef.current;
      // A hands-only backend reports no torso, so the shoulder-based estimate
      // cannot run. Touching the targets proves reachability outright, which
      // is better evidence than any estimate would have been.
      const check = requiresHands(mode)
        ? checkHandPosition(snapshot, zones, touchedRef.current)
        : checkPosition(snapshot, zones, fieldAspect());

      // Having touched every target settles the question in ANY mode. Geometry
      // that disagrees with a demonstrated fact is the thing that is wrong.
      const allTouched = zones.every((z) => touchedRef.current.has(z.id));
      setPosition(
        allTouched && !check.ok
          ? { ...check, ok: true, guidance: 'You reached all four — good to go.' }
          : check,
      );
    }, POSITION_CHECK_MS);
    return () => window.clearInterval(id);
  }, [phase, fieldAspect, snapshotRef, zonesRef, mode]);

  /** One-time setup: camera, then let the player position and confirm. */
  const setUp = useCallback(async () => {
    setPhase('arming');
    if (pose.status !== 'running') await pose.start();
    if (pose.status === 'error') {
      setPhase('intro');
      return;
    }
    startPositioning();
  }, [pose, startPositioning]);

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
        {sizeFlash && <div className="sizeflash mono">target size {sizeFlash}</div>}

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
            <h2>Find your spot</h2>
            <p className="play__hint">
              The four targets are fixed — they are in the same place every game. Move
              yourself until you can reach all of them.
            </p>
            <p className="play__hint" style={{ fontSize: '0.75rem' }}>{mode.stance}</p>

            <p
              className="play__guidance"
              style={{ color: position?.ok ? 'var(--good)' : 'var(--gold)' }}
            >
              {position?.guidance ?? 'Looking for you…'}
            </p>

            {position && position.centre && (
              <div className="reachbar">
                <div
                  className="reachbar__fill"
                  style={{
                    width: `${Math.min(100, position.reachRatio * 100)}%`,
                    background: position.ok ? 'var(--good)' : 'var(--gold)',
                  }}
                />
                <span className="reachbar__mark" />
              </div>
            )}

            <p className="play__hint" style={{ fontSize: '0.72rem' }}>
              Touched {position?.reachable.length ?? 0} of{' '}
              {(position?.reachable.length ?? 0) + (position?.unreachable.length ?? 4)} targets.
              Reaching them all unlocks this step in any mode.
            </p>

            <div className="sizecontrol">
              <span className="sizecontrol__label">target size</span>
              <button onClick={() => nudgeSize(-1)} aria-label="Smaller targets">−</button>
              <span className="sizecontrol__value mono">{settings.zoneScale.toFixed(2)}×</span>
              <button onClick={() => nudgeSize(1)} aria-label="Bigger targets">+</button>
            </div>

            <div className="calbuttons calbuttons--two">
              <button
                className="button--primary"
                onClick={donePositioning}
                disabled={!position?.ok}
              >
                I'm in position
              </button>
              <button onClick={donePositioning}>Skip</button>
            </div>
          </div>
        )}

        {(phase === 'intro' || phase === 'arming') && (
          <div className="play__overlay">
            <div className="play__panel">
              <h1 className="stage__title">hop<span>//</span>beat</h1>
              <p className="play__hint">
                A webcam turns your body into the controller. Pick a mode, set up once,
                then play.
              </p>

              <div className="songselect">
                {(VISIBLE_MODES.length > 0 ? VISIBLE_MODES : GAME_MODES).map((m) => (
                  <button
                    key={m.id}
                    className={`songselect__item ${modeId === m.id ? 'is-active' : ''}`}
                    onClick={() => setModeId(m.id)}
                    disabled={phase === 'arming'}
                  >
                    <span className="songselect__title">{m.name}</span>
                    <span className="songselect__meta">{m.description}</span>
                  </button>
                ))}
              </div>

              <p className="play__hint" style={{ fontSize: '0.72rem' }}>
                First start downloads the tracking model — a few seconds, once.
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

              <div className="difficulty">
                {(['easy', 'normal'] as const).map((d) => (
                  <button
                    key={d}
                    className={difficulty === d ? 'is-active' : ''}
                    onClick={() => setDifficulty(d)}
                  >
                    {d}
                  </button>
                ))}
              </div>

              <p className="play__hint">
                {map.notes.length} notes · {map.analysis.bpm.toFixed(1)} BPM
                {' · ±'}{windowsFor(map.difficulty).goodMs}ms window
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
                <span className="menufit__label">
                  Targets are fixed. Check you can reach all four before you start.
                </span>
                <button className="button--quiet" onClick={startPositioning}>
                  Check position
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

              {showDiagnostics && (() => {
                const diagnosis = timingDiagnosis(score);
                if (diagnosis.fault === 'unknown' || diagnosis.fault === 'none') return null;
                return (
                  <p className="play__hint" style={{ color: 'var(--gold)' }}>
                    {diagnosis.explanation}
                  </p>
                );
              })()}

              <button className="button--primary" onClick={retry}>Play again</button>
              {showDiagnostics && (
                <button onClick={downloadLog}>
                  Download play log{markCount > 0 ? ` (${markCount} marked)` : ''}
                </button>
              )}
              <button onClick={quit}>Menu</button>
            </div>
          </div>
        )}
      </div>

      <aside className="play__side">
        <h2 className="panel__heading">How to play</h2>
        <ol className="howto">
          <li>Stand where the camera can see you, and check you can reach all four targets.</li>
          <li>Each target lights up with a ring closing in on it.</li>
          <li>Hit the target when the ring meets it — with your hand, in the air.</li>
          <li>Keep going. Missing one is fine; the next is already on its way.</li>
        </ol>

        <h2 className="panel__heading" style={{ marginTop: 18 }}>Target size</h2>
        <div className="sizecontrol">
          <span className="sizecontrol__label">size</span>
          <button onClick={() => nudgeSize(-1)} aria-label="Smaller targets">−</button>
          <span className="sizecontrol__value mono">{settings.zoneScale.toFixed(2)}×</span>
          <button onClick={() => nudgeSize(1)} aria-label="Bigger targets">+</button>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          Make them bigger if they are hard to hit. Works during a song, or press{' '}
          <kbd>[</kbd> <kbd>]</kbd>.
        </p>

        <h2 className="panel__heading" style={{ marginTop: 18 }}>If it feels out of time</h2>
        <div className="field">
          <label className="field__label">
            <span>timing</span>
            <span className="field__value mono">
              {settings.audioOffsetMs > 0 ? '+' : ''}{settings.audioOffsetMs} ms
            </span>
          </label>
          <input
            type="range"
            min={-200}
            max={200}
            step={5}
            value={settings.audioOffsetMs}
            onChange={(e) => {
              const audioOffsetMs = Number(e.target.value);
              setSettings((prev) => ({ ...prev, audioOffsetMs }));
              clockRef.current?.setOffsetMs(audioOffsetMs);
            }}
          />
          <p className="field__help">
            Slide right if the game feels like it wants you to hit early, left if late.
          </p>
        </div>

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

        <button
          style={{ marginTop: 14 }}
          disabled={pose.status !== 'running' || phase === 'calibrating' || phase === 'playing'}
          onClick={startPositioning}
        >
          Check my position
        </button>
        <p className="hint" style={{ marginTop: 8 }}>
          The targets never move. If one is out of reach, step closer to the camera.
        </p>

        {showDiagnostics && (
          <>
            <h2 className="panel__heading" style={{ marginTop: 20 }}>Diagnostics</h2>
            <div className="row"><span className="row__label">mode</span>
              <span className="row__value mono">{mode.name}</span></div>
            <div className="row"><span className="row__label">timing bias</span>
              <span className="row__value mono">
                {meanDeltaMs(score) === null
                  ? '—'
                  : `${meanDeltaMs(score)! > 0 ? '+' : ''}${meanDeltaMs(score)!.toFixed(0)} ms`}
              </span></div>
            <div className="row"><span className="row__label">spread</span>
              <span className="row__value mono">
                {meanAbsDeltaMs(score) === null ? '—' : `${meanAbsDeltaMs(score)!.toFixed(0)} ms`}
              </span></div>
            <div className="row"><span className="row__label">clock drift</span>
              <span className="row__value mono">{hud.driftMs.toFixed(1)} ms</span></div>
            <div className="row"><span className="row__label">pose</span>
              <span className="row__value mono">{pose.telemetry.poseHz.toFixed(0)} Hz</span></div>
            <div className="row"><span className="row__label">input latency</span>
              <span className="row__value mono">{pose.telemetry.latencyMeanMs.toFixed(0)} ms</span></div>
            <div className="row"><span className="row__label">marks</span>
              <span className="row__value mono">{markCount}</span></div>

            {(() => {
              const diagnosis = timingDiagnosis(score);
              if (diagnosis.fault === 'unknown') return null;
              const colour =
                diagnosis.fault === 'tempo'
                  ? 'var(--bad)'
                  : diagnosis.fault === 'offset'
                    ? 'var(--gold)'
                    : 'var(--good)';
              return (
                <p className="hint" style={{ marginTop: 10, color: colour, lineHeight: 1.6 }}>
                  {diagnosis.explanation}
                </p>
              );
            })()}

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
                  Set timing to {suggestion > 0 ? '+' : ''}{suggestion} ms
                </button>
              );
            })()}

            <button style={{ marginTop: 8 }} disabled={phase !== 'playing'} onClick={markMoment}>
              Mark this moment <kbd>M</kbd>
            </button>
            <button style={{ marginTop: 6 }} onClick={downloadLog}>
              Download play log
            </button>
          </>
        )}
      </aside>
    </div>
  );
}
