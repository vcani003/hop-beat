/**
 * Where the project actually is against docs/SPEC.md.
 *
 * Structured data rather than a hand-written page, for two reasons: marking
 * something done is a one-line edit that cannot quietly disagree with the
 * prose around it, and the whole thing can be checked by tests — every
 * completed milestone must have its exit criterion met, every answered
 * question must cite evidence, and every decision listed here must exist in
 * docs/DECISIONS.md.
 *
 * The roadmap and task lists are transcribed from SPEC.md §15; the open
 * questions from §20. Keep the wording faithful to the spec so the two can be
 * compared.
 */

export type Status = 'done' | 'active' | 'todo';

/**
 * A capability the project has stopped developing.
 *
 * Deprecated is not deleted and not failed. It records that work has closed on
 * something, and why, so the reason survives longer than the conversation that
 * produced it.
 */
export interface Deprecation {
  subject: string;
  /** Spec section stating the terms. */
  specSection: string;
  summary: string;
  /** Things that were established and still hold. */
  stillTrue: string[];
}

export const DEPRECATIONS: Deprecation[] = [
  {
    subject: 'Camera-based tracking',
    specSection: '§25',
    summary:
      'Closed to further work after MVP 1. The code stays and keeps working; no new features, no further tuning. Not a technical failure — the controller met its exit criterion at ~28 ms of input latency. The reason is that nearly every change after MVP 0 was to the input layer and almost none was to the rhythm game.',
    stillTrue: [
      'A normal webcam was proven to be a viable controller — MVP 0’s exit criterion was met and signed off in play.',
      'The engine consumes ZoneEvents and has never known where they come from, so another input source attaches without touching the clock, judgment, scoring, charts or renderer.',
      'Spec §24 still binds any camera mode that is ever revived.',
    ],
  },
];

export interface Task {
  title: string;
  status: Status;
  /** How we know it is done, or what is blocking it. */
  note?: string;
}

export interface Milestone {
  id: string;
  title: string;
  goal: string;
  status: Status;
  exitCriterion: string;
  exitMet: boolean;
  tasks: Task[];
}

export interface OpenQuestion {
  number: number;
  question: string;
  /** Undefined while the question is still open. */
  answer?: string;
  /** What we measured or observed. Required whenever there is an answer. */
  evidence?: string;
  /** True when the answer is real but provisional. */
  partial?: boolean;
}

export interface DecisionEntry {
  number: number;
  /** Must match a "### N. Title" heading in docs/DECISIONS.md. */
  title: string;
  summary: string;
  /** Set when this decision overturned an earlier one. */
  corrects?: string;
}

export const MILESTONES: Milestone[] = [
  {
    id: 'mvp0',
    title: 'MVP 0 — Prove the Controller',
    goal: 'Answer one question only: can a normal webcam reliably become the input device?',
    status: 'done',
    exitCriterion:
      'Move either wrist into each target and receive reliable, low-latency zone-enter events across repeated attempts.',
    exitMet: true,
    tasks: [
      { title: 'Create Vite + React + TypeScript project', status: 'done' },
      { title: 'Request webcam permission and render mirrored preview', status: 'done', note: 'Mirroring is an explicit, tested coordinate transform — see transforms.ts' },
      { title: 'Integrate MediaPipe Pose Landmarker', status: 'done', note: 'Runtime and models vendored locally; no CDN in the startup path' },
      { title: 'Draw raw landmarks', status: 'done', note: 'Canvas 2D, tinted by confidence' },
      { title: 'Create four screen-anchored zones', status: 'done', note: 'Normalised coordinates, circular in pixels rather than in normalised units' },
      { title: 'Detect wrist entry/exit for each zone', status: 'done', note: 'Hysteresis, exit grace and a visibility gate; refusals are reported, not silent' },
      { title: 'Display a clear hit indicator and basic debug telemetry', status: 'done', note: 'Canvas ripple on entry; HUD reports pose rate, inference cost and input latency' },
    ],
  },
  {
    id: 'mvp1',
    title: 'MVP 1 — Make It a Rhythm Game',
    goal: 'One song playable start to finish with understandable timing feedback and repeatable scoring.',
    status: 'active',
    exitCriterion:
      'One full song is playable from start to finish with understandable timing feedback and repeatable scoring.',
    exitMet: false,
    tasks: [
      { title: 'Use one legally usable/local development track', status: 'done', note: 'A click track we synthesise ourselves, plus the player\u2019s own audio loaded at runtime and never committed' },
      { title: 'Create one manually authored JSON beatmap first', status: 'done', note: 'maps/fixtures/click-120-warmup.json — 54 notes, hand-written' },
      { title: 'Implement playback adapter and authoritative clock', status: 'done', note: 'Interpolated, with minimum-drift bias correction; YouTube slots in behind the same interface at MVP 3' },
      { title: 'Spawn/schedule notes against timestamps', status: 'done', note: 'Approach rings converge on their target at the note\u2019s time' },
      { title: 'Implement PERFECT / GOOD / MISS and combo/score', status: 'done', note: '±80 / ±160 ms, judged at the camera-frame time the input actually happened' },
      { title: 'Create start, pause, calibration, play and results states', status: 'done', note: 'Calibration is real rather than a placeholder — it fits the play field to the player\u2019s reach' },
      { title: 'Add simple PixiJS targets and procedural player visualization', status: 'done', note: 'Approach rings, skeleton, wrist trails, judgment ripples' },
    ],
  },
  {
    id: 'mvp2',
    title: 'MVP 2 — Generate a Map',
    goal: 'Analyse a song once and produce a deterministic, reasonably playable generated chart.',
    status: 'todo',
    exitCriterion:
      'A song can be analyzed once and produce a deterministic, reasonably playable generated chart without hand-entering every note.',
    exitMet: false,
    tasks: [
      { title: 'Build a separate analysis tool/path that accepts permitted audio', status: 'todo' },
      { title: 'Decode audio to PCM and test @audio/beat BPM/onset/beat output', status: 'todo' },
      { title: 'Persist raw analysis metadata for debugging', status: 'todo' },
      { title: 'Build choreography generator v1', status: 'todo' },
      { title: 'Generate Easy/Normal maps using density + travel-distance rules', status: 'todo' },
      { title: 'Compare generated map against the handmade reference map', status: 'todo' },
    ],
  },
  {
    id: 'mvp3',
    title: 'MVP 3 — YouTube Playback',
    goal: "Drive a cached map from an artist's official upload, with the player visible and functional.",
    status: 'todo',
    exitCriterion:
      "A permitted artist's YouTube upload can drive a cached map with acceptable perceived synchronization while the official player remains visible and functional.",
    exitMet: false,
    tasks: [
      { title: 'Integrate official visible YouTube IFrame player', status: 'todo' },
      { title: 'Create a YouTube PlaybackAdapter around player state and getCurrentTime()', status: 'todo' },
      { title: 'Bind a cached map to a specific video ID', status: 'todo' },
      { title: 'Handle play/pause/buffering/seeking explicitly', status: 'todo' },
      { title: 'Test drift and perceived timing over an entire song', status: 'todo' },
      { title: 'Add per-device/user offset calibration if required', status: 'todo' },
    ],
  },
  {
    id: 'mvp4',
    title: 'MVP 4 — Map Editor / Curation',
    goal: 'Curate what the generator produced.',
    status: 'todo',
    exitCriterion: 'Not stated in the spec — curation tooling is judged by use.',
    exitMet: false,
    tasks: [
      { title: 'Timeline/waveform or event-lane editor', status: 'todo' },
      { title: 'Move/add/delete notes', status: 'todo' },
      { title: 'Change target/limb/type', status: 'todo' },
      { title: 'Loop and replay a small section', status: 'todo' },
      { title: 'Mark map as curated and retain generator provenance', status: 'todo' },
      { title: 'Export/import versioned beatmap JSON', status: 'todo' },
    ],
  },
  {
    id: 'mvp5',
    title: 'MVP 5 — Visual / Installation Experiments',
    goal: 'Richer procedural themes, and optional renderers beyond the browser.',
    status: 'todo',
    exitCriterion: 'Not stated in the spec — experimental by design.',
    exitMet: false,
    tasks: [
      { title: 'Add richer procedural visual themes', status: 'todo' },
      { title: 'Create renderer-independent event bus', status: 'todo' },
      { title: 'Prototype optional TouchDesigner event adapter', status: 'todo' },
      { title: 'Experiment with projection or large-screen mode', status: 'todo' },
      { title: 'Only add 3D if the game concept actually benefits from depth', status: 'todo' },
    ],
  },
];

export const OPEN_QUESTIONS: OpenQuestion[] = [
  {
    number: 1,
    question: 'Is MediaPipe wrist tracking responsive enough for satisfying rhythm judgment on typical laptops?',
    answer: 'Responsive enough to build on. Whether it is satisfying awaits real judgment logic in MVP 1.',
    evidence: '~28 ms end-to-end input latency, 30 Hz pose rate, ~18 ms mean inference on a laptop webcam.',
    partial: true,
  },
  {
    number: 2,
    question: 'What pose inference rate gives the best CPU/latency tradeoff?',
    answer: 'Does not matter on this hardware. Choose the model for landmark quality, not for speed.',
    evidence: 'All four lite/full × GPU/CPU combinations finish well inside the 33 ms budget of a 30 fps camera, and are perceptually identical in play.',
  },
  {
    number: 3,
    question: 'How large should screen zones be to feel intentional rather than frustrating?',
    answer: 'Not one number — it needs to be adjustable without leaving the game.',
    evidence:
      'A size settled while standing still felt too small once notes arrived on a clock, and there was no way to change it mid-play. Size is now bound to a key and adjustable during a song. Spec §24 permits this because size moves no target.',
    partial: true,
  },
  {
    number: 4,
    question: 'Should notes require zone entry, dwell, velocity, or directional crossing?',
    answer: 'Entry — but of the PATH between pose samples, not of the sampled positions.',
    evidence:
      'At 26–30 Hz a fast arm extension crosses a whole zone between two samples, so testing sampled positions alone drops hits that visibly happened. Sweeping the segment also lets the crossing be timestamped by interpolation.',
    partial: true,
  },
  {
    number: 5,
    question: 'How much YouTube timing jitter/drift is perceptible in this style of game?',
  },
  {
    number: 6,
    question: 'What calibration model is necessary: global offset, input offset, or both?',
  },
  {
    number: 7,
    question: 'Can @audio/beat produce useful candidates across the music styles we care about?',
  },
  {
    number: 8,
    question: 'What rules make auto-generated choreography feel musical rather than random?',
  },
  {
    number: 9,
    question: 'Does showing the webcam improve playability, or is an abstract procedural player enough?',
    answer: 'The abstract figure is enough. The camera feed is off by default.',
    evidence: 'Played through MVP 0 with the video hidden and only the skeleton drawn, without loss of control.',
  },
  {
    number: 10,
    question: 'Which visual effects remain readable while the player is moving quickly?',
  },
];

export const DECISIONS: DecisionEntry[] = [
  {
    number: 1,
    title: 'Canvas 2D for MVP 0, PixiJS deferred to MVP 1',
    summary:
      'A GPU scene graph would sit between the pose data and the screen exactly when that data most needs to be seen unfiltered. PixiJS arrives with the targets that justify it.',
  },
  {
    number: 2,
    title: 'Pose assets vendored locally, not loaded from a CDN',
    summary:
      'A rhythm game that stalls mid-song on a network hiccup is a broken rhythm game. ~50 MB of derived assets, gitignored and reproducible from a script.',
  },
  {
    number: 3,
    title: 'Zones are circular in PIXELS, not in normalised units',
    summary:
      'Normalised 0–1 coordinates on a 16:9 screen describe an ellipse. Vertical offsets are scaled by 1/aspect so a zone is round where the player sees it.',
  },
  {
    number: 4,
    title: 'Zone entry needs three guards, not a radius test',
    summary:
      'Hysteresis for positional jitter, an exit grace period for tracking dropout, a visibility gate for extrapolated landmarks. A plain radius test produces unusable events.',
  },
  {
    number: 5,
    title: '`presentationTime`, not `captureTime`, is the frame clock on macOS',
    summary:
      'captureTime is not exposed here, so frame times include compositor delay. Frames carry a suspect flag rather than hiding it, because MVP 1 calibrates against this number.',
  },
  {
    number: 6,
    title: 'Two clocks in the React layer',
    summary:
      'The pose and render loops touch only refs; a 5 Hz interval publishes a summary to React. Feedback the player feels is drawn on canvas, never rendered by React.',
  },
  {
    number: 7,
    title: 'Refused hits are reported, not merely refused',
    summary:
      'A diagnostic ZONE_BLOCKED event, once per approach, says whether a hit was missed by the model, by the geometry, or by our own settings — three problems with three different fixes.',
  },
  {
    number: 8,
    title: 'Sessions are recorded and exportable',
    summary:
      'The fastest gap between accepted hits on one target bounds playable tempo. Exported JSON carries the tuning and the machine, because a latency figure without them is not evidence.',
  },
  {
    number: 9,
    title: 'Settings persist to localStorage',
    summary:
      'These values are tuning found in front of a camera, not preferences. Corrupt stored data falls back to defaults rather than throwing.',
  },
  {
    number: 10,
    title: 'Model and delegate are interchangeable on this hardware',
    summary:
      'Every combination finishes inside the frame budget, so the difference lands in slack rather than in felt latency. Choose for landmark quality.',
  },
  {
    number: 11,
    title: 'A synthesised click track is the MVP 1 development track',
    summary:
      'A metronome we generate needs no licence review and has a tempo we know exactly, so a chart can be checked by ear with no analysis step. AudioContext.currentTime is also the most accurate clock available in a browser.',
  },
  {
    number: 12,
    title: 'The clock corrects bias by minimum drift, not by average drift',
    summary:
      'Starting an audio context leaves a constant lead that can sit under the resync threshold forever. Correcting toward the MEAN would instead invent a lag on any source that reports coarsely; the minimum measures real bias and ignores coarseness.',
  },
  {
    number: 13,
    title: 'Collision sweeps the path between pose samples',
    summary:
      'A hand moving fast crosses a zone entirely between two frames, so every sampled position is outside a target it visibly hit. Sweeping the segment fixes that and dates the crossing by interpolation.',
  },
  {
    number: 14,
    title: 'The player is guided into position; the targets never move',
    summary:
      'Targets stay at fixed screen coordinates so they can be learned, so a chart\u2019s difficulty means something, and so two people can compare scores. Calibration tells the player where to stand instead — reach in screen space depends on distance from the camera, so an unreachable corner is solved by stepping closer.',
    corrects:
      'an earlier version that fitted the targets to the player, which spec §3 rules out',
  },
  {
    number: 15,
    title: 'Camera tracking is deprecated',
    summary:
      'Closed to further work, not deleted. Not a verdict on whether it worked — MVP 0 passed — but on where the effort was going: after MVP 0 nearly every change was input-layer, and almost none was the game. Cheap to do because the engine never knew where its input came from.',
  },
];

/** Roll-up used by the progress page header. */
export function taskTotals(milestones: readonly Milestone[] = MILESTONES) {
  const tasks = milestones.flatMap((m) => m.tasks);
  return {
    done: tasks.filter((t) => t.status === 'done').length,
    total: tasks.length,
    milestonesDone: milestones.filter((m) => m.status === 'done').length,
    milestonesTotal: milestones.length,
  };
}

export function questionTotals(questions: readonly OpenQuestion[] = OPEN_QUESTIONS) {
  return {
    answered: questions.filter((q) => q.answer && !q.partial).length,
    partial: questions.filter((q) => q.answer && q.partial).length,
    open: questions.filter((q) => !q.answer).length,
    total: questions.length,
  };
}
