import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DECISIONS,
  MILESTONES,
  OPEN_QUESTIONS,
  questionTotals,
  taskTotals,
} from '../src/spec/progress.ts';

const decisionsMd = readFileSync(
  fileURLToPath(new URL('../docs/DECISIONS.md', import.meta.url)),
  'utf8',
);

describe('milestones', () => {
  it('covers MVP 0 through MVP 5, in order', () => {
    expect(MILESTONES.map((m) => m.id)).toEqual(['mvp0', 'mvp1', 'mvp2', 'mvp3', 'mvp4', 'mvp5']);
  });

  it('marks a milestone done only when its exit criterion is met', () => {
    for (const m of MILESTONES) {
      if (m.status === 'done') {
        expect(m.exitMet, `${m.id} is done but its exit criterion is not met`).toBe(true);
      }
    }
  });

  it('has every task of a done milestone actually done', () => {
    for (const m of MILESTONES.filter((m) => m.status === 'done')) {
      const unfinished = m.tasks.filter((t) => t.status !== 'done');
      expect(unfinished, `${m.id} has unfinished tasks`).toEqual([]);
    }
  });

  it('never leaves a milestone done while an earlier one is not', () => {
    const lastDone = MILESTONES.map((m) => m.status === 'done').lastIndexOf(true);
    for (let i = 0; i < lastDone; i++) {
      expect(MILESTONES[i].status, `${MILESTONES[i].id} precedes a completed milestone`).toBe('done');
    }
  });

  it('runs at most one active milestone at a time', () => {
    expect(MILESTONES.filter((m) => m.status === 'active').length).toBeLessThanOrEqual(1);
  });

  it('gives every milestone a goal and an exit criterion', () => {
    for (const m of MILESTONES) {
      expect(m.goal.length, m.id).toBeGreaterThan(10);
      expect(m.exitCriterion.length, m.id).toBeGreaterThan(10);
      expect(m.tasks.length, m.id).toBeGreaterThan(0);
    }
  });
});

describe('open questions', () => {
  it('carries all ten from the spec, numbered 1..10', () => {
    expect(OPEN_QUESTIONS.map((q) => q.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  /** An answer without evidence is an opinion, and the spec asks for prototyping. */
  it('requires evidence behind every answer', () => {
    for (const q of OPEN_QUESTIONS.filter((q) => q.answer)) {
      expect(q.evidence, `question ${q.number} is answered without evidence`).toBeTruthy();
    }
  });

  it('does not mark an unanswered question as partial', () => {
    for (const q of OPEN_QUESTIONS.filter((q) => !q.answer)) {
      expect(q.partial, `question ${q.number}`).toBeUndefined();
      expect(q.evidence, `question ${q.number}`).toBeUndefined();
    }
  });
});

describe('decisions stay in step with docs/DECISIONS.md', () => {
  /**
   * The page and the document are two views of one record. Without this test
   * the summary shown in the app could drift away from the decision it claims
   * to summarise, and nobody would notice.
   */
  it('has a matching heading in the document for every listed decision', () => {
    for (const d of DECISIONS) {
      expect(decisionsMd, `decision ${d.number} is missing from DECISIONS.md`).toContain(
        `### ${d.number}. ${d.title}`,
      );
    }
  });

  it('lists every numbered decision the document contains', () => {
    const inDoc = [...decisionsMd.matchAll(/^### (\d+)\. /gm)].map((m) => Number(m[1]));
    expect(DECISIONS.map((d) => d.number).sort((a, b) => a - b)).toEqual(
      inDoc.sort((a, b) => a - b),
    );
  });

  it('numbers decisions consecutively from 1', () => {
    expect(DECISIONS.map((d) => d.number)).toEqual(DECISIONS.map((_, i) => i + 1));
  });

  it('summarises rather than restates the title', () => {
    for (const d of DECISIONS) {
      expect(d.summary.length, `decision ${d.number}`).toBeGreaterThan(40);
    }
  });
});

describe('roll-ups', () => {
  it('counts completed work without double counting', () => {
    const totals = taskTotals();
    expect(totals.total).toBe(MILESTONES.flatMap((m) => m.tasks).length);
    expect(totals.done).toBeLessThanOrEqual(totals.total);
    expect(totals.milestonesTotal).toBe(6);
  });

  it('partitions the questions exactly once each', () => {
    const q = questionTotals();
    expect(q.answered + q.partial + q.open).toBe(q.total);
    expect(q.total).toBe(OPEN_QUESTIONS.length);
  });

  it('reflects MVP 0 being complete', () => {
    expect(taskTotals().milestonesDone).toBe(1);
    expect(MILESTONES[0].exitMet).toBe(true);
  });
});
