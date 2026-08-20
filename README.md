# hop//beat

A browser-based spatial rhythm game where an ordinary webcam turns the
player's body into the controller. Targets arrive on beat; pose landmarks
decide input; a precomputed beatmap decides timing.

**Nothing is built yet.** This repository currently holds the specification
and the visual concept. See [`docs/SPEC.md`](docs/SPEC.md).

---

## Where the name comes from

`hop` carries a deliberate lineage from **Bunny Hop Player**, the project that
restarted the habit of building for curiosity rather than for a résumé — and it
describes the movement. `beat` is the rhythm-game core. `//` gives it the
creative-coding character.

## The one thing this has to prove

> A person stands in front of a normal webcam, music plays, targets arrive on
> beat, their movement becomes input, and the screen responds immediately —
> reliably enough that the technology disappears.

Everything else in the spec is downstream of that.

## Decisions already made

| | |
|---|---|
| **Stack** | React · TypeScript · Vite — a realtime client app, not an SSR problem |
| **Pose** | MediaPipe Pose Landmarker, consumed directly as landmarks |
| **Rendering** | PixiJS 8 / WebGL. Procedural figure, not a rigged 3D avatar |
| **Targets** | Screen-anchored, in normalised 0–1 coordinates |
| **Timing** | The playback clock is authoritative — not the renderer, not the pose frame rate |
| **Beatmaps** | Precomputed and cached. Live analysis is not a dependency of play |
| **Backend** | None |

## Two constraints worth stating up front

**Gameplay beats visuals.** Latency, timing correctness and input reliability
come before graphical complexity. Debug visualisation before aesthetic
visualisation.

**Music rights are separate from monetisation.** Not charging for something
does not make a recording free to use. The intended workflow is an artist
supplying analysis-quality audio plus their own YouTube upload for playback —
the official player stays visible, and nothing is downloaded, isolated or
modified. See §11 of the spec.

## Roadmap

MVP 0 is the only assignment until it is met and reviewed.

- **MVP 0 — prove the controller.** Webcam, pose landmarks, four zones, reliable
  wrist-entry events. No music, no scoring, no art.
- **MVP 1 — make it a rhythm game.** One track, one hand-authored map,
  authoritative clock, judgment and scoring.
- **MVP 2 — generate a map.** Offline analysis, then a choreography generator
  that turns musical events into playable movement.
- **MVP 3 — YouTube playback.** Official IFrame player as the clock source.
- **MVP 4 — map editor.** Curate what the generator produced.
- **MVP 5 — visual and installation experiments.**

## Repository

```
docs/
  SPEC.md                 the specification, in markdown
  hop-beat-spec-v1.docx   the original document
  concept-mockup.png      visual direction: light, dark and outline modes
```

> The mockup is a **concept image**. It shows a commercial track and its album
> art for illustration only — that is not a licensing decision, and §11 of the
> spec is what governs the real one.
