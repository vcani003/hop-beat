/**
 * The game loop's core, per spec §5 and §7.
 *
 *   playbackTime = clock.getTimeMs()
 *   for each active note:
 *       if an eligible limb entered its zone in time  -> judge
 *       if its window has closed                      -> miss
 *
 * Two things make this more than that sketch:
 *
 * INPUTS ARE JUDGED AT THE TIME THEY HAPPENED, not the time they arrive. A
 * zone entry carries the timestamp of the camera frame that produced it, which
 * MVP 0 measured as roughly 28 ms old on arrival. `clock.playbackTimeAtMs`
 * converts that instant into playback time, so the player is not charged for
 * the pipeline's latency.
 *
 * JUDGMENT DOES NOT ADVANCE WHILE PLAYBACK IS STOPPED. Spec §14: notes must
 * not silently expire against a paused or buffering player.
 *
 * No DOM, no MediaPipe, no renderer. Fed by the caller, tested with a fake
 * clock and synthetic events.
 */
import type { InputLimb } from '../../pose/poseTypes.ts';
import type { ZoneEvent } from '../ZoneTracker.ts';
import type { Beatmap } from '../maps/schema.ts';
import type { ZoneId } from '../zones.ts';
import type { GameClock } from './GameClock.ts';
import {
  collectExpiredNotes,
  findClaimableNote,
  toActiveNotes,
  judgeDelta,
  DEFAULT_WINDOWS,
  type ActiveNote,
  type Judgment,
  type TimingWindows,
} from './NoteJudge.ts';
import {
  applyJudgment,
  initialScoreState,
  type ScoreState,
} from './ScoreSystem.ts';

/** What the renderer and HUD are told about each decision. */
export interface JudgmentEvent {
  noteId: string;
  zone: ZoneId;
  judgment: Judgment;
  /** Signed: negative early, positive late. Null for a note that expired. */
  deltaMs: number | null;
  /** Playback time at which the judgment was made. */
  playbackTimeMs: number;
  limb?: InputLimb;
}

export interface GameEngineOptions {
  windows?: TimingWindows;
}

export class GameEngine {
  private clock: GameClock;
  private map: Beatmap;
  private windows: TimingWindows;
  private notes: ActiveNote[];
  private score: ScoreState = initialScoreState();
  /** Index of the first note that has not yet been judged or expired. */
  private cursor = 0;

  constructor(clock: GameClock, map: Beatmap, options: GameEngineOptions = {}) {
    this.clock = clock;
    this.map = map;
    this.windows = options.windows ?? DEFAULT_WINDOWS;
    this.notes = toActiveNotes(map);
  }

  getNotes(): readonly ActiveNote[] {
    return this.notes;
  }

  getScore(): ScoreState {
    return this.score;
  }

  getMap(): Beatmap {
    return this.map;
  }

  getWindows(): TimingWindows {
    return this.windows;
  }

  setWindows(windows: TimingWindows): void {
    this.windows = windows;
  }

  /** Every note judged, one way or another. */
  isComplete(): boolean {
    return this.notes.every((n) => n.judgment !== null);
  }

  reset(): void {
    this.notes = toActiveNotes(this.map);
    this.score = initialScoreState();
    this.cursor = 0;
  }

  /**
   * Credit player input against the chart.
   *
   * Only ZONE_ENTER counts. Exits describe the same gesture ending, and
   * ZONE_BLOCKED is diagnostic — crediting either would score one movement
   * twice.
   */
  handleZoneEvents(events: readonly ZoneEvent[]): JudgmentEvent[] {
    if (!this.clock.isRunning()) return [];

    const judged: JudgmentEvent[] = [];

    for (const event of events) {
      if (event.type !== 'ZONE_ENTER') continue;

      const inputTimeMs = this.clock.playbackTimeAtMs(event.timestampMs);
      const claimed = findClaimableNote(
        this.notes,
        event.zoneId,
        event.limb,
        inputTimeMs,
        this.windows,
      );
      // No claimable note: the player moved, but nothing was there to hit.
      // Extra movement is not punished — spec §19 rules out choreography
      // grading, and a miss here would make exploration feel hostile.
      if (!claimed) continue;

      const deltaMs = inputTimeMs - claimed.timeMs;
      const judgment = judgeDelta(Math.abs(deltaMs), this.windows);

      claimed.judgment = judgment;
      claimed.deltaMs = deltaMs;
      this.score = applyJudgment(this.score, judgment, Math.abs(deltaMs));

      judged.push({
        noteId: claimed.note.id,
        zone: claimed.note.zone,
        judgment,
        deltaMs,
        playbackTimeMs: inputTimeMs,
        limb: event.limb,
      });
    }

    this.advanceCursor();
    return judged;
  }

  /**
   * Retire notes whose window has closed. Call once per frame.
   *
   * Returns nothing while playback is stopped, so a paused song cannot bleed
   * misses.
   */
  update(): JudgmentEvent[] {
    if (!this.clock.isRunning()) return [];

    const playbackTimeMs = this.clock.getTimeMs();
    const expired = collectExpiredNotes(this.notes, playbackTimeMs, this.windows);

    const judged: JudgmentEvent[] = [];
    for (const active of expired) {
      active.judgment = 'MISS';
      this.score = applyJudgment(this.score, 'MISS', 0);
      judged.push({
        noteId: active.note.id,
        zone: active.note.zone,
        judgment: 'MISS',
        deltaMs: null,
        playbackTimeMs,
      });
    }

    this.advanceCursor();
    return judged;
  }

  /**
   * Move the cursor past a contiguous run of settled notes.
   *
   * Charts are sorted, so once the leading notes are judged they never need
   * looking at again. This keeps per-frame work proportional to the notes
   * currently in play rather than to the length of the song.
   */
  private advanceCursor(): void {
    while (this.cursor < this.notes.length && this.notes[this.cursor].judgment !== null) {
      this.cursor += 1;
    }
  }

  /** Notes still in play, for the renderer. Never scans the settled prefix. */
  pendingNotes(): readonly ActiveNote[] {
    return this.notes.slice(this.cursor);
  }
}
