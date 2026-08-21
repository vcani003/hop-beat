/**
 * The playback contract, per spec §17.
 *
 * Everything the game knows about time comes through this interface, which is
 * what lets a click track, a local file and — at MVP 3 — a YouTube embed drive
 * exactly the same engine.
 */
export type PlaybackState = 'idle' | 'playing' | 'paused' | 'buffering' | 'ended';

export interface PlaybackAdapter {
  play(): Promise<void> | void;
  pause(): void;
  /** Position within the track, in milliseconds. */
  getCurrentTimeMs(): number;
  getState(): PlaybackState;
  /** Total length in ms, or null when the source cannot say. */
  getDurationMs(): number | null;
  seekMs?(timeMs: number): void;
  dispose(): void;
}
