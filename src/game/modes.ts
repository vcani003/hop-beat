/**
 * Game modes: a fixed target layout plus the tracking it requires. Spec §24.
 *
 * A mode declares what it needs and nothing else is loaded. The JS costs
 * nothing either way — MediaPipe ships as one pre-bundled file and measured at
 * 8 bytes' difference with every hand class imported — but the model files are
 * megabytes fetched at runtime, and a body-only mode should never pay for a
 * hand model it will not use. docs/TRACKING.md has the numbers.
 */
import { CORNERS_4, type TargetLayout } from './zones.ts';

export type TrackingCapability = 'body' | 'hands';

export interface GameMode {
  id: string;
  name: string;
  description: string;
  layout: TargetLayout;
  capabilities: TrackingCapability[];
  /** What the player should do with their body to play this mode. */
  stance: string;
  /** Model fetched on entering the mode, in MB, for an honest loading message. */
  modelSizeMb: number;
  /** Kept for future modes that should not be offered yet. None are hidden today. */
  hidden?: boolean;
}

export const BODY_MODE: GameMode = {
  id: 'body',
  name: 'Full body',
  description: 'Hit targets with your wrists. Stand back far enough to be seen head to hips.',
  layout: CORNERS_4,
  capabilities: ['body'],
  stance: 'Stand back — head and hips both in frame.',
  modelSizeMb: 5.8,
};

export const HANDS_MODE: GameMode = {
  id: 'hands',
  name: 'Hands only',
  description:
    'Hit targets with your hands. Sit or stand close — only your hands need to be seen.',
  layout: CORNERS_4,
  capabilities: ['hands'],
  // The distance conflict in docs/TRACKING.md is the reason this mode exists
  // separately rather than as an add-on: hands landmark well close to the lens,
  // full-body tracking wants the player far from it, and no single position
  // serves both well.
  stance: 'Come closer — hands up, elbows relaxed. Your whole body does not need to fit.',
  modelSizeMb: 8.4,
};

export const GAME_MODES: readonly GameMode[] = [BODY_MODE, HANDS_MODE];

/**
 * Modes offered in the picker.
 *
 * Both camera modes are offered. They are deprecated in the sense of §25 — no
 * new work is going into them — but they are playable, and leaving them
 * playable is how anyone else gets to try them and say what is wrong.
 */
export const VISIBLE_MODES: readonly GameMode[] = GAME_MODES.filter((m) => !m.hidden);

export function findMode(id: string | undefined): GameMode {
  return GAME_MODES.find((m) => m.id === id) ?? BODY_MODE;
}

export const requiresHands = (mode: GameMode): boolean => mode.capabilities.includes('hands');
export const requiresBody = (mode: GameMode): boolean => mode.capabilities.includes('body');
