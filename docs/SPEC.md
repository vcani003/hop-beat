<!-- Converted from docs/hop-beat-spec-v1.docx. The .docx is the original;
     this markdown exists so the spec is diffable and searchable. -->

hop//beat

Spatial Rhythm Game • Product + Technical Project Specification

Draft for implementation planning with Claude • August 2026

One-line conceptA browser-based spatial rhythm game where a normal webcam turns the player's body into the controller. Players hit screen-anchored targets on beat; pose landmarks determine input, a cached beatmap determines timing, and lightweight procedural graphics turn movement into a responsive visual performance.


# 1. Why This Project Exists

The project begins with a real interest: rhythm games, music, movement, interactive visuals, and the question of whether an ordinary webcam can turn physical space into a playable controller. The software should exist because the interaction is interesting.

Primary personal goal: build something I genuinely want to experiment with and play.

Portfolio goal: demonstrate frontend/system-design ability through a technically unusual, immediately demoable experience.

Learning goal: explore computer vision, realtime rendering, music analysis, game timing, procedural graphics, and latency.

Product goal: make the core experience accessible in a browser with consumer hardware: laptop + webcam.

Long-term creative goal: allow songs to become playable experiences through generated, curated, or handmade maps.


## Project Name + Origin

Working title: hop//beat. “hop” connects to physical movement, and to Bunny Hop Player; “beat” describes the rhythm-game core; “//” gives the name a digital/creative-coding character.

Where the idea came from: curiosity about Moderna’s mRNA cancer research led to questions about how biological instructions are engineered, which led to thinking about scientist-facing software and applied projects. That chain of curiosity became the idea for a webcam-controlled spatial rhythm game.


# 2. Product Identity

The closest familiar comparison is visually Just Dance-like and mechanically DDR-like, but it should not clone either. The player's body is represented by a lightweight procedural 2D figure or abstract motion visualization. Gameplay is based on hitting spatial targets at specific times rather than reproducing an entire fixed choreography.

VISUAL IDEA                         GAMEPLAY IDEAcamera / body pose                   timestamped notes        ↓                                  ↓procedural player                    screen target        ↓                                  ↓movement trails / effects            body part enters zone        └──────────────┬───────────────────┘                       ↓                PERFECT / GOOD / MISS


# 3. Core Design Decisions Already Made

Browser-first. The primary product should run in a browser. A player should be able to open a URL, allow camera access, calibrate, and play.

React + TypeScript + Vite. Use React for application UI and TypeScript for game/application logic. Vite is preferred over Next.js because this is a realtime client application, not an SSR/content problem.

Pose estimation in the browser. Use MediaPipe Pose Landmarker as the initial body-tracking solution. Gameplay should consume pose landmarks directly rather than routing input through a separate visual tool.

PixiJS for the initial renderer. Use GPU-accelerated 2D rendering for targets, notes, procedural body graphics, trails, and effects. Do not begin with a heavy 3D avatar.

Procedural player representation. Generate the player visualization from pose coordinates using lines, circles, curves, ribbons, particles, etc. Avoid rigged 3D characters in the MVP.

Screen-anchored targets. Targets belong to stable normalized screen coordinates. The player moves into them. This is simpler and feels more like a classic rhythm-game field.

Precomputed beatmaps. Analyze a song before gameplay and cache derived timing/choreography metadata. Do not make live audio analysis a dependency of normal gameplay.

YouTube can be a playback source, not an audio extraction source. Use the official visible YouTube embed/API where appropriate. Do not rip, isolate, download, or modify YouTube audio.

TouchDesigner is optional. Do not make TouchDesigner foundational. It may later become an alternate renderer for installations, projection, or experimental visuals.

Gameplay beats visuals. Latency, timing correctness, and input reliability have priority over graphical complexity.


# 4. Proposed Technology Stack

Layer

Initial choice

Responsibility

App

React + TypeScript + Vite

Menus, song selection, calibration UI, settings, results, app state

Rendering

PixiJS 8 / WebGL

Game canvas, notes, targets, procedural body, trails, particles

Camera

getUserMedia

Webcam capture

Pose

MediaPipe Pose Landmarker

Body landmark coordinates and confidence

Game loop

TypeScript + requestAnimationFrame

Clock sampling, note lifecycle, collisions, scoring

Playback

YouTube IFrame API + local/dev audio adapters

Playback and authoritative playback position

Analysis

@audio/beat initially

Offline/pre-play BPM, beats, onsets from permitted audio samples

Richer analysis

Meyda later

Energy/spectral features if choreography needs them

Advanced analysis

Essentia.js only if justified

Deeper MIR/ML features; avoid until a concrete need exists

Maps

Versioned JSON

Portable beatmap/choreography metadata

Persistence

Local files/localStorage initially

No backend required for MVP

Testing

Vitest + React Testing Library

Pure engine logic, UI, map validation

Optional installation renderer

TouchDesigner

Projection/installation-scale visuals via event adapter


# 5. System Architecture

┌─────────────────────┐                         │   PLAYBACK SOURCE    │                         │ YouTube / local dev  │                         └──────────┬──────────┘                                    │ current playback time                                    ▼┌────────────┐    landmarks   ┌─────────────────────┐    events    ┌──────────────┐│   WEBCAM   │ ─────────────► │     GAME ENGINE     │ ──────────► │    PIXIJS    ││ MediaPipe  │                │ notes / hit windows │             │   RENDERER   │└────────────┘                │ scoring / collision │             └──────────────┘                              └──────────┬──────────┘                                         │                                         ▼                              ┌─────────────────────┐                              │      REACT UI       │                              │ score / combo / UI  │                              └─────────────────────┘Optional later:GAME EVENTS ─────────────► TouchDesigner adapter / installation renderer


# 6. Coordinate and Input Model

Normalize the camera/game field to coordinates from 0.0 to 1.0. This keeps gameplay independent of screen resolution. The webcam preview may be mirrored for natural interaction, but the coordinate transform must be explicit and tested.

(0,0) ───────────────────────────── (1,0)  │       [UPPER LEFT] [UPPER RIGHT]    │  │                                     │  │                  PLAYER             │  │                                     │  │       [LOWER LEFT] [LOWER RIGHT]    │(0,1) ───────────────────────────── (1,1)

MVP input should use wrists/hands only. A hit occurs when an eligible landmark enters the target region within the note's timing window. Later versions may add feet, knees, torso, ducking, leaning, swipes, holds, simultaneous hits, and movement velocity.


# 7. Rhythm Timing Model

The playback clock, not the renderer and not the pose-estimation frame rate, should be authoritative for note judgment. The game loop repeatedly samples playback time and compares it against note timestamps. Pose updates may arrive at a lower rate than rendering; visual interpolation can smooth motion without inventing gameplay timestamps.

playbackTime = playbackAdapter.getCurrentTime()pose = latestPoseSnapshotfor each active note:    delta = playbackTime - note.time    if eligible body landmark enters note zone:        judge(abs(delta))Example starting windows (TUNABLE, not final):PERFECT  <= 80 msGOOD     <= 160 msMISS     > 160 ms

Do not lock final timing windows until real-device testing. Webcam inference, display, browser scheduling, and playback source can all introduce offset. Build calibration as a first-class feature once basic gameplay works.


# 8. Music Analysis and Beatmap Generation

Normal gameplay should use a precomputed beatmap. The audio is analyzed once from a source the project is permitted to analyze. The derived metadata is then cached. The actual audio does not need to be stored with the map.

PERMITTED ANALYSIS AUDIO        ↓decode to PCM samples        ↓@audio/beat        ↓BPM + beat timestamps + onset timestamps        ↓OUR CHOREOGRAPHY GENERATOR        ↓difficulty + target selection + ergonomic constraints        ↓beatmap JSON        ↓PLAYBACK SOURCE + CACHED MAP        ↓realtime game

@audio/beat is the initial candidate because it operates on raw samples and exposes onset detection, tempo estimation, and beat tracking in browser or Node. Treat it as replaceable behind an analysis interface. The project's unique work is not reimplementing FFT/onset research; it is converting musical events into enjoyable physical choreography.


# 9. Choreography Generator

Beat detection answers 'when might something happen?' It does not answer 'what should the player do?' The choreography generator is a core project feature and should remain our code.

Select a subset of detected beats/onsets based on difficulty.

Choose a target zone and eligible limb.

Avoid impossible or unpleasant rapid cross-screen transitions.

Account for travel distance versus milliseconds available.

Prefer readable patterns and intentional repetition over pure randomness.

Use section/intensity information later to increase density or movement during energetic passages.

Use a deterministic random seed when randomness is used, so regenerated maps are reproducible.


# 10. Beatmap Data Model

{  "schemaVersion": 1,  "song": {    "id": "artist-track-slug",    "title": "Track Name",    "artist": "Artist",    "playback": {      "provider": "youtube",      "videoId": "VIDEO_ID"    }  },  "analysis": {    "bpm": 128.1,    "confidence": 0.91,    "offsetMs": 0,    "generatorVersion": "0.1.0"  },  "difficulty": "normal",  "mapType": "generated",  "notes": [    {      "id": "n001",      "timeMs": 1842,      "type": "hit",      "zone": "upperLeft",      "limb": "eitherHand"    }  ]}

Map types should eventually be: generated, curated (generated then edited), and handmade. Store only the information necessary to reproduce gameplay and attribution. Keep map schema versioned from the beginning.


# 11. YouTube + Music Rights Strategy

The project should not assume that being non-monetized makes copyrighted music free to use. Music rights and platform rules are separate from monetization. For public demos, prefer artists/tracks with explicit permission or licenses that cover the intended use.

Do not bundle copyrighted DDR recordings or assume Hatsune Miku songs are generally free to use. Individual compositions/recordings have their own rights holders.

Preferred artist workflow: artist supplies/authorizes an analysis-quality audio file, plus a YouTube URL used for public playback.

Analyze the permitted source offline/pre-play; store the derived beatmap, not the source recording, unless the license explicitly permits distribution.

For YouTube playback, keep the official player visible and functional and use the official IFrame API for playback state/current time.

Do not download, isolate, separate, or modify YouTube audio/video through the API integration.

Before public launch or monetization, perform a fresh policy/license review; platform policies can change.

A potentially strong product angle is collaboration with indie artists: their official YouTube upload remains the playback experience while the game provides an additional interactive layer and credits the artist clearly. This is a product direction, not a blanket legal conclusion.


# 12. Procedural Visual Direction

The initial player representation should be generated mathematically from pose landmarks rather than using a rigged avatar. This reduces asset complexity and keeps rendering lightweight while creating room for a distinctive visual identity.

Skeleton/line figure from shoulder-elbow-wrist, hip-knee-ankle connections.

Circles or shapes at joints.

Curves/ribbons following arms and movement.

Short motion trails from wrists.

Target pulse/ripple on successful hits.

Theme system later: ink, neon wireframe, constellation, doodle, pixel-like, etc.

Rendering style is deliberately not finalized. MVP visuals should be diagnostic first: landmarks, zones, and hit feedback must be easy to inspect.


# 13. TouchDesigner Decision

TouchDesigner is not required for the core browser game. It remains valuable as an optional experimental renderer if the project evolves toward projection mapping, performances, gallery installations, or event-scale visuals.

Core gameplay must work without TouchDesigner.

Expose renderer-agnostic GameEvents so another renderer can subscribe later.

Possible future adapter: WebSocket/WebRTC/event bridge from game engine to TouchDesigner.

If commercial use is considered, re-check current TouchDesigner licensing before using it in paid work.


# 14. Performance and Latency Principles

Pose inference and gameplay judgment come before decorative effects.

Never require pose estimation to run at the same FPS as rendering.

Keep the latest timestamped pose snapshot; interpolate only for visuals.

Avoid React state updates on every animation frame. Keep hot game-loop state outside normal React render flow.

Pool/reuse frequently created visual objects where practical.

Provide graphics quality tiers if effects become expensive.

Measure actual timing rather than optimizing based on guesses.

Log pose inference duration, render FPS, playback drift, and hit delta during development.

Pause judgment while YouTube is buffering/paused; do not let notes silently advance against a stopped player.


# 15. MVP Roadmap


## MVP 0 — Prove the Controller

Goal: answer one question only: can a normal webcam reliably become the input device?

Create Vite + React + TypeScript project.

Request webcam permission and render mirrored preview.

Integrate MediaPipe Pose Landmarker.

Draw raw landmarks.

Create four screen-anchored zones.

Detect wrist entry/exit for each zone.

Display a clear hit indicator and basic debug telemetry.

No music. No scoring. No TouchDesigner. No polished art.

MVP 0 exit criterionMove either wrist into each target and receive reliable, low-latency zone-enter events across repeated attempts.


## MVP 1 — Make It a Rhythm Game

Use one legally usable/local development track.

Create one manually authored JSON beatmap first.

Implement playback adapter and authoritative clock.

Spawn/schedule notes against timestamps.

Implement PERFECT / GOOD / MISS and combo/score.

Create start, pause, calibration placeholder, play, and results states.

Add simple PixiJS targets and procedural player visualization.

MVP 1 exit criterionOne full song is playable from start to finish with understandable timing feedback and repeatable scoring.


## MVP 2 — Generate a Map

Build a separate analysis tool/path that accepts permitted audio.

Decode audio to PCM and test @audio/beat BPM/onset/beat output.

Persist raw analysis metadata for debugging.

Build choreography generator v1.

Generate Easy/Normal maps using density + travel-distance rules.

Compare generated map against the handmade reference map.

MVP 2 exit criterionA song can be analyzed once and produce a deterministic, reasonably playable generated chart without hand-entering every note.


## MVP 3 — YouTube Playback

Integrate official visible YouTube IFrame player.

Create a YouTube PlaybackAdapter around player state and getCurrentTime().

Bind a cached map to a specific video ID.

Handle play/pause/buffering/seeking explicitly.

Test drift and perceived timing over an entire song.

Add per-device/user offset calibration if required.

MVP 3 exit criterionA permitted artist's YouTube upload can drive a cached map with acceptable perceived synchronization while the official player remains visible and functional.


## MVP 4 — Map Editor / Curation

Timeline/waveform or event-lane editor.

Move/add/delete notes.

Change target/limb/type.

Loop and replay a small section.

Mark map as curated and retain generator provenance.

Export/import versioned beatmap JSON.


## MVP 5 — Visual / Installation Experiments

Add richer procedural visual themes.

Create renderer-independent event bus.

Prototype optional TouchDesigner event adapter.

Experiment with projection or large-screen mode.

Only add 3D if the game concept actually benefits from depth.


# 16. Recommended Repository Structure

src/  app/    routes/    screens/  game/    engine/      GameClock.ts      GameEngine.ts      NoteJudge.ts      CollisionSystem.ts      ScoreSystem.ts    maps/      schema.ts      validator.ts    choreography/      generator.ts      ergonomics.ts  pose/    MediaPipePoseProvider.ts    poseTypes.ts    transforms.ts  playback/    PlaybackAdapter.ts    LocalAudioAdapter.ts    YouTubeAdapter.ts  render/    pixi/      GameRenderer.ts      ProceduralPlayer.ts      TargetRenderer.ts      Effects.ts  analysis/    AudioAnalyzer.ts    AudioBeatAnalyzer.ts  events/    GameEventBus.ts  ui/    components/  debug/    telemetry.tsmaps/  fixtures/  generated/tests/  engine/  choreography/  maps/


# 17. Key Interfaces

interface PlaybackAdapter {  play(): Promise<void> | void;  pause(): void;  getCurrentTimeMs(): number;  getState(): 'idle' | 'playing' | 'paused' | 'buffering' | 'ended';}interface PoseSnapshot {  timestampMs: number;  landmarks: Record<string, { x: number; y: number; visibility?: number }>;}interface GameEvent {  type: 'NOTE_HIT' | 'NOTE_MISS' | 'COMBO_CHANGED' | 'BEAT';  timestampMs: number;  payload?: unknown;}interface AudioAnalysis {  bpm: number;  confidence: number;  beatsMs: number[];  onsetsMs: number[];}


# 18. Testing Strategy

Unit-test timing judgment around exact window boundaries.

Unit-test collision with mirrored/non-mirrored coordinates.

Unit-test map schema validation and migrations.

Unit-test choreography travel-distance constraints and deterministic seeding.

Use fake PlaybackAdapter clocks for deterministic engine tests.

Keep recorded pose-coordinate fixtures so collision/gameplay tests do not require a live webcam.

Add a developer debug HUD for FPS, pose Hz, current song time, active note, hit delta, and confidence.

Perform real-device manual tests on at least a laptop webcam and one external/alternate camera when available.


# 19. Explicit Non-Goals for the First Build

No multiplayer.

No accounts/social graph.

No backend unless a real requirement appears.

No community map marketplace.

No full-body choreography grading.

No 3D avatar system.

No AI-generated choreography requirement.

No automatic YouTube audio extraction.

No TouchDesigner dependency.

No attempt to support every song before one song feels good.

No premature mobile support; full-body camera framing on phones is a separate UX problem.


# 20. Open Questions to Learn Through Prototyping

Is MediaPipe wrist tracking responsive enough for satisfying rhythm judgment on typical laptops?

What pose inference rate gives the best CPU/latency tradeoff?

How large should screen zones be to feel intentional rather than frustrating?

Should notes require zone entry, dwell, velocity, or directional crossing?

How much YouTube timing jitter/drift is perceptible in this style of game?

What calibration model is necessary: global offset, input offset, or both?

Can @audio/beat produce useful candidates across the music styles we care about?

What rules make auto-generated choreography feel musical rather than random?

Does showing the webcam improve playability, or is an abstract procedural player enough?

Which visual effects remain readable while the player is moving quickly?


# 21. Instructions for Claude

Treat this document as product/architecture intent, not permission to build every future feature. Work incrementally. The immediate assignment is MVP 0 only unless explicitly told to advance.

Read the entire spec before proposing implementation.

Start by writing a short MVP 0 implementation plan and identify any technical assumptions that must be validated.

Preserve the architecture boundaries: pose provider, game engine, playback adapter, renderer, and React UI should not become one coupled component.

Do not introduce a backend, Next.js, TouchDesigner, 3D engine, state-management framework, or additional heavy dependency without a demonstrated requirement.

Prefer small pure TypeScript modules for coordinate transforms, collision, timing, and scoring so they are testable.

Build debug visualization before aesthetic visualization.

Do not silently advance to MVP 1. Stop when MVP 0 exit criteria are met and present results/limitations for review.

When a library/API assumption is uncertain, verify current official documentation before coding around it.

Keep a short decision log for changes to the decisions in this spec.


# 22. Definition of Success

The project succeeds even before it becomes a polished product if it demonstrates a convincing interaction: a person stands in front of a normal webcam, music plays, targets arrive on beat, their physical movement becomes input, and the screen responds immediately. The engineering should make that interaction feel reliable enough that the technology disappears and the player wants to try another song.


# 23. Current Technical Reference Notes

These references were checked while preparing this spec. Re-check them when implementing or before launch because APIs, licenses, and policies can change.

YouTube IFrame Player API: https://developers.google.com/youtube/iframe_api_referenceOfficial API supports embedded playback controls/state and getCurrentTime().

YouTube Developer Policies: https://developers.google.com/youtube/terms/developer-policiesDo not separate/isolate/modify audio or video components; preserve player functionality.

YouTube Policy Guide: https://developers.google.com/youtube/terms/developer-policies-guideOfficial compliance examples for visible/standard player experience.

MediaPipe Pose Landmarker: https://ai.google.dev/edge/mediapipePose tracking family; current docs expose 33 pose landmarks and live/video modes.

PixiJS Renderers: https://pixijs.com/8.x/guides/components/renderersWebGL/WebGL2 renderer is the stable recommended production renderer in PixiJS 8 docs.

@audio/beat: https://github.com/audiojs/beatOnset detection, tempo estimation, and beat tracking on raw samples; browser and Node support.

Meyda: https://github.com/meyda/meydaJavaScript audio feature extraction; offline and Web Audio realtime support.

Essentia.js: https://github.com/MTG/essentia.jsWebAssembly-backed music/audio analysis; powerful but heavier and currently AGPL-3.0 in the repository.

TouchDesigner licensing: https://derivative.ca/UserGuide/TouchDesigner_ProductsNon-Commercial is free for non-paying use with limits; Commercial is required for paid work.

# 24. Target Layouts and Player Positioning

Added after MVP 1. This section is normative and takes precedence where it
overlaps §3 and §6, which state the same principle less explicitly.


## The principle

**Targets are fixed. The player positions themselves to the targets. Never the
reverse.**

A target's coordinates belong to the game mode, not to whoever is standing in
front of the camera. They are the same on every run, for every player, on every
machine.

This is not a stylistic preference. Body-fitted targets break three things at
once:

- **Learnability.** Muscle memory is most of what a rhythm game trades in, and
  it requires the upper-left target to be where it was yesterday.
- **Difficulty.** The travel distance between two notes — and therefore whether
  a pattern is playable at tempo — must not depend on the player's build or
  where they happened to stand.
- **Comparability.** Two people playing the same chart must be playing the same
  chart.

The corollary is that a player who cannot reach a target has a *positioning*
problem, and the software's job is to say so and help, not to quietly redefine
the game.


## Target layouts

A layout is a named, fixed set of targets belonging to a game mode.

    TargetLayout
      id            stable identifier, referenced by beatmaps
      name          human-readable
      zones         fixed normalised coordinates and radii

MVP 0 and MVP 1 define one layout, `corners4`: four targets at the corners of
the play field, per §6.

Later modes may define others — a six-target layout, a layout using floor
positions for footwork, a wide layout for projection. **Every one of them
inherits this section's requirement.** A mode does not get to opt out of fixed
positions because its layout is unusual.

A beatmap references the layout it was authored against. A chart written for
`corners4` is not automatically playable on a six-target layout, and the map
schema should say which it needs rather than assume.


## The positioning requirement

Before play begins, in every mode, the player must be positioned such that
**every target in the active layout is reachable**.

The check is generic over layouts: it takes the layout's zones and the player's
pose, and reports which targets are reachable, which are not, and what the
player should change. It must never modify the layout.

The physical basis is that reach in *screen* space depends on distance from the
camera. Close to the lens, an arm span covers most of the frame; far away, very
little. So:

- targets out of reach -> **move closer to the camera**
- body cropped by the frame -> **move further away**
- reach lopsided -> **centre yourself**

There is a workable band between those two, and finding it is the player's
side of the calibration.


## What may be adjusted

Target **size** is a legitimate accessibility and difficulty setting, and may be
changed by the player at any time, including during play. Size does not move a
target or change which layout is in use, so it does not violate this section.

Target **position** is not adjustable. If a future mode needs targets somewhere
else, that is a new layout with a new id, not a per-player adjustment.


## Testing

- A positioning check must be proven unable to modify the layout it inspects.
- Reach advice must be monotonic: approaching the camera must never reduce the
  number of reachable targets.
- Every layout ships with a test that all of its targets fit on screen.


# 25. Deprecation — camera tracking

Recorded after MVP 1. **Camera-based tracking is deprecated.** It is not
deleted, not broken, and not disowned — it is closed to further work.

## Status

Everything built for it stays in the repository and keeps working:
pose tracking, hand tracking, the zone tracker, positioning, target layouts,
game modes and their tests. MVP 0's result stands: a normal webcam was proven
to be a viable controller, at roughly 28 ms of input latency, and that finding
does not expire because the direction changed.

## What deprecated means here

- **No new features** are built on camera input.
- **No further tuning** of calibration, positioning, hit detection, gesture
  recognition or tracking backends.
- Existing behaviour is **left as it is**. Bugs in it are not fixed unless
  something else depends on them.
- §24's positioning rules still describe how camera modes behave, and remain
  binding on any camera mode that is ever revived.

## Why

Not a technical failure. The controller met its exit criterion and the timing
pipeline is sound. Four specific things are unsolved, and they are the reason:

**Haptics.** There are none. Hitting a target in the air feels like nothing at
all, because nothing is there. DDR works partly because a foot lands on a pad
and the body registers the impact without needing to be told. Waving at a
screen has no equivalent, and no amount of visual polish substitutes for it.

**Camera latency.** ~28 ms measured, before any judgment logic runs, which is a
third of a ±80 ms window spent before the player's movement is even seen. It is
survivable but it is not free, and it stacks with everything else.

**Visual feedback is not yet understood.** How to signal an incoming note, a
landed hit and a miss — at a size and pace readable while moving fast — is a
real design problem that has not been solved here. Approach rings were a first
attempt, not an answer.

**Hitting beats is awkward.** Reported repeatedly and never fully fixed: hits
that do not register, targets that are hard to reach, difficulty telling which
of several targets is next. Each round improved something and the whole never
became comfortable.

Alongside that, the effort was going to the wrong place: across the sessions
after MVP 0, nearly all work was in the input layer and almost none was the
rhythm game. An input method needing that much attention before the game
underneath can be judged is absorbing the project rather than serving it.

## Ideas worth trying if this is revived

Kept because the goal has not changed — *"I would so love to play DDR"* — and
because these were not tried.

**Use the floor.** Feet, not hands. This is where DDR's haptics actually come
from: the ground stops your foot and your body feels it, for free, with no
hardware. It also removes the reach problem entirely — a floor target is
reachable by definition — and MediaPipe already returns ankle and foot
landmarks.

**Audio as the missing sense.** A percussive click on every hit, immediately,
before any scoring is resolved. Sound is the fastest feedback channel available
and needs no hardware. Rhythm players lean on it far more than on visuals.

**A phone in each hand.** Real vibration, real haptics, and an accelerometer
with none of the camera's latency. Costs a pairing step and a transport, but it
is the only route to genuine touch feedback.

**Predictive compensation.** The wrist's velocity is known, so its position can
be extrapolated forward by the measured latency. Fights the pipeline delay
rather than accepting it.

**Fire on the way in, not at arrival.** A strike could be judged at the moment
the hand commits — a velocity threshold toward a target — rather than when it
arrives. That is earlier than the geometric crossing and closer to when the
player believes they hit.

**Fewer, larger, and one at a time.** Reachability and readability both improve.
The easy chart moved in this direction and helped; it may not have gone far
enough.

## What survives independently

The parts worth keeping are the parts that never knew about a camera:

- `GameClock` — an authoritative playback clock with bias correction
- `NoteJudge`, `ScoreSystem`, `GameEngine` — pure, clock-free, tested
- the beatmap schema, validator and hand-authored patterns
- the PixiJS renderer
- `PlaybackAdapter` and the click-track and local-audio sources

The engine consumes `ZoneEvent`s and has never known where they came from.
That boundary, set in MVP 0, is what makes this deprecation cheap: another
input source can be attached without touching anything above it.


End of specification
