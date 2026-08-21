/**
 * Timing judgment. Spec §7.
 *
 * Pure and clock-free: it is told the playback time an input happened at, and
 * answers what that input was worth. Every boundary here is unit-tested,
 * because a window that is wrong by one millisecond is a bug nobody can see
 * and everybody can feel.
 */
import type { InputLimb } from '../../pose/poseTypes.ts';
import type { ZoneId } from '../zones.ts';
import type { Beatmap, Note } from '../maps/schema.ts';
import { noteTimeMs } from '../maps/schema.ts';

export type Judgment = 'PERFECT' | 'GOOD' | 'MISS';

export interface TimingWindows {
  perfectMs: number;
  goodMs: number;
}

/**
 * Spec §7's starting values, explicitly TUNABLE and not final:
 * "Do not lock final timing windows until real-device testing."
 */
export const DEFAULT_WINDOWS: TimingWindows = { perfectMs: 80, goodMs: 160 };

/** Runtime state for one note in a chart. */
export interface ActiveNote {
  note: Note;
  /** Note time with the map's authoring offset already applied. */
  timeMs: number;
  judgment: Judgment | null;
  /** Signed error in ms: negative is early, positive is late. */
  deltaMs: number | null;
}

export function toActiveNotes(map: Beatmap): ActiveNote[] {
  return map.notes.map((note) => ({
    note,
    timeMs: noteTimeMs(note, map),
    judgment: null,
    deltaMs: null,
  }));
}

/** Which judgment an absolute timing error earns. */
export function judgeDelta(absDeltaMs: number, windows: TimingWindows = DEFAULT_WINDOWS): Judgment {
  if (absDeltaMs <= windows.perfectMs) return 'PERFECT';
  if (absDeltaMs <= windows.goodMs) return 'GOOD';
  return 'MISS';
}

/** Can this limb satisfy this note? */
export function limbMatches(note: Note, limb: InputLimb): boolean {
  if (note.limb === 'eitherHand') return true;
  return note.limb === (limb === 'leftWrist' ? 'leftHand' : 'rightHand');
}

/**
 * Find the note an input should be credited against.
 *
 * The rule is NEAREST IN TIME among unjudged notes in the same zone that the
 * limb can satisfy and that are still inside the GOOD window. Nearest rather
 * than earliest matters when a chart puts two notes close together in one
 * zone: crediting the earlier one would consume the note the player was not
 * aiming at and leave the intended one to expire.
 *
 * Returns null when nothing is claimable, which the caller should treat as an
 * input that simply does not score — not as a miss. Punishing extra movement
 * would make the game feel hostile, and spec §19 rules out grading
 * choreography.
 */
export function findClaimableNote(
  notes: readonly ActiveNote[],
  zone: ZoneId,
  limb: InputLimb,
  playbackTimeMs: number,
  windows: TimingWindows = DEFAULT_WINDOWS,
): ActiveNote | null {
  let best: ActiveNote | null = null;
  let bestDelta = Infinity;

  for (const active of notes) {
    if (active.judgment !== null) continue;
    if (active.note.zone !== zone) continue;
    if (!limbMatches(active.note, limb)) continue;

    const delta = Math.abs(playbackTimeMs - active.timeMs);
    if (delta > windows.goodMs) continue;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = active;
    }
  }

  return best;
}

/**
 * Notes whose window has fully closed without being judged.
 *
 * A note is only missed once the player can no longer reach it — the moment
 * playback passes its late GOOD boundary. Marking it earlier would steal hits
 * the player was still entitled to.
 */
export function collectExpiredNotes(
  notes: readonly ActiveNote[],
  playbackTimeMs: number,
  windows: TimingWindows = DEFAULT_WINDOWS,
): ActiveNote[] {
  return notes.filter(
    (active) => active.judgment === null && playbackTimeMs > active.timeMs + windows.goodMs,
  );
}

/** Notes currently worth drawing: approaching, live, or just passed. */
export function visibleNotes(
  notes: readonly ActiveNote[],
  playbackTimeMs: number,
  leadMs: number,
  trailMs = 200,
): ActiveNote[] {
  return notes.filter(
    (active) =>
      active.timeMs - playbackTimeMs <= leadMs && active.timeMs - playbackTimeMs >= -trailMs,
  );
}
