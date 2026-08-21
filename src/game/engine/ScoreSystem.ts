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
  /** Sum of |error| over judged hits, for the results screen. */
  totalAbsDeltaMs: number;
  judgedCount: number;
}

export function initialScoreState(): ScoreState {
  return {
    score: 0,
    combo: 0,
    maxCombo: 0,
    counts: { PERFECT: 0, GOOD: 0, MISS: 0 },
    totalAbsDeltaMs: 0,
    judgedCount: 0,
  };
}

export function comboMultiplier(combo: number): number {
  return COMBO_TIERS.find((tier) => combo >= tier.combo)?.multiplier ?? 1;
}

/**
 * Apply one judgment. Returns a NEW state — the engine keeps this outside
 * React, but immutability keeps the reducer trivially testable.
 */
export function applyJudgment(
  state: ScoreState,
  judgment: Judgment,
  absDeltaMs: number,
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
    totalAbsDeltaMs: isHit ? state.totalAbsDeltaMs + absDeltaMs : state.totalAbsDeltaMs,
    judgedCount: state.judgedCount + 1,
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
