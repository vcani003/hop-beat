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

  it('refuses a landmark the model is not confident about', () => {
    const events = tracker.update(
      snapshot(0, { leftWrist: at(0, 0.2) }),
      ZONES,
      ASPECT,
    );
    expect(events).toEqual([]);
  });

  it('refuses a landmark extrapolated outside the camera frame', () => {
    const t = new ZoneTracker(config({ requireInFrame: true }));
    const offscreen = { x: -0.02, y: 0.25, visibility: 1 };
    const edgeZone: Zone = { ...ZONE, cx: 0.02, radius: 0.1 };
    expect(t.update(snapshot(0, { leftWrist: offscreen }), [edgeZone], ASPECT)).toEqual([]);
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
    expect(tracker.update(snapshot(100, { leftWrist: at(0) }), ZONES, ASPECT)).toEqual([]);
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
