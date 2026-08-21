import { describe, expect, it } from 'vitest';
import { buildPatternChart } from '../src/game/maps/patterns.ts';
import { windowsFor } from '../src/game/engine/NoteJudge.ts';
import { chartForTrack, LOCAL_TRACKS, WARMUP_MAP } from '../src/game/maps/library.ts';
import { validateBeatmap } from '../src/game/maps/validator.ts';

const opts = (over: Partial<Parameters<typeof buildPatternChart>[0]> = {}) => ({
  id: 't', title: 'T', artist: 'A', src: 'audio/t.mp3',
  bpm: 120, firstBeatMs: 0, durationMs: 60_000, ...over,
});

describe('buildPatternChart', () => {
  it('produces a valid beatmap', () => {
    expect(validateBeatmap(buildPatternChart(opts())).errors).toEqual([]);
  });

  it('emits notes in chronological order', () => {
    const notes = buildPatternChart(opts()).notes;
    for (let i = 1; i < notes.length; i++) {
      expect(notes[i].timeMs).toBeGreaterThanOrEqual(notes[i - 1].timeMs);
    }
  });

  /** A chart that outlives its audio would end in a wall of unhittable notes. */
  it('never writes a note past the end of the track', () => {
    for (const bpm of [90, 112.35, 123.05, 166.71]) {
      const chart = buildPatternChart(opts({ bpm, durationMs: 58_500 }));
      expect(chart.notes.at(-1)!.timeMs, `bpm ${bpm}`).toBeLessThan(58_500);
    }
  });

  it('leaves a rest before the first note so the player can settle', () => {
    const chart = buildPatternChart(opts({ bpm: 120, firstBeatMs: 500, restBars: 2 }));
    // Two bars of 4 beats at 500 ms, after the first beat at 500 ms.
    expect(chart.notes[0].timeMs).toBe(500 + 8 * 500);
  });

  it('shifts every note when the first beat moves', () => {
    const a = buildPatternChart(opts({ firstBeatMs: 0 }));
    const b = buildPatternChart(opts({ firstBeatMs: 250 }));
    expect(b.notes[0].timeMs - a.notes[0].timeMs).toBe(250);
  });

  /**
   * The correction that matters most: tempo estimators land an octave out
   * routinely, and halving the BPM must re-pin the whole chart rather than
   * requiring it to be re-authored.
   */
  it('re-pins the chart when the tempo is halved', () => {
    const fast = buildPatternChart(opts({ bpm: 160, durationMs: 120_000 }));
    const slow = buildPatternChart(opts({ bpm: 80, durationMs: 120_000 }));
    // Half the tempo: each phrase covers twice the time, so fewer fit.
    expect(slow.notes.length).toBeLessThan(fast.notes.length);
    expect(slow.notes[1].timeMs - slow.notes[0].timeMs).toBeCloseTo(
      (fast.notes[1].timeMs - fast.notes[0].timeMs) * 2,
      0,
    );
  });

  it('uses all four zones and includes handed notes', () => {
    const chart = buildPatternChart(opts({ durationMs: 120_000 }));
    expect(new Set(chart.notes.map((n) => n.zone)).size).toBe(4);
    expect(chart.notes.some((n) => n.limb !== 'eitherHand')).toBe(true);
  });

  it('is marked handmade — the pattern is authored, only its timing computed', () => {
    expect(buildPatternChart(opts()).mapType).toBe('handmade');
  });
});

describe('the track library', () => {
  it('builds a valid chart for every local track', () => {
    for (const track of LOCAL_TRACKS) {
      const chart = chartForTrack(track);
      expect(validateBeatmap(chart).errors, track.title).toEqual([]);
      expect(chart.notes.length, track.title).toBeGreaterThan(20);
      expect(chart.notes.at(-1)!.timeMs, track.title).toBeLessThan(track.durationMs);
    }
  });

  it('points every local track at a gitignored audio path, never a bundled file', () => {
    for (const track of LOCAL_TRACKS) {
      expect(chartForTrack(track).song.playback.src).toBe(`audio/${track.file}`);
    }
  });

  it('credits an artist for every track', () => {
    for (const track of LOCAL_TRACKS) {
      expect(track.artist.length, track.title).toBeGreaterThan(0);
    }
  });

  it('honours a tempo override', () => {
    const track = LOCAL_TRACKS[0];
    expect(chartForTrack(track, { bpm: track.bpm / 2 }).analysis.bpm).toBeCloseTo(track.bpm / 2);
  });

  it('keeps the warm-up chart on the click track, needing no audio file', () => {
    expect(WARMUP_MAP.song.playback.provider).toBe('clickTrack');
    expect(WARMUP_MAP.song.playback.src).toBeUndefined();
  });
});

describe('difficulty', () => {
  const at = (bpm = 120, durationMs = 120_000, difficulty?: 'easy' | 'normal') =>
    buildPatternChart(opts({ bpm, durationMs, difficulty }));

  /**
   * Written after play: "I still think the game is very hard... hard to keep
   * track." A chart that is hard to READ is not difficult, it is unfair.
   */
  it('gives easy roughly half the notes of normal', () => {
    const easy = at(120, 120_000, 'easy').notes.length;
    const normal = at(120, 120_000, 'normal').notes.length;
    expect(easy).toBeLessThan(normal);
    expect(easy / normal).toBeLessThan(0.65);
  });

  it('never puts two easy notes closer than a beat apart', () => {
    const notes = at(120, 120_000, 'easy').notes;
    const beatMs = 60_000 / 120;
    for (let i = 1; i < notes.length; i++) {
      expect(notes[i].timeMs - notes[i - 1].timeMs, `notes ${i - 1}->${i}`)
        .toBeGreaterThanOrEqual(beatMs - 1);
    }
  });

  it('never asks a specific hand on easy', () => {
    expect(at(120, 120_000, 'easy').notes.every((n) => n.limb === 'eitherHand')).toBe(true);
  });

  it('never overlaps two easy notes in time', () => {
    const times = at(120, 120_000, 'easy').notes.map((n) => n.timeMs);
    expect(new Set(times).size).toBe(times.length);
  });

  it('still uses all four targets on easy, so the layout is learned', () => {
    expect(new Set(at(120, 120_000, 'easy').notes.map((n) => n.zone)).size).toBe(4);
  });

  it('records the difficulty it was built at', () => {
    expect(at(120, 60_000, 'easy').difficulty).toBe('easy');
    expect(at(120, 60_000, 'normal').difficulty).toBe('normal');
  });
});

describe('timing windows by difficulty', () => {
  it('is more forgiving on easy than on normal', () => {
    expect(windowsFor('easy').perfectMs).toBeGreaterThan(windowsFor('normal').perfectMs);
    expect(windowsFor('easy').goodMs).toBeGreaterThan(windowsFor('normal').goodMs);
  });

  it('falls back to the normal windows for anything unrecognised', () => {
    expect(windowsFor(undefined)).toEqual(windowsFor('normal'));
    expect(windowsFor('nightmare')).toEqual(windowsFor('normal'));
  });

  /**
   * Roughly 28 ms of the window is spent in the camera pipeline before the
   * player's movement is even seen, so a window must leave room for it.
   */
  it('leaves room for the measured input latency', () => {
    for (const d of ['easy', 'normal']) {
      expect(windowsFor(d).perfectMs, d).toBeGreaterThan(28 * 2);
    }
  });
});
