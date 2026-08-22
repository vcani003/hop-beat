# Nekodancer — recreation plan

**Status: research and plan. No code written.**

A recreation of [Nekodancer](https://atelier801.fandom.com/wiki/Nekodancer)
(Atelier 801, released 24 July 2014): a browser rhythm game where a cat avatar
dances to falling arrows, played against other people in rooms, to music the
players themselves queue from YouTube.

---

## 1. Why this is a good pivot

Every problem that parked hop//beat's camera tracking (spec §25) disappears:

| hop//beat problem | Nekodancer |
|---|---|
| No haptics — hitting air feels like nothing | **Keys.** Your finger hits something solid, every time |
| ~28 ms camera latency before judgment | **~0.** A keydown is an event, not an inference |
| Visual feedback not understood | **Solved by the genre.** Falling arrows into a receptor is thirty years old and readable |
| Awkward to hit beats | Four keys, four lanes, no reach, no calibration |

And it is the same *game* underneath. The engine hop//beat already has — an
authoritative clock, note judgment, scoring — is input-agnostic by design and
does not care whether an event came from a wrist or a key.

---

## 2. What the original does

Gathered from the Atelier 801 forums and wikis; details marked *(unconfirmed)*
need checking against the real game.

### Core loop

- Arrows scroll toward a receptor. Player presses **arrow keys or WASD**.
- Judgments, best to worst: **Perfect · Nice · Okay · Oops · Miss**.
  Five tiers, not three — a meaningfully finer grain than hop//beat's.
- **No randomness.** Rating is purely precision.

### Scoring

- A Perfect at zero combo is **7 points**, doubled to **14** by an ×2
  multiplier.
- Combo rises with consecutive correct inputs and **resets on error**.
- Higher combo multiplies the points each arrow is worth.
- **5 points for completing a song** all the way through.

### Health

- Every round starts with a **full health bar**.
- Missing an arrow, or hitting a wrong key, drains it.
- Correct inputs **restore** it.

This is the mechanic hop//beat lacks entirely, and it changes the feel: a run
can end badly rather than merely scoring low.

### Power-ups

Special arrows fire an effect at a **random opponent** for 3–10 seconds:

| Effect | Does |
|---|---|
| Short | Shrinks the visible arrow area to about ⅛ of the screen |
| Wave | Arrows swerve horizontally |
| Speed | Arrows come faster |
| Blink | Arrows flash slowly |
| Heart | *(positive, on yourself)* Refills the health bar |

### Music — and the finding that matters

- Players paste **YouTube links** into a personal playlist, **max 10 songs**.
- A song limit around **3:05** *(one source)* or **4 min 30 s** *(another)* —
  **unconfirmed**, needs checking.
- **~15 second setup window** between rounds.
- The top-ranked player **chooses the next song**.
- You need songs in your own playlist to earn scoreboard points.

> **On first add, a song is "Processed" — the game generates its notes
> automatically, once.**

That is not a detail. It is hop//beat's **MVP 2** (offline analysis and
choreography generation) and **MVP 3** (YouTube as the playback source), and it
is load-bearing rather than optional: without generation there is no content,
because the content is whatever the players paste in.

### Rooms and social

- **Rooms** with several players, competing on a live scoreboard.
- **Training rooms** — private, friends only, for practising a specific song.
- **Sushi**, the currency, earned by finishing a round **in a room with 2+
  players**. Solo play and alt accounts earn none.
- Multiple **servers/communities**, **chat**, **friends**, **levels**,
  **accessories and custom avatars**. Largely **free to play**.

---

## 3. What transfers from hop//beat

Roughly the whole engine, which is the argument for doing this here rather than
starting cold.

**Transfers directly**

- `GameClock` — authoritative playback clock, interpolated, with minimum-drift
  bias correction. Written against an interface, so a YouTube player satisfies
  it the same way the click track does.
- `PlaybackAdapter` + the click-track and local-audio sources.
- Beatmap schema, validator, and the versioning discipline around them.
- The whole testing approach: pure engine, fake clocks, no hardware.

**Transfers with work**

- `NoteJudge` — three judgments become five, and lanes replace zones.
- `ScoreSystem` — different formula, plus health, which is new.
- `GameEngine` — same shape; notes arrive on a clock and are judged.
- The PixiJS renderer — the harness and effect pooling survive; a scrolling
  four-lane field is new drawing.

**Does not transfer**

- Everything camera. Untouched, still playable, still deprecated per §25.
- Positioning, layouts, target sizing, gestures.

**Genuinely new**

- Falling-arrow field, receptor line, scroll speed.
- Health, power-ups.
- **YouTube IFrame playback as the clock source.**
- **Automatic chart generation from audio.**
- Accounts, rooms, chat, friends, levels, currency, cosmetics — all server-side.

---

## 4. The thing to be honest about: this needs a backend

hop//beat's §19 says "no backend unless a real requirement appears." Multiplayer
rooms, chat, friends, accounts, currency and cosmetics **are** that requirement.
There is no way to do the social half client-side.

That makes this a different project in a way the pivot from webcam to keyboard
does not. It is worth deciding deliberately rather than drifting into it.

---

## 5. Proposed staging

Ordered so something is playable early and nothing large is built on an
unproven assumption.

**Stage 0 — arrows, keys, one hand-written chart**
Four lanes, falling arrows, five judgments, combo, health. Keyboard input into
the existing engine. One chart by hand against local audio. No YouTube, no
network, no cat.
*Done when: a chart is playable end to end and the timing feels right.*
This is small. Most of it already exists.

**Stage 1 — the cat, and the game around the round**
Avatar reacting to hits and misses, results screen, song select, the feel.
*Done when: it is enjoyable alone.*

**Stage 2 — YouTube playback**
IFrame player as clock source. §11's rights position already covers this, and
§25's clock work already handles a source that buffers and drifts.
*Done when: a YouTube track drives a chart in sync for a whole song.*

**Stage 3 — automatic chart generation**
Analyse audio, place arrows. The hard, interesting, and unavoidable part —
without it there is no content.
*Done when: a pasted song produces a chart worth playing.*

**Stage 4 — multiplayer**
Backend, accounts, rooms, live scoreboard, chat. The largest stage by far, and
the first that cannot be undone cheaply.

**Stage 5 — progression**
Levels, sushi, shop, accessories, custom avatars, friends.

**Power-ups** land naturally at Stage 4, since their whole point is affecting
someone else.

---

## 6. Open questions

- **Repository.** Same repo as hop//beat, sharing the engine? A sibling repo
  with the engine extracted as a shared package? Or standalone, copying what it
  needs? Sharing is cleaner but couples two projects moving at different speeds.
- **How faithful?** A recreation of the 2014 game, or that game as a starting
  point for something of your own?
- **Backend, when.** Stages 0–3 need none. Committing to one early shapes
  everything after it.
- **The song limit** and several scoring specifics are unconfirmed above and
  should be checked against the real game before being built to.
