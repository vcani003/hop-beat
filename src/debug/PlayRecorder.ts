/**
 * A recording of one play, detailed enough to diagnose a missed hit after the
 * fact.
 *
 * The problem this solves is a reporting one. "It missed" cannot be
 * investigated: it does not say whether the hand was seen, whether it reached
 * the target, whether a strike fired, or whether the strike simply landed
 * outside the note's window. Those are four different faults with four
 * different fixes.
 *
 * So a run records enough to reconstruct it:
 *
 *   - every note, and what became of it
 *   - every strike, matched or not
 *   - the wrist positions, downsampled
 *   - MARKS the player drops when something feels wrong
 *
 * That last one matters most. A player cannot report a timestamp, but they can
 * press a key the moment something feels off, and that turns "somewhere in the
 * song" into a point to look at.
 */
import type { ZoneEvent } from '../game/ZoneTracker.ts';
import type { JudgmentEvent } from '../game/engine/GameEngine.ts';
import type { PoseSnapshot } from '../pose/poseTypes.ts';
import type { Beatmap } from '../game/maps/schema.ts';

/** How often wrist positions are kept. ~10 Hz is enough to see a path. */
const TRACK_INTERVAL_MS = 100;
/** Bounded so a forgotten tab cannot grow without limit. */
const MAX_TRACK_POINTS = 12_000;
const MAX_EVENTS = 20_000;

export interface TrackPoint {
  /** Playback time, so it lines up with note times. */
  tMs: number;
  lx: number;
  ly: number;
  lv: number;
  rx: number;
  ry: number;
  rv: number;
}

export interface RecordedStrike {
  tMs: number;
  playbackMs: number;
  zone: string;
  limb: string;
  swept: boolean;
  /** Note it was credited to, or null when it scored nothing. */
  noteId: string | null;
  judgment: string | null;
  deltaMs: number | null;
}

export interface PlayerMark {
  playbackMs: number;
  note: string;
}

export class PlayRecorder {
  private track: TrackPoint[] = [];
  private strikes: RecordedStrike[] = [];
  private marks: PlayerMark[] = [];
  private lastTrackAt = -Infinity;

  reset(): void {
    this.track = [];
    this.strikes = [];
    this.marks = [];
    this.lastTrackAt = -Infinity;
  }

  /** Sample where the hands are. Called every pose frame; keeps ~10 per second. */
  sampleTrack(snapshot: PoseSnapshot, playbackMs: number): void {
    if (playbackMs - this.lastTrackAt < TRACK_INTERVAL_MS) return;
    if (this.track.length >= MAX_TRACK_POINTS) return;
    this.lastTrackAt = playbackMs;

    const l = snapshot.landmarks.leftWrist;
    const r = snapshot.landmarks.rightWrist;
    const round = (v: number) => Math.round(v * 1000) / 1000;
    this.track.push({
      tMs: Math.round(playbackMs),
      lx: round(l.x), ly: round(l.y), lv: round(l.visibility),
      rx: round(r.x), ry: round(r.y), rv: round(r.visibility),
    });
  }

  /**
   * Record a strike alongside what the engine made of it.
   *
   * Matched and unmatched strikes are both kept, because "the hand arrived and
   * nothing happened" is the single most useful line in the file.
   */
  recordStrikes(
    events: readonly ZoneEvent[],
    judgments: readonly JudgmentEvent[],
    playbackMs: number,
  ): void {
    if (this.strikes.length >= MAX_EVENTS) return;

    // Each judgment belongs to exactly one strike. Matching by zone and limb
    // alone would credit two strikes on the same target in one batch to the
    // same note — which is precisely the rapid-repeat case this recording
    // exists to investigate, so it would lie about the thing being studied.
    const unclaimed = [...judgments];

    for (const event of events) {
      if (event.type !== 'ZONE_ENTER') continue;
      const index = unclaimed.findIndex(
        (j) => j.zone === event.zoneId && j.limb === event.limb,
      );
      const judgment = index >= 0 ? unclaimed.splice(index, 1)[0] : undefined;
      this.strikes.push({
        tMs: Math.round(event.timestampMs),
        playbackMs: Math.round(playbackMs),
        zone: event.zoneId,
        limb: event.limb,
        swept: event.swept === true,
        noteId: judgment?.noteId ?? null,
        judgment: judgment?.judgment ?? null,
        deltaMs: judgment?.deltaMs != null ? Math.round(judgment.deltaMs) : null,
      });
    }
  }

  /** The player says something felt wrong, here. */
  mark(playbackMs: number, note = 'felt wrong'): PlayerMark {
    const mark = { playbackMs: Math.round(playbackMs), note };
    this.marks.push(mark);
    return mark;
  }

  markCount(): number {
    return this.marks.length;
  }

  /**
   * Everything needed to reconstruct the run, plus a window around each mark so
   * the interesting part can be read without scrolling the whole file.
   */
  build(map: Beatmap, context: Record<string, unknown>) {
    const noteOutcomes = map.notes.map((note) => {
      const strike = this.strikes.find((s) => s.noteId === note.id);
      return {
        id: note.id,
        timeMs: note.timeMs,
        zone: note.zone,
        limb: note.limb,
        outcome: strike?.judgment ?? 'MISS',
        deltaMs: strike?.deltaMs ?? null,
      };
    });

    return {
      schemaVersion: 1,
      context,
      song: map.song,
      difficulty: map.difficulty,
      summary: {
        notes: map.notes.length,
        strikes: this.strikes.length,
        unmatchedStrikes: this.strikes.filter((s) => s.noteId === null).length,
        sweptStrikes: this.strikes.filter((s) => s.swept).length,
        marks: this.marks.length,
      },
      marks: this.marks.map((mark) => ({
        ...mark,
        // A window either side, which is where the answer almost always is.
        notesNearby: noteOutcomes.filter(
          (n) => Math.abs(n.timeMs - mark.playbackMs) <= 2000,
        ),
        strikesNearby: this.strikes.filter(
          (s) => Math.abs(s.playbackMs - mark.playbackMs) <= 2000,
        ),
        trackNearby: this.track.filter(
          (p) => Math.abs(p.tMs - mark.playbackMs) <= 2000,
        ),
      })),
      notes: noteOutcomes,
      strikes: this.strikes,
      track: this.track,
    };
  }
}
