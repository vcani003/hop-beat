/**
 * The PixiJS game renderer. Spec §3, §12.
 *
 * Its whole job is to make timing READABLE. A note that simply appears at the
 * instant it should be hit is unplayable — the player needs to see it coming
 * and feel when it arrives. So each note is drawn as an approach ring that
 * shrinks onto its target, reaching the target's own radius exactly at the
 * note's time. Hitting "when the rings meet" is a visual instruction anyone
 * can follow without being taught.
 *
 * The player figure is generated from pose landmarks — lines, circles and
 * trails — rather than a rigged avatar. Spec §12: procedural, lightweight, and
 * cheap enough that gameplay never pays for it.
 *
 * Everything is drawn from state handed in each frame. The renderer owns no
 * game state, so it can be destroyed and rebuilt without disturbing a song in
 * progress.
 */
import { Application, Container, Graphics, Text } from 'pixi.js';
import type { ActiveNote, Judgment } from '../../game/engine/NoteJudge.ts';
import type { PoseSnapshot } from '../../pose/poseTypes.ts';
import { INPUT_LIMBS, POSE_BONES } from '../../pose/poseTypes.ts';
import type { Zone } from '../../game/zones.ts';

const ZONE_COLOUR: Record<string, number> = {
  upperLeft: 0x8b5cf6,
  upperRight: 0x38bdf8,
  lowerLeft: 0xf5c451,
  lowerRight: 0xf472b6,
};

const JUDGMENT_COLOUR: Record<Judgment, number> = {
  PERFECT: 0x4ade80,
  GOOD: 0xf5c451,
  MISS: 0xf87171,
};

/** How far ahead of its time a note becomes visible. */
export const APPROACH_LEAD_MS = 1400;

interface Popup {
  text: Text;
  bornAt: number;
}

interface Ripple {
  graphic: Graphics;
  bornAt: number;
  colour: number;
}

export interface RenderState {
  zones: readonly Zone[];
  /**
   * True while the zones shown are a PROVISIONAL fit that is still following
   * the player. Drawn differently on purpose: targets that move are a
   * contradiction of how this game works (spec §3 anchors them to the screen),
   * so the one moment they do move must not look like normal play.
   */
  zonesArePreview?: boolean;
  notes: readonly ActiveNote[];
  playbackTimeMs: number;
  snapshot: PoseSnapshot | null;
  poseVisible: boolean;
  nowMs: number;
  showSkeleton: boolean;
}

const RIPPLE_MS = 500;
const POPUP_MS = 700;
const TRAIL_LENGTH = 12;

export class GameRenderer {
  private app: Application | null = null;
  private zoneLayer = new Container();
  private noteLayer = new Container();
  private playerLayer = new Container();
  private effectLayer = new Container();

  private zoneGraphics = new Graphics();
  private noteGraphics = new Graphics();
  private playerGraphics = new Graphics();

  private ripples: Ripple[] = [];
  private popups: Popup[] = [];
  /** Recent wrist positions in field space, for motion trails. */
  private trails: Record<string, Array<{ x: number; y: number }>> = {
    leftWrist: [],
    rightWrist: [],
  };

  private width = 0;
  private height = 0;

  /**
   * Build the renderer inside a container element.
   *
   * PixiJS creates its OWN canvas here rather than being handed one, and that
   * is load-bearing. React StrictMode mounts every effect twice: the first
   * Application begins initialising, is cancelled, and destroys itself — and
   * if both were pointed at the same <canvas>, that teardown takes the WebGL
   * context out from under the second one. The symptom is a game that runs
   * perfectly while drawing nothing at all.
   *
   * Giving each Application its own canvas makes the two instances genuinely
   * independent, so cleaning up the first cannot touch the second.
   */
  async init(container: HTMLElement): Promise<void> {
    const app = new Application();
    await app.init({
      resizeTo: container,
      backgroundAlpha: 0, // the webcam or the page shows through
      antialias: true,
      // Capping DPR keeps a 5K display from quietly tripling fill cost. Spec
      // §14: gameplay comes before decoration.
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });

    app.canvas.className = 'play__canvas';
    container.appendChild(app.canvas);

    app.stage.addChild(this.zoneLayer, this.noteLayer, this.playerLayer, this.effectLayer);
    this.zoneLayer.addChild(this.zoneGraphics);
    this.noteLayer.addChild(this.noteGraphics);
    this.playerLayer.addChild(this.playerGraphics);

    this.app = app;
    this.resize();
  }

  resize(): void {
    if (!this.app) return;
    // `renderer.screen` is the view rectangle in CSS pixels — the same space
    // the layout and the pose landmarks live in. `renderer.width` is NOT a
    // physical-pixel figure to be divided by resolution, and treating it as one
    // drew the whole scene at half scale in the top-left corner.
    this.width = this.app.renderer.screen.width;
    this.height = this.app.renderer.screen.height;
  }

  /** Radius in pixels for a zone whose radius is in field-space X units. */
  private radiusPx(zone: Zone): number {
    return zone.radius * this.width;
  }

  render(state: RenderState): void {
    if (!this.app) return;
    this.resize();
    this.drawZones(state);
    this.drawNotes(state);
    this.drawPlayer(state);
    this.updateEffects(state.nowMs);
  }

  private drawZones(state: RenderState): void {
    const g = this.zoneGraphics;
    g.clear();

    for (const zone of state.zones) {
      const cx = zone.cx * this.width;
      const cy = zone.cy * this.height;
      const r = this.radiusPx(zone);
      const colour = ZONE_COLOUR[zone.id] ?? 0xffffff;

      if (state.zonesArePreview) {
        // Hollow, faint, and ringed by a wider halo — legible as "this is
        // where they WOULD go", not as a target to hit.
        g.circle(cx, cy, r).stroke({ width: 2, color: colour, alpha: 0.5 });
        g.circle(cx, cy, r * 1.25).stroke({ width: 1, color: colour, alpha: 0.18 });
        g.circle(cx, cy, 2).fill({ color: colour, alpha: 0.5 });
        continue;
      }

      g.circle(cx, cy, r).fill({ color: colour, alpha: 0.07 });
      g.circle(cx, cy, r).stroke({ width: 2, color: colour, alpha: 0.55 });
      g.circle(cx, cy, 3).fill({ color: colour, alpha: 0.8 });
    }
  }

  private drawNotes(state: RenderState): void {
    const g = this.noteGraphics;
    g.clear();

    for (const active of state.notes) {
      if (active.judgment !== null) continue;

      const remaining = active.timeMs - state.playbackTimeMs;
      if (remaining > APPROACH_LEAD_MS || remaining < -200) continue;

      const zone = state.zones.find((z) => z.id === active.note.zone);
      if (!zone) continue;

      const cx = zone.cx * this.width;
      const cy = zone.cy * this.height;
      const targetR = this.radiusPx(zone);
      const colour = ZONE_COLOUR[zone.id] ?? 0xffffff;

      // progress runs 0 -> 1 as the note arrives. The ring starts three times
      // the target radius and lands exactly on it at progress 1, so "rings
      // meet" is the timing cue.
      const progress = 1 - Math.max(0, remaining) / APPROACH_LEAD_MS;
      const approachR = targetR * (1 + 2 * (1 - progress));
      const alpha = Math.min(1, progress * 2.2);

      g.circle(cx, cy, approachR).stroke({ width: 3, color: colour, alpha: alpha * 0.9 });

      // A filled core swells as the note lands, so peripheral vision can catch
      // it while the player is looking elsewhere.
      if (progress > 0.75) {
        const heat = (progress - 0.75) / 0.25;
        g.circle(cx, cy, targetR * 0.9).fill({ color: colour, alpha: heat * 0.35 });
      }

      // Handed notes say so, because the chart is about to insist.
      if (active.note.limb !== 'eitherHand' && progress > 0.4) {
        const label = active.note.limb === 'leftHand' ? -1 : 1;
        g.circle(cx + label * targetR * 0.55, cy - targetR * 0.55, 5)
          .fill({ color: 0xffffff, alpha: alpha * 0.85 });
      }
    }
  }

  private drawPlayer(state: RenderState): void {
    const g = this.playerGraphics;
    g.clear();
    if (!state.snapshot || !state.poseVisible) {
      for (const limb of INPUT_LIMBS) this.trails[limb].length = 0;
      return;
    }

    const { landmarks } = state.snapshot;
    const px = (v: number) => v * this.width;
    const py = (v: number) => v * this.height;

    if (state.showSkeleton) {
      for (const [a, b] of POSE_BONES) {
        const pa = landmarks[a];
        const pb = landmarks[b];
        const confidence = Math.min(pa.visibility, pb.visibility);
        if (confidence < 0.35) continue;
        g.moveTo(px(pa.x), py(pa.y))
          .lineTo(px(pb.x), py(pb.y))
          .stroke({ width: 3, color: 0xffffff, alpha: 0.2 + confidence * 0.5 });
      }
    }

    for (const limb of INPUT_LIMBS) {
      const p = landmarks[limb];
      const trail = this.trails[limb];

      if (p.visibility >= 0.4) {
        trail.push({ x: p.x, y: p.y });
        if (trail.length > TRAIL_LENGTH) trail.shift();
      } else {
        trail.length = 0;
        continue;
      }

      // Trail: older samples thinner and fainter, which reads as speed.
      for (let i = 1; i < trail.length; i++) {
        const t = i / trail.length;
        g.moveTo(px(trail[i - 1].x), py(trail[i - 1].y))
          .lineTo(px(trail[i].x), py(trail[i].y))
          .stroke({ width: 1 + t * 5, color: 0xffffff, alpha: t * 0.5 });
      }

      g.circle(px(p.x), py(p.y), 11).fill({ color: 0xffffff, alpha: 0.22 });
      g.circle(px(p.x), py(p.y), 11).stroke({ width: 2.5, color: 0xffffff, alpha: 0.9 });
    }
  }

  /** Fire the feedback for one judgment. Called from the engine's output. */
  showJudgment(judgment: Judgment, zone: Zone | undefined, nowMs: number): void {
    if (!this.app || !zone) return;

    const cx = zone.cx * this.width;
    const cy = zone.cy * this.height;
    const colour = JUDGMENT_COLOUR[judgment];

    if (judgment !== 'MISS') {
      const graphic = new Graphics();
      this.effectLayer.addChild(graphic);
      this.ripples.push({ graphic, bornAt: nowMs, colour });
    }

    const text = new Text({
      text: judgment,
      style: {
        fill: colour,
        fontSize: judgment === 'PERFECT' ? 26 : 22,
        fontFamily: 'ui-monospace, Menlo, monospace',
        fontWeight: '700',
        letterSpacing: 1.5,
      },
    });
    text.anchor.set(0.5);
    text.position.set(cx, cy - this.radiusPx(zone) - 22);
    this.effectLayer.addChild(text);
    this.popups.push({ text, bornAt: nowMs });

    // Ripples need to know where they started; store it on the graphic.
    const latest = this.ripples[this.ripples.length - 1];
    if (latest && latest.bornAt === nowMs) {
      latest.graphic.position.set(cx, cy);
      (latest.graphic as Graphics & { baseRadius?: number }).baseRadius = this.radiusPx(zone);
    }
  }

  private updateEffects(nowMs: number): void {
    this.ripples = this.ripples.filter((ripple) => {
      const age = (nowMs - ripple.bornAt) / RIPPLE_MS;
      if (age >= 1) {
        ripple.graphic.destroy();
        return false;
      }
      const base = (ripple.graphic as Graphics & { baseRadius?: number }).baseRadius ?? 40;
      const eased = 1 - (1 - age) ** 3;
      ripple.graphic.clear();
      ripple.graphic
        .circle(0, 0, base * (1 + eased * 1.6))
        .stroke({ width: 4 * (1 - age), color: ripple.colour, alpha: 1 - age });
      return true;
    });

    this.popups = this.popups.filter((popup) => {
      const age = (nowMs - popup.bornAt) / POPUP_MS;
      if (age >= 1) {
        popup.text.destroy();
        return false;
      }
      popup.text.alpha = 1 - age ** 2;
      popup.text.y -= 0.6;
      return true;
    });
  }

  clearEffects(): void {
    for (const ripple of this.ripples) ripple.graphic.destroy();
    for (const popup of this.popups) popup.text.destroy();
    this.ripples = [];
    this.popups = [];
    for (const limb of INPUT_LIMBS) this.trails[limb].length = 0;
  }

  destroy(): void {
    this.clearEffects();
    // `true` removes the canvas this Application created, so a cancelled
    // StrictMode instance leaves nothing behind for the live one to trip over.
    this.app?.destroy(true, { children: true });
    this.app = null;
  }

  /** True once a WebGL context exists and drawing will actually appear. */
  isReady(): boolean {
    return this.app !== null;
  }
}
