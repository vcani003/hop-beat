/**
 * The charts this build can play.
 *
 * Two kinds. The warm-up runs against a click track we synthesise, so it needs
 * no audio file and carries no licensing question at all. The rest are played
 * against audio in `public/audio/`, which is GITIGNORED — spec §11 says to
 * store the derived beatmap, not the recording, and nothing here commits a
 * track to the repository.
 *
 * Attribution is recorded per track because §11 also treats crediting the
 * artist as part of doing this properly, not a nicety.
 */
import warmup from '../../../maps/fixtures/click-120-warmup.json';
import { parseBeatmap } from './validator.ts';
import { buildPatternChart, type Difficulty } from './patterns.ts';
import type { Beatmap } from './schema.ts';

/** Validated at module load: a malformed shipped chart is a build problem. */
export const WARMUP_MAP: Beatmap = parseBeatmap(warmup);

/**
 * Tempo and first-beat values measured with scripts/estimate-tempo.py.
 *
 * They are estimates from a crude energy-flux detector, not ground truth, and
 * a tempo estimator landing an octave out is routine. The play screen exposes
 * both values so a chart can be pinned by ear — which is the honest workflow
 * until MVP 2 brings a real analysis pipeline.
 */
export interface LocalTrack {
  id: string;
  title: string;
  artist: string;
  file: string;
  bpm: number;
  firstBeatMs: number;
  durationMs: number;
}

export const LOCAL_TRACKS: LocalTrack[] = [
  {
    id: 'blackbox-vibe-key',
    title: 'Black Box Vibe (Key)',
    artist: 'BlackBoxx',
    file: 'blackbox-black-box-vibe-key-287081.mp3',
    bpm: 123.05,
    firstBeatMs: 93,
    durationMs: 175_595,
  },
  {
    id: 'alexgrohl-electronic',
    title: 'Electronic',
    artist: 'AlexGrohl',
    file: 'alexgrohl-electronic-470603.mp3',
    bpm: 112.35,
    firstBeatMs: 372,
    durationMs: 105_848,
  },
  {
    id: 'jonasblakewood-dance-pop-party',
    title: 'Dance Pop Party',
    artist: 'JonasBlakewood',
    file: 'jonasblakewood-dance-pop-party-573475.mp3',
    bpm: 166.71,
    firstBeatMs: 35,
    durationMs: 58_514,
  },
  {
    id: 'jonasblakewood-trap-dance',
    title: 'Trap Dance',
    artist: 'JonasBlakewood',
    file: 'jonasblakewood-trap-dance-583357.mp3',
    bpm: 161.5,
    firstBeatMs: 163,
    durationMs: 61_231,
  },
];

/** Build a chart for a local track, optionally overriding the measured grid. */
export function chartForTrack(
  track: LocalTrack,
  overrides: { bpm?: number; firstBeatMs?: number; difficulty?: Difficulty } = {},
): Beatmap {
  return buildPatternChart({
    difficulty: overrides.difficulty ?? 'normal',
    id: track.id,
    title: track.title,
    artist: track.artist,
    src: `audio/${track.file}`,
    bpm: overrides.bpm ?? track.bpm,
    firstBeatMs: overrides.firstBeatMs ?? track.firstBeatMs,
    durationMs: track.durationMs,
  });
}

export const BUILT_IN_MAPS: readonly Beatmap[] = [WARMUP_MAP];
