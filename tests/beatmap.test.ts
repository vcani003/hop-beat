import { describe, expect, it } from 'vitest';
import { validateBeatmap, parseBeatmap } from '../src/game/maps/validator.ts';
import { beatmapDurationMs, noteTimeMs, type Beatmap } from '../src/game/maps/schema.ts';
import warmup from '../maps/fixtures/click-120-warmup.json';

const valid = (): Beatmap => ({
  schemaVersion: 1,
  song: { id: 'x', title: 'X', artist: 'A', playback: { provider: 'clickTrack', bpm: 120 } },
  analysis: { bpm: 120, confidence: 1, offsetMs: 0, generatorVersion: 'test' },
  difficulty: 'normal',
  mapType: 'handmade',
  notes: [{ id: 'n1', timeMs: 0, type: 'hit', zone: 'upperLeft', limb: 'eitherHand' }],
});

const errorsFor = (mutate: (m: Beatmap) => void): string[] => {
  const map = valid();
  mutate(map);
  return validateBeatmap(map).errors;
};

describe('validateBeatmap — structure', () => {
  it('accepts a well-formed map', () => {
    const result = validateBeatmap(valid());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(validateBeatmap(null).ok).toBe(false);
    expect(validateBeatmap('a map').ok).toBe(false);
  });

  it('refuses a schema version it cannot read', () => {
    const errors = errorsFor((m) => { (m as { schemaVersion: number }).schemaVersion = 2; });
    expect(errors.join()).toMatch(/Unsupported schemaVersion 2/);
  });

  it('requires the playback field its provider needs', () => {
    expect(errorsFor((m) => { m.song.playback = { provider: 'youtube' }; }).join()).toMatch(/videoId/);
    expect(errorsFor((m) => { m.song.playback = { provider: 'localAudio' }; }).join()).toMatch(/src/);
    expect(errorsFor((m) => { m.song.playback = { provider: 'clickTrack' }; }).join()).toMatch(/bpm/);
  });

  it('rejects an unknown provider', () => {
    const errors = errorsFor((m) => {
      (m.song.playback as { provider: string }).provider = 'spotify';
    });
    expect(errors.join()).toMatch(/Unknown playback provider "spotify"/);
  });
});

describe('validateBeatmap — notes', () => {
  it('names the offending note, not just "invalid beatmap"', () => {
    const errors = errorsFor((m) => {
      m.notes.push({ id: 'n2', timeMs: 100, type: 'hit', zone: 'nowhere' as 'upperLeft', limb: 'eitherHand' });
    });
    expect(errors.join()).toMatch(/note\[1\] \(n2\).*unknown zone "nowhere"/);
  });

  it('rejects duplicate ids', () => {
    const errors = errorsFor((m) => { m.notes.push({ ...m.notes[0] }); });
    expect(errors.join()).toMatch(/duplicate id/);
  });

  /** The engine walks the chart forward and never looks back. */
  it('rejects notes out of chronological order', () => {
    const errors = errorsFor((m) => {
      m.notes = [
        { id: 'a', timeMs: 500, type: 'hit', zone: 'upperLeft', limb: 'eitherHand' },
        { id: 'b', timeMs: 100, type: 'hit', zone: 'upperLeft', limb: 'eitherHand' },
      ];
    });
    expect(errors.join()).toMatch(/out of order/);
  });

  it('allows two notes at the same instant', () => {
    const errors = errorsFor((m) => {
      m.notes = [
        { id: 'a', timeMs: 500, type: 'hit', zone: 'upperLeft', limb: 'leftHand' },
        { id: 'b', timeMs: 500, type: 'hit', zone: 'upperRight', limb: 'rightHand' },
      ];
    });
    expect(errors).toEqual([]);
  });

  it('rejects negative times and unknown limbs', () => {
    expect(errorsFor((m) => { m.notes[0].timeMs = -1; }).join()).toMatch(/zero or more/);
    expect(errorsFor((m) => { (m.notes[0] as { limb: string }).limb = 'foot'; }).join()).toMatch(/unknown limb/);
  });

  it('warns rather than errors on an empty chart', () => {
    const map = valid();
    map.notes = [];
    const result = validateBeatmap(map);
    expect(result.ok).toBe(true);
    expect(result.warnings.join()).toMatch(/no notes/);
  });
});

describe('parseBeatmap', () => {
  it('lists every problem at once rather than the first', () => {
    const map = valid();
    (map as { schemaVersion: number }).schemaVersion = 9;
    map.notes[0].zone = 'nope' as 'upperLeft';
    expect(() => parseBeatmap(map)).toThrow(/schemaVersion[\s\S]*unknown zone/);
  });
});

describe('schema helpers', () => {
  it('applies the authoring offset to note times', () => {
    const map = valid();
    map.analysis.offsetMs = 120;
    expect(noteTimeMs(map.notes[0], map)).toBe(120);
  });

  it('reports duration as the last note, and zero for an empty chart', () => {
    const map = valid();
    map.notes.push({ id: 'n9', timeMs: 9000, type: 'hit', zone: 'lowerLeft', limb: 'eitherHand' });
    expect(beatmapDurationMs(map)).toBe(9000);
    expect(beatmapDurationMs({ ...map, notes: [] })).toBe(0);
  });
});

describe('the shipped warm-up chart', () => {
  it('is valid', () => {
    const result = validateBeatmap(warmup);
    expect(result.errors).toEqual([]);
  });

  it('is played against a click track, so it carries no licensing question', () => {
    expect((warmup as Beatmap).song.playback.provider).toBe('clickTrack');
  });

  it('uses all four zones', () => {
    const zones = new Set((warmup as Beatmap).notes.map((n) => n.zone));
    expect(zones.size).toBe(4);
  });

  /**
   * A warm-up teaches; it does not test. Reported after playing: "it seems
   * many beats happen at once across different hit zones and it is hard to
   * tell which one to hit... rapid fire hits should not be done first round."
   */
  it('never asks for two targets at the same moment', () => {
    const times = (warmup as Beatmap).notes.map((n) => n.timeMs);
    expect(new Set(times).size).toBe(times.length);
  });

  it('never goes faster than one note per beat', () => {
    const notes = (warmup as Beatmap).notes;
    const beatMs = 60_000 / (warmup as Beatmap).analysis.bpm;
    for (let i = 1; i < notes.length; i++) {
      expect(notes[i].timeMs - notes[i - 1].timeMs, `note ${i}`).toBeGreaterThanOrEqual(beatMs - 1);
    }
  });

  it('never asks for a specific hand', () => {
    expect((warmup as Beatmap).notes.every((n) => n.limb === 'eitherHand')).toBe(true);
  });

  it('introduces each corner before asking the player to move between them', () => {
    const notes = (warmup as Beatmap).notes;
    // The opening should stay put: the first four notes use only two zones.
    expect(new Set(notes.slice(0, 4).map((n) => n.zone)).size).toBeLessThanOrEqual(2);
  });
});
