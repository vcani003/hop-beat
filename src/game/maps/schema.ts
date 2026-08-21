/**
 * The beatmap format, per spec §10.
 *
 * Versioned from the very first map. Charts outlive the code that reads them —
 * a map hand-authored today should still load after the generator, the editor
 * and the renderer have all been rewritten, and that is only possible if every
 * file says which shape it is.
 */
import type { ZoneId } from '../zones.ts';

export const BEATMAP_SCHEMA_VERSION = 1;

/** Which limb may satisfy a note. `eitherHand` is the MVP default. */
export type NoteLimb = 'eitherHand' | 'leftHand' | 'rightHand';

/**
 * Only `hit` exists in MVP 1. Holds, swipes and simultaneous notes are listed
 * in spec §6 as later work; naming the field now means adding them does not
 * require a schema bump.
 */
export type NoteType = 'hit';

export interface Note {
  id: string;
  /** Milliseconds from the start of the track. */
  timeMs: number;
  type: NoteType;
  zone: ZoneId;
  limb: NoteLimb;
}

export type PlaybackProvider = 'clickTrack' | 'localAudio' | 'youtube';

export interface PlaybackSource {
  provider: PlaybackProvider;
  /** youtube only. */
  videoId?: string;
  /** localAudio only — a path or object URL. Never a bundled copyrighted file. */
  src?: string;
  /** clickTrack only. */
  bpm?: number;
  beatsPerBar?: number;
  bars?: number;
}

export interface SongMeta {
  id: string;
  title: string;
  artist: string;
  playback: PlaybackSource;
}

export interface AnalysisMeta {
  bpm: number;
  confidence: number;
  /**
   * Milliseconds to add to every note time when judging. Corrects a map
   * authored against a source whose first beat is not at zero.
   */
  offsetMs: number;
  generatorVersion: string;
}

export type MapType = 'generated' | 'curated' | 'handmade';

export interface Beatmap {
  schemaVersion: number;
  /**
   * The target layout this chart was authored against. Spec §24: a chart
   * written for four corners is not automatically playable on another layout,
   * so the map says which it needs rather than leaving it to be assumed.
   * Absent means `corners4`, which is all that existed when the format was
   * defined.
   */
  layoutId?: string;
  song: SongMeta;
  analysis: AnalysisMeta;
  difficulty: string;
  mapType: MapType;
  notes: Note[];
}

/** Duration of the chart itself, ignoring however long the audio runs. */
export function beatmapDurationMs(map: Beatmap): number {
  return map.notes.length === 0 ? 0 : map.notes[map.notes.length - 1].timeMs;
}

/** Note time adjusted by the map's authoring offset. Judge against this. */
export function noteTimeMs(note: Note, map: Beatmap): number {
  return note.timeMs + map.analysis.offsetMs;
}
