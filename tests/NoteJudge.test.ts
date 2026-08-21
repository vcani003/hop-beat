import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOWS,
  collectExpiredNotes,
  findClaimableNote,
  judgeDelta,
  limbMatches,
  toActiveNotes,
  visibleNotes,
  type ActiveNote,
} from '../src/game/engine/NoteJudge.ts';
import type { Beatmap, Note } from '../src/game/maps/schema.ts';
import type { ZoneId } from '../src/game/zones.ts';

const note = (id: string, timeMs: number, zone: ZoneId = 'upperLeft', limb: Note['limb'] = 'eitherHand'): Note =>
  ({ id, timeMs, type: 'hit', zone, limb });

const mapWith = (notes: Note[], offsetMs = 0): Beatmap => ({
  schemaVersion: 1,
  song: { id: 's', title: 'T', artist: 'A', playback: { provider: 'clickTrack', bpm: 120 } },
  analysis: { bpm: 120, confidence: 1, offsetMs, generatorVersion: 'test' },
  difficulty: 'normal',
  mapType: 'handmade',
  notes,
});

const active = (notes: Note[], offsetMs = 0): ActiveNote[] => toActiveNotes(mapWith(notes, offsetMs));

describe('judgeDelta — window boundaries', () => {
  it('is PERFECT exactly on the boundary', () => {
    expect(judgeDelta(0)).toBe('PERFECT');
    expect(judgeDelta(80)).toBe('PERFECT');
  });

  it('is GOOD one millisecond past PERFECT', () => {
    expect(judgeDelta(80.001)).toBe('GOOD');
    expect(judgeDelta(160)).toBe('GOOD');
  });

  it('is MISS one millisecond past GOOD', () => {
    expect(judgeDelta(160.001)).toBe('MISS');
    expect(judgeDelta(5000)).toBe('MISS');
  });

  it('honours custom windows', () => {
    const tight = { perfectMs: 30, goodMs: 60 };
    expect(judgeDelta(31, tight)).toBe('GOOD');
    expect(judgeDelta(61, tight)).toBe('MISS');
  });
});

describe('limbMatches', () => {
  it('lets either hand satisfy an eitherHand note', () => {
    expect(limbMatches(note('n', 0), 'leftWrist')).toBe(true);
    expect(limbMatches(note('n', 0), 'rightWrist')).toBe(true);
  });

  it('binds a handed note to that hand only', () => {
    const left = note('n', 0, 'upperLeft', 'leftHand');
    expect(limbMatches(left, 'leftWrist')).toBe(true);
    expect(limbMatches(left, 'rightWrist')).toBe(false);
  });
});

describe('toActiveNotes', () => {
  it('applies the map authoring offset once, up front', () => {
    const notes = active([note('n1', 1000)], 250);
    expect(notes[0].timeMs).toBe(1250);
    expect(notes[0].note.timeMs).toBe(1000);
  });

  it('starts every note unjudged', () => {
    expect(active([note('n1', 0), note('n2', 500)]).every((n) => n.judgment === null)).toBe(true);
  });
});

describe('findClaimableNote', () => {
  it('claims a note inside the GOOD window', () => {
    const notes = active([note('n1', 1000)]);
    expect(findClaimableNote(notes, 'upperLeft', 'leftWrist', 1100)?.note.id).toBe('n1');
  });

  it('claims nothing outside the window', () => {
    const notes = active([note('n1', 1000)]);
    expect(findClaimableNote(notes, 'upperLeft', 'leftWrist', 1200)).toBeNull();
  });

  it('ignores notes in a different zone', () => {
    const notes = active([note('n1', 1000, 'upperLeft')]);
    expect(findClaimableNote(notes, 'lowerRight', 'leftWrist', 1000)).toBeNull();
  });

  it('ignores notes the limb cannot satisfy', () => {
    const notes = active([note('n1', 1000, 'upperLeft', 'rightHand')]);
    expect(findClaimableNote(notes, 'upperLeft', 'leftWrist', 1000)).toBeNull();
  });

  it('ignores notes already judged', () => {
    const notes = active([note('n1', 1000)]);
    notes[0].judgment = 'PERFECT';
    expect(findClaimableNote(notes, 'upperLeft', 'leftWrist', 1000)).toBeNull();
  });

  /**
   * The rule that matters when a chart doubles up in one zone. Crediting the
   * earlier note would consume the one the player was not aiming at, and leave
   * the note they DID hit to expire as a miss.
   */
  it('claims the nearest note in time, not the earliest', () => {
    const notes = active([note('n1', 1000), note('n2', 1150)]);
    expect(findClaimableNote(notes, 'upperLeft', 'leftWrist', 1140)?.note.id).toBe('n2');
    expect(findClaimableNote(notes, 'upperLeft', 'leftWrist', 1020)?.note.id).toBe('n1');
  });

  it('claims an early hit as readily as a late one', () => {
    const notes = active([note('n1', 1000)]);
    expect(findClaimableNote(notes, 'upperLeft', 'leftWrist', 900)?.note.id).toBe('n1');
  });
});

describe('collectExpiredNotes', () => {
  /** A note is only missed once the player can no longer reach it. */
  it('does not expire a note still inside its late window', () => {
    const notes = active([note('n1', 1000)]);
    expect(collectExpiredNotes(notes, 1000 + DEFAULT_WINDOWS.goodMs)).toEqual([]);
  });

  it('expires a note one millisecond past its late window', () => {
    const notes = active([note('n1', 1000)]);
    const expired = collectExpiredNotes(notes, 1000 + DEFAULT_WINDOWS.goodMs + 1);
    expect(expired.map((n) => n.note.id)).toEqual(['n1']);
  });

  it('never expires a note that was already judged', () => {
    const notes = active([note('n1', 1000)]);
    notes[0].judgment = 'GOOD';
    expect(collectExpiredNotes(notes, 99_999)).toEqual([]);
  });
});

describe('visibleNotes', () => {
  it('shows notes approaching within the lead time', () => {
    const notes = active([note('n1', 1000), note('n2', 5000)]);
    const visible = visibleNotes(notes, 0, 1500);
    expect(visible.map((n) => n.note.id)).toEqual(['n1']);
  });

  it('keeps a just-passed note briefly, so feedback can land', () => {
    const notes = active([note('n1', 1000)]);
    expect(visibleNotes(notes, 1100, 1500, 200)).toHaveLength(1);
    expect(visibleNotes(notes, 1400, 1500, 200)).toHaveLength(0);
  });
});
