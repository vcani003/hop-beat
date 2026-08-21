# Gesture design — customisation overlay

**Status: planned, not built.** Written before implementation so the
interaction is agreed rather than guessed at. Nothing in this document exists
in the codebase yet apart from one tested primitive, noted at the end.

The shape comes from the player:

> "hold a ninjutsu move at heart center for 2–3 seconds, which pauses song and
> opens an overlay, from there we can customize things on screen. If I can hover
> the target and then it pulses and I use my hands to *stretch* it."

---

## 1. The constraint that shapes everything

**MediaPipe Pose Landmarker has no fingers.** It returns 33 body landmarks —
shoulders, elbows, wrists, hips, knees, ankles, and a few face points. Wrists
are the end of the chain. There is no way to tell an open palm from a fist,
let alone a specific hand sign.

Finger configurations need **MediaPipe Hand Landmarker**, a different task
giving 21 landmarks per hand. Adding it means:

- a second model loaded and a second inference per frame
- measured pose inference is ~18 ms with a person in frame, against a 33 ms
  budget at 30 fps — a second model is unlikely to fit without dropping the
  pose rate
- hands must be reasonably large in frame, which fights standing far enough
  back for full-body tracking

So a true hand-sign trigger is a real project, not a detail. Two ways forward:

**A. Pose-detectable equivalent (no new model, buildable now).** The *shape* of
the gesture survives: both wrists brought together at chest height, held still
for 2–3 seconds. It reads as a deliberate ritual pose, it is unmistakable from
33 landmarks, and it costs nothing extra.

**B. True hand signs (needs Hand Landmarker).** Worth revisiting if hand
tracking earns its place for other reasons — finger-level input would open up
far more than a menu trigger. Not worth it for this alone.

**Recommendation: A now, B as its own piece of work later.** The interaction
below is written against A and would survive being upgraded to B.

---

## 2. Trigger — the heart-centre hold

    both wrists within  ~0.12 field-X units of each other
    at chest height     between shoulder line and hip line
    held still          neither wrist moving more than ~0.03 per 200 ms
    for                 2000 ms

Held-still is the important clause. It is what separates a ritual pose from
hands that happen to pass each other mid-chart, and it is cheap to check.

**Feedback while charging.** A ring fills at the player's chest over the two
seconds. Breaking the pose empties it immediately. Nobody should trigger this
without having watched it happen, and nobody should fail to trigger it without
seeing how close they got.

**Cancel.** Dropping the hands, or hitting Escape, closes the overlay.

**Not while a note is live.** The trigger is suppressed within a judgment
window of any pending note, so it can never eat a hit.

---

## 3. Overlay — pause, then customise

On trigger: pause playback (which freezes the clock and judgment already, per
spec §14), dim the field, and show the targets with their current sizes.

Everything adjustable here is adjustable **without moving a target**, per spec
§24. That is the boundary: size, yes; position, never.

---

## 4. Hover and stretch

    HOVER    hold a wrist within a target for 400 ms
             -> the target pulses and becomes "held"
    STRETCH  bring the second hand in; the distance between the two wrists
             sets the target's diameter, live
    COMMIT   drop both hands, or hold still for 600 ms
    CANCEL   Escape, or move a wrist outside 2x the target radius

Hover-then-act is what makes this safe. A single hand near a target does
nothing; a size change needs a deliberate second hand.

---

## 5. Jitter — the part the player was right to worry about

> "idk if it would be too difficult since hand gestures are a little jittery"

Landmark positions wobble by a few pixels every frame, and a size mapped
directly to a raw wrist distance would visibly breathe. Three mechanisms
handle it, and all three are already proven elsewhere in this codebase:

**Dwell, not instant.** Every state change requires the condition to hold for a
period rather than for a frame. This is exactly the exit-grace mechanism in
`ZoneTracker`, which already absorbs momentary tracking dropout, and it is
expressed in milliseconds so it behaves the same at 15 Hz and 60 Hz.

**Smoothing.** An exponential moving average over the wrist distance, time
constant ~150 ms. Slow enough to kill the wobble, fast enough that the size
still follows the hands. Confidence-weighted, so a low-visibility frame
contributes less rather than yanking the value.

**A deadband.** Below ~0.01 field units of change, do nothing. This is the same
reasoning as the clock's slew deadband: do not chase noise.

**And a quantised result.** Size lands on the same 0.05 steps the buttons and
keys use. The final value is therefore always a value the player could have
reached another way — which also means the gesture can never produce a size
that looks "off the grid".

A useful precedent: the hold trigger is the *easiest* thing here to make
robust, because a static pose held for two seconds gives roughly 60 frames to
average over. Jitter is a much smaller problem for holds than for tracking.

---

## 6. What exists today

- `targetSizing.ts` — `handSpanSizing()` maps the distance between two roughly
  level wrists onto a target diameter, clamped and tested. This is the STRETCH
  step's primitive, and nothing calls it yet.
- Buttons and keys (`[` `]`, `-` `=`) already change size from anywhere,
  including mid-song. That is MVP 1's answer, agreed with the player:
  > "maybe a plus/minus on screen would be a mvp 1 while we work out jitters."

---

## 7. Open questions

- Does the heart-centre hold survive a real chart without a single false
  trigger? Needs logging before it is trusted — the session recorder already
  exists for exactly this kind of measurement.
- Should the overlay expose anything beyond size? Timing offset is the obvious
  candidate, and it has the same "changes nothing structural" property.
- Is pausing right, or should the overlay be usable between songs only? Pausing
  mid-song is more useful and more likely to be triggered by accident.
