/**
 * Hand-designed note patterns, written on a tempo grid.
 *
 * This is not the choreography generator — that is MVP 2's job, and it will
 * decide WHAT to play from musical analysis. Here the musical decisions are
 * already made by hand, note by note, in `PATTERN`; the only thing computed is
 * where the beats fall in milliseconds.
 *
 * Doing it this way rather than by writing out fifty timestamps means a chart
 * can be re-pinned when a tempo estimate turns out to be wrong, without
 * re-authoring the music.
 */
import type { Beatmap, Note, NoteLimb } from './schema.ts';
import type { ZoneId } from '../zones.ts';

const UL: ZoneId = 'upperLeft';
const UR: ZoneId = 'upperRight';
const LL: ZoneId = 'lowerLeft';
const LR: ZoneId = 'lowerRight';

interface PatternStep {
  /** Position in beats from the start of the phrase. */
  beat: number;
  zone: ZoneId;
  limb?: NoteLimb;
}

/**
 * One 16-beat phrase, repeated for the length of the track with variations.
 *
 * The shape is deliberate: a sweep to teach the corners, doubles to settle
 * into the pulse, then eighths as the only genuinely demanding bar. Spec §9
 * calls for "readable patterns and intentional repetition over pure
 * randomness", which applies just as much to a chart written by hand.
 */
const PHRASE_A: PatternStep[] = [
  { beat: 0, zone: UL }, { beat: 1, zone: UR }, { beat: 2, zone: LR }, { beat: 3, zone: LL },
  { beat: 4, zone: UL }, { beat: 5, zone: UR }, { beat: 6, zone: LR }, { beat: 7, zone: LL },
  { beat: 8, zone: UL }, { beat: 9, zone: UL }, { beat: 10, zone: UR }, { beat: 11, zone: UR },
  { beat: 12, zone: LL }, { beat: 13, zone: LL }, { beat: 14, zone: LR }, { beat: 15, zone: LR },
];

/** The same length, with eighths — used for louder sections. */
const PHRASE_B: PatternStep[] = [
  { beat: 0, zone: UL }, { beat: 0.5, zone: UR }, { beat: 1, zone: UL }, { beat: 1.5, zone: UR },
  { beat: 2, zone: LL }, { beat: 2.5, zone: LR }, { beat: 3, zone: LL }, { beat: 3.5, zone: LR },
  { beat: 4, zone: UL, limb: 'leftHand' }, { beat: 5, zone: UR, limb: 'rightHand' },
  { beat: 6, zone: LL, limb: 'leftHand' }, { beat: 7, zone: LR, limb: 'rightHand' },
  { beat: 8, zone: UL }, { beat: 9, zone: LR }, { beat: 10, zone: UR }, { beat: 11, zone: LL },
  { beat: 12, zone: UL }, { beat: 13, zone: LR }, { beat: 14, zone: UR }, { beat: 15, zone: LL },
];

export interface PatternChartOptions {
  id: string;
  title: string;
  artist: string;
  src: string;
  bpm: number;
  /** Milliseconds to the first beat of the track. */
  firstBeatMs: number;
  durationMs: number;
  /** Bars of silence at the start before notes begin. */
  restBars?: number;
  difficulty?: string;
}

export function buildPatternChart(options: PatternChartOptions): Beatmap {
  const { bpm, firstBeatMs, durationMs, restBars = 2 } = options;
  const beatMs = 60_000 / bpm;
  const phraseBeats = 16;

  const notes: Note[] = [];
  let phraseIndex = 0;
  let beatCursor = restBars * 4;

  // Stop a full phrase before the end so a chart never runs past its audio.
  while ((beatCursor + phraseBeats) * beatMs + firstBeatMs < durationMs - beatMs) {
    // Alternate, with B appearing more often once the track is under way.
    const phrase = phraseIndex === 0 || phraseIndex % 2 === 0 ? PHRASE_A : PHRASE_B;
    for (const step of phrase) {
      notes.push({
        id: `n${(notes.length + 1).toString().padStart(3, '0')}`,
        timeMs: Math.round(firstBeatMs + (beatCursor + step.beat) * beatMs),
        type: 'hit',
        zone: step.zone,
        limb: step.limb ?? 'eitherHand',
      });
    }
    beatCursor += phraseBeats;
    phraseIndex += 1;
  }

  notes.sort((a, b) => a.timeMs - b.timeMs);

  return {
    schemaVersion: 1,
    song: {
      id: options.id,
      title: options.title,
      artist: options.artist,
      playback: { provider: 'localAudio', src: options.src },
    },
    analysis: {
      bpm,
      // Tempo was measured by scripts/estimate-tempo.py rather than tapped by
      // hand, so this is not a claim of certainty — the UI lets it be corrected.
      confidence: 0.6,
      offsetMs: 0,
      generatorVersion: 'handmade-pattern-1',
    },
    difficulty: options.difficulty ?? 'normal',
    // The PATTERN is hand-designed; only its placement in time is computed.
    mapType: 'handmade',
    notes,
  };
}
