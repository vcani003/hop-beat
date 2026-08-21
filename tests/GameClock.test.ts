import { describe, expect, it } from 'vitest';
import { GameClock } from '../src/game/engine/GameClock.ts';
import type { PlaybackAdapter, PlaybackState } from '../src/playback/PlaybackAdapter.ts';

/** A playback source whose reported time only moves when a test says so. */
class FakeAdapter implements PlaybackAdapter {
  timeMs = 0;
  state: PlaybackState = 'playing';
  play() {}
  pause() {}
  getCurrentTimeMs() { return this.timeMs; }
  getState() { return this.state; }
  getDurationMs() { return 60_000; }
  dispose() {}
}

function setup(
  options: {
    resyncThresholdMs?: number;
    offsetMs?: number;
    slewRate?: number;
    slewDeadbandMs?: number;
  } = {},
) {
  const adapter = new FakeAdapter();
  let wall = 1000;
  const clock = new GameClock(adapter, {
    // Slewing is off unless a test asks for it, so the interpolation and
    // resync tests measure exactly one behaviour each.
    slewRate: 0,
    ...options,
    now: () => wall,
  });
  return {
    adapter,
    clock,
    /** Wall time moves; the source does not. Models a stall or a coarse update. */
    advanceWall: (ms: number) => { wall += ms; },
    /** Wall time and the source move together, as a healthy source behaves. */
    advanceBoth: (ms: number) => { wall += ms; adapter.timeMs += ms; },
    wallNow: () => wall,
  };
}

describe('GameClock — interpolation', () => {
  /**
   * The staircase problem: an <audio> element updates currentTime only every
   * 20–50 ms. Polling it directly gives a time that sticks and then jumps,
   * which both stutters the visuals and shows up as judgment error.
   */
  it('advances smoothly between coarse source updates', () => {
    const { clock, advanceWall } = setup();
    clock.tick();
    expect(clock.getTimeMs()).toBe(0);

    // The source has not updated, but 16 ms of wall time have passed.
    advanceWall(16);
    clock.tick();
    expect(clock.getTimeMs()).toBe(16);

    advanceWall(16);
    clock.tick();
    expect(clock.getTimeMs()).toBe(32);
  });

  it('never runs backwards when the source catches up', () => {
    const { clock, adapter, advanceWall } = setup();
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) {
      advanceWall(16);
      // Source updates only every other tick, in 32 ms steps.
      if (i % 2 === 1) adapter.timeMs += 32;
      clock.tick();
      seen.push(clock.getTimeMs());
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i], `sample ${i}`).toBeGreaterThanOrEqual(seen[i - 1]);
    }
  });
});

describe('GameClock — resync', () => {
  it('snaps back when interpolation drifts past the threshold', () => {
    const { clock, adapter, advanceWall } = setup({ resyncThresholdMs: 40 });
    clock.tick();

    // Wall time runs on while the source stalls entirely — a hitch.
    advanceWall(100);
    clock.tick();

    expect(clock.getTimeMs()).toBe(adapter.timeMs);
    expect(clock.stats().resyncCount).toBe(1);
  });

  it('tolerates jitter smaller than the threshold without resyncing', () => {
    const { clock, adapter, advanceWall } = setup({ resyncThresholdMs: 40 });
    clock.tick();
    for (let i = 0; i < 5; i++) {
      advanceWall(20);
      adapter.timeMs += 20 + (i % 2 === 0 ? 8 : -8); // ±8 ms of wobble
      clock.tick();
    }
    expect(clock.stats().resyncCount).toBe(0);
  });

  it('lets the source win in the end', () => {
    const { clock, adapter, advanceWall } = setup({ resyncThresholdMs: 40 });
    clock.tick();
    advanceWall(1000);
    adapter.timeMs = 5000; // a seek
    clock.tick();
    expect(clock.getTimeMs()).toBe(5000);
  });
});

describe('GameClock — stopped playback', () => {
  /** Spec §14: notes must not silently advance against a stopped player. */
  it('does not advance while paused, however much wall time passes', () => {
    const { clock, adapter, advanceWall } = setup();
    adapter.timeMs = 2000;
    clock.tick();
    adapter.state = 'paused';
    clock.tick();

    advanceWall(5000);
    clock.tick();
    expect(clock.getTimeMs()).toBe(2000);
    expect(clock.isRunning()).toBe(false);
  });

  it('does not advance while buffering', () => {
    const { clock, adapter, advanceWall } = setup();
    adapter.state = 'buffering';
    clock.tick();
    advanceWall(3000);
    clock.tick();
    expect(clock.isRunning()).toBe(false);
    expect(clock.getTimeMs()).toBe(0);
  });

  it('resumes from where it stopped, not from where wall time got to', () => {
    const { clock, adapter, advanceWall, advanceBoth } = setup();
    adapter.timeMs = 2000;
    adapter.state = 'paused';
    clock.tick();

    // Five seconds of real time pass while the song sits still.
    advanceWall(5000);

    adapter.state = 'playing';
    clock.tick();
    expect(clock.getTimeMs()).toBe(2000);

    advanceBoth(50);
    clock.tick();
    expect(clock.getTimeMs()).toBe(2050);
  });

  it('treats a stalled source as drift and resyncs onto it', () => {
    // A source that reports the same position while wall time runs on is
    // stalling, not playing smoothly — following wall time would desynchronise
    // the chart from the audio the player can hear.
    const { clock, advanceWall } = setup({ resyncThresholdMs: 40 });
    clock.tick();
    advanceWall(50);
    clock.tick();
    expect(clock.getTimeMs()).toBe(0);
    expect(clock.stats().resyncCount).toBe(1);
  });
});

describe('GameClock — calibration offset', () => {
  it('shifts judged time without touching the raw position', () => {
    const { clock, adapter } = setup({ offsetMs: 30 });
    adapter.timeMs = 1000;
    clock.tick();
    expect(clock.getTimeMs()).toBe(1030);
    expect(clock.rawTimeMs()).toBe(1000);
  });

  it('can be changed mid-song', () => {
    const { clock, adapter } = setup();
    adapter.timeMs = 1000;
    clock.tick();
    expect(clock.getTimeMs()).toBe(1000);
    clock.setOffsetMs(-25);
    expect(clock.getTimeMs()).toBe(975);
  });
});

describe('GameClock — playbackTimeAtMs', () => {
  /**
   * The whole reason MVP 0 kept honest camera-frame timestamps: an input that
   * happened 28 ms ago must be judged against where the song was 28 ms ago,
   * not against where it is now.
   */
  it('maps a past wall-clock instant back to its playback time', () => {
    const { clock, adapter, advanceWall, wallNow } = setup();
    adapter.timeMs = 1000;
    clock.tick();

    const inputHappenedAt = wallNow();
    advanceWall(28); // the pose pipeline's latency
    clock.tick();

    expect(clock.getTimeMs()).toBe(1028);
    expect(clock.playbackTimeAtMs(inputHappenedAt)).toBe(1000);
  });

  it('includes the calibration offset', () => {
    const { clock, adapter, wallNow } = setup({ offsetMs: 10 });
    adapter.timeMs = 500;
    clock.tick();
    expect(clock.playbackTimeAtMs(wallNow())).toBe(510);
  });

  it('returns the frozen position while stopped', () => {
    const { clock, adapter, wallNow } = setup();
    adapter.timeMs = 700;
    adapter.state = 'paused';
    clock.tick();
    expect(clock.playbackTimeAtMs(wallNow() - 500)).toBe(700);
  });
});

describe('GameClock — bias correction (slew)', () => {
  /**
   * The bug this exists for: starting an AudioContext leaves the clock a few
   * tens of milliseconds ahead of the audio, and if that bias sits just under
   * the resync threshold it never corrects. A constant 36 ms error eats nearly
   * half of an ±80 ms PERFECT window while looking like a healthy clock.
   */
  it('bleeds off a persistent bias that never trips the resync threshold', () => {
    const { clock, adapter, advanceWall } = setup({ resyncThresholdMs: 40, slewRate: 0.05 });

    // Manufacture a 30 ms lead: wall time runs on while the source stalls,
    // which is what an audio context doing its start-up does.
    advanceWall(30);
    clock.tick();
    expect(clock.stats().driftMs).toBeCloseTo(30);
    expect(clock.stats().resyncCount).toBe(0); // under the threshold

    // From here the source runs perfectly, carrying the bias with it.
    for (let i = 0; i < 400; i++) {
      advanceWall(16);
      adapter.timeMs += 16;
      clock.tick();
    }

    expect(Math.abs(clock.stats().driftMs)).toBeLessThan(4);
    expect(clock.stats().resyncCount).toBe(0); // corrected smoothly, never jumped
  });

  /**
   * And the trap it must not fall into. A source reporting in 32 ms steps makes
   * drift sawtooth between 0 and +32; its MEAN is +16 even though the
   * interpolated clock is exactly right. Correcting toward that mean would
   * invent a 16 ms lag.
   */
  it('does not "correct" a source that is merely coarse', () => {
    const { clock, adapter, advanceWall } = setup({ resyncThresholdMs: 60, slewRate: 0.05 });
    clock.tick();

    let elapsed = 0;
    for (let i = 0; i < 400; i++) {
      advanceWall(16);
      elapsed += 16;
      // The source only reports on 32 ms boundaries — a staircase.
      adapter.timeMs = Math.floor(elapsed / 32) * 32;
      clock.tick();
    }

    // The clock should still be tracking true elapsed time, not the staircase
    // average. Being pulled to the mean would show up as a ~16 ms deficit.
    expect(clock.rawTimeMs()).toBeGreaterThan(elapsed - 6);
    expect(clock.rawTimeMs()).toBeLessThanOrEqual(elapsed + 34);
  });

  it('leaves a small bias alone rather than chasing noise', () => {
    const { clock, adapter, advanceWall } = setup({ slewRate: 0.05, slewDeadbandMs: 3 });
    advanceWall(2);
    clock.tick();
    const before = clock.rawTimeMs();
    for (let i = 0; i < 200; i++) {
      advanceWall(16);
      adapter.timeMs += 16;
      clock.tick();
    }
    // The 2 ms head start survives: it is inside the deadband.
    expect(clock.rawTimeMs() - before).toBeCloseTo(200 * 16, 0);
  });

  it('can be disabled entirely', () => {
    const { clock, adapter, advanceWall } = setup({ resyncThresholdMs: 60, slewRate: 0 });
    advanceWall(30);
    clock.tick();
    for (let i = 0; i < 300; i++) {
      advanceWall(16);
      adapter.timeMs += 16;
      clock.tick();
    }
    expect(clock.stats().driftMs).toBeCloseTo(30);
  });

  it('discards drift history on an explicit sync', () => {
    const { clock, adapter, advanceWall } = setup({ slewRate: 0.05 });
    for (let i = 0; i < 100; i++) {
      advanceWall(16);
      adapter.timeMs += 16;
      clock.tick();
    }
    clock.sync();
    expect(clock.stats().biasMs).toBe(0);
  });
});
