/**
 * The authoritative clock. Spec §7.
 *
 * The problem this solves: a playback source reports its position far more
 * coarsely than a game needs to read it. An <audio> element updates
 * `currentTime` only every 20–50 ms depending on the browser, so polling it
 * once per frame produces a time that sticks and then jumps. Notes scheduled
 * against a staircase visibly stutter, and judgment inherits the staircase as
 * error.
 *
 * So the clock does two things:
 *
 *   1. SAMPLE the source, and remember the wall-clock instant of that sample.
 *   2. INTERPOLATE forward from that sample using performance.now(), which is
 *      smooth and monotonic.
 *
 * When the interpolation drifts too far from a fresh sample, it resynchronises.
 * The source always wins in the end — interpolation only fills the gaps
 * between the truths it tells.
 *
 * Nothing here touches the DOM or the audio API, so the whole thing is tested
 * against a fake adapter and an injected clock.
 */
import type { PlaybackAdapter } from '../../playback/PlaybackAdapter.ts';

export interface GameClockOptions {
  /**
   * Resync when interpolated and sampled time disagree by more than this.
   * Small enough that error stays well inside a judgment window; large enough
   * not to fight normal source jitter.
   */
  resyncThresholdMs?: number;
  /**
   * Added to playback time before judging. Positive values mean the player's
   * input arrives late — which it does, by roughly the input latency measured
   * in MVP 0. Spec §7 calls for calibration to be first class.
   */
  offsetMs?: number;
  /**
   * Fraction of measured bias removed per tick. Zero disables slewing and
   * leaves only hard resyncs.
   */
  slewRate?: number;
  /** Bias smaller than this is left alone, so the clock does not chase noise. */
  slewDeadbandMs?: number;
  /** Injectable for tests. Defaults to performance.now. */
  now?: () => number;
}

export const DEFAULT_RESYNC_THRESHOLD_MS = 40;
export const DEFAULT_SLEW_RATE = 0.05;
export const DEFAULT_SLEW_DEADBAND_MS = 3;
/** Ticks of drift history used to estimate bias. About a second at 60 Hz. */
const DRIFT_WINDOW = 60;

export class GameClock {
  private adapter: PlaybackAdapter;
  private now: () => number;
  private resyncThresholdMs: number;
  private slewRate: number;
  private slewDeadbandMs: number;
  private offsetMs: number;
  /** Recent drift samples, used to separate real bias from source coarseness. */
  private driftHistory: number[] = [];

  /** Source time at the last sample, and the wall-clock instant it was taken. */
  private sampledTimeMs = 0;
  private sampledAtMs = 0;
  private running = false;
  private resyncCount = 0;
  private lastDriftMs = 0;

  constructor(adapter: PlaybackAdapter, options: GameClockOptions = {}) {
    this.adapter = adapter;
    this.now = options.now ?? (() => performance.now());
    this.resyncThresholdMs = options.resyncThresholdMs ?? DEFAULT_RESYNC_THRESHOLD_MS;
    this.slewRate = options.slewRate ?? DEFAULT_SLEW_RATE;
    this.slewDeadbandMs = options.slewDeadbandMs ?? DEFAULT_SLEW_DEADBAND_MS;
    this.offsetMs = options.offsetMs ?? 0;
    this.sync();
  }

  setOffsetMs(offsetMs: number): void {
    this.offsetMs = offsetMs;
  }

  getOffsetMs(): number {
    return this.offsetMs;
  }

  /** Force the interpolator back onto the source's reported position. */
  sync(): void {
    this.sampledTimeMs = this.adapter.getCurrentTimeMs();
    this.sampledAtMs = this.now();
    this.driftHistory.length = 0;
  }

  /**
   * Advance the clock. Call once per frame, before reading the time.
   *
   * While the source is not playing there is nothing to interpolate: a paused
   * track's position is simply whatever it says it is. Spec §14 is explicit
   * that judgment must not advance against a stopped player.
   */
  tick(): void {
    const state = this.adapter.getState();
    this.running = state === 'playing';

    if (!this.running) {
      this.sync();
      this.lastDriftMs = 0;
      return;
    }

    const sourceTimeMs = this.adapter.getCurrentTimeMs();
    const interpolated = this.sampledTimeMs + (this.now() - this.sampledAtMs);
    this.lastDriftMs = interpolated - sourceTimeMs;

    if (Math.abs(this.lastDriftMs) > this.resyncThresholdMs) {
      this.resyncCount += 1;
      this.sync();
      return;
    }

    this.slewTowardSource();
  }

  /**
   * Remove persistent bias without jumping, and without fighting a coarse
   * source.
   *
   * The trap this avoids: a source that reports its position in 30 ms steps
   * makes drift sawtooth between 0 and +30 ms. The MEAN of that is +15 ms even
   * though the interpolated clock is perfectly correct — correcting toward the
   * mean would introduce a 15 ms lag that was never there.
   *
   * The MINIMUM drift over a window does not have that problem. For a merely
   * coarse source it sits at zero, so nothing is corrected. For a source we are
   * genuinely ahead of, every sample including the smallest carries the bias,
   * so the minimum measures it exactly.
   *
   * Bias is then bled off a few percent per tick, which is invisible to a
   * player but converges in well under a second.
   */
  private slewTowardSource(): void {
    if (this.slewRate <= 0) return;

    this.driftHistory.push(this.lastDriftMs);
    if (this.driftHistory.length < DRIFT_WINDOW) return;
    if (this.driftHistory.length > DRIFT_WINDOW) this.driftHistory.shift();

    const bias = Math.min(...this.driftHistory);
    if (Math.abs(bias) <= this.slewDeadbandMs) return;

    this.sampledTimeMs -= bias * this.slewRate;
  }

  /**
   * Current playback position, smoothed, with the calibration offset applied.
   * This is the number every note is judged against.
   */
  getTimeMs(): number {
    return this.rawTimeMs() + this.offsetMs;
  }

  /** Position without the calibration offset — for display and debugging. */
  rawTimeMs(): number {
    if (!this.running) return this.sampledTimeMs;
    return this.sampledTimeMs + (this.now() - this.sampledAtMs);
  }

  /**
   * Playback time corresponding to a past wall-clock instant.
   *
   * This is how an input event gets judged honestly. A zone entry is stamped
   * with the time of the CAMERA FRAME that produced it, which is already
   * ~28 ms old by the time the engine sees it. Judging it against "now" would
   * charge the player for the pipeline's latency; judging it against the
   * playback time at the moment their hand actually moved does not.
   */
  playbackTimeAtMs(wallClockMs: number): number {
    if (!this.running) return this.sampledTimeMs + this.offsetMs;
    return this.sampledTimeMs + (wallClockMs - this.sampledAtMs) + this.offsetMs;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Diagnostics for the HUD: how far interpolation had wandered, and how often. */
  stats(): { driftMs: number; resyncCount: number; biasMs: number } {
    return {
      driftMs: this.lastDriftMs,
      resyncCount: this.resyncCount,
      biasMs: this.driftHistory.length >= DRIFT_WINDOW ? Math.min(...this.driftHistory) : 0,
    };
  }

  reset(): void {
    this.resyncCount = 0;
    this.lastDriftMs = 0;
    this.sync();
  }
}
