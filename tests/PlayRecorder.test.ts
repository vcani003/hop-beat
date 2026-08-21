import { describe, expect, it } from 'vitest';
import { PlayRecorder } from '../src/debug/PlayRecorder.ts';
import type { Beatmap } from '../src/game/maps/schema.ts';
import type { ZoneEvent } from '../src/game/ZoneTracker.ts';
import type { JudgmentEvent } from '../src/game/engine/GameEngine.ts';
import { snapshot } from './helpers.ts';

const map = (): Beatmap => ({
  schemaVersion: 1,
  song: { id: 's', title: 'T', artist: 'A', playback: { provider: 'clickTrack', bpm: 120 } },
  analysis: { bpm: 120, confidence: 1, offsetMs: 0, generatorVersion: 'test' },
  difficulty: 'easy',
  mapType: 'handmade',
  notes: [
    { id: 'n1', timeMs: 1000, type: 'hit', zone: 'upperLeft', limb: 'eitherHand' },
    { id: 'n2', timeMs: 5000, type: 'hit', zone: 'upperRight', limb: 'eitherHand' },
  ],
});

const strike = (timestampMs: number, zoneId = 'upperLeft'): ZoneEvent => ({
  type: 'ZONE_ENTER',
  zoneId: zoneId as ZoneEvent['zoneId'],
  limb: 'leftWrist',
  timestampMs,
  distance: 0.01,
});

const judgment = (noteId: string, zone = 'upperLeft', deltaMs = 12): JudgmentEvent => ({
  noteId,
  zone: zone as JudgmentEvent['zone'],
  judgment: 'PERFECT',
  deltaMs,
  playbackTimeMs: 1000,
  limb: 'leftWrist',
});

const hands = (t: number, x: number) =>
  snapshot(t, { leftWrist: { x, y: 0.3, visibility: 1 }, rightWrist: { x: 0.8, y: 0.3, visibility: 1 } });

describe('PlayRecorder — strikes', () => {
  it('records a matched strike with what it scored', () => {
    const r = new PlayRecorder();
    r.recordStrikes([strike(1000)], [judgment('n1')], 1000);
    const doc = r.build(map(), {});
    expect(doc.strikes).toHaveLength(1);
    expect(doc.strikes[0]).toMatchObject({ noteId: 'n1', judgment: 'PERFECT', deltaMs: 12 });
  });

  /**
   * The single most useful line in the file: the hand arrived and nothing
   * happened. Without it, a miss cannot be told from a hand never seen.
   */
  it('records a strike that scored nothing', () => {
    const r = new PlayRecorder();
    r.recordStrikes([strike(2500)], [], 2500);
    const doc = r.build(map(), {});
    expect(doc.strikes[0].noteId).toBeNull();
    expect(doc.summary.unmatchedStrikes).toBe(1);
  });

  it('ignores exits and diagnostics', () => {
    const r = new PlayRecorder();
    r.recordStrikes(
      [
        { type: 'ZONE_EXIT', zoneId: 'upperLeft', limb: 'leftWrist', timestampMs: 1, distance: 0.3 },
        { type: 'ZONE_BLOCKED', zoneId: 'upperLeft', limb: 'leftWrist', timestampMs: 2, distance: 0.01, reason: 'refractory' },
      ],
      [],
      0,
    );
    expect(r.build(map(), {}).strikes).toEqual([]);
  });

  it('notes when a strike was found by sweeping', () => {
    const r = new PlayRecorder();
    r.recordStrikes([{ ...strike(1000), swept: true }], [], 1000);
    expect(r.build(map(), {}).summary.sweptStrikes).toBe(1);
  });
});

describe('PlayRecorder — every note gets an outcome', () => {
  it('reports notes nothing hit as misses', () => {
    const r = new PlayRecorder();
    r.recordStrikes([strike(1000)], [judgment('n1')], 1000);
    const outcomes = r.build(map(), {}).notes;
    expect(outcomes.find((n) => n.id === 'n1')?.outcome).toBe('PERFECT');
    expect(outcomes.find((n) => n.id === 'n2')?.outcome).toBe('MISS');
  });

  it('accounts for every note in the chart', () => {
    expect(new PlayRecorder().build(map(), {}).notes).toHaveLength(2);
  });
});

describe('PlayRecorder — hand track', () => {
  it('downsamples rather than keeping every frame', () => {
    const r = new PlayRecorder();
    for (let t = 0; t < 1000; t += 33) r.sampleTrack(hands(t, 0.5), t);
    const track = r.build(map(), {}).track;
    expect(track.length).toBeLessThan(15);
    expect(track.length).toBeGreaterThan(5);
  });

  it('keeps positions and confidence for both hands', () => {
    const r = new PlayRecorder();
    r.sampleTrack(hands(0, 0.25), 0);
    expect(r.build(map(), {}).track[0]).toMatchObject({ lx: 0.25, rx: 0.8, lv: 1, rv: 1 });
  });
});

describe('PlayRecorder — marks', () => {
  /**
   * A player cannot report a timestamp; they can press a key. This is what
   * turns "somewhere in the song" into a point to look at.
   */
  it('gathers everything near a marked moment', () => {
    const r = new PlayRecorder();
    for (let t = 0; t < 6000; t += 100) r.sampleTrack(hands(t, 0.5), t);
    r.recordStrikes([strike(900)], [], 900);
    r.recordStrikes([strike(4800, 'upperRight')], [], 4800);
    r.mark(1000, 'felt wrong');

    const doc = r.build(map(), {});
    expect(doc.marks).toHaveLength(1);
    const mark = doc.marks[0];
    // The note at 1000 ms is in the window; the one at 5000 ms is not.
    expect(mark.notesNearby.map((n) => n.id)).toEqual(['n1']);
    expect(mark.strikesNearby).toHaveLength(1);
    expect(mark.trackNearby.length).toBeGreaterThan(10);
  });

  it('counts marks as they are dropped', () => {
    const r = new PlayRecorder();
    expect(r.markCount()).toBe(0);
    r.mark(500);
    r.mark(900);
    expect(r.markCount()).toBe(2);
  });

  it('clears everything on reset, so runs never bleed together', () => {
    const r = new PlayRecorder();
    r.recordStrikes([strike(1000)], [], 1000);
    r.sampleTrack(hands(0, 0.5), 0);
    r.mark(100);
    r.reset();
    const doc = r.build(map(), {});
    expect(doc.strikes).toEqual([]);
    expect(doc.track).toEqual([]);
    expect(doc.marks).toEqual([]);
  });
});

describe('PlayRecorder — the exported document', () => {
  it('carries the settings and machine alongside the events', () => {
    const doc = new PlayRecorder().build(map(), { zoneScale: 0.65, poseHz: 30 });
    expect(doc.context).toMatchObject({ zoneScale: 0.65, poseHz: 30 });
    expect(doc.song.title).toBe('T');
    expect(doc.schemaVersion).toBe(1);
  });

  it('summarises without needing the whole file read', () => {
    const r = new PlayRecorder();
    r.recordStrikes([strike(1000), strike(2000)], [judgment('n1')], 1000);
    r.mark(1000);
    expect(r.build(map(), {}).summary).toMatchObject({
      notes: 2,
      strikes: 2,
      unmatchedStrikes: 1,
      marks: 1,
    });
  });
});
