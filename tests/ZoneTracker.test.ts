import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TRACKER_CONFIG,
  ZoneTracker,
  type ZoneTrackerConfig,
} from '../src/game/ZoneTracker.ts';
import type { Zone } from '../src/game/zones.ts';
import { snapshot } from './helpers.ts';

/** A square field keeps distances euclidean so the numbers stay readable. */
const ASPECT = 1;
const ZONE: Zone = {
  id: 'upperLeft',
  label: 'UPPER LEFT',
  cx: 0.2,
  cy: 0.25,
  radius: 0.1,
  colour: '#8b5cf6',
};
const ZONES = [ZONE];

const config = (over: Partial<ZoneTrackerConfig> = {}): ZoneTrackerConfig => ({
  ...DEFAULT_TRACKER_CONFIG,
  ...over,
});

/** Positions relative to the zone centre, in field-X units. */
const at = (offset: number, visibility = 1) => ({
  x: ZONE.cx + offset,
  y: ZONE.cy,
  visibility,
});

describe('ZoneTracker — entering', () => {
  let tracker: ZoneTracker;
  beforeEach(() => {
    tracker = new ZoneTracker(config());
  });

  it('emits ZONE_ENTER when a wrist crosses the radius', () => {
    expect(tracker.update(snapshot(0, { leftWrist: at(0.4) }), ZONES, ASPECT)).toEqual([]);

    const events = tracker.update(snapshot(33, { leftWrist: at(0.05) }), ZONES, ASPECT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'ZONE_ENTER',
      zoneId: 'upperLeft',
      limb: 'leftWrist',
      timestampMs: 33,
    });
  });

  it('stamps the event with the CAMERA FRAME time, not the time of processing', () => {
    const [event] = tracker.update(snapshot(9999, { leftWrist: at(0) }), ZONES, ASPECT);
    expect(event.timestampMs).toBe(9999);
  });

  it('does not re-emit while the wrist stays inside', () => {
    tracker.update(snapshot(0, { leftWrist: at(0.05) }), ZONES, ASPECT);
    for (let t = 33; t < 500; t += 33) {
      expect(tracker.update(snapshot(t, { leftWrist: at(0.05) }), ZONES, ASPECT)).toEqual([]);
    }
  });

  it('refuses a landmark the model is not confident about, and says so', () => {
    const events = tracker.update(
      snapshot(0, { leftWrist: at(0, 0.2) }),
      ZONES,
      ASPECT,
    );
    expect(events.map((e) => e.type)).toEqual(['ZONE_BLOCKED']);
    expect(events[0].reason).toBe('visibility');
  });

  it('refuses a landmark extrapolated outside the camera frame', () => {
    const t = new ZoneTracker(config({ requireInFrame: true }));
    const offscreen = { x: -0.02, y: 0.25, visibility: 1 };
    const edgeZone: Zone = { ...ZONE, cx: 0.02, radius: 0.1 };
    const events = t.update(snapshot(0, { leftWrist: offscreen }), [edgeZone], ASPECT);
    expect(events.map((e) => e.type)).toEqual(['ZONE_BLOCKED']);
    expect(events[0].reason).toBe('visibility');
  });

  it('tracks both wrists in the same zone independently', () => {
    const events = tracker.update(
      snapshot(0, { leftWrist: at(0.02), rightWrist: at(-0.02) }),
      ZONES,
      ASPECT,
    );
    expect(events.map((e) => e.limb)).toEqual(['leftWrist', 'rightWrist']);
  });
});

describe('ZoneTracker — hysteresis suppresses jitter', () => {
  /**
   * The failure this prevents: a hand resting on the zone edge, wobbling by a
   * pixel or two per frame, machine-gunning enter/exit events. With a 1.3x exit
   * radius the wrist must genuinely leave before the tracker believes it.
   */
  it('holds the zone while the wrist rattles across the enter radius', () => {
    const tracker = new ZoneTracker(config({ exitRadiusScale: 1.3 }));
    tracker.update(snapshot(0, { leftWrist: at(0.09) }), ZONES, ASPECT);

    let t = 33;
    for (const offset of [0.101, 0.098, 0.105, 0.099, 0.11, 0.102, 0.097]) {
      const events = tracker.update(snapshot(t, { leftWrist: at(offset) }), ZONES, ASPECT);
      expect(events, `offset ${offset} at t=${t}`).toEqual([]);
      t += 33;
    }
  });

  it('still exits once the wrist passes the larger exit radius', () => {
    const tracker = new ZoneTracker(config({ exitRadiusScale: 1.3, exitGraceMs: 0 }));
    tracker.update(snapshot(0, { leftWrist: at(0) }), ZONES, ASPECT);
    const events = tracker.update(snapshot(33, { leftWrist: at(0.14) }), ZONES, ASPECT);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('ZONE_EXIT');
  });
});

describe('ZoneTracker — exit grace absorbs tracking dropout', () => {
  it('does not exit when the model loses the wrist for a single frame', () => {
    const tracker = new ZoneTracker(config({ exitGraceMs: 80 }));
    tracker.update(snapshot(0, { leftWrist: at(0) }), ZONES, ASPECT);

    // Frame 2: visibility collapses. Frame 3: it recovers, 33 ms later.
    expect(tracker.update(snapshot(33, { leftWrist: at(0, 0.05) }), ZONES, ASPECT)).toEqual([]);
    expect(tracker.update(snapshot(66, { leftWrist: at(0) }), ZONES, ASPECT)).toEqual([]);
    expect(tracker.activePairs().has('upperLeft:leftWrist')).toBe(true);
  });

  it('exits when the dropout outlasts the grace period', () => {
    const tracker = new ZoneTracker(config({ exitGraceMs: 80 }));
    tracker.update(snapshot(0, { leftWrist: at(0) }), ZONES, ASPECT);
    expect(tracker.update(snapshot(33, { leftWrist: at(0, 0.05) }), ZONES, ASPECT)).toEqual([]);
    expect(tracker.update(snapshot(66, { leftWrist: at(0, 0.05) }), ZONES, ASPECT)).toEqual([]);

    const events = tracker.update(snapshot(120, { leftWrist: at(0, 0.05) }), ZONES, ASPECT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'ZONE_EXIT', dwellMs: 120 });
  });

  it('restarts the grace clock if the wrist comes back and leaves again', () => {
    const tracker = new ZoneTracker(config({ exitGraceMs: 80, exitRadiusScale: 1.3 }));
    tracker.update(snapshot(0, { leftWrist: at(0) }), ZONES, ASPECT);
    tracker.update(snapshot(50, { leftWrist: at(0.2) }), ZONES, ASPECT); // out
    tracker.update(snapshot(90, { leftWrist: at(0) }), ZONES, ASPECT); // back in, grace cleared
    tracker.update(snapshot(130, { leftWrist: at(0.2) }), ZONES, ASPECT); // out again

    // 80 ms after the FIRST exit but only 40 ms after the second: still inside.
    expect(tracker.activePairs().has('upperLeft:leftWrist')).toBe(true);
    const events = tracker.update(snapshot(215, { leftWrist: at(0.2) }), ZONES, ASPECT);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('ZONE_EXIT');
  });

  it('reports how long the wrist was held', () => {
    const tracker = new ZoneTracker(config({ exitGraceMs: 0 }));
    tracker.update(snapshot(1000, { leftWrist: at(0) }), ZONES, ASPECT);
    const [event] = tracker.update(snapshot(1450, { leftWrist: at(0.5) }), ZONES, ASPECT);
    expect(event.dwellMs).toBe(450);
  });
});

describe('ZoneTracker — refractory period', () => {
  it('is off by default, so fast repeat hits are possible', () => {
    const tracker = new ZoneTracker(config({ exitGraceMs: 0 }));
    tracker.update(snapshot(0, { leftWrist: at(0) }), ZONES, ASPECT);
    tracker.update(snapshot(33, { leftWrist: at(0.5) }), ZONES, ASPECT);
    const events = tracker.update(snapshot(66, { leftWrist: at(0) }), ZONES, ASPECT);
    expect(events.map((e) => e.type)).toEqual(['ZONE_ENTER']);
  });

  it('blocks re-entry inside the window when configured', () => {
    const tracker = new ZoneTracker(config({ exitGraceMs: 0, refractoryMs: 200 }));
    tracker.update(snapshot(0, { leftWrist: at(0) }), ZONES, ASPECT);
    tracker.update(snapshot(33, { leftWrist: at(0.5) }), ZONES, ASPECT);

    const refused = tracker.update(snapshot(100, { leftWrist: at(0) }), ZONES, ASPECT);
    expect(refused.map((e) => e.type)).toEqual(['ZONE_BLOCKED']);

    // Withdraw, then approach again after the window has elapsed.
    tracker.update(snapshot(150, { leftWrist: at(0.5) }), ZONES, ASPECT);
    const events = tracker.update(snapshot(240, { leftWrist: at(0) }), ZONES, ASPECT);
    expect(events.map((e) => e.type)).toEqual(['ZONE_ENTER']);
  });
});

describe('ZoneTracker — lifecycle', () => {
  it('forgets held zones on reset, without emitting phantom exits', () => {
    const tracker = new ZoneTracker(config());
    tracker.update(snapshot(0, { leftWrist: at(0) }), ZONES, ASPECT);
    expect(tracker.activePairs().size).toBe(1);
    tracker.reset();
    expect(tracker.activePairs().size).toBe(0);
    const events = tracker.update(snapshot(1000, { leftWrist: at(0) }), ZONES, ASPECT);
    expect(events.map((e) => e.type)).toEqual(['ZONE_ENTER']);
  });

  it('emits nothing at all when no person is in view', () => {
    const tracker = new ZoneTracker(config());
    for (let t = 0; t < 1000; t += 33) {
      expect(tracker.update(snapshot(t, {}), ZONES, ASPECT)).toEqual([]);
    }
  });
});

describe('ZoneTracker — blocked hits are observable, not merely suspected', () => {
  /**
   * The failure these tests pin down: with a long refractory window, a genuine
   * rapid double-hit is silently swallowed. Silence is the problem — the
   * tracker must say so, or tuning is guesswork.
   */
  it('reports a rapid re-entry that the refractory window swallowed', () => {
    const tracker = new ZoneTracker(config({ exitGraceMs: 0, refractoryMs: 360 }));
    tracker.update(snapshot(0, { leftWrist: at(0) }), ZONES, ASPECT); // hit 1
    tracker.update(snapshot(60, { leftWrist: at(0.5) }), ZONES, ASPECT); // away

    // A second deliberate hit 250 ms after the first — an eighth note at 120 BPM.
    const events = tracker.update(snapshot(250, { leftWrist: at(0) }), ZONES, ASPECT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'ZONE_BLOCKED',
      reason: 'refractory',
      zoneId: 'upperLeft',
      limb: 'leftWrist',
    });
    expect(events[0].remainingMs).toBe(170);
    expect(tracker.blockedCounts().refractory).toBe(1);
  });

  it('counts one blocked event per approach, not one per frame', () => {
    const tracker = new ZoneTracker(config({ exitGraceMs: 0, refractoryMs: 400 }));
    tracker.update(snapshot(0, { leftWrist: at(0) }), ZONES, ASPECT);
    tracker.update(snapshot(30, { leftWrist: at(0.5) }), ZONES, ASPECT);

    // Wrist parked inside the locked-out zone for ten consecutive frames.
    let blocked = 0;
    for (let t = 60; t < 360; t += 30) {
      blocked += tracker.update(snapshot(t, { leftWrist: at(0) }), ZONES, ASPECT).length;
    }
    expect(blocked).toBe(1);
    expect(tracker.blockedCounts().refractory).toBe(1);
  });

  it('re-arms so a later approach is reported separately', () => {
    const tracker = new ZoneTracker(config({ exitGraceMs: 0, refractoryMs: 400 }));
    tracker.update(snapshot(0, { leftWrist: at(0) }), ZONES, ASPECT);
    tracker.update(snapshot(30, { leftWrist: at(0.5) }), ZONES, ASPECT);
    tracker.update(snapshot(100, { leftWrist: at(0) }), ZONES, ASPECT); // blocked
    tracker.update(snapshot(160, { leftWrist: at(0.5) }), ZONES, ASPECT); // withdraw
    tracker.update(snapshot(220, { leftWrist: at(0) }), ZONES, ASPECT); // blocked again
    expect(tracker.blockedCounts().refractory).toBe(2);
  });

  it('distinguishes a low-confidence refusal from a lockout', () => {
    const tracker = new ZoneTracker(config({ refractoryMs: 0, minVisibility: 0.5 }));
    const events = tracker.update(snapshot(0, { leftWrist: at(0, 0.2) }), ZONES, ASPECT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'ZONE_BLOCKED', reason: 'visibility' });
    expect(events[0].remainingMs).toBeUndefined();
    expect(tracker.blockedCounts()).toEqual({ refractory: 0, visibility: 1 });
  });

  it('stays silent when the refractory window has genuinely elapsed', () => {
    const tracker = new ZoneTracker(config({ exitGraceMs: 0, refractoryMs: 360 }));
    tracker.update(snapshot(0, { leftWrist: at(0) }), ZONES, ASPECT);
    tracker.update(snapshot(60, { leftWrist: at(0.5) }), ZONES, ASPECT);
    const events = tracker.update(snapshot(500, { leftWrist: at(0) }), ZONES, ASPECT);
    expect(events.map((e) => e.type)).toEqual(['ZONE_ENTER']);
    expect(tracker.blockedCounts().refractory).toBe(0);
  });

  it('reports nothing for a wrist that never approaches a zone', () => {
    const tracker = new ZoneTracker(config({ refractoryMs: 400 }));
    for (let t = 0; t < 600; t += 30) {
      expect(tracker.update(snapshot(t, { leftWrist: at(0.6) }), ZONES, ASPECT)).toEqual([]);
    }
    expect(tracker.blockedCounts()).toEqual({ refractory: 0, visibility: 0 });
  });

  it('clears its counters on reset', () => {
    const tracker = new ZoneTracker(config({ exitGraceMs: 0, refractoryMs: 400 }));
    tracker.update(snapshot(0, { leftWrist: at(0) }), ZONES, ASPECT);
    tracker.update(snapshot(30, { leftWrist: at(0.5) }), ZONES, ASPECT);
    tracker.update(snapshot(60, { leftWrist: at(0) }), ZONES, ASPECT);
    expect(tracker.blockedCounts().refractory).toBe(1);
    tracker.reset();
    expect(tracker.blockedCounts()).toEqual({ refractory: 0, visibility: 0 });
  });
});

describe('ZoneTracker — swept collision catches a hand that moves between frames', () => {
  // Far enough outside the 0.1 radius to be a genuine miss on both samples,
  // but still inside the camera frame — ZONE.cx is 0.2, so a larger offset
  // would put x below zero and be rejected as extrapolated before sweeping
  // ever ran.
  const FAR = 0.19;

  /**
   * The reported symptom: "sometimes I hit the beat but it doesn't register",
   * and "I extend my arm to reach and it doesn't always reach".
   *
   * At a 26–30 Hz pose rate samples are ~35 ms apart. A fast arm extension can
   * cross a zone's whole diameter inside one gap, so every SAMPLED position is
   * outside the zone even though the hand visibly went through it.
   */
  it('registers a hit that no individual sample was inside', () => {
    const tracker = new ZoneTracker(config({ sweptCollision: true }));
    // Frame 1: well to the left of the zone. Frame 2: well past it. Neither
    // sample is within the 0.1 radius, but the straight path crosses dead
    // centre.
    tracker.update(snapshot(0, { leftWrist: at(-FAR) }), ZONES, ASPECT);
    const events = tracker.update(snapshot(35, { leftWrist: at(FAR) }), ZONES, ASPECT);

    expect(events.map((e) => e.type)).toEqual(['ZONE_ENTER']);
    expect(events[0].swept).toBe(true);
  });

  it('misses it entirely when sweeping is disabled', () => {
    const tracker = new ZoneTracker(config({ sweptCollision: false }));
    tracker.update(snapshot(0, { leftWrist: at(-FAR) }), ZONES, ASPECT);
    expect(tracker.update(snapshot(35, { leftWrist: at(FAR) }), ZONES, ASPECT)).toEqual([]);
  });

  /**
   * And the accuracy win that comes with it: the hand reached the zone partway
   * between two frames, so the entry is timestamped by interpolation rather
   * than rounded up to the frame that noticed. Worth up to a full frame — ~35
   * ms — against an ±80 ms PERFECT window.
   */
  it('timestamps the crossing by interpolation, not by the frame that saw it', () => {
    const tracker = new ZoneTracker(config({ sweptCollision: true }));
    tracker.update(snapshot(0, { leftWrist: at(-FAR) }), ZONES, ASPECT);
    const [event] = tracker.update(snapshot(40, { leftWrist: at(FAR) }), ZONES, ASPECT);

    // Centre is halfway along the path, so halfway through the gap.
    expect(event.timestampMs).toBeCloseTo(20, 0);
    expect(event.timestampMs).toBeLessThan(40);
  });

  it('does not sweep from a stale sample', () => {
    const tracker = new ZoneTracker(config({ sweptCollision: true, maxSweepGapMs: 120 }));
    tracker.update(snapshot(0, { leftWrist: at(-FAR) }), ZONES, ASPECT);
    // Half a second later: whatever path the hand took, it was not this one.
    expect(tracker.update(snapshot(500, { leftWrist: at(FAR) }), ZONES, ASPECT)).toEqual([]);
  });

  it('does not sweep from a position the model did not trust', () => {
    const tracker = new ZoneTracker(config({ sweptCollision: true, minVisibility: 0.5 }));
    tracker.update(snapshot(0, { leftWrist: at(-FAR, 0.1) }), ZONES, ASPECT);
    expect(tracker.update(snapshot(35, { leftWrist: at(FAR) }), ZONES, ASPECT)).toEqual([]);
  });

  it('does not invent a hit from a path that passes the zone by', () => {
    const tracker = new ZoneTracker(config({ sweptCollision: true }));
    // A horizontal sweep well below the zone: never within the radius.
    const below = (offset: number) => ({ x: ZONE.cx + offset, y: ZONE.cy + 0.4, visibility: 1 });
    tracker.update(snapshot(0, { leftWrist: below(-FAR) }), ZONES, ASPECT);
    expect(tracker.update(snapshot(35, { leftWrist: below(FAR) }), ZONES, ASPECT)).toEqual([]);
  });

  it('still emits exactly one enter for a hand that arrives and stays', () => {
    const tracker = new ZoneTracker(config({ sweptCollision: true }));
    tracker.update(snapshot(0, { leftWrist: at(-FAR) }), ZONES, ASPECT);
    const first = tracker.update(snapshot(35, { leftWrist: at(0) }), ZONES, ASPECT);
    expect(first.map((e) => e.type)).toEqual(['ZONE_ENTER']);
    for (let t = 70; t < 400; t += 35) {
      expect(tracker.update(snapshot(t, { leftWrist: at(0) }), ZONES, ASPECT)).toEqual([]);
    }
  });
});
