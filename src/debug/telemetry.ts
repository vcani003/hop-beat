/**
 * Measurement, not guessing. Spec §14: "Measure actual timing rather than
 * optimizing based on guesses."
 *
 * Averages hide the frames that ruin a rhythm game. A pose pipeline that
 * averages 12 ms but spikes to 90 ms four times a second feels broken while
 * looking fine, so everything here reports percentiles alongside the mean.
 */

/** A fixed-size ring of recent samples. Allocates once, never grows. */
export class RollingStat {
  private samples: Float64Array;
  private capacity: number;
  private index = 0;
  private count = 0;

  constructor(capacity = 120) {
    this.capacity = capacity;
    this.samples = new Float64Array(capacity);
  }

  push(value: number): void {
    this.samples[this.index] = value;
    this.index = (this.index + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  get size(): number {
    return this.count;
  }

  mean(): number {
    if (this.count === 0) return 0;
    let total = 0;
    for (let i = 0; i < this.count; i++) total += this.samples[i];
    return total / this.count;
  }

  /** @param p 0–1. percentile(0.95) is the number worth worrying about. */
  percentile(p: number): number {
    if (this.count === 0) return 0;
    const sorted = Array.from(this.samples.subarray(0, this.count)).sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[rank];
  }

  max(): number {
    let highest = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.samples[i] > highest) highest = this.samples[i];
    }
    return highest;
  }

  reset(): void {
    this.index = 0;
    this.count = 0;
  }
}

/**
 * Events per second, measured over a sliding window rather than as an
 * instantaneous 1/delta — which is far too twitchy to read off a screen.
 */
export class RateCounter {
  private times: number[] = [];
  private windowMs: number;

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }

  tick(nowMs: number): void {
    this.times.push(nowMs);
    const cutoff = nowMs - this.windowMs;
    while (this.times.length > 0 && this.times[0] < cutoff) this.times.shift();
  }

  /** Hz over the window. */
  rate(nowMs: number): number {
    const cutoff = nowMs - this.windowMs;
    while (this.times.length > 0 && this.times[0] < cutoff) this.times.shift();
    return (this.times.length * 1000) / this.windowMs;
  }

  reset(): void {
    this.times.length = 0;
  }
}

export const formatMs = (value: number): string => `${value.toFixed(1)} ms`;
