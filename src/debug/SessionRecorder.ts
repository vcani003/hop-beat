/**
 * A recording of everything that happened in one session, and the summary that
 * answers the question MVP 0 exists to answer: are these events good enough?
 *
 * Pure data in, pure data out — no DOM, no download logic. The React layer
 * decides what to do with the JSON; this module only has to be correct.
 *
 * The statistic that matters most here is the repeat interval. A rhythm game
 * lives or dies on whether the same target can be hit twice in quick
 * succession, and the fastest interval the tracker actually ACCEPTED is a hard
 * upper bound on the tempo the game can support.
 */
import type { BlockReason, ZoneEvent } from '../game/ZoneTracker.ts';
import type { ZoneId } from '../game/zones.ts';
import { ZONE_IDS } from '../game/zones.ts';

export interface RecordedEvent extends ZoneEvent {
  /** Age of the camera frame when the event was produced, in ms. */
  latencyMs: number;
}

export interface ZoneBreakdown {
  hits: number;
  blocked: number;
  meanDwellMs: number;
}

export interface IntervalStats {
  /** How many repeat gaps were observed. */
  count: number;
  fastestMs: number | null;
  medianMs: number | null;
}

export interface SessionSummary {
  durationMs: number;
  hits: number;
  exits: number;
  blocked: Record<BlockReason, number>;
  perZone: Record<ZoneId, ZoneBreakdown>;
  perLimb: Record<string, number>;
  /** Gaps between consecutive accepted hits on the SAME zone and limb. */
  repeatInterval: IntervalStats;
  /**
   * The fastest repeat the tracker refused, if any. When this is well below
   * `repeatInterval.fastestMs`, the settings — not the player — are the limit.
   */
  fastestBlockedRepeatMs: number | null;
  meanDwellMs: number;
}

const emptyZone = (): ZoneBreakdown => ({ hits: 0, blocked: 0, meanDwellMs: 0 });

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const pairKey = (e: ZoneEvent) => `${e.zoneId}:${e.limb}`;

/** Derive the session summary from a raw event list. */
export function summarise(events: readonly RecordedEvent[]): SessionSummary {
  const perZone = Object.fromEntries(ZONE_IDS.map((id) => [id, emptyZone()])) as Record<
    ZoneId,
    ZoneBreakdown
  >;
  const perLimb: Record<string, number> = {};
  const blocked: Record<BlockReason, number> = { refractory: 0, visibility: 0 };

  const dwellsByZone: Record<string, number[]> = {};
  const allDwells: number[] = [];
  const lastHitAt = new Map<string, number>();
  const lastBlockedNearAt = new Map<string, number>();
  const repeatGaps: number[] = [];
  const blockedGaps: number[] = [];

  let hits = 0;
  let exits = 0;
  let firstMs = Infinity;
  let lastMs = -Infinity;

  for (const event of events) {
    firstMs = Math.min(firstMs, event.timestampMs);
    lastMs = Math.max(lastMs, event.timestampMs);
    const key = pairKey(event);

    if (event.type === 'ZONE_ENTER') {
      hits += 1;
      perZone[event.zoneId].hits += 1;
      perLimb[event.limb] = (perLimb[event.limb] ?? 0) + 1;

      const previous = lastHitAt.get(key);
      if (previous !== undefined) repeatGaps.push(event.timestampMs - previous);
      lastHitAt.set(key, event.timestampMs);
      lastBlockedNearAt.set(key, event.timestampMs);
    } else if (event.type === 'ZONE_EXIT') {
      exits += 1;
      if (event.dwellMs !== undefined) {
        allDwells.push(event.dwellMs);
        (dwellsByZone[event.zoneId] ??= []).push(event.dwellMs);
      }
    } else if (event.type === 'ZONE_BLOCKED') {
      perZone[event.zoneId].blocked += 1;
      if (event.reason) blocked[event.reason] += 1;
      // A refused repeat: measure it against the hit it was trying to follow.
      const previous = lastBlockedNearAt.get(key);
      if (event.reason === 'refractory' && previous !== undefined) {
        blockedGaps.push(event.timestampMs - previous);
      }
    }
  }

  for (const id of ZONE_IDS) {
    const dwells = dwellsByZone[id] ?? [];
    perZone[id].meanDwellMs =
      dwells.length > 0 ? dwells.reduce((a, b) => a + b, 0) / dwells.length : 0;
  }

  return {
    durationMs: events.length > 0 ? lastMs - firstMs : 0,
    hits,
    exits,
    blocked,
    perZone,
    perLimb,
    repeatInterval: {
      count: repeatGaps.length,
      fastestMs: repeatGaps.length > 0 ? Math.min(...repeatGaps) : null,
      medianMs: median(repeatGaps),
    },
    fastestBlockedRepeatMs: blockedGaps.length > 0 ? Math.min(...blockedGaps) : null,
    meanDwellMs:
      allDwells.length > 0 ? allDwells.reduce((a, b) => a + b, 0) / allDwells.length : 0,
  };
}

/**
 * Interval in ms between beats at a given tempo, so a measured repeat gap can
 * be read as "this is the fastest music the current settings can follow".
 */
export function beatIntervalMs(bpm: number, division = 1): number {
  return 60000 / (bpm * division);
}

/** The fastest BPM at which quarter notes could repeat, given a gap in ms. */
export function maxSustainableBpm(gapMs: number): number {
  return gapMs > 0 ? 60000 / gapMs : 0;
}

export interface SessionDocument {
  schemaVersion: 1;
  recordedAtIso: string;
  settings: unknown;
  environment: unknown;
  summary: SessionSummary;
  events: readonly RecordedEvent[];
}

export function buildSessionDocument(
  events: readonly RecordedEvent[],
  settings: unknown,
  environment: unknown,
  recordedAtIso: string,
): SessionDocument {
  return {
    schemaVersion: 1,
    recordedAtIso,
    settings,
    environment,
    summary: summarise(events),
    events,
  };
}
