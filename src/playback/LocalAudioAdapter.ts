/**
 * Playback from an audio file the player supplies themselves.
 *
 * Nothing is bundled: the file is chosen at runtime and read as an object URL,
 * so no recording is ever committed to this repository. Spec §11.
 *
 * Its clock is coarser than the click track's — `currentTime` on a media
 * element updates only every 20–50 ms — which is exactly the staircase
 * GameClock exists to smooth over.
 */
import type { PlaybackAdapter, PlaybackState } from './PlaybackAdapter.ts';
import { assetUrl } from '../assets.ts';

export class LocalAudioAdapter implements PlaybackAdapter {
  private audio: HTMLAudioElement;
  private objectUrl: string | null = null;
  private ended = false;

  constructor(source: File | string) {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    if (typeof source === 'string') {
      this.audio.src = assetUrl(source);
    } else {
      this.objectUrl = URL.createObjectURL(source);
      this.audio.src = this.objectUrl;
    }
    this.audio.addEventListener('ended', () => {
      this.ended = true;
    });
  }

  /** Resolves once metadata is known, so duration is available before play. */
  ready(): Promise<void> {
    if (this.audio.readyState >= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
      this.audio.addEventListener('error', () => reject(new Error('Could not decode that audio file.')), { once: true });
    });
  }

  async play(): Promise<void> {
    this.ended = false;
    await this.audio.play();
  }

  pause(): void {
    this.audio.pause();
  }

  getCurrentTimeMs(): number {
    return this.audio.currentTime * 1000;
  }

  getState(): PlaybackState {
    if (this.ended) return 'ended';
    if (this.audio.paused) return this.audio.currentTime === 0 ? 'idle' : 'paused';
    // readyState below HAVE_FUTURE_DATA means playback cannot continue yet.
    // Spec §14: pause judgment while buffering rather than letting notes
    // advance against a stalled player.
    if (this.audio.readyState < 3) return 'buffering';
    return 'playing';
  }

  getDurationMs(): number | null {
    return Number.isFinite(this.audio.duration) ? this.audio.duration * 1000 : null;
  }

  seekMs(timeMs: number): void {
    this.audio.currentTime = timeMs / 1000;
  }

  setVolume(volume: number): void {
    this.audio.volume = volume;
  }

  dispose(): void {
    this.audio.pause();
    this.audio.src = '';
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}
