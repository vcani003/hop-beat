import { describe, expect, it } from 'vitest';
import {
  BODY_MODE,
  findMode,
  GAME_MODES,
  HANDS_MODE,
  requiresBody,
  requiresHands,
  VISIBLE_MODES,
} from '../src/game/modes.ts';
import { TARGET_LAYOUTS } from '../src/game/zones.ts';

describe('game modes', () => {
  it('gives every mode a unique id', () => {
    const ids = GAME_MODES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('points every mode at a real layout', () => {
    for (const mode of GAME_MODES) {
      expect(TARGET_LAYOUTS, mode.id).toContain(mode.layout);
    }
  });

  /** Spec §24: every layout's targets fit on screen, whichever mode uses it. */
  it('keeps every mode’s targets on screen', () => {
    for (const mode of GAME_MODES) {
      for (const zone of mode.layout.build()) {
        expect(zone.cx - zone.radius, `${mode.id}/${zone.id}`).toBeGreaterThanOrEqual(0);
        expect(zone.cx + zone.radius, `${mode.id}/${zone.id}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('declares at least one capability per mode', () => {
    for (const mode of GAME_MODES) {
      expect(mode.capabilities.length, mode.id).toBeGreaterThan(0);
    }
  });

  /**
   * The point of declaring capabilities: a body-only mode must not drag in a
   * hand model it will never use.
   */
  it('keeps the body mode free of hand tracking', () => {
    expect(requiresHands(BODY_MODE)).toBe(false);
    expect(requiresBody(BODY_MODE)).toBe(true);
  });

  it('keeps the hands mode free of body tracking', () => {
    expect(requiresHands(HANDS_MODE)).toBe(true);
    expect(requiresBody(HANDS_MODE)).toBe(false);
  });

  it('tells the player how to stand for each mode', () => {
    for (const mode of GAME_MODES) {
      expect(mode.stance.length, mode.id).toBeGreaterThan(10);
      expect(mode.description.length, mode.id).toBeGreaterThan(10);
    }
  });

  it('falls back to the body mode for an unknown id', () => {
    expect(findMode(undefined)).toBe(BODY_MODE);
    expect(findMode('nope')).toBe(BODY_MODE);
    expect(findMode('hands')).toBe(HANDS_MODE);
  });
});

describe('mode visibility', () => {
  /**
   * Deprecated in the sense of §25 — no new work — but playable. Leaving them
   * in the picker is how anyone else gets to try them and say what is wrong.
   */
  it('still offers both camera modes', () => {
    expect(VISIBLE_MODES).toContain(BODY_MODE);
    expect(VISIBLE_MODES).toContain(HANDS_MODE);
  });

  it('keeps them intact and resolvable by id', () => {
    expect(GAME_MODES).toContain(BODY_MODE);
    expect(findMode('body')).toBe(BODY_MODE);
    expect(findMode('hands')).toBe(HANDS_MODE);
  });

  it('leaves every mode complete, hidden or not', () => {
    for (const mode of GAME_MODES) {
      expect(mode.capabilities.length, mode.id).toBeGreaterThan(0);
      expect(mode.layout, mode.id).toBeTruthy();
      expect(mode.stance.length, mode.id).toBeGreaterThan(10);
    }
  });
});
