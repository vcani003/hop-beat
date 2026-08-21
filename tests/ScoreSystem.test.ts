import { describe, expect, it } from 'vitest';
import {
  accuracy,
  applyJudgment,
  comboMultiplier,
  grade,
  initialScoreState,
  meanAbsDeltaMs,
  meanDeltaMs,
  suggestedOffsetMs,
} from '../src/game/engine/ScoreSystem.ts';

const play = (sequence: Array<[('PERFECT' | 'GOOD' | 'MISS'), number]>) =>
  sequence.reduce((state, [j, d]) => applyJudgment(state, j, d), initialScoreState());

describe('combo', () => {
  it('grows on a hit and resets to zero on a miss', () => {
    const state = play([['PERFECT', 0], ['GOOD', 100], ['MISS', 0]]);
    expect(state.combo).toBe(0);
    expect(state.maxCombo).toBe(2);
  });

  it('remembers the best run of the song', () => {
    const state = play([
      ['PERFECT', 0], ['PERFECT', 0], ['PERFECT', 0],
      ['MISS', 0],
      ['PERFECT', 0],
    ]);
    expect(state.combo).toBe(1);
    expect(state.maxCombo).toBe(3);
  });
});

describe('comboMultiplier', () => {
  it('steps up at the tier boundaries', () => {
    expect(comboMultiplier(0)).toBe(1);
    expect(comboMultiplier(19)).toBe(1);
    expect(comboMultiplier(20)).toBe(2);
    expect(comboMultiplier(50)).toBe(3);
    expect(comboMultiplier(100)).toBe(4);
  });

  it('caps rather than growing without bound', () => {
    expect(comboMultiplier(100_000)).toBe(4);
  });
});

describe('score', () => {
  it('pays PERFECT more than GOOD, and nothing for a miss', () => {
    expect(play([['PERFECT', 0]]).score).toBe(300);
    expect(play([['GOOD', 0]]).score).toBe(100);
    expect(play([['MISS', 0]]).score).toBe(0);
  });

  /**
   * The multiplier is read from the combo BEFORE the note extends it, so a
   * note is never retroactively worth more than it was when it was on screen.
   */
  it('uses the multiplier the player could see at the time', () => {
    const nineteen = play(Array(19).fill(['PERFECT', 0]));
    expect(nineteen.combo).toBe(19);
    expect(comboMultiplier(nineteen.combo)).toBe(1); // 2x starts AT 20

    // The 20th note is scored at the 1x the player could see, and is the note
    // that lifts the combo to 20.
    const twentieth = applyJudgment(nineteen, 'PERFECT', 0);
    expect(twentieth.combo).toBe(20);
    expect(twentieth.score - nineteen.score).toBe(300);

    // Only the note after it is paid at the new tier.
    const twentyfirst = applyJudgment(twentieth, 'PERFECT', 0);
    expect(twentyfirst.score - twentieth.score).toBe(600);
  });
});

describe('accuracy and grade', () => {
  it('is a perfect score before anything has been judged', () => {
    expect(accuracy(initialScoreState())).toBe(1);
  });

  it('is the earned fraction of the maximum', () => {
    expect(accuracy(play([['PERFECT', 0], ['PERFECT', 0]]))).toBeCloseTo(1);
    expect(accuracy(play([['PERFECT', 0], ['MISS', 0]]))).toBeCloseTo(0.5);
    expect(accuracy(play([['GOOD', 0]]))).toBeCloseTo(1 / 3);
  });

  it('grades on the accuracy thresholds', () => {
    expect(grade(play(Array(20).fill(['PERFECT', 0])))).toBe('S');
    expect(grade(play([...Array(9).fill(['PERFECT', 0]), ['MISS', 0]]))).toBe('A');
    expect(grade(play([...Array(8).fill(['PERFECT', 0]), ['MISS', 0], ['MISS', 0]]))).toBe('B');
    expect(grade(play([...Array(5).fill(['PERFECT', 0]), ['MISS', 0], ['MISS', 0], ['MISS', 0], ['MISS', 0], ['MISS', 0]]))).toBe('D');
  });
});

describe('timing error', () => {
  it('averages only over notes that were actually hit', () => {
    const state = play([['PERFECT', 20], ['GOOD', 120], ['MISS', 0]]);
    expect(meanAbsDeltaMs(state)).toBeCloseTo(70);
  });

  it('is null when nothing has been hit', () => {
    expect(meanAbsDeltaMs(play([['MISS', 0]]))).toBeNull();
    expect(meanAbsDeltaMs(initialScoreState())).toBeNull();
  });
});

describe('timing bias vs spread', () => {
  /**
   * The distinction the calibration UI depends on. A player who is 60 ms early
   * half the time and 60 ms late the rest has the same mean ABSOLUTE error as
   * one who is 60 ms late every time — but only the second has a problem the
   * offset slider can fix.
   */
  it('separates being inconsistent from being consistently late', () => {
    const scattered = play([['GOOD', -60], ['GOOD', 60], ['GOOD', -60], ['GOOD', 60]]);
    const alwaysLate = play([['GOOD', 60], ['GOOD', 60], ['GOOD', 60], ['GOOD', 60]]);

    expect(meanAbsDeltaMs(scattered)).toBeCloseTo(60);
    expect(meanAbsDeltaMs(alwaysLate)).toBeCloseTo(60);

    expect(meanDeltaMs(scattered)).toBeCloseTo(0);
    expect(meanDeltaMs(alwaysLate)).toBeCloseTo(60);
  });

  it('reports early as negative', () => {
    expect(meanDeltaMs(play([['PERFECT', -30], ['PERFECT', -50]]))).toBeCloseTo(-40);
  });

  it('ignores misses, which have no meaningful error', () => {
    expect(meanDeltaMs(play([['GOOD', 40], ['MISS', 0]]))).toBeCloseTo(40);
  });
});

describe('suggestedOffsetMs', () => {
  it('suggests nothing from too few hits', () => {
    expect(suggestedOffsetMs(play([['GOOD', 60], ['GOOD', 60]]), 0)).toBeNull();
  });

  it('suggests nothing when the player is already centred', () => {
    expect(suggestedOffsetMs(play(Array(12).fill(['PERFECT', 4])), 0)).toBeNull();
  });

  it('cancels a consistent lateness', () => {
    // Consistently 60 ms late means the game should judge 60 ms earlier.
    expect(suggestedOffsetMs(play(Array(12).fill(['GOOD', 60])), 0)).toBe(-60);
  });

  it('adjusts relative to the offset already in use', () => {
    expect(suggestedOffsetMs(play(Array(12).fill(['GOOD', 60])), 20)).toBe(-40);
  });

  it('rounds to something a slider can express', () => {
    const suggestion = suggestedOffsetMs(play(Array(12).fill(['GOOD', 37])), 0)!;
    // Math.abs, because a negative multiple of five gives -0 in JavaScript and
    // Object.is(-0, 0) is false.
    expect(Math.abs(suggestion % 5)).toBe(0);
    expect(suggestion).toBe(-35);
  });
});
