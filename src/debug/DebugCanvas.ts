/**
 * MVP 0's renderer: plain Canvas 2D, drawn straight from field-space
 * coordinates. Spec §12 asks for diagnostic visuals before aesthetic ones, and
 * §15 does not introduce PixiJS until MVP 1 — a GPU scene graph would only make
 * it harder to see what the pose pipeline is actually doing.
 *
 * Everything here reads state and draws. It owns no state of its own, so the
 * game loop stays the single source of truth.
 */
import type { PoseSnapshot } from '../pose/poseTypes.ts';
import { INPUT_LIMBS, LANDMARK_NAMES, POSE_BONES } from '../pose/poseTypes.ts';
import type { Zone } from '../game/zones.ts';

export interface HitFlash {
  zoneId: string;
  /** performance.now() at the moment of entry. */
  startedAt: number;
}

export interface SceneState {
  width: number;
  height: number;
  aspect: number;
  zones: readonly Zone[];
  snapshot: PoseSnapshot | null;
  detected: boolean;
  /** Keys of the form "zoneId:limb" currently held. */
  activePairs: ReadonlySet<string>;
  flashes: readonly HitFlash[];
  exitRadiusScale: number;
  minVisibility: number;
  showSkeleton: boolean;
  nowMs: number;
}

const FLASH_MS = 420;

/** Resize the backing store for the display's pixel density. */
export function resizeCanvas(canvas: HTMLCanvasElement): { width: number; height: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const backingWidth = Math.round(width * dpr);
  const backingHeight = Math.round(height * dpr);
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  return { width, height };
}

export function drawScene(ctx: CanvasRenderingContext2D, state: SceneState): void {
  const dpr = ctx.canvas.width / state.width || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, state.width, state.height);

  drawZones(ctx, state);
  if (state.snapshot && state.detected && state.showSkeleton) drawSkeleton(ctx, state);
  if (state.snapshot && state.detected) drawWrists(ctx, state);
  drawFlashes(ctx, state);
  if (!state.detected) drawNoPersonNotice(ctx, state);
}

function drawZones(ctx: CanvasRenderingContext2D, state: SceneState): void {
  const { width, height, aspect } = state;

  for (const zone of state.zones) {
    const cx = zone.cx * width;
    const cy = zone.cy * height;
    // The zone is a circle in PIXELS. Its radius is expressed in field-space X
    // units, so converting through the width is what makes it round.
    const r = zone.radius * width;
    const held = INPUT_LIMBS.some((limb) => state.activePairs.has(`${zone.id}:${limb}`));

    // The hysteresis band, drawn as a shaded ring between the enter radius and
    // the exit radius. This is the buffer a wrist must cross to count as having
    // LEFT. Shading it rather than labelling it means the setting explains
    // itself: at 1.00x the band visibly disappears, which is exactly the
    // configuration in which a hand resting on the edge flickers.
    const exitR = r * state.exitRadiusScale;
    if (exitR > r + 0.5) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, exitR, 0, Math.PI * 2);
      ctx.arc(cx, cy, r, 0, Math.PI * 2, true); // reverse winding cuts the hole
      ctx.fillStyle = held ? `${zone.colour}22` : 'rgba(255,255,255,0.05)';
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, exitR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = held ? `${zone.colour}44` : 'rgba(255,255,255,0.05)';
    ctx.fill();
    ctx.lineWidth = held ? 5 : 2;
    ctx.strokeStyle = held ? zone.colour : `${zone.colour}88`;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = zone.colour;
    ctx.fill();

    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = held ? zone.colour : 'rgba(255,255,255,0.55)';
    ctx.textAlign = 'center';
    ctx.fillText(zone.label, cx, cy + exitR + 18);

    if (zone.id === state.zones[0]?.id) {
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText('cross to enter', cx, cy - r + 12);

      // Whether a gap EXISTS is a property of the setting, not of how many
      // pixels it happens to occupy — a small zone must not be mislabelled as
      // having no hysteresis just because its band is thin on screen.
      if (state.exitRadiusScale > 1.02) {
        // Only draw the second label when there is room for it to be legible.
        if (exitR - r > 11) ctx.fillText('cross to leave', cx, cy - exitR + 11);
      } else {
        ctx.fillStyle = 'rgba(248,113,113,0.9)';
        ctx.fillText('no gap — will chatter', cx, cy - exitR - 6);
      }
    }

    if (held) {
      const limbs = INPUT_LIMBS.filter((l) => state.activePairs.has(`${zone.id}:${l}`))
        .map((l) => (l === 'leftWrist' ? 'L' : 'R'))
        .join(' + ');
      ctx.fillStyle = zone.colour;
      ctx.fillText(limbs, cx, cy + r + 32);
    }

    // Live distance readout for whichever wrist is nearest — the number that
    // makes "why did that not register?" answerable.
    if (state.snapshot && state.detected) {
      const nearest = nearestWristDistance(state, zone, aspect);
      if (nearest !== null) {
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.fillText(nearest.toFixed(3), cx, cy - r - 8);
      }
    }
  }
}

function nearestWristDistance(state: SceneState, zone: Zone, aspect: number): number | null {
  if (!state.snapshot) return null;
  let best = Infinity;
  for (const limb of INPUT_LIMBS) {
    const p = state.snapshot.landmarks[limb];
    if (p.visibility < state.minVisibility) continue;
    const dx = p.x - zone.cx;
    const dy = (p.y - zone.cy) / aspect;
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return Number.isFinite(best) ? best : null;
}

function drawSkeleton(ctx: CanvasRenderingContext2D, state: SceneState): void {
  const { snapshot, width, height } = state;
  if (!snapshot) return;

  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const [a, b] of POSE_BONES) {
    const pa = snapshot.landmarks[a];
    const pb = snapshot.landmarks[b];
    const confidence = Math.min(pa.visibility, pb.visibility);
    if (confidence < 0.3) continue;
    ctx.strokeStyle = `rgba(255,255,255,${0.15 + confidence * 0.6})`;
    ctx.beginPath();
    ctx.moveTo(pa.x * width, pa.y * height);
    ctx.lineTo(pb.x * width, pb.y * height);
    ctx.stroke();
  }

  // Raw landmarks, tinted by confidence: green where the model is sure, red
  // where it is guessing. Spec §15 asks MVP 0 to draw them, and seeing the
  // model lose a limb is far more instructive than reading about it.
  for (const name of LANDMARK_NAMES) {
    const p = snapshot.landmarks[name];
    if (p.visibility < 0.2) continue;
    const hue = p.visibility * 120; // 0 red -> 120 green
    ctx.beginPath();
    ctx.arc(p.x * width, p.y * height, 3, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${hue}, 85%, 60%, ${0.3 + p.visibility * 0.6})`;
    ctx.fill();
  }
}

function drawWrists(ctx: CanvasRenderingContext2D, state: SceneState): void {
  const { snapshot, width, height } = state;
  if (!snapshot) return;

  for (const limb of INPUT_LIMBS) {
    const p = snapshot.landmarks[limb];
    const trusted = p.visibility >= state.minVisibility;
    const x = p.x * width;
    const y = p.y * height;

    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = trusted ? '#ffffff' : 'rgba(255,90,90,0.85)';
    ctx.stroke();
    ctx.fillStyle = trusted ? 'rgba(255,255,255,0.28)' : 'rgba(255,90,90,0.18)';
    ctx.fill();

    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = trusted ? '#ffffff' : 'rgba(255,120,120,0.9)';
    ctx.textAlign = 'center';
    ctx.fillText(limb === 'leftWrist' ? 'L' : 'R', x, y - 19);
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText(p.visibility.toFixed(2), x, y + 26);
  }
}

/** An expanding ring at the exact moment ZONE_ENTER fired. */
function drawFlashes(ctx: CanvasRenderingContext2D, state: SceneState): void {
  for (const flash of state.flashes) {
    const zone = state.zones.find((z) => z.id === flash.zoneId);
    if (!zone) continue;
    const age = (state.nowMs - flash.startedAt) / FLASH_MS;
    if (age < 0 || age > 1) continue;

    const eased = 1 - (1 - age) ** 3;
    const r = zone.radius * state.width * (1 + eased * 1.5);
    ctx.beginPath();
    ctx.arc(zone.cx * state.width, zone.cy * state.height, r, 0, Math.PI * 2);
    ctx.lineWidth = 4 * (1 - age);
    ctx.strokeStyle = zone.colour;
    ctx.globalAlpha = 1 - age;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

export function isFlashAlive(flash: HitFlash, nowMs: number): boolean {
  return nowMs - flash.startedAt < FLASH_MS;
}

function drawNoPersonNotice(ctx: CanvasRenderingContext2D, state: SceneState): void {
  ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.textAlign = 'center';
  ctx.fillText('no person detected — step back until head and hips are in frame',
    state.width / 2, state.height - 24);
}
