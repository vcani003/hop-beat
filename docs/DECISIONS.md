# Decision log

Changes and additions to the decisions recorded in [`SPEC.md`](SPEC.md).
Spec §21 asks for this to be kept short.

---

## MVP 0

### 1. Canvas 2D for MVP 0, PixiJS deferred to MVP 1

**Spec §3** names PixiJS as the initial renderer. MVP 0 (§15) asks only to draw
raw landmarks, zones and hit feedback, and §12 asks for diagnostic visuals
before aesthetic ones.

A GPU scene graph adds a layer between the pose data and what is on screen at
exactly the moment we most need to see the pose data unfiltered. Canvas 2D draws
straight from field-space coordinates with nothing in between. PixiJS enters at
MVP 1 as planned, when there are targets and effects to justify it.

Nothing in `render/` was written, so this defers work rather than discarding it.

### 2. Pose assets vendored locally, not loaded from a CDN

The MediaPipe WebAssembly runtime and `.task` models are copied into `public/`
by `scripts/fetch-assets.mjs`, run automatically on `npm install`.

A rhythm game that stalls mid-song on a network hiccup is a broken rhythm game,
and CDN latency would sit in the startup path of every session. Both
directories are gitignored: ~50 MB of derived assets, reproducible from the
script.

### 3. Zones are circular in PIXELS, not in normalised units

Field space is 0–1 on both axes, but screens are not square. A naive
`hypot(dx, dy)` over normalised coordinates describes an ellipse on a 16:9
display — a zone measurably easier to hit vertically than horizontally, for a
reason no player could ever infer.

`distanceToZone` therefore scales the vertical offset by `1 / aspect`. Zone
radius is expressed in field-space **X** units.

### 4. Zone entry needs three guards, not a radius test

Spec §20 asks whether notes should require entry, dwell, velocity or
directional crossing. That question is downstream of a more basic one: a plain
`isInside(wrist, zone)` check does not produce usable events at all.

`ZoneTracker` adds three mechanisms, each answering a distinct failure:

| Failure | Mechanism | Default |
|---|---|---|
| Positional jitter at the boundary | Hysteresis — exit radius > enter radius | `1.3×` |
| Momentary tracking dropout | Exit grace period, in ms not frames | `80 ms` |
| Landmarks extrapolated off-frame | Visibility gate + in-frame check | `0.5` |

All are tunable at runtime, because §20's sizing questions are answered by
standing in front of a camera, not by picking numbers now.

A refractory period exists but defaults to **0 ms**: two sixteenth notes at
180 BPM are 83 ms apart, and a rhythm game must not swallow fast repeat hits.

### 5. `presentationTime`, not `captureTime`, is the frame clock on macOS

`requestVideoFrameCallback` is used instead of `requestAnimationFrame` so
inference runs once per *camera* frame rather than once per display refresh.

Measured on this machine: **`captureTime` is not exposed.** Frame timestamps
therefore come from `presentationTime`, which includes browser compositor delay
on top of capture and inference.

Rather than hide this, `PoseFrame` carries a `timestampSuspect` flag and the
HUD reports which clock is in use. A timing measurement that might be wrong is
worse than no measurement, because §7's judgment windows will be calibrated
against it.

### 6. Two clocks in the React layer

Spec §14 forbids React state updates on every animation frame. The pose
callback and render loop read and write refs only; a 5 Hz interval copies a
summary into React state for the HUD.

Feedback the player *feels* — the ring that fires on zone entry — is drawn on
the canvas, never rendered by React, so it is never behind the interaction.

### 7. Refused hits are reported, not merely refused

First real-webcam session surfaced a complaint the tracker could not answer:
"rapid firing isn't capturing all the time." Nothing in the event stream said
whether a hit had been missed by the model, missed by the geometry, or refused
by the tracker's own settings — the three have completely different fixes.

`ZoneTracker` now emits a third, **diagnostic-only** event: `ZONE_BLOCKED`,
carrying the reason (`refractory` or `visibility`). It fires once per approach,
not once per frame, so "3 hits were swallowed" means what it says. Gameplay
consumes only `ZONE_ENTER` / `ZONE_EXIT`.

### 8. Sessions are recorded and exportable

`SessionRecorder` accumulates every event and derives a summary. The statistic
that matters is the **repeat interval**: the fastest gap between accepted hits
on the *same* zone and limb, which is a hard upper bound on playable tempo.
When the fastest *refused* repeat is quicker than the fastest accepted one, the
settings — not the player — are the ceiling, and the panel says so.

Exported JSON carries the tuning and the machine alongside the events. A
latency figure without its model, delegate and camera format is not evidence.

### 9. Settings persist to localStorage

These values are tuning found by standing in front of a camera, not
preferences. Losing them on reload makes every session start from scratch.
Corrupt stored data falls back to defaults rather than throwing.

---

## Measurements

Recorded on the development machine, Chromium, `pose_landmarker_lite`,
1280×720 input, **no person in frame** (detector only — the landmark model does
not run, so real-world cost will be higher):

| Delegate | Model ready | Inference median | Inference p95 |
|---|---|---|---|
| GPU (WebGL) | 131 ms | 9.5 ms | 13.1 ms |
| CPU (SIMD WASM) | 67 ms | 12.8 ms | 14.7 ms |

Both fit inside a 33 ms frame budget with room to spare. GPU is faster at
steady state; CPU initialises faster. SIMD is supported.

Note this table was measured with **no person in frame**, so only the detector
ran. With a person present and the landmark model doing real work, mean
inference on `full`/CPU measured ~18 ms — still comfortably inside budget. See
"MVP 0 exit criterion" below for the end-to-end figures.

### Hysteresis versus refractory, simulated at a 30 Hz pose rate

The first tuned configuration suppressed boundary chatter with a 360 ms
re-entry lockout and hysteresis disabled (`1.00×`). Both mechanisms were then
measured against the two failures they exist to prevent — a hand held wobbling
on the zone boundary, and genuine fast repeat hits on one target.

Zone radius `0.049` field units (`zoneScale 0.65`), exit grace 40 ms.

| Configuration | Spurious hits, 10 s edge hover | 16ths @ 90 BPM (167 ms) | 8ths @ 120 BPM (250 ms) |
|---|---|---|---|
| hyst `1.00×`, refr `360 ms` | 14 | 12 / 35 | 12 / 24 |
| hyst `1.00×`, refr `0 ms` | 19 | — | — |
| hyst `1.25×`, refr `0 ms` | **1** | **34 / 35** | **24 / 24** |
| hyst `1.40×`, refr `0 ms` | 1 | 34 / 35 | 24 / 24 |

The lockout turns out to be a poor chatter suppressor — it only cut spurious
entries from 19 to 14, because a 360 ms window still permits nearly three false
hits a second — while costing more than half of all repeat hits above 120 BPM.

Hysteresis does the same job far better (14 → 1, where 1 is the single genuine
entry) and costs no tempo at all, because it constrains *leaving* rather than
*returning*.

**Conclusion: hysteresis is the correct chatter mechanism; the refractory
period should stay near zero and exists only as an escape hatch.** The two are
not interchangeable, and the earlier framing in decision 4 that treated them as
parallel options was wrong.

### 10. Model and delegate are interchangeable on this hardware

All four combinations of `lite`/`full` and `GPU`/`CPU` finish well inside the
33 ms budget set by a 30 fps camera, so none of them is the bottleneck and they
are perceptually identical in play. Confirmed by the operator: "I think they're
all about the same."

They are not *equal* — GPU is measurably faster at steady state — but the
difference lands in slack rather than in latency the player can feel.

**Therefore choose the model for landmark quality, not for speed**, and revisit
only if a slower machine, a higher-resolution camera, or the `heavy` variant
pushes inference past the frame budget. `lite` is the current default purely
because it loads fastest; `full` costs nothing measurable if wrist accuracy in
fast motion ever proves marginal.

**Narrowed after MVP 1.** This holds *for pose alone*, and only because every
option finishes with slack to spare. Add hand tracking and the slack is gone:
pose + hand measures 15.5 ms on GPU and 36 ms on CPU against a 33 ms budget. So
the moment a mode needs hands, the delegate stops being a shrug and becomes a
requirement. See docs/TRACKING.md.

---

## MVP 0 exit criterion

> Move either wrist into each target and receive reliable, low-latency
> zone-enter events across repeated attempts. — Spec §15

**Met.** Confirmed by the operator in play with the corrected tuning:
hysteresis `1.25×`, re-entry lockout `20 ms`, exit grace `40 ms`, zone size
`0.65×`, confidence `0.40`, `lite` on the CPU delegate — "i can rapid fire a lot
more cleanly."

Measured on the same machine during a healthy session: 30 Hz pose rate, 60 fps
render, ~18 ms mean inference, ~28 ms end-to-end input latency with no
implausible frame timestamps.

That latency figure is the one MVP 1 inherits: it consumes roughly a third of
the ±80 ms PERFECT window in spec §7 before any judgment logic runs.

Also answered along the way, spec §20 #9 — *does showing the webcam improve
playability?* No. The skeleton alone is enough to play by, and the camera feed
is off by default.


---

## MVP 1

### 11. A synthesised click track is the MVP 1 development track

Spec §15 asks MVP 1 for "one legally usable/local development track", and §11
is firm that not charging for something does not make a recording free to use.

A metronome we generate ourselves settles that question by not raising it, and
is useful beyond the licence: its tempo is known exactly, so a hand-written
chart can be verified by ear with no analysis step in between.

It is also the most accurate clock available in a browser.
`AudioContext.currentTime` is driven by the audio hardware rather than the main
thread, so it keeps correct time while JavaScript is busy. Measured here: 805 ms
of audio per 805 ms of wall clock, zero resyncs.

The player's own audio is supported through `LocalAudioAdapter` and lives in
`public/audio/`, which is **gitignored** — no recording is committed.

### 12. The clock corrects bias by minimum drift, not by average drift

Measured on a real click track: the interpolated clock sat a constant **36 ms**
ahead of the audio, and because that was under the 40 ms resync threshold it
would have stayed there for the whole song. Against an ±80 ms PERFECT window
that is nearly half the budget, spent before any judgment logic runs.

The obvious fix — nudge toward the average drift — is wrong. A source that
reports its position in 30 ms steps makes drift sawtooth between 0 and +30; its
mean is +15 even though the interpolated clock is exactly right, so correcting
toward it would invent a 15 ms lag.

The **minimum** drift over a window does not have that problem. For a merely
coarse source it sits at zero and nothing is corrected; for a source we are
genuinely ahead of, every sample including the smallest carries the bias. Bias
is then bled off 5% per tick, which converges in well under a second and is
invisible to a player.

### 13. Collision sweeps the path between pose samples

Reported symptom: *"sometimes I'll hit the beat but it doesn't register"*, and
*"I extend my arm to reach and it doesn't always reach"*.

Neither is a tracking failure. At a 26–30 Hz pose rate, samples are ~35 ms
apart, and a fast arm extension covers more than a zone's diameter in that gap.
The hand passes clean through the target while every sampled position is
outside it.

`ZoneTracker` now tests the segment between consecutive trusted samples. Two
things follow: hits that were previously invisible register, and the crossing
can be dated by interpolation rather than rounded up to the frame that noticed
it — worth up to a full frame of timing accuracy.

The bookkeeping that decides whether one approach is still under way stays on
the CURRENT point. Using the swept answer there would keep an approach alive
while the hand withdrew back through the zone, and count two attempts as one.

### 14. The player is guided into position; the targets never move

**This reverses an earlier decision, which was wrong.**

Reported symptom: *"even though I'm far back enough I have trouble hitting the
bottom right"*. The diagnosis was right — the target really was outside her
reach — and the fix was backwards. I made the four targets fit themselves to
whoever was standing there.

Spec §3 says the opposite, in as many words: *"Screen-anchored targets. Targets
belong to stable normalized screen coordinates. **The player moves into
them.**"* Three rounds of feedback followed, ending in the plainest possible
statement of it: *"the targets should always have a fixed position on the
screen, the user should calibrate themselves for the target position, not the
other way around."*

Body-fitted targets fail for reasons well past tidiness:

- **They cannot be learned.** Muscle memory is most of what a rhythm game
  trades in, and it needs the upper-left target to be where it was yesterday.
- **Difficulty stops meaning anything.** The distance between two notes — and
  therefore whether a pattern is playable at tempo — would depend on who is
  playing.
- **Two people cannot compare scores** on the same chart.

So the targets are fixed, and calibration answers a different question: from
where the player is standing, can they reach them, and if not, what should they
do about it?

The physical insight that makes the advice possible is that reach in SCREEN
space depends on distance from the camera. Stand close and your arms span most
of the frame; stand far and they span very little. So an unreachable corner is
almost always solved by stepping closer, and a body cropped out of frame by
stepping back. `positioning.ts` finds that sweet spot and says which way to
move; unreachable targets are marked in red where they already are.

The module has no way to relocate a target even in principle — it only reads
them — which is the property worth having.

---

## MVP 1 exit criterion

> One full song is playable from start to finish with understandable timing
> feedback and repeatable scoring. — Spec §15

**Not yet signed off.** Every task is built; the criterion needs a full song
played end to end.

### 15. Camera tracking is deprecated

Marked deprecated after MVP 1, at the project owner's direction: *"we are going
off the rails... deprecate hop//beat's camera tracking entirely, we are taking
a step back."*

Deprecated, not deleted. The code stays and keeps working; no new work is done
on it. Spec §25 states the terms.

This is not a verdict on whether it worked. MVP 0 met its exit criterion and
the measured latency was fine. It is a verdict on where the effort was going:
across the sessions after MVP 0, nearly every change was to the input layer,
and almost none was to the rhythm game. Calibration alone took four rounds,
largely because I kept inventing interaction design from short prompts instead
of asking — and each of those rounds spent attention that the game underneath
never got.

What makes this cheap is a boundary drawn in MVP 0: the engine consumes
`ZoneEvent`s and has never known where they come from. Everything above the
input layer — clock, judgment, scoring, charts, renderer — is untouched by
this, and would accept a different input source without modification.

---

## Open after MVP 0

- Whether a fast wrist can *tunnel* through a zone entirely between two pose
  frames. At 30 Hz a hand crossing the screen in 0.5 s moves ~0.066 field units
  per frame against a 0.098-unit zone diameter, so this is plausible. The fix
  would be swept-segment collision — testing the path between consecutive wrist
  positions rather than the positions themselves. Not yet built.
- Whether `lite` is sufficient or `full` is needed for wrist accuracy in motion.
- Zone radius that feels intentional (§20 #3) — needs a person and a slider.
- Whether zone *entry* is the right hit semantic, or dwell/velocity/crossing
  (§20 #4). MVP 0 deliberately implements entry only.
