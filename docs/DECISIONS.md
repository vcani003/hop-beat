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

**Not yet measured on real hardware with a real person:** end-to-end input
latency. See "Open after MVP 0" below.

---

## Open after MVP 0

- Real-webcam input latency, with `timestampSuspect` reading 0%.
- Whether `lite` is sufficient or `full` is needed for wrist accuracy in motion.
- Zone radius that feels intentional (§20 #3) — needs a person and a slider.
- Whether zone *entry* is the right hit semantic, or dwell/velocity/crossing
  (§20 #4). MVP 0 deliberately implements entry only.
