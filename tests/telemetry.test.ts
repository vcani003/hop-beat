import { describe, expect, it } from 'vitest';
import { RateCounter, RollingStat } from '../src/debug/telemetry.ts';

describe('RollingStat', () => {
  it('reports zero before any samples arrive', () => {
    const stat = new RollingStat(10);
    expect(stat.mean()).toBe(0);
    expect(stat.percentile(0.95)).toBe(0);
  });

  it('averages the samples it holds', () => {
    const stat = new RollingStat(10);
    for (const v of [10, 20, 30]) stat.push(v);
    expect(stat.mean()).toBeCloseTo(20);
  });

  it('discards samples older than its capacity', () => {
    const stat = new RollingStat(3);
    for (const v of [100, 100, 100, 1, 1, 1]) stat.push(v);
    expect(stat.size).toBe(3);
    expect(stat.mean()).toBeCloseTo(1);
  });

  it('surfaces the spike that the mean hides', () => {
    const stat = new RollingStat(100);
    for (let i = 0; i < 90; i++) stat.push(10);
    for (let i = 0; i < 10; i++) stat.push(90);
    // A 18 ms mean reads as comfortable; a 90 ms p95 is a visibly dropped frame.
    expect(stat.mean()).toBeCloseTo(18);
    expect(stat.percentile(0.95)).toBe(90);
    expect(stat.max()).toBe(90);
  });

  it('uses nearest-rank percentiles: p95 is the value 95% of samples sit below', () => {
    const stat = new RollingStat(100);
    for (let i = 1; i <= 100; i++) stat.push(i);
    expect(stat.percentile(0.5)).toBe(50);
    expect(stat.percentile(0.95)).toBe(95);
  });

  it('handles the boundary percentiles', () => {
    const stat = new RollingStat(10);
    for (const v of [5, 1, 3, 2, 4]) stat.push(v);
    expect(stat.percentile(0)).toBe(1);
    expect(stat.percentile(1)).toBe(5);
  });
});

describe('RateCounter', () => {
  it('counts events inside the window', () => {
    const counter = new RateCounter(1000);
    for (let t = 0; t < 1000; t += 100) counter.tick(t);
    expect(counter.rate(999)).toBeCloseTo(10);
  });

  it('drops events that fall out of the window', () => {
    const counter = new RateCounter(1000);
    for (let t = 0; t < 1000; t += 100) counter.tick(t);
    expect(counter.rate(2500)).toBe(0);
  });

  it('is zero before anything happens', () => {
    expect(new RateCounter().rate(0)).toBe(0);
  });
});
