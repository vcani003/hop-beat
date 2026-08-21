import { describe, expect, it } from 'vitest';
import {
  buildSessionDocument,
  maxSustainableBpm,
  summarise,
  type RecordedEvent,
} from '../src/debug/SessionRecorder.ts';

const hit = (timestampMs: number, zoneId = 'upperLeft', limb = 'leftWrist'): RecordedEvent => ({
  type: 'ZONE_ENTER',
  zoneId: zoneId as RecordedEvent['zoneId'],
  limb: limb as RecordedEvent['limb'],
  timestampMs,
  distance: 0.01,
  latencyMs: 42,
});

const exit = (timestampMs: number, dwellMs: number, zoneId = 'upperLeft'): RecordedEvent => ({
  ...hit(timestampMs, zoneId),
  type: 'ZONE_EXIT',
  dwellMs,
});

const blocked = (
  timestampMs: number,
  reason: 'refractory' | 'visibility' = 'refractory',
  zoneId = 'upperLeft',
): RecordedEvent => ({ ...hit(timestampMs, zoneId), type: 'ZONE_BLOCKED', reason });

describe('summarise — empty session', () => {
  it('does not invent statistics from no data', () => {
    const s = summarise([]);
    expect(s.hits).toBe(0);
    expect(s.durationMs).toBe(0);
    expect(s.repeatInterval).toEqual({ count: 0, fastestMs: null, medianMs: null });
    expect(s.fastestBlockedRepeatMs).toBeNull();
    expect(s.meanDwellMs).toBe(0);
  });
});

describe('summarise — counting', () => {
  it('tallies hits per zone and per limb', () => {
    const s = summarise([
      hit(0, 'upperLeft', 'leftWrist'),
      hit(500, 'upperRight', 'rightWrist'),
      hit(1000, 'upperRight', 'rightWrist'),
    ]);
    expect(s.hits).toBe(3);
    expect(s.perZone.upperRight.hits).toBe(2);
    expect(s.perZone.lowerLeft.hits).toBe(0);
    expect(s.perLimb).toEqual({ leftWrist: 1, rightWrist: 2 });
  });

  it('measures the session from first to last event', () => {
    expect(summarise([hit(1000), hit(4500)]).durationMs).toBe(3500);
  });

  it('averages dwell time overall and per zone', () => {
    const s = summarise([
      exit(100, 200, 'upperLeft'),
      exit(200, 400, 'upperLeft'),
      exit(300, 900, 'lowerRight'),
    ]);
    expect(s.perZone.upperLeft.meanDwellMs).toBe(300);
    expect(s.perZone.lowerRight.meanDwellMs).toBe(900);
    expect(s.meanDwellMs).toBeCloseTo(500);
  });
});

describe('summarise — repeat intervals', () => {
  /**
   * The number that bounds playable tempo: how fast the SAME target was
   * actually re-hit, not how fast the player tried.
   */
  it('measures gaps between repeat hits on the same zone and limb', () => {
    const s = summarise([hit(0), hit(400), hit(700), hit(1500)]);
    expect(s.repeatInterval.count).toBe(3);
    expect(s.repeatInterval.fastestMs).toBe(300);
    expect(s.repeatInterval.medianMs).toBe(400);
  });

  it('does not treat different zones as repeats of each other', () => {
    const s = summarise([hit(0, 'upperLeft'), hit(100, 'upperRight'), hit(200, 'lowerLeft')]);
    expect(s.repeatInterval.count).toBe(0);
    expect(s.repeatInterval.fastestMs).toBeNull();
  });

  it('does not treat the other hand as a repeat', () => {
    const s = summarise([
      hit(0, 'upperLeft', 'leftWrist'),
      hit(120, 'upperLeft', 'rightWrist'),
    ]);
    expect(s.repeatInterval.count).toBe(0);
  });
});

describe('summarise — refused hits', () => {
  it('separates lockouts from low-confidence refusals', () => {
    const s = summarise([blocked(100, 'refractory'), blocked(200, 'visibility'), blocked(300, 'refractory')]);
    expect(s.blocked).toEqual({ refractory: 2, visibility: 1 });
    expect(s.perZone.upperLeft.blocked).toBe(3);
  });

  /**
   * The diagnosis this whole module exists for: if the fastest REFUSED repeat
   * is quicker than the fastest ACCEPTED one, the settings are the ceiling —
   * the player was already going faster than the tracker would allow.
   */
  it('surfaces when the settings, not the player, are the limit', () => {
    const s = summarise([hit(0), blocked(250, 'refractory'), hit(900), hit(1500)]);
    expect(s.fastestBlockedRepeatMs).toBe(250);
    expect(s.repeatInterval.fastestMs).toBe(600);
    expect(s.fastestBlockedRepeatMs!).toBeLessThan(s.repeatInterval.fastestMs!);
  });

  it('ignores visibility refusals when measuring blocked repeats', () => {
    const s = summarise([hit(0), blocked(120, 'visibility')]);
    expect(s.fastestBlockedRepeatMs).toBeNull();
  });
});

describe('maxSustainableBpm', () => {
  it('converts a repeat gap into a tempo ceiling', () => {
    expect(maxSustainableBpm(500)).toBe(120);
    expect(maxSustainableBpm(360)).toBeCloseTo(166.7, 1);
  });

  it('is zero for a nonsensical gap', () => {
    expect(maxSustainableBpm(0)).toBe(0);
  });
});

describe('buildSessionDocument', () => {
  it('packages events, settings and a summary under a versioned schema', () => {
    const doc = buildSessionDocument([hit(0), hit(600)], { zoneScale: 0.65 }, { model: 'full' }, '2026-08-20T19:00:00.000Z');
    expect(doc.schemaVersion).toBe(1);
    expect(doc.recordedAtIso).toBe('2026-08-20T19:00:00.000Z');
    expect(doc.settings).toEqual({ zoneScale: 0.65 });
    expect(doc.summary.hits).toBe(2);
    expect(doc.events).toHaveLength(2);
  });
});
