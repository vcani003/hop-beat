import { describe, expect, it } from 'vitest';
import { checkHandPosition, checkPosition } from '../src/game/positioning.ts';
import { defaultZones } from '../src/game/zones.ts';
import { snapshot } from './helpers.ts';

const ASPECT = 16 / 9;
const ZONES = defaultZones();

/** A person standing square to the camera. */
const standing = (
  { centreX = 0.5, shoulderWidth = 0.2, shoulderY = 0.4, visibility = 1 } = {},
) =>
  snapshot(0, {
    leftShoulder: { x: centreX - shoulderWidth / 2, y: shoulderY, visibility },
    rightShoulder: { x: centreX + shoulderWidth / 2, y: shoulderY, visibility },
    leftHip: { x: centreX - shoulderWidth / 3, y: shoulderY + 0.25, visibility },
    rightHip: { x: centreX + shoulderWidth / 3, y: shoulderY + 0.25, visibility },
  });

describe('checkPosition — no usable pose', () => {
  it('asks the player to step into view when there is no snapshot', () => {
    const result = checkPosition(null, ZONES, ASPECT);
    expect(result.ok).toBe(false);
    expect(result.problem).toBe('noPose');
    expect(result.centre).toBeNull();
  });

  it('does the same when the shoulders are not confidently seen', () => {
    expect(checkPosition(standing({ visibility: 0.2 }), ZONES, ASPECT).problem).toBe('noPose');
  });

  it('does the same when the shoulders have collapsed together', () => {
    expect(checkPosition(standing({ shoulderWidth: 0.005 }), ZONES, ASPECT).problem).toBe('noPose');
  });
});

describe('checkPosition — the targets never move', () => {
  /**
   * The property this whole module exists to preserve. Whatever it reports,
   * it is reporting ABOUT fixed targets — it cannot move them.
   */
  it('leaves the zones it was given completely untouched', () => {
    const before = JSON.stringify(ZONES);
    checkPosition(standing({ centreX: 0.2, shoulderWidth: 0.4 }), ZONES, ASPECT);
    checkPosition(standing({ centreX: 0.9, shoulderWidth: 0.05 }), ZONES, ASPECT);
    expect(JSON.stringify(ZONES)).toBe(before);
  });

  it('reports on the same fixed layout for every player', () => {
    const small = checkPosition(standing({ shoulderWidth: 0.12 }), ZONES, ASPECT);
    const large = checkPosition(standing({ shoulderWidth: 0.3 }), ZONES, ASPECT);
    // Different verdicts, identical targets.
    expect(small.reachable.length + small.unreachable.length).toBe(4);
    expect(large.reachable.length + large.unreachable.length).toBe(4);
  });
});

describe('checkPosition — too far away', () => {
  /**
   * Reach in SCREEN space depends on distance from the camera. Far away, an
   * arm span covers very little of the frame, so the fixed corners become
   * unreachable — and the fix is to step closer, not to move the targets.
   */
  it('tells a distant player to step closer', () => {
    const result = checkPosition(standing({ shoulderWidth: 0.08 }), ZONES, ASPECT);
    expect(result.ok).toBe(false);
    expect(result.problem).toBe('tooFar');
    expect(result.guidance).toMatch(/closer/i);
    expect(result.unreachable.length).toBeGreaterThan(0);
  });

  it('reports a reach ratio below one when targets are out of range', () => {
    expect(checkPosition(standing({ shoulderWidth: 0.08 }), ZONES, ASPECT).reachRatio).toBeLessThan(1);
  });

  it('names which targets cannot be reached', () => {
    const result = checkPosition(standing({ shoulderWidth: 0.08 }), ZONES, ASPECT);
    expect(result.unreachable.every((id) => ZONES.some((z) => z.id === id))).toBe(true);
  });
});

describe('checkPosition — too close', () => {
  it('tells a player filling the frame to step back', () => {
    const result = checkPosition(standing({ shoulderWidth: 0.7 }), ZONES, ASPECT);
    expect(result.problem).toBe('tooClose');
    expect(result.guidance).toMatch(/back/i);
  });

  it('flags shoulders cropped by the frame edge', () => {
    const result = checkPosition(standing({ centreX: 0.5, shoulderWidth: 0.99 }), ZONES, ASPECT);
    expect(result.problem).toBe('tooClose');
  });
});

describe('checkPosition — off centre', () => {
  it('tells a player standing to one side which way to move', () => {
    const left = checkPosition(standing({ centreX: 0.3, shoulderWidth: 0.3 }), ZONES, ASPECT);
    expect(left.problem).toBe('offCentreLeft');
    expect(left.guidance).toMatch(/right/i);

    const right = checkPosition(standing({ centreX: 0.7, shoulderWidth: 0.3 }), ZONES, ASPECT);
    expect(right.problem).toBe('offCentreRight');
    expect(right.guidance).toMatch(/left/i);
  });

  it('tolerates being slightly off centre', () => {
    expect(checkPosition(standing({ centreX: 0.53, shoulderWidth: 0.34 }), ZONES, ASPECT).problem)
      .not.toMatch(/offCentre/);
  });
});

describe('checkPosition — a good spot', () => {
  it('approves a centred player close enough to reach everything', () => {
    const result = checkPosition(standing({ centreX: 0.5, shoulderWidth: 0.34 }), ZONES, ASPECT);
    expect(result.ok).toBe(true);
    expect(result.problem).toBe('none');
    expect(result.unreachable).toEqual([]);
    expect(result.reachable).toHaveLength(4);
    expect(result.reachRatio).toBeGreaterThanOrEqual(1);
  });

  it('exposes the reach circle so it can be drawn', () => {
    const result = checkPosition(standing({ shoulderWidth: 0.34 }), ZONES, ASPECT);
    expect(result.centre).not.toBeNull();
    expect(result.reachRadius).toBeGreaterThan(0);
  });

  /** Stepping closer must monotonically improve reach, or the advice is wrong. */
  it('improves the reach ratio as the player approaches the camera', () => {
    const ratios = [0.10, 0.16, 0.22, 0.28, 0.34].map(
      (w) => checkPosition(standing({ shoulderWidth: w }), ZONES, ASPECT).reachRatio,
    );
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]).toBeGreaterThan(ratios[i - 1]);
    }
  });
});

describe('checkHandPosition — modes with no torso to measure', () => {
  const hands = (leftVis = 1, rightVis = 1) =>
    snapshot(0, {
      leftWrist: { x: 0.3, y: 0.5, visibility: leftVis },
      rightWrist: { x: 0.7, y: 0.5, visibility: rightVis },
    });

  const ids = ZONES.map((z) => z.id);

  /**
   * The bug this exists for: a hands-only backend reports no shoulders, so the
   * body check returned "no pose" forever and the player could never confirm
   * their position at all.
   */
  it('does not demand shoulders that this backend cannot supply', () => {
    const result = checkHandPosition(hands(), ZONES, new Set(ids));
    expect(result.ok).toBe(true);
    expect(result.problem).toBe('none');
  });

  it('asks for hands when it cannot see any', () => {
    const result = checkHandPosition(hands(0.1, 0.1), ZONES, new Set());
    expect(result.ok).toBe(false);
    expect(result.problem).toBe('noHands');
    expect(result.guidance).toMatch(/hands up/i);
  });

  it('counts progress as targets are touched', () => {
    const result = checkHandPosition(hands(), ZONES, new Set([ids[0], ids[1]]));
    expect(result.ok).toBe(false);
    expect(result.reachable).toHaveLength(2);
    expect(result.unreachable).toHaveLength(2);
    expect(result.guidance).toMatch(/2 of 4/);
  });

  it('only passes once every target has been demonstrated', () => {
    for (let n = 0; n < ids.length; n++) {
      const partial = checkHandPosition(hands(), ZONES, new Set(ids.slice(0, n)));
      expect(partial.ok, `${n} touched`).toBe(false);
    }
    expect(checkHandPosition(hands(), ZONES, new Set(ids)).ok).toBe(true);
  });

  /** Demonstrated reach beats any estimate — that is the whole point. */
  it('accepts a touch even from a pose the body check would reject', () => {
    const noBody = snapshot(0, {
      leftWrist: { x: 0.2, y: 0.24, visibility: 1 },
    });
    expect(checkPosition(noBody, ZONES, ASPECT).ok).toBe(false);
    expect(checkHandPosition(noBody, ZONES, new Set(ids)).ok).toBe(true);
  });

  it('never modifies the layout it was given', () => {
    const before = JSON.stringify(ZONES);
    checkHandPosition(hands(), ZONES, new Set(ids));
    expect(JSON.stringify(ZONES)).toBe(before);
  });
});
