/**
 * Turns a stream of noisy pose snapshots into clean ZONE_ENTER / ZONE_EXIT
 * events. This is the entire point of MVP 0: if these events are not
 * trustworthy, no amount of beatmap or rendering work above it can be.
 *
 * Pure logic — no DOM, no MediaPipe, no clock of its own. It is driven entirely
 * by the timestamps on the snapshots it is fed, which is what lets tests replay
 * synthetic movement deterministically without a webcam. Spec §18.
 *
 * Three things corrupt a naive `isInside(wrist, zone)` check:
 *
 *   1. POSITIONAL JITTER. The model's idea of where a wrist is wobbles by a few
 *      pixels every frame. Rest a hand exactly on a zone edge and a plain
 *      radius test fires enter/exit dozens of times a second.
 *      -> Fixed by HYSTERESIS: leaving takes a larger radius than entering.
 *
 *   2. TRACKING DROPOUT. The model briefly loses a limb — motion blur, a hand
 *      crossing the torso — and reports it with near-zero visibility for a
 *      frame or two before recovering. Hysteresis cannot help; the position is
 *      simply gone.
 *      -> Fixed by an EXIT GRACE PERIOD: an exit condition must hold for a
 *         sustained interval before we believe it. Expressed in milliseconds,
 *         not frames, so it behaves the same at 15 Hz and 60 Hz.
 *
 *   3. HALLUCINATION. MediaPipe extrapolates limbs it cannot see, including
 *      well outside the camera frame.
 *      -> Fixed by gating on visibility and, optionally, on being in frame.
 */
import type { FieldPoint, InputLimb, PoseSnapshot } from '../pose/poseTypes.ts';
import { INPUT_LIMBS } from '../pose/poseTypes.ts';
import { isInFrame } from '../pose/transforms.ts';
import type { Zone, ZoneId } from './zones.ts';
import { distanceToZone, sweptDistanceToZone } from './zones.ts';

export interface ZoneTrackerConfig {
  /** Reject landmarks the model is not confident about. 0–1. */
  minVisibility: number;
  /** Exit radius as a multiple of enter radius. Must be >= 1. */
  exitRadiusScale: number;
  /**
   * How far back the hand must pull before it can hit the same target again,
   * as a multiple of the target radius.
   *
   * This is the difference between "tap twice" and "leave and come back".
   * Below 1.0 the hand re-arms while still INSIDE the target, so a repeated
   * strike works the way a drum does — pull back a little, hit again — rather
   * than requiring the arm to travel clear of the zone between every note.
   *
   * Reported as: "even when I hit, it doesn't capture, or maybe cus I don't
   * fully leave." Exactly that: re-entry was gated on a full geometric exit.
   */
  reArmRadiusScale: number;
  /** How long an exit condition must persist before ZONE_EXIT is emitted. */
  exitGraceMs: number;
  /** Minimum gap between leaving a zone and being able to re-enter it. */
  refractoryMs: number;
  /** Ignore landmarks MediaPipe has extrapolated outside the camera frame. */
  requireInFrame: boolean;
  /**
   * Test the path between pose samples, not just the samples themselves.
   * Without this a fast hand tunnels straight through a zone between frames.
   */
  sweptCollision: boolean;
  /**
   * Ignore a previous sample older than this when sweeping. A stale sample
   * would describe a path the hand did not take in one motion.
   *
   * Generous enough to span a few frames the model was unsure about, because
   * those frames are precisely the ones a fast hand produces.
   */
  maxSweepGapMs: number;
}

export const DEFAULT_TRACKER_CONFIG: ZoneTrackerConfig = {
  minVisibility: 0.5,
  exitRadiusScale: 1.3,
  // Well inside the target, and still far enough that landmark jitter — a few
  // pixels — cannot re-arm on its own.
  reArmRadiusScale: 0.7,
  exitGraceMs: 80,
  // Zero by default: hysteresis and grace already suppress chatter, and a
  // rhythm game must allow genuinely fast repeat hits — two sixteenth notes at
  // 180 BPM are only 83 ms apart. Exposed so it can be raised if real play
  // proves otherwise.
  refractoryMs: 0,
  requireInFrame: true,
  sweptCollision: true,
  maxSweepGapMs: 250,
};

/**
 * Why an entry that geometrically happened was not accepted.
 *
 *   refractory  the re-entry lockout had not elapsed
 *   visibility  the model did not trust the landmark, or it was off-frame
 */
export type BlockReason = 'refractory' | 'visibility';

export interface ZoneEvent {
  /**
   * ZONE_BLOCKED is DIAGNOSTIC ONLY. It records a hit the player almost
   * certainly meant to make and the tracker refused — the single most useful
   * thing to see when tuning, and the reason a swallowed rapid hit is
   * observable rather than merely suspected. Gameplay must consume only
   * ZONE_ENTER and ZONE_EXIT.
   */
  type: 'ZONE_ENTER' | 'ZONE_EXIT' | 'ZONE_BLOCKED';
  zoneId: ZoneId;
  limb: InputLimb;
  /** Camera-frame time of the snapshot that triggered this. Not wall clock. */
  timestampMs: number;
  /** Distance to zone centre at the moment of the event, in field-X units. */
  distance: number;
  /** How long the limb was inside. ZONE_EXIT only. */
  dwellMs?: number;
  /** ZONE_BLOCKED only. */
  reason?: BlockReason;
  /** ZONE_BLOCKED, reason 'refractory': how much longer the lockout had left. */
  remainingMs?: number;
  /**
   * True when the entry was found by sweeping the path between samples rather
   * than by a sample landing inside. Its timestamp is interpolated.
   */
  swept?: boolean;
}

interface PairState {
  inside: boolean;
  /**
   * Whether a new strike may fire. Cleared by a hit, restored once the hand
   * pulls back past the re-arm radius — which is a shorter journey than
   * leaving the zone.
   */
  armed: boolean;
  enteredAtMs: number;
  /** When the exit condition first became true, or null if it currently isn't. */
  exitCandidateSinceMs: number | null;
  lastExitMs: number;
  /**
   * True while a single continuous approach is already known to be blocked.
   *
   * Without this, a wrist held inside a locked-out zone would report a new
   * blocked event on every pose frame — thirty per second of the same fact.
   * Counting only the rising edge makes "3 hits were swallowed" mean what it
   * says.
   */
  blockedApproach: boolean;
}

const pairKey = (zoneId: ZoneId, limb: InputLimb) => `${zoneId}:${limb}`;

/** Running totals of refused entries, for the debug HUD. */
export interface BlockedCounts {
  refractory: number;
  visibility: number;
}

interface LimbSample {
  x: number;
  y: number;
  timestampMs: number;
}

export class ZoneTracker {
  private state = new Map<string, PairState>();
  /** Last trusted position of each limb, for swept collision. */
  private previous = new Map<InputLimb, LimbSample>();
  private config: ZoneTrackerConfig;
  private blocked: BlockedCounts = { refractory: 0, visibility: 0 };

  constructor(config: ZoneTrackerConfig = DEFAULT_TRACKER_CONFIG) {
    this.config = config;
  }

  setConfig(config: ZoneTrackerConfig): void {
    this.config = config;
  }

  /** Forget all tracking state — e.g. after the camera restarts. */
  reset(): void {
    this.state.clear();
    this.previous.clear();
    this.blocked = { refractory: 0, visibility: 0 };
  }

  /** How many intended hits have been refused, and why. */
  blockedCounts(): BlockedCounts {
    return { ...this.blocked };
  }

  /** Which (zone, limb) pairs are currently held. For debug rendering. */
  activePairs(): ReadonlySet<string> {
    const active = new Set<string>();
    for (const [key, s] of this.state) if (s.inside) active.add(key);
    return active;
  }

  /**
   * Advance the state machine by one pose snapshot.
   * Returns every event that occurred, in a stable order.
   */
  update(snapshot: PoseSnapshot, zones: readonly Zone[], aspect: number): ZoneEvent[] {
    const events: ZoneEvent[] = [];
    const now = snapshot.timestampMs;

    for (const zone of zones) {
      for (const limb of INPUT_LIMBS) {
        const point = snapshot.landmarks[limb];
        const key = pairKey(zone.id, limb);
        const state = this.state.get(key) ?? {
          inside: false,
          armed: true,
          enteredAtMs: 0,
          exitCandidateSinceMs: null,
          lastExitMs: Number.NEGATIVE_INFINITY,
          blockedApproach: false,
        };

        const distance = distanceToZone(point, zone, aspect);
        const trusted = this.isTrusted(point);

        // Sweep the path from the previous sample. `enterDistance` is the
        // closest the hand came, which is what decides a hit; `distance` stays
        // the CURRENT distance and is what decides whether it has left.
        let enterDistance = distance;
        let enterTimeMs = now;
        let swept = false;
        const last = this.previous.get(limb);
        if (
          this.config.sweptCollision &&
          trusted &&
          last &&
          now - last.timestampMs <= this.config.maxSweepGapMs
        ) {
          const hit = sweptDistanceToZone(last, point, zone, aspect);
          if (hit.distance < enterDistance) {
            enterDistance = hit.distance;
            // Interpolate the crossing time. The hand reached the zone partway
            // between two frames, and saying so is worth up to ~35 ms of
            // timing accuracy the judge would otherwise lose.
            enterTimeMs = last.timestampMs + hit.t * (now - last.timestampMs);
            swept = true;
          }
        }

        if (!state.inside) {
          // Two different questions, deliberately answered by two different
          // measurements:
          //
          //   sweptInside — did the hand's PATH cross the zone? This decides a
          //     hit, and is what stops a fast arm tunnelling straight through.
          //
          //   pointInside — is the hand AT the zone right now? This tracks
          //     whether one continuous approach is still under way. Using the
          //     swept answer here would keep an approach "live" while the hand
          //     withdrew through the zone it had just left, and two separate
          //     attempts would be counted as one.
          const sweptInside = enterDistance <= zone.radius;
          const pointInside = distance <= zone.radius;
          const pastRefractory = now - state.lastExitMs >= this.config.refractoryMs;

          if (!pointInside) {
            // The approach is over; the next one starts fresh.
            state.blockedApproach = false;
          }

          if (sweptInside && trusted && pastRefractory) {
            state.inside = true;
            state.armed = false;
            state.enteredAtMs = enterTimeMs;
            state.exitCandidateSinceMs = null;
            state.blockedApproach = false;
            events.push({
              type: 'ZONE_ENTER',
              zoneId: zone.id,
              limb,
              timestampMs: enterTimeMs,
              distance: enterDistance,
              ...(swept ? { swept: true } : {}),
            });
          } else if (pointInside && !state.blockedApproach) {
            // At the zone, and refused. Reported once per approach — and only
            // for a hand that is actually there, so a swept-through refusal is
            // under-reported rather than double-counted.
            state.blockedApproach = true;
            const reason: BlockReason = pastRefractory ? 'visibility' : 'refractory';
            this.blocked[reason] += 1;
            events.push({
              type: 'ZONE_BLOCKED',
              zoneId: zone.id,
              limb,
              timestampMs: now,
              distance,
              reason,
              ...(reason === 'refractory'
                ? { remainingMs: this.config.refractoryMs - (now - state.lastExitMs) }
                : {}),
            });
          }
        } else {
          // Re-arm well before the hand has left. A repeated strike should feel
          // like hitting a drum twice, not like leaving the room and returning.
          if (distance > zone.radius * this.config.reArmRadiusScale) state.armed = true;

          // Already inside and re-armed: a fresh inward strike counts, without
          // ever requiring a geometric exit first.
          const strikeAgain =
            state.armed && trusted && distance <= zone.radius * this.config.reArmRadiusScale;
          if (strikeAgain && now - state.lastExitMs >= this.config.refractoryMs) {
            state.armed = false;
            state.enteredAtMs = enterTimeMs;
            events.push({
              type: 'ZONE_ENTER',
              zoneId: zone.id,
              limb,
              timestampMs: enterTimeMs,
              distance: enterDistance,
              ...(swept ? { swept: true } : {}),
            });
          }

          const beyondExitRadius = distance > zone.radius * this.config.exitRadiusScale;
          const shouldExit = beyondExitRadius || !trusted;

          if (!shouldExit) {
            // Back inside before the grace period elapsed — the dropout or
            // wobble never became a real exit.
            state.exitCandidateSinceMs = null;
          } else {
            state.exitCandidateSinceMs ??= now;
            if (now - state.exitCandidateSinceMs >= this.config.exitGraceMs) {
              state.inside = false;
              state.armed = true;
              state.lastExitMs = now;
              state.blockedApproach = false;
              events.push({
                type: 'ZONE_EXIT',
                zoneId: zone.id,
                limb,
                timestampMs: now,
                distance,
                dwellMs: now - state.enteredAtMs,
              });
              state.exitCandidateSinceMs = null;
            }
          }
        }

        this.state.set(key, state);
      }
    }

    // Remember trusted positions only — sweeping from a position the model was
    // unsure of would invent a path the hand never took.
    //
    // But do NOT forget the last trusted one when a frame is untrusted. Motion
    // blur is what makes a landmark uncertain, and a hand moving fast enough to
    // blur is exactly the hand that needs sweeping. Discarding the anchor on a
    // blurry frame disabled the mechanism precisely when it mattered, and left
    // the NEXT frame with nothing to sweep from either.
    //
    // A hand confidently seen at A and confidently seen at C did travel A to C,
    // whatever the model made of the blur in between. The staleness limit is
    // what stops that reasoning being stretched too far.
    for (const limb of INPUT_LIMBS) {
      const point = snapshot.landmarks[limb];
      if (this.isTrusted(point)) {
        this.previous.set(limb, { x: point.x, y: point.y, timestampMs: now });
      }
    }

    return events;
  }

  private isTrusted(p: FieldPoint): boolean {
    if (p.visibility < this.config.minVisibility) return false;
    if (this.config.requireInFrame && !isInFrame(p)) return false;
    return true;
  }
}
