# Tracking capabilities — cost, latency, and how to load them

**Status: measured, with an architecture proposed but not built.**

The question: can hand gestures be tracked, what does it cost, and can it be
loaded in a controlled way rather than being paid for by every game mode?

**Short answer: yes, on the GPU delegate, and it is much cheaper than I
previously said.** I told you a second model "probably doesn't fit" against an
18 ms budget. That was wrong — it was an estimate from the wrong baseline, and
the measurement disagrees with it.

---

## 1. Measurements

Same machine, same 1280×720 textured frame, 25 runs each, median and p95 in
milliseconds. The frame budget at 30 fps is **33 ms**.

### GPU delegate (WebGL)

| Task | Median | p95 | Model | Load |
|---|---|---|---|---|
| Pose only (lite) | 9.5 | 13.4 | 5.8 MB | 202 ms |
| Hand only (2 hands) | 8.3 | 10.3 | 7.8 MB | 128 ms |
| **Gesture Recognizer** (2 hands) | **7.8** | 11.3 | 8.4 MB | 92 ms |
| Pose **+** Hand, sequential | 15.5 | 16.4 | 13.6 MB | — |
| **Holistic** (pose + hands + face) | **9.2** | 12.5 | 13.7 MB | 140 ms |

### CPU delegate (SIMD WebAssembly)

| Task | Median | p95 |
|---|---|---|
| Pose only (lite) | 13.5 | 16.5 |
| Hand only | 23.0 | 24.0 |
| Gesture Recognizer | 23.2 | 29.6 |
| Pose **+** Hand, sequential | **36.0** | 36.7 |
| Holistic | 14.0 | 15.2 |

### The caveat that matters

**These are floor numbers.** The frame contains no person, so the detector runs
but the landmark stages largely do not. MVP 0 measured pose at 12.8 ms blank
against ~18 ms with a person in frame — roughly a **1.4×** factor.

Applying that, a realistic GPU estimate with a body and two hands present:

| | estimate | verdict at 30 fps |
|---|---|---|
| Pose only | ~13 ms | comfortable |
| Pose + Hand | ~22 ms | fits, with headroom |
| Holistic | ~13–20 ms | fits |

And on CPU, pose + hand lands near **50 ms**, which misses the budget outright.

**This must be re-measured on a real body before anything ships against it.**

---

## 2. What the numbers actually say

**1. Hand tracking is affordable — but only on the GPU delegate.**

This narrows an earlier finding rather than contradicting it. Decision 10 said
model and delegate were interchangeable, and that was true *for pose alone*,
because every option finished inside the budget. Add a second model and the
slack disappears: GPU costs 15.5 ms, CPU costs 36 ms. **Once hands are
involved, the delegate is a real decision, not a shrug.**

**2. Gesture Recognizer is strictly better value than Hand Landmarker.**

It is *cheaper* (7.8 vs 8.3 ms) and returns everything Hand Landmarker does —
21 landmarks per hand, handedness, world coordinates — plus a `gestures` field
carrying a trained classification. There is no reason to choose plain hand
landmarks over it.

It ships with a small canned vocabulary (closed fist, open palm, pointing up,
thumbs up/down, victory, "I love you"). That is not a ninjutsu sign, but it is
a robust, pre-trained trigger that costs nothing extra — and 21 landmarks per
hand means a *custom* sign can be recognised from the landmark geometry
ourselves, which is a far smaller problem than training a model.

**3. Holistic is the surprise.**

Pose + hands + face in a single graph, at 9.2 ms — cheaper than running pose and
hand separately (15.5 ms) and barely more than pose alone (9.5 ms). One graph
sharing one detection pass beats two graphs each doing their own.

The cost is that it also computes a face mesh we have no use for, and its
result shape differs from PoseLandmarker's, so the pose provider would need an
adapter.

---

## 2b. What it costs to ship both

Measured, not estimated.

**JavaScript bundle: effectively nothing.** Importing `GestureRecognizer`,
`HolisticLandmarker` and `HandLandmarker` on top of `PoseLandmarker` changed
the main chunk from **711,692 to 711,700 bytes — 8 bytes.**

MediaPipe ships as one pre-bundled ES module. It does not tree-shake per class,
so every hand class has been in the build since MVP 0. There was never anything
to lazy-load on the JavaScript side, because there was never a saving to make.

Building the whole hands mode — provider, adapter, mode registry, UI — cost
**4.6 KB** (711.7 → 716.3 KB).

**WASM runtime: shared.** Every vision task runs on the same
`vision_wasm_internal.wasm`. Loading a second task does not load a second
runtime.

**Models: the only real cost, and already lazy.** `.task` files live in
`public/` and are fetched by URL when a task is constructed — never bundled.
Selecting the hands mode and starting the camera fetches
`gesture_recognizer.task` (8.4 MB) and **nothing else**; the pose model is not
downloaded at all. Verified by intercepting fetch.

So "lazy load the module as we use the feature" is already the behaviour, and
the unit that loads lazily is the model rather than the code.

---

## 3. Proposed architecture — capabilities, declared per mode

The thing to avoid is every mode paying for every capability. So a mode
declares what it needs, and only that is loaded.

    TrackingCapability = 'body' | 'hands' | 'gestures'

    GameMode
      id
      layoutId        which fixed target layout (spec §24)
      capabilities    what tracking it requires

    corners4-classic   capabilities: ['body']
    hands-only-mode    capabilities: ['hands', 'gestures']
    full-body-plus     capabilities: ['body', 'hands']

A resolver maps a capability set onto the cheapest backend that satisfies it:

| Capabilities | Backend | GPU cost |
|---|---|---|
| `body` | PoseLandmarker (lite) | ~9.5 ms |
| `hands` or `gestures` | GestureRecognizer | ~7.8 ms |
| `body` + `hands` | Holistic, **or** Pose + GestureRecognizer | ~9.2 / ~17 ms |

Holistic wins on cost for the combined case; two models win on flexibility,
since the gesture classifier comes with it. Which to prefer is a decision to
make once there is a real body in front of the camera to measure.

### The interface

`MediaPipePoseProvider` already isolates MediaPipe behind `PoseSnapshot` — no
gameplay code imports MediaPipe. The same boundary extends:

    LandmarkProvider
      capabilities()             what this backend actually supplies
      start(video, onFrame)
      close()

    TrackingFrame
      body?      PoseSnapshot          33 landmarks, as today
      hands?     HandSnapshot[]        21 landmarks each, handedness
      gestures?  GestureLabel[]        classification, when available

Everything downstream reads the fields it needs and ignores the rest. A mode
requiring `hands` on a backend that cannot supply them fails at load with a
clear message, rather than silently never firing.

### Loading

Models load **on entering a mode**, not at startup. The game is playable in
~200 ms with pose alone today, and a hands mode should not tax that. Loads are
90–200 ms, so a mode switch can afford one without a visible stall.

The vendoring script already handles this shape — it takes a list and fetches
what is missing.

---

## 4. Tradeoffs, stated plainly

**Distance.** Hands must be reasonably large in frame to landmark well. Full-body
tracking wants the player far enough back to fit head to hips. These pull in
opposite directions, and it is the sharpest constraint on a mode using both.
A hands-only mode can have the player much closer, which is why it may be the
better first hands mode.

**Delegate.** GPU is required for anything with hands. Some machines and some
browsers reject the WebGL backend, so a CPU fallback must degrade to body-only
rather than stuttering.

**Budget.** At 30 fps there is room. At 60 fps capture there is not, and the
pose loop would need to run at half the camera rate — worth knowing before
promising anything about high-frame-rate cameras.

**Latency.** Two sequential models add their inference times, which lands
directly in the ~28 ms input latency MVP 0 measured. Holistic avoids this by
sharing one pass, which is a second argument for it.

---

## 5. What I recommend

1. **Re-measure with a real body and hands in frame.** Everything above is a
   floor. Nothing should be committed to on synthetic numbers.
2. **Prototype Gesture Recognizer alone**, in a hands-only context where the
   player is close to the camera. It is the cheapest capability and it sidesteps
   the distance conflict entirely.
3. **Then decide Holistic vs two models** for combined modes, with real numbers.
4. Build the capability resolver once there are two modes to resolve between.
   One mode does not need an abstraction.

**Built since:** `src/game/modes.ts` declares `body` and `hands` modes with
their capabilities, and `usePosePipeline` loads only the backend the active
mode requires. Hands are adapted into a `PoseSnapshot` so both modes drive the
same engine, the same charts and the same judgment — which is the only way
comparing them means anything.

Reproduce the benchmark models with:

    node scripts/fetch-assets.mjs --tracking-candidates
