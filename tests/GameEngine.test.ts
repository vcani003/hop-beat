import { beforeEach, describe, expect, it } from 'vitest';
import { GameEngine } from '../src/game/engine/GameEngine.ts';
import { GameClock } from '../src/game/engine/GameClock.ts';
import type { Beatmap, Note } from '../src/game/maps/schema.ts';
import type { ZoneEvent } from '../src/game/ZoneTracker.ts';
import type { ZoneId } from '../src/game/zones.ts';
import type { PlaybackAdapter, PlaybackState } from '../src/playback/PlaybackAdapter.ts';

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

const note = (id: string, timeMs: number, zone: ZoneId = 'upperLeft', limb: Note['limb'] = 'eitherHand'): Note =>
  ({ id, timeMs, type: 'hit', zone, limb });

const mapWith = (notes: Note[]): Beatmap => ({
  schemaVersion: 1,
  song: { id: 's', title: 'T', artist: 'A', playback: { provider: 'clickTrack', bpm: 120 } },
  analysis: { bpm: 120, confidence: 1, offsetMs: 0, generatorVersion: 'test' },
  difficulty: 'normal',
  mapType: 'handmade',
  notes,
});

const enter = (zoneId: ZoneId, timestampMs: number, limb: 'leftWrist' | 'rightWrist' = 'leftWrist'): ZoneEvent =>
  ({ type: 'ZONE_ENTER', zoneId, limb, timestampMs, distance: 0.01 });

function setup(notes: Note[]) {
  const adapter = new FakeAdapter();
  let wall = 10_000;
  const clock = new GameClock(adapter, { now: () => wall });
  const engine = new GameEngine(clock, mapWith(notes));
  clock.tick();
  return {
    adapter,
    clock,
    engine,
    wallNow: () => wall,
    /** Move the song and wall time together, then tick the clock. */
    advance: (ms: number) => {
      wall += ms;
      adapter.timeMs += ms;
      clock.tick();
    },
  };
}

describe('GameEngine — judging input', () => {
  it('scores a note hit dead on time as PERFECT', () => {
    const { engine, advance, wallNow } = setup([note('n1', 1000)]);
    advance(1000);
    const judged = engine.handleZoneEvents([enter('upperLeft', wallNow())]);
    expect(judged).toHaveLength(1);
    expect(judged[0]).toMatchObject({ noteId: 'n1', judgment: 'PERFECT' });
    expect(engine.getScore().score).toBe(300);
    expect(engine.getScore().combo).toBe(1);
  });

  it('scores a late-but-reachable hit as GOOD', () => {
    const { engine, advance, wallNow } = setup([note('n1', 1000)]);
    advance(1120);
    const judged = engine.handleZoneEvents([enter('upperLeft', wallNow())]);
    expect(judged[0].judgment).toBe('GOOD');
    expect(judged[0].deltaMs).toBeCloseTo(120);
  });

  it('reports early hits as negative delta', () => {
    const { engine, advance, wallNow } = setup([note('n1', 1000)]);
    advance(950);
    const judged = engine.handleZoneEvents([enter('upperLeft', wallNow())]);
    expect(judged[0].deltaMs).toBeCloseTo(-50);
    expect(judged[0].judgment).toBe('PERFECT');
  });

  /**
   * The reason MVP 0 kept honest camera-frame timestamps. The player's hand
   * arrived on the beat; the event reached the engine 28 ms later. Judging
   * against arrival time would turn a PERFECT into a worse score for a
   * pipeline delay the player did not cause.
   */
  it('judges input at the time it HAPPENED, not the time it arrived', () => {
    const { engine, advance, wallNow } = setup([note('n1', 1000)]);
    advance(1000);
    const handArrived = wallNow();

    advance(75); // pose pipeline latency, then the engine finally sees it
    const judged = engine.handleZoneEvents([enter('upperLeft', handArrived)]);

    expect(judged[0].deltaMs).toBeCloseTo(0);
    expect(judged[0].judgment).toBe('PERFECT');
  });

  it('respects a handed note', () => {
    const { engine, advance, wallNow } = setup([note('n1', 1000, 'upperLeft', 'rightHand')]);
    advance(1000);
    expect(engine.handleZoneEvents([enter('upperLeft', wallNow(), 'leftWrist')])).toEqual([]);
    expect(engine.handleZoneEvents([enter('upperLeft', wallNow(), 'rightWrist')])).toHaveLength(1);
  });

  it('lets a note be claimed only once', () => {
    const { engine, advance, wallNow } = setup([note('n1', 1000)]);
    advance(1000);
    expect(engine.handleZoneEvents([enter('upperLeft', wallNow())])).toHaveLength(1);
    expect(engine.handleZoneEvents([enter('upperLeft', wallNow())])).toEqual([]);
    expect(engine.getScore().judgedCount).toBe(1);
  });
});

describe('GameEngine — what does not score', () => {
  it('ignores exits and diagnostic blocks', () => {
    const { engine, advance, wallNow } = setup([note('n1', 1000)]);
    advance(1000);
    const judged = engine.handleZoneEvents([
      { type: 'ZONE_EXIT', zoneId: 'upperLeft', limb: 'leftWrist', timestampMs: wallNow(), distance: 0.2, dwellMs: 100 },
      { type: 'ZONE_BLOCKED', zoneId: 'upperLeft', limb: 'leftWrist', timestampMs: wallNow(), distance: 0.01, reason: 'refractory' },
    ]);
    expect(judged).toEqual([]);
    expect(engine.getScore().judgedCount).toBe(0);
  });

  /**
   * Moving where no note is due costs nothing. Spec §19 rules out grading
   * choreography, and punishing exploration would make the game hostile.
   */
  it('does not punish movement with nothing to hit', () => {
    const { engine, advance, wallNow } = setup([note('n1', 5000)]);
    advance(1000);
    expect(engine.handleZoneEvents([enter('lowerRight', wallNow())])).toEqual([]);
    expect(engine.getScore().combo).toBe(0);
    expect(engine.getScore().counts.MISS).toBe(0);
  });

  it('ignores a hit in the wrong zone', () => {
    const { engine, advance, wallNow } = setup([note('n1', 1000, 'upperLeft')]);
    advance(1000);
    expect(engine.handleZoneEvents([enter('upperRight', wallNow())])).toEqual([]);
  });
});

describe('GameEngine — misses', () => {
  it('misses a note once its window has fully closed', () => {
    const { engine, advance } = setup([note('n1', 1000)]);
    advance(1000 + 160);
    expect(engine.update()).toEqual([]); // still exactly reachable

    advance(2);
    const judged = engine.update();
    expect(judged).toHaveLength(1);
    expect(judged[0]).toMatchObject({ noteId: 'n1', judgment: 'MISS', deltaMs: null });
    expect(engine.getScore().combo).toBe(0);
  });

  it('breaks a combo', () => {
    const { engine, advance, wallNow } = setup([note('n1', 1000), note('n2', 3000)]);
    advance(1000);
    engine.handleZoneEvents([enter('upperLeft', wallNow())]);
    expect(engine.getScore().combo).toBe(1);

    advance(2500); // sail past n2
    engine.update();
    expect(engine.getScore().combo).toBe(0);
    expect(engine.getScore().maxCombo).toBe(1);
  });
});

describe('GameEngine — stopped playback', () => {
  /** Spec §14: do not let notes silently advance against a stopped player. */
  let harness: ReturnType<typeof setup>;
  beforeEach(() => {
    harness = setup([note('n1', 1000)]);
  });

  it('emits no misses while paused, however long the pause', () => {
    const { engine, adapter, clock, advance } = harness;
    advance(500);
    adapter.state = 'paused';
    clock.tick();

    for (let i = 0; i < 50; i++) {
      expect(engine.update()).toEqual([]);
    }
    expect(engine.getScore().judgedCount).toBe(0);
  });

  it('accepts no input while paused', () => {
    const { engine, adapter, clock, advance, wallNow } = harness;
    advance(1000);
    adapter.state = 'paused';
    clock.tick();
    expect(engine.handleZoneEvents([enter('upperLeft', wallNow())])).toEqual([]);
  });

  it('resumes judging when playback resumes', () => {
    const { engine, adapter, clock, advance, wallNow } = harness;
    advance(900);
    adapter.state = 'paused';
    clock.tick();
    adapter.state = 'playing';
    clock.tick();
    advance(100);
    expect(engine.handleZoneEvents([enter('upperLeft', wallNow())])[0].judgment).toBe('PERFECT');
  });
});

describe('GameEngine — lifecycle', () => {
  it('is complete only when every note has settled', () => {
    const { engine, advance, wallNow } = setup([note('n1', 1000), note('n2', 2000)]);
    advance(1000);
    engine.handleZoneEvents([enter('upperLeft', wallNow())]);
    expect(engine.isComplete()).toBe(false);

    advance(1200);
    engine.update();
    expect(engine.isComplete()).toBe(true);
  });

  it('drops settled notes from the pending list', () => {
    const { engine, advance, wallNow } = setup([note('n1', 1000), note('n2', 5000)]);
    expect(engine.pendingNotes()).toHaveLength(2);
    advance(1000);
    engine.handleZoneEvents([enter('upperLeft', wallNow())]);
    expect(engine.pendingNotes().map((n) => n.note.id)).toEqual(['n2']);
  });

  it('restores a fresh chart on reset', () => {
    const { engine, advance, wallNow } = setup([note('n1', 1000)]);
    advance(1000);
    engine.handleZoneEvents([enter('upperLeft', wallNow())]);
    expect(engine.getScore().score).toBeGreaterThan(0);

    engine.reset();
    expect(engine.getScore().score).toBe(0);
    expect(engine.isComplete()).toBe(false);
    expect(engine.pendingNotes()).toHaveLength(1);
  });
});
