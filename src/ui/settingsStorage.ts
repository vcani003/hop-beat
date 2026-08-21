/**
 * Settings survive a reload.
 *
 * These values are tuning, not preference: they were found by standing in
 * front of a camera and moving sliders, and losing them on every refresh makes
 * the next tuning pass start from scratch. Unknown or corrupt stored data
 * falls back to defaults rather than throwing — a broken settings blob must
 * never be able to stop the app from starting.
 */
import { DEFAULT_SETTINGS, type Settings } from './types.ts';

const KEY = 'hopbeat.mvp0.settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const stored = JSON.parse(raw) as Partial<Settings>;
    // Spread over the defaults so a setting added later is simply picked up.
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private browsing, or a full quota. Not worth interrupting play for.
  }
}

export function clearSettings(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
