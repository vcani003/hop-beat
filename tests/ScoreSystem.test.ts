import { describe, expect, it } from 'vitest';
import {
  accuracy,
  applyJudgment,
  comboMultiplier,
  grade,
  initialScoreState,
  meanAbsDeltaMs,
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
