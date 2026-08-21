/**
 * A metronome we synthesise ourselves, used as MVP 1's development track.
 *
 * Spec §11 is firm that not charging for something does not make a recording
 * free to use, and §15 asks MVP 1 for "one legally usable/local development
 * track". A click track we generate is unambiguously ours, needs no licence
 * review, and — usefully — has a tempo we know exactly, so a chart written
 * against it can be verified by ear without any analysis step.
 *
 * It is also the most accurate clock available here. `AudioContext.currentTime`
 * is driven by the audio hardware rather than the main thread, so it keeps
 * running at the correct rate even when JavaScript is busy. An <audio>
 * element's `currentTime` is a much coarser report of the same idea.
 *
 * Clicks are scheduled up front rather than polled into existence. WebAudio
 * schedules against its own clock with sample accuracy; a setInterval that
 * fires "roughly now" would reintroduce exactly the jitter we are trying to
 * avoid.
 */
import type { PlaybackAdapter, PlaybackState } from './PlaybackAdapter.ts';

export interface ClickTrackOptions {
  bpm: number;
  beatsPerBar?: number;
  bars?: number;
  /** Silent-ish count-in before time zero, so the player can find the tempo. */
  leadInBars?: number;
  volume?: number;
}

const DOWNBEAT_HZ = 1600;
const BEAT_HZ = 1000;

export class ClickTrackAdapter implements PlaybackAdapter {
  private ctx: AudioContext;
  private gain: GainNode;
  private options: Required<ClickTrackOptions>;
  private state: PlaybackState = 'idle';
  /** AudioContext time corresponding to track time zero. */
  private startedAtCtxTime = 0;
  private scheduled = false;

  constructor(options: ClickTrackOptions) {
    this.options = {
      beatsPerBar: 4,
      bars: 16,
      leadInBars: 1,
      volume: 0.25,
      ...options,
    };
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.options.volume;
    this.gain.connect(this.ctx.destination);
  }

  get beatMs(): number {
    return 60_000 / this.options.bpm;
  }

  /** Milliseconds of count-in before track time zero. */
  get leadInMs(): number {
    return this.options.leadInBars * this.options.beatsPerBar * this.beatMs;
  }

  async play(): Promise<void> {
    // Browsers start an AudioContext suspended until a user gesture. Resuming
    // also covers coming back from pause, so callers need only one method and
    // can hold this behind the PlaybackAdapter interface.
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    if (!this.scheduled) {
      this.startedAtCtxTime = this.ctx.currentTime + this.leadInMs / 1000;
      this.scheduleClicks();
      this.scheduled = true;
    }
    this.state = 'playing';
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    // Suspending stops currentTime advancing, which freezes the clock as well
    // as the sound — the two cannot drift apart while paused.
    void this.ctx.suspend();
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused') return;
    await this.ctx.resume();
    this.state = 'playing';
  }

  getCurrentTimeMs(): number {
    if (this.state === 'idle') return -this.leadInMs;
    const timeMs = (this.ctx.currentTime - this.startedAtCtxTime) * 1000;
    const duration = this.getDurationMs();
    if (this.state === 'playing' && timeMs > duration + 1000) this.state = 'ended';
    return timeMs;
  }

  getState(): PlaybackState {
    return this.state;
  }

  getDurationMs(): number {
    return this.options.bars * this.options.beatsPerBar * this.beatMs;
  }

  /**
   * One click, built from an oscillator and a short exponential decay.
   *
   * A raw gate would click audibly at the edges; ramping the gain down over
   * ~50 ms gives the percussive shape a metronome needs without any sample.
   */
  private scheduleClick(atSeconds: number, isDownbeat: boolean): void {
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.frequency.value = isDownbeat ? DOWNBEAT_HZ : BEAT_HZ;
    osc.type = 'sine';

    env.gain.setValueAtTime(0.0001, atSeconds);
    env.gain.exponentialRampToValueAtTime(1, atSeconds + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, atSeconds + 0.05);

    osc.connect(env);
    env.connect(this.gain);
    osc.start(atSeconds);
    osc.stop(atSeconds + 0.06);
  }

  private scheduleClicks(): void {
    const { beatsPerBar, bars, leadInBars } = this.options;
    const beatSeconds = this.beatMs / 1000;
    const leadInBeats = leadInBars * beatsPerBar;

    // Count-in beats sit before track time zero, at negative track time.
    for (let i = 0; i < leadInBeats; i++) {
      const at = this.startedAtCtxTime - (leadInBeats - i) * beatSeconds;
      this.scheduleClick(at, i % beatsPerBar === 0);
    }

    for (let beat = 0; beat < bars * beatsPerBar; beat++) {
      this.scheduleClick(this.startedAtCtxTime + beat * beatSeconds, beat % beatsPerBar === 0);
    }
  }

  setVolume(volume: number): void {
    this.options.volume = volume;
    this.gain.gain.value = volume;
  }

  dispose(): void {
    this.state = 'idle';
    void this.ctx.close();
  }
}
