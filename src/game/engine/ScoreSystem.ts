/**
 * Score, combo and accuracy.
 *
 * Deliberately conventional — the interesting problem in this project is the
 * controller, not the points formula, and a familiar scoring model lets a
 * player judge their own improvement without learning a new system first.
 */
import type { Judgment } from './NoteJudge.ts';

export const JUDGMENT_VALUE: Record<Judgment, number> = {
  PERFECT: 300,
  GOOD: 100,
  MISS: 0,
};

/** Combo multiplier steps. Capped so a long chart cannot run away. */
const COMBO_TIERS = [
  { combo: 100, multiplier: 4 },
  { combo: 50, multiplier: 3 },
  { combo: 20, multiplier: 2 },
  { combo: 0, multiplier: 1 },
];

export interface ScoreState {
  score: number;
  combo: number;
  maxCombo: number;
  counts: Record<Judgment, number>;
  /** Sum of |error| over judged hits — how tight the player is. */
  totalAbsDeltaMs: number;
  /**
   * Sum of SIGNED error over judged hits — which way they are off.
   *
   * The two answer different questions and both are needed. A player who is
   * 60 ms early half the time and 60 ms late the other half has the same mean
   * absolute error as one who is 60 ms late every single time, but only the
   * second has a calibration problem the offset slider can fix.
   */
  totalDeltaMs: number;
  judgedCount: number;
  /**
   * Signed error of each hit, paired with when in the song it happened.
   *
   * Kept so the two ways a chart can be out of time can be told apart, which a
   * single average cannot do. See timingDiagnosis().
   */
  samples: Array<{ atMs: number; deltaMs: number }>;
}

export function initialScoreState(): ScoreState {
  return {
    score: 0,
    combo: 0,
    maxCombo: 0,
    counts: { PERFECT: 0, GOOD: 0, MISS: 0 },
    totalAbsDeltaMs: 0,
    totalDeltaMs: 0,
    judgedCount: 0,
    samples: [],
  };
}

export function comboMultiplier(combo: number): number {
  return COMBO_TIERS.find((tier) => combo >= tier.combo)?.multiplier ?? 1;
}

/**
 * Apply one judgment. Returns a NEW state — the engine keeps this outside
 * React, but immutability keeps the reducer trivially testable.
 */
/**
 * @param deltaMs SIGNED timing error: negative early, positive late. Ignored
 *   for a MISS, which has no meaningful error.
 */
export function applyJudgment(
  state: ScoreState,
  judgment: Judgment,
  deltaMs: number,
  atMs = 0,
): ScoreState {
  const isHit = judgment !== 'MISS';
  // The multiplier is read from the combo BEFORE this note extends it, so the
  // first note of a new tier is not retroactively worth more than it was on
  // screen.
  const multiplier = isHit ? comboMultiplier(state.combo) : 1;
  const combo = isHit ? state.combo + 1 : 0;

  return {
    score: state.score + JUDGMENT_VALUE[judgment] * multiplier,
    combo,
    maxCombo: Math.max(state.maxCombo, combo),
    counts: { ...state.counts, [judgment]: state.counts[judgment] + 1 },
    totalAbsDeltaMs: isHit ? state.totalAbsDeltaMs + Math.abs(deltaMs) : state.totalAbsDeltaMs,
    totalDeltaMs: isHit ? state.totalDeltaMs + deltaMs : state.totalDeltaMs,
    judgedCount: state.judgedCount + 1,
    samples: isHit ? [...state.samples, { atMs, deltaMs }] : state.samples,
  };
}

/** 0–1. Judged notes only, so accuracy is meaningful mid-song. */
export function accuracy(state: ScoreState): number {
  if (state.judgedCount === 0) return 1;
  const earned =
    state.counts.PERFECT * JUDGMENT_VALUE.PERFECT + state.counts.GOOD * JUDGMENT_VALUE.GOOD;
  return earned / (state.judgedCount * JUDGMENT_VALUE.PERFECT);
}

/** Mean absolute timing error over hits, or null when nothing has been hit. */
export function meanAbsDeltaMs(state: ScoreState): number | null {
  const hits = state.counts.PERFECT + state.counts.GOOD;
  return hits === 0 ? null : state.totalAbsDeltaMs / hits;
}

/**
 * Mean SIGNED timing error. Negative means consistently early, positive means
 * consistently late — the number the calibration offset should cancel.
 */
export function meanDeltaMs(state: ScoreState): number | null {
  const hits = state.counts.PERFECT + state.counts.GOOD;
  return hits === 0 ? null : state.totalDeltaMs / hits;
}

/**
 * The offset that would centre the player's hits, or null when there is not
 * enough evidence yet. Suggesting a correction from three notes would chase
 * noise.
 */
export function suggestedOffsetMs(state: ScoreState, currentOffsetMs: number): number | null {
  const hits = state.counts.PERFECT + state.counts.GOOD;
  const mean = meanDeltaMs(state);
  if (hits < 8 || mean === null || Math.abs(mean) < 12) return null;
  return Math.round((currentOffsetMs - mean) / 5) * 5;
}

export type TimingFault = 'none' | 'offset' | 'tempo' | 'unknown';

export interface TimingDiagnosis {
  fault: TimingFault;
  /** Average signed error across the whole song. */
  biasMs: number;
  /** How much the error moved from the first half to the second. */
  driftMs: number;
  explanation: string;
}

/** Not worth diagnosing below this many hits — the answer would be noise. */
const MIN_SAMPLES_TO_DIAGNOSE = 10;
const OFFSET_THRESHOLD_MS = 25;
const DRIFT_THRESHOLD_MS = 45;

/**
 * Tell a wrong OFFSET apart from a wrong TEMPO.
 *
 * These feel identical while playing — the notes are not where the music is —
 * but they have different causes and different fixes, and an average cannot
 * distinguish them.
 *
 * A wrong offset shifts every note by the same amount, so the error is
 * constant from the first note to the last: the audio-offset slider cancels it.
 *
 * A wrong tempo puts the notes on the wrong GRID, so the error grows steadily
 * through the song. No offset fixes that; the BPM has to change. At 123 BPM,
 * being wrong by half a beat-per-minute drifts by about 700 ms over three
 * minutes, which is several windows wide by the end while looking fine at the
 * start.
 *
 * Comparing the first half against the second half separates them.
 */
export function timingDiagnosis(state: ScoreState): TimingDiagnosis {
  const samples = state.samples;
  if (samples.length < MIN_SAMPLES_TO_DIAGNOSE) {
    return {
      fault: 'unknown',
      biasMs: 0,
      driftMs: 0,
      explanation: 'Not enough hits yet to tell offset from tempo.',
    };
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const half = Math.floor(samples.length / 2);
  const firstHalf = mean(samples.slice(0, half).map((s) => s.deltaMs));
  const secondHalf = mean(samples.slice(half).map((s) => s.deltaMs));
  const biasMs = mean(samples.map((s) => s.deltaMs));
  const driftMs = secondHalf - firstHalf;

  if (Math.abs(driftMs) > DRIFT_THRESHOLD_MS) {
    return {
      fault: 'tempo',
      biasMs,
      driftMs,
      explanation:
        `Your timing drifted by ${driftMs.toFixed(0)} ms across the song, so the chart is on the ` +
        `wrong grid — the BPM is off. The offset slider cannot fix this; try the ÷2 or ×2 buttons, ` +
        `or nudge the tempo.`,
    };
  }

  if (Math.abs(biasMs) > OFFSET_THRESHOLD_MS) {
    return {
      fault: 'offset',
      biasMs,
      driftMs,
      explanation:
        `You are consistently ${Math.abs(biasMs).toFixed(0)} ms ` +
        `${biasMs > 0 ? 'late' : 'early'} by the same amount all song, which is an offset ` +
        `problem, not a tempo one. The audio offset slider cancels it exactly.`,
    };
  }

  return {
    fault: 'none',
    biasMs,
    driftMs,
    explanation: 'Timing looks steady — the chart is on the right grid.',
  };
}

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D';

const GRADE_THRESHOLDS: ReadonlyArray<{ min: number; grade: Grade }> = [
  { min: 0.95, grade: 'S' },
  { min: 0.9, grade: 'A' },
  { min: 0.8, grade: 'B' },
  { min: 0.7, grade: 'C' },
  { min: 0, grade: 'D' },
];

export function grade(state: ScoreState): Grade {
  const value = accuracy(state);
  return GRADE_THRESHOLDS.find((t) => value >= t.min)?.grade ?? 'D';
}
