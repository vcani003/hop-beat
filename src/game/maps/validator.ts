/**
 * Beatmap validation.
 *
 * A malformed chart must fail loudly at load, not produce a song that plays
 * with three unhittable notes somewhere in the middle. Errors name the note
 * that caused them, because "invalid beatmap" is useless when a chart has
 * four hundred entries.
 */
import { TARGET_LAYOUTS, ZONE_IDS } from '../zones.ts';
import {
  BEATMAP_SCHEMA_VERSION,
  type Beatmap,
  type MapType,
  type NoteLimb,
  type PlaybackProvider,
} from './schema.ts';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const LIMBS: NoteLimb[] = ['eitherHand', 'leftHand', 'rightHand'];
const MAP_TYPES: MapType[] = ['generated', 'curated', 'handmade'];
const PROVIDERS: PlaybackProvider[] = ['clickTrack', 'localAudio', 'youtube'];

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validateBeatmap(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['Beatmap must be an object.'], warnings };
  }
  const map = input as Partial<Beatmap>;

  if (map.schemaVersion !== BEATMAP_SCHEMA_VERSION) {
    errors.push(
      `Unsupported schemaVersion ${String(map.schemaVersion)} — this build reads version ${BEATMAP_SCHEMA_VERSION}.`,
    );
  }

  // --- song ---
  if (!map.song) {
    errors.push('Missing `song`.');
  } else {
    if (!map.song.id) errors.push('Missing `song.id`.');
    if (!map.song.title) errors.push('Missing `song.title`.');
    if (!map.song.artist) warnings.push('No `song.artist` — attribution matters (spec §11).');

    const playback = map.song.playback;
    if (!playback) {
      errors.push('Missing `song.playback`.');
    } else if (!PROVIDERS.includes(playback.provider)) {
      errors.push(`Unknown playback provider "${String(playback.provider)}".`);
    } else if (playback.provider === 'youtube' && !playback.videoId) {
      errors.push('`youtube` playback requires `song.playback.videoId`.');
    } else if (playback.provider === 'localAudio' && !playback.src) {
      errors.push('`localAudio` playback requires `song.playback.src`.');
    } else if (playback.provider === 'clickTrack' && !isFiniteNumber(playback.bpm)) {
      errors.push('`clickTrack` playback requires a numeric `song.playback.bpm`.');
    }
  }

  // --- analysis ---
  if (!map.analysis) {
    errors.push('Missing `analysis`.');
  } else {
    if (!isFiniteNumber(map.analysis.bpm) || map.analysis.bpm <= 0) {
      errors.push('`analysis.bpm` must be a positive number.');
    }
    if (!isFiniteNumber(map.analysis.offsetMs)) {
      errors.push('`analysis.offsetMs` must be a number.');
    }
  }

  if (map.mapType !== undefined && !MAP_TYPES.includes(map.mapType)) {
    errors.push(`Unknown mapType "${String(map.mapType)}".`);
  }

  if (map.layoutId !== undefined && !TARGET_LAYOUTS.some((l) => l.id === map.layoutId)) {
    errors.push(
      `Unknown layoutId "${String(map.layoutId)}" — this build has: ${TARGET_LAYOUTS.map((l) => l.id).join(', ')}.`,
    );
  }

  // --- notes ---
  if (!Array.isArray(map.notes)) {
    errors.push('`notes` must be an array.');
    return { ok: errors.length === 0, errors, warnings };
  }

  const seenIds = new Set<string>();
  let previousTime = -Infinity;

  map.notes.forEach((note, index) => {
    const where = `note[${index}]${note?.id ? ` (${note.id})` : ''}`;

    if (!note || typeof note !== 'object') {
      errors.push(`${where} is not an object.`);
      return;
    }
    if (!note.id) {
      errors.push(`${where} is missing an id.`);
    } else if (seenIds.has(note.id)) {
      errors.push(`${where} has a duplicate id.`);
    } else {
      seenIds.add(note.id);
    }

    if (!isFiniteNumber(note.timeMs) || note.timeMs < 0) {
      errors.push(`${where} needs a timeMs of zero or more.`);
    } else {
      // Sorted order is not cosmetic: the engine walks the chart forward and
      // relies on never needing to look backwards for a note it has passed.
      if (note.timeMs < previousTime) {
        errors.push(`${where} is out of order — notes must be sorted by timeMs.`);
      }
      previousTime = note.timeMs;
    }

    if (note.type !== 'hit') {
      errors.push(`${where} has unsupported type "${String(note.type)}" — only "hit" exists.`);
    }
    if (!ZONE_IDS.includes(note.zone)) {
      errors.push(`${where} has unknown zone "${String(note.zone)}".`);
    }
    if (!LIMBS.includes(note.limb)) {
      errors.push(`${where} has unknown limb "${String(note.limb)}".`);
    }
  });

  if (map.notes.length === 0) warnings.push('Chart has no notes.');

  return { ok: errors.length === 0, errors, warnings };
}

/** Validate and narrow, or throw with every problem listed at once. */
export function parseBeatmap(input: unknown): Beatmap {
  const result = validateBeatmap(input);
  if (!result.ok) {
    throw new Error(`Invalid beatmap:\n  ${result.errors.join('\n  ')}`);
  }
  return input as Beatmap;
}
