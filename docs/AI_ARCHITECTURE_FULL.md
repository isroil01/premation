# Premation AI — Complete Architecture Reference

**Scope:** every AI surface in `motion-editor` (Electron/React editor + its `packages/*`) and
`motion-back` (NestJS + Postgres/Prisma). Logic, data shapes, prompts, UI, workflows, cost,
measured results, and the gaps that are still real.

**Read date:** 2026-08-04 · motion-editor `dev` @ `b31117d` (v0.3.0) · motion-back `main` @ `b3c21a9`
**Method:** every file under `motion-editor/src/core/ai`, `motion-editor/packages/{caster,ai-tools,technique-library,design-system,product-motion}`, the AI UI surfaces, `electron/ai*`, and all of `motion-back/src/ai` was read. Counts below are measured, not estimated.

> This supersedes the 2026-07-28 `AI_ARCHITECTURE_FULL.md` (deleted from `dev`). Section 17 lists
> what changed since then — six of that audit's seven ranked findings are fixed.

---

## 1. The thesis in one paragraph

**The LLM casts; code emits.** A model is good at deciding *what a piece is about* and *which of N
authored options fits* — and bad at authoring a bezier, a stagger interval, or a hex value it cannot
see the result of. So the generative path spends exactly **three model calls on decisions** (a
creative brief, a layout cast, a motion cast), and every keyframe, curve, colour and offset is
produced by hand-authored libraries that three linters verify before anything executes. The quality
floor stops being stochastic. The project's own acceptance test is *swap in a weak model, or a stub
returning nonsense, and the output still passes every linter* — `packages/caster/src/caster.test.ts`
asserts it.

Everything else in this document is the machinery that makes that true, plus the two older paths
kept behind it as fallbacks.

---

## 2. System map

```
                       ┌─────────────────────────── motion-editor (renderer) ───────────────────────────┐
   user prompt ──────► │  AiChatPanel ──► useAiChat ──► runAgent (AgentLoop)                            │
                       │                                    │                                           │
                       │                    classifyPrompt(prompt)                                      │
                       │                    ├─ 'generative' ─┬─► [A] CasterRunner ──► @motion/caster    │
                       │                    │                │        3 model calls + 1 fit critic      │
                       │                    │                └─► [B] DirectorRunner ─► POST /ai/director/run
                       │                    └─ 'trivial_edit' ─► [C] direct tool loop (≤22 turns)       │
                       │                                                                                 │
                       │   every path executes through ONE ToolRegistry (62 tools) inside ONE            │
                       │   aiTransaction  ⇒  one prompt = one undo entry                                 │
                       └────────────────────────────────┬────────────────────────────────────────────────┘
                                                        │ provider bytes
                        ┌───────────────────────────────┴────────────────────────────┐
              server edition                                              local edition
   POST /ai/stream → motion-back gateway                        IPC ai:stream → Electron main
   (key AES-256-GCM in Postgres)                                (key in OS keystore, write-only)
                        └──────────────► provider (OpenAI / Anthropic / Gemini) ◄────┘
```

### 2.1 Code ledger (measured)

| Area | Non-test LOC | Test LOC |
|---|---:|---:|
| editor `src/core/ai` (loop, runners, tools, verify, filmstrip, design) | 7 343 | 2 301 |
| editor AI UI (`AiChatPanel`, `AiChatContext`, `useAiChat`, `AiSettingsSection`, `aiProviderStore`) | 2 538 | — |
| `electron/aiProxy.ts` + `electron/aiKeyVault.ts` | 441 | — |
| `packages/caster` | 2 007 | 1 089 |
| `packages/ai-tools` | 3 544 | 706 |
| `packages/technique-library` | 5 885 | 874 |
| `packages/design-system` | 8 040 | 666 |
| `packages/product-motion` | 3 783 | 569 |
| **motion-back `src/ai`** | **7 726** | 476 |

### 2.2 Library inventory (measured)

| Thing | Count | Where |
|---|---:|---|
| Look packs | **8** | `design-system/src/packs.ts` |
| Layout templates | **44** | `design-system/src/templates/*` (7 files) |
| Editorial motion techniques | **47** | `technique-library/src/techniques/*` |
| Product-UI motion techniques | **26** | `product-motion/src/techniques{,2,3}.ts` |
| UI component specs | **45** | `product-motion/src/components{,2,3}.ts` |
| AI tools | **62** — 8 read / 38 write / 16 compose | `ai-tools/src/tools/*` |
| Design lint rules | 14 | `design-system/src/lint.ts` |
| Timing lint rules | 11 | `technique-library/src/lint.ts` |
| UI-motion lint rules | 11 | `product-motion/src/lint.ts` |

Technique categories: `entrance` 12, `kinetic_type` 9, `camera` 6, `emphasis` 6, `background` 5,
`transition` 5, `exit` 4.

The 8 packs: `apple_keynote`, `swiss_editorial`, `broadcast_sports`, `cyberpunk_kinetic`,
`luxury_film`, `saas_explainer`, `saas_product`, `mobile_app`. The last two are the *product*
vocabularies — springs, 8–24px travel, exits faster than entrances, no motion blur, ever — and their
rules deliberately contradict the editorial library's.

---

## 3. Key custody and transport

The renderer is **keyless in both editions**. That is the design, not an accident: a compromised
renderer can *spend* the user's key but cannot *read* it.

| | server edition | local edition |
|---|---|---|
| Who holds the key | motion-back, AES-256-GCM at rest (`AI_KEY_SECRET` → scrypt → 32-byte key) | Electron main, OS keystore (`electron/aiKeyVault.ts`) |
| Who calls the provider | `AiGatewayService.openStream` | `electron/aiProxy.ts` (main-process `fetch`) |
| Read-back path for the key | **none** — `GET /ai/keys` returns `{present, hint}` only | **none** — vault is write-only |
| Wire | `POST /ai/stream`, provider SSE piped back verbatim | `ai:stream` IPC + `ai:stream:event` chunks |

`src/core/ai/aiTransport.ts` is the single seam: `streamProviderBytes()` picks the transport by
capability (`aiRunsThroughBackend()`), and both yield the same `AsyncGenerator<string>` so
`streamTurn()` has one SSE parse loop rather than two. Both throw `AiTransportError` with the same
codes, so an auth failure never flattens into "check your connection".

**SSRF guard, both sides:** the caller sends a *provider id*, never a URL. Complete URLs live in flat
maps (`AiGatewayService.ENDPOINTS`, `aiProxy.ENDPOINTS`); the one concatenation site is Gemini's
model-in-path, guarded by `SAFE_MODEL = /^[A-Za-z0-9._:-]{1,128}$/` and `encodeURIComponent`. The
image allowlist is a **separate** map (`IMAGE_ENDPOINTS`) on purpose — reusing the chat map and
appending a path is exactly the shape SSRF guards fail at. `redirect: 'error'` on the gateway fetch
stops an auth header following a provider redirect.

**Historical hole, closed:** `AiSettingsSection.tsx` used to mirror plaintext keys into
`localStorage` under `motion_editor_local_ai_key_<provider>` and re-upload them on refresh. Removed;
`src/core/api/purgeLocalKeys.ts` deletes what earlier builds wrote (matching both the exact legacy
prefix and anything `/(^|_)(api[_-]?key|key|token|secret|password)(_|$)/i`), and an ESLint rule fails
the build on new credential-shaped `localStorage` writes.

---

## 4. Edition gating — the assistant is server-only today

`src/core/config/edition.ts` exposes capability predicates, not edition checks.
`aiEnabled = () => isServerEdition()`.

This predicate has now been all three of its possible values, and the file records why:
`isServerEdition()` (backend held the key) → `() => true` (local grew a keystore path, so "coming
soon" became a false statement in the OSS README) → `isServerEdition()` again — **not** because the
local path broke. The vault, proxy, adapters, tools and runners are all untouched and all still
correct. The local edition simply does not ship the assistant as a product surface. It is a
distribution decision and a one-line flip.

Critically, the gate is **not** enforced by that predicate alone. Gating happens at the surfaces:

- panel registry (`panelAvailability.ts`) — the `ai` panel is withheld, not disabled;
- workspace presets — `ai-focus` is withheld, `default` has `ai` stripped from its sidebar;
- the Customize dialog's AI tab;
- **the main process** — `electron/edition.ts` has its own `aiEnabled()` (it must: `VITE_EDITION`
  never reaches main), and when false `registerAiKeyIpc`/`registerAiProxyIpc` are never called, so
  `ai:stream`, `ai:cancel` and `aiKeys:*` do not exist as channels at all.
  `assertRendererEditionMatches` logs loudly on a mismatch and main's gate wins.

`src/core/config/editionAiSurface.test.ts` asserts the *surfaces*, not the predicate — because the
predicate previously had zero runtime callers, so flipping it would have hidden nothing while looking
exactly like a fix.

---

## 5. Path selection

`src/core/ai/pipeline/Router.ts` — 65 lines, one pure function, no model call.

```
GENERATIVE_NOUN  /video|animation|intro|teaser|promo|explainer|reel|sequence|scene|ad|trailer|opener|montage/
TRIVIAL_VERB     /^(make|change|set|delete|remove|move|hide|show|rename|update|align|resize|rotate)\b/
TARGETS_EXISTING /\b(this|that|it|selection|selected|layer|layers|the (colou?r|title|text|background|opacity|font))\b/
```

`generative` unless the prompt is a short (<60 char) imperative pointing at something that already
exists. A generative noun outranks any verb — *"change the intro video"* is not a trivial edit.

The bias is deliberate and asymmetric: sending a brief to the direct loop produces exactly the
hand-assembled output the caster exists to replace; sending a small edit through the caster costs two
extra model calls and still does the right thing.

This was a `class Router` whose constructor took a `RouterOptions` and immediately discarded it. It
held no state and used none of the provider/dialect/model/signal it was handed.

---

## 6. Path A — the caster (primary, `casterEnabled()` default **on**)

```
prompt
  ├─▶ [LLM 1]        CREATIVE BRIEF     ← pack, energy, tone, duration, beats, art direction
  ├─▶ deterministic  SEQUENCER          ← beat grid, tag hints, CONTINUITY CONTRACT
  ├─▶ [LLM 2a]       CAST LAYOUT        ← template + seed, per beat
  ├─▶ [LLM 2b]       CAST MOTION        ← technique + params + seed, per beat
  ├─▶ deterministic  VALIDATE + REPAIR  ← reject → top-ranked valid candidate
  ├─▶ deterministic  EMIT + LINT ×N     ← 3 linters, deterministic repair, ≤2 rounds
  ├─▶ existing       EXECUTE            ← same ToolRegistry, same transaction
  └─▶ [LLM 3]        FIT CRITIC         ← one call, prose, no score
```

Host adapter: `src/core/ai/CasterRunner.ts` (602 LOC). Pure core: `packages/caster` (2 007 LOC).
`@motion/caster` calls nothing — it takes the two model stages as **injected hooks**, which is what
makes the weak-model acceptance test possible.

### 6.1 Stage 1 — the creative brief

System prompt (`cast.ts:briefPrompt`) asks for exactly three decisions: **which look pack**, **how
much energy (0..1)**, **what the beats are (3–5)**. Note what is absent: any mention of keyframes,
easing, timing, stagger or colour values.

Two structural rules are stated because a model agrees with them and then violates them anyway:

- *consecutive beats must SHARE something* — same headline, same media, or the same kind of content
  in the same place. "A sequence where every element leaves and a new set arrives is a slideshow."
- *do not describe motion* — naming an animation would override authored craft with a guess.

One field is genuinely the model's and cannot be enumerated: **`art`** — what a beat should be a
*picture of*. It exists because of a measured ceiling: the design linter's `PRIMITIVE_ONLY` rule
("Nothing in this composition is an imported or generated asset — it is entirely rectangles and
text") fired on 100% of output and no template could satisfy it, because nothing in the pipeline
could produce an image.

Response schema `BRIEF_SCHEMA`; the reference images attached to the turn reach **this stage only**
(the only stage a picture can inform), with an explicit "this is REFERENCE, do not describe it back"
instruction. Whatever comes back goes through `coerceBrief()`, which is structurally total: unknown
pack → `LOOK_PACKS[0]`, no beats → one hero beat carrying the prompt as a headline, energy clamped,
duration capped at 120 s, `art` length-gated at ≥8 chars (the backend image DTO rejects shorter, so a
one-word "subject" would cost a round trip to be told so).

**Provider-schema fallback.** Structured output is not one feature — each provider implements a
different subset of JSON Schema, and Gemini's is the narrowest. Measured against a live key,
`BRIEF_SCHEMA` returns `400 INVALID_ARGUMENT`. So `askJson` retries without the schema, and carries
the shape in the system prompt instead — generated **from** the schema by `shapeHint()` so the two
cannot drift. That detail is load-bearing: with only "return JSON", Gemini returned well-formed
objects whose beats had **empty content**, so every beat then failed layout casting. It stopped
400-ing and started succeeding at producing nothing usable, which is the worse of the two failures.

### 6.2 Stage 2 — the sequencer (deterministic, `sequencer.ts`)

Turns the brief into a beat grid: normalised weights, `MIN_BEAT_MS = 700` floor taken proportionally
from the rest, tag hints from the free-text `purpose` via a 10-entry regex table (used only to *rank*
candidates, never to select one).

**The continuity contract is the point.** The old system prompt required "3–5 scenes tiling the
duration", which structurally guarantees a slideshow. This replaces a *tiling* rule with a *survival*
rule:

> Every beat boundary must declare at least one element that **survives** it, and how it transforms.

`survivalBetween()` derives it from what the beats actually share, in descending strength:
`transform_into` (same media — the viewer tracks one object across the cut) → `persist` (same
headline) → `match_cut` (shared role, different content) → `mask_reveal` → `carry_motion` (the
auto-inserted weakest bridge). `validate()` reports a bare boundary as an **error** and
"every boundary is only `carry_motion`" as a warning.

The generated-media sentinel (`GENERATED_MEDIA = '__generated__'`) is deliberately excluded from the
`transform_into` test: two beats that each asked for a generated picture asked for two *different*
pictures, and matching on the sentinel would claim the strongest continuity in the vocabulary for the
one case that has none.

`availableRolesFor()` returns the *animatable* role vocabulary, wider than the layout slot
vocabulary: it appends `mark`, `rule` and **`background`**. That last one was an expensive omission —
the candidate filter is `t.roles.some(r => availableRoles.has(r))`, so every technique declaring only
`background` matched nothing on 100% of beats. Seven techniques (five ambients plus `rule_wipe` and
`glitch_slam`), all named in pack `prefer` lists, so six of eight packs were asking for techniques the
caster could not reach and quietly got their fallback — a large part of why pieces in different packs
still resembled each other.

### 6.3 Stage 3 — casting (two calls, all beats per call)

The model sees a **pre-filtered, capped list of one-line briefs**. Never a `TechniqueDef`, never a
`LayoutTemplate`, never a keyframe. Filtering is by pack, energy band, slot duration, and which roles
the content can actually fill — so every candidate is *valid* and the model's job is taste rather
than feasibility. Caps: **25** motion candidates, **12** layout. "Handing it 250 options and asking it
to choose does not produce a considered choice; it produces a pick from the top of the list."

Order is load-bearing: **layout first, motion second**, because the motion prompt names the roles the
layout actually produced, making motion casting a constrained match rather than free invention.

Cost discipline: **one call for all beats**, not one per beat. A five-beat piece must not become
eleven model calls.

### 6.4 Validation and repair (`validateCasting`)

Every rejection falls back to the **highest-ranked valid candidate** — the model is never re-asked.
The constraint was already in the prompt; a model that violated it once will violate it again, and a
sort decides it better than a retry. `rejectReason()` covers: unregistered id, pack `forbid`, pack
`forbidCategories` ("a product interface has no camera and its type is read, not watched"),
`forbidAboveEnergy`, `minDurationMs` vs beat length, per-composition cap, antipattern clash, and
`exclusiveResource` — the camera case is specific: *"a second camera layer would sit in the scene with
its whole animation ignored — the renderer uses the first camera it finds."*

Seed fallbacks are index-derived (`beat.index * 7 + 1`, `* 11 + 3`), not 0: "a seed of exactly 0 on
every beat is how a library with four variants produces one."

### 6.5 Emit (`emit.ts`, 883 LOC — the deterministic half)

Per composition, once, before any beat:

1. `compositionShutter()` — the shutter that decides whether a fast move reads as *rendered* lives on
   the composition, not per layer. Emitting it per technique would be N calls fighting each other.
2. **One backdrop.** Paint order is creation order, so a template emitting its own full-frame gradient
   mid-piece covers every beat composed before it. The gradient angle is picked from an 8-entry table
   by the first layout's seed — a constant angle would make the largest area in the frame identical
   across every piece a pack ever produces.
3. **One graphic device** (`deviceFor`) above the backdrop, behind everything else — what puts a
   curve, a diagonal or a repeated mark into a frame whose every other element is an axis-aligned
   rectangle. Returns nothing for the product packs, so a dashboard stays a dashboard.
4. **Image budget** — `MAX_GENERATED_IMAGES = 2`, decided once, longest beats winning, ties broken on
   index so a repair re-emit cannot drift. A hard cap in code, not a request in the prompt: a model
   asked "would five stock photographs in a five-beat piece be lazy?" says yes and then art-directs
   all five.

Per beat: layout composes → `withGeneratedMedia()` rewrites the template's placeholder
`create_media{assetId:'__generated__'}` **in place** into `generate_image` (same id, same position,
aspect derived from the paired sizing call) so 44 templates never learn that imagery exists → depth
staging (`emitDepth`, back-to-front `media → … → headline`, **skipped when a camera technique owns
the depth**, or the beat carries two disagreeing depth systems) → `emitTypeMask` on headlines so a
technique can *uncover* type rather than fade it.

Then motion: only the roles the technique **declares** ∩ the roles the layout **produced**;
`background` is supplied explicitly as `COMPOSITION_BACKDROP_ID` because no layout produces a
background slot.

Then **`beatLifecycle()`**, and it exists because the renderer has no per-layer time range — a layer
is visible whenever `visible !== false`, and the only lever is its opacity track. Without this pass a
five-beat piece is cumulative: beat 0's headline still sits there while beat 4 plays over it. Two
deterministic rules — entrances only for layers no technique gave one, exits at the boundary unless a
technique already took the layer out — and **this is where `survival` finally does something**: the
surviving role cross-dissolves *across* the boundary, overlapping its counterpart in the next beat,
while everything else has cleared it. Guarded by `minExitMs = max(120, 4 frames)`, because 100→0
inside one frame is a POP, which is precisely the defect the timing linter exists to catch.

### 6.6 Lint → repair → re-emit

All three linters run over the emitted calls (`sceneFromCalls` reduces `ToolCall[]` to a flat
`LintLayer[]` **before anything executes**). The UI linter only runs when there *is* product-vocabulary
content — running it on an editorial piece would report correct editorial craft as a defect.

`REPAIRS` is a deterministic table: `SIMULTANEOUS_ENTRY` → widen span ×1.8, `UNIFORM_STAGGER` → ×1.5,
`UI_TRAVEL_TOO_FAR` → halve, `UI_STAGGER_TOO_WIDE` → 35 ms. These are corrections with exactly one
right answer, so they run in code. Max **2** rounds: "a problem that survives two corrections is not
going to yield to a third — it is a mismatch the caster should be told about rather than ground down."

### 6.7 Variants

`variants: N` re-seeds the *validated casting* (layouts `+ i*17`, motion `+ i*23` — prime multiples,
because a flat `+i` would make variant 1 of beat 0 identical to variant 0 of beat 1, and the piece
would look reshuffled rather than redesigned) and re-emits. **Zero extra model calls** — emit is pure.
Variants are ranked by `designScore + craftScore + uiMotionScore`, best applied, and all scores are
reported to the user, because "emitting several and silently keeping the best would spend the work and
hide the choice — and the choice is the point."

### 6.8 The fit critic

**One** call, **one** iteration, only if something was actually built, over a filmstrip + velocity
graphs. Returns **prose, never a score**:

> 1. Does this serve that brief? Be specific about where it does not.
> 2. **Name the stock template it resembles.** If you can name one, it fails.

The reasoning is explicit: averaged rubric scores converge to the mean, and the mean is exactly the
naive output this architecture exists to escape — so the old loop's most expensive stage was actively
pulling *toward* the problem. The critic is told **not** to comment on easing, timing or spacing:
those are verified mechanically and it cannot see them accurately in stills.

Returns `undefined` if nothing rendered — "a critique with no evidence is a critique of nothing, and
asking for one anyway is how a loop learns to hallucinate about images it never saw."

### 6.9 What the user is told

`CasterRunResult.problems` merges sequence problems, casting substitutions, **and linter findings —
both errors and warnings.** Warnings used to be filtered out here, and the deterministic repair pass
also only acts on errors, so a warning was computed, discarded, and never fixed anywhere.
`PRIMITIVE_ONLY` spent its whole life in that gap: it fired on every run, its message named the exact
ceiling on the output's quality, and nobody ever saw it. Warnings are now labelled "judgement call"
and surfaced in the answer (first 3 + "…and N more"), not just written to a console global.

---

## 7. Path B — the backend director (fallback)

Runs only when the caster did not (`if (!backendRan)`). `DirectorRunner.ts` → `POST /ai/director/run`
→ `DirectorService.executeRun`, SSE back.

```
inspectPrompt (SafetyGuardrails) → resolveApiKey → assembleRunMemory
  → IntentEngine
  → creative ∥ brand          (dependency order matters)
  → art ∥ motion ∥ camera     (fed the REAL creative directive)
  → typography                (fed the REAL art directive)
  → SceneComposer (deterministic) → AnimationComposer (LLM)
  → ExecutionPlanner (deterministic) → ToolPlanner (LLM, chunked)
  → emit tool_calls  ──────────────► editor executes against the live document
  → QualityLoop ×≤5 (6 critics, threshold 9.5) → targeted director re-runs
  → persistRunMemory
```

Cost shape: **6 directors + 1 animation composer + N planner chunks + 6 critics × ≤5 iterations.**
That is why it is the fallback.

Details worth knowing:

- **Director order is load-bearing.** The first pass used to hand every downstream director a
  hardcoded stub ("build", pacing medium, blank notes), so the narrative arc never reached the visual
  directors until a quality-loop rerun.
- **`toolCatalog` is sent from the editor's live registry** with per-property `description` stripped
  (`enforceableSchema`) — the full catalogue is ~10.7 k tokens per chunk, enough to 429 a run on its
  own; stripped it is ~7 k and still carries every rule a call can be rejected for. Schemas are
  required in practice: measured live, names-only produced 45 correctly-named calls of which **39 were
  rejected**, because every tool sets `additionalProperties: false`.
- **`ToolPlanner` chunks at 40 steps**, 3 concurrent, and halves a chunk up to 3 times on a typed
  `truncated` error. The whole plan used to go in one request: a 3-scene/12-second piece emitted
  ~19 800 chars and was cut mid-token by gpt-4o's 4096-token output cap. `LlmClient.extractTruncated`
  reads the provider's own `finish_reason`/`stop_reason`/`finishReason` rather than inferring
  truncation from a downstream parse failure — inferring it produced a fix to the JSON extractor for a
  bug the extractor could never have caused.
- **`LayerSnapshotDto.type`** must stay in sync with the editor's `SceneKind`. It once listed 8 of 13
  kinds, and a scene containing *any* missing kind fails validation for the whole request — so
  `/ai/director/run` returned 400 on virtually every call while the editor swallowed the error and
  silently fell back. The director pipeline was dead in production without a log line.
- **Two independent execution bugs, both fixed:** the SSE reader read `call.name` where the backend
  writes `call.tool` (every director call would have executed as `undefined`), and it now accepts both.
- **Memory is now written.** `saveProject/saveBrand/saveConversation/saveMotion/saveUserPreference`
  had *zero* call sites — memory was read on every run and never written, so the reads were decorative.
  `persistRunMemory` writes conversation intents unconditionally (the user's intent is real whether or
  not the output was good) and style/brand/motion memory only above a score of 7, because learning from
  a 3/10 run compounds. `projectId`/`conversationId` are now threaded from `useAiChat` → `runAgent` →
  `runBackendDirector`; they were never passed before, so both memories keyed on `undefined` forever.
- **Storage:** brand memory on `User.brandMemory`, project memory on `Project.aiMemory` (both JSON
  columns), fronted by TTL caches. **Conversation, motion and user-preference memory are
  in-process-only** (`TtlCache`, 30–60 min) — they do not survive a restart and do not work across
  more than one server instance.

---

## 8. Path C — the direct tool loop

The fallback of fallbacks, and also the **sighted polish pass every other path lands in**.

`MAX_STEPS = 22` (raised from 12 once the visual-feedback loop was added), `LOOP_NUDGE = 3` /
`LOOP_ABORT = 5` on identical repeated calls (keyed by a stable, key-order-independent JSON of the
args), `MAX_CRITIQUES = 2`, `MAX_CRITIQUES_GENERATIVE = 3`.

`SYSTEM_PROMPT` (`buildContext.ts`, ~75 lines) is the direct loop's craft layer: prefer compose tools,
think in scenes, recipes are scaffolding not the final look, batch aggressively, look before you edit,
and an explicit NEVER list ("never leave layers stacked on the same spot", "never let everything
appear at the same instant", "for a camera move to read as 3D the content must be at different z").

`buildContextPreamble()` is deliberately ~400 tokens: comp settings + aspect label, playhead,
selection, layer counts, and the *full* layer list only when ≤12 layers (past that, top-level names
plus "call `describe_scene`"). The old pipeline stuffed every node into the prompt and sent it blind —
unaffordable on a 200-layer comp *and* still missing the things that decide whether the motion is any
good. The model pages through the document instead of swallowing it.

### 8.1 The sighted loop — the biggest single lever on quality

When the model stops calling tools but `changes.length > 0` and critique budget remains:

1. **Mechanical checks first** (`verify.ts`) — arithmetic over the scene graph, so they cost nothing
   and catch the class of defect a vision pass should not spend a render on: `past-end`, `offscreen`,
   `invisible`, `opacity-only`, `simultaneous`.

   Read the false positives before touching it. A first version flagged five issues against
   known-good output and **all five were wrong**: a light sweep *starts* at x = −480 by design (so
   `offscreen` samples position over time and reports only a layer off-canvas at *every* sample);
   ambient orbs carry a *single* opacity keyframe, which is a constant not an entrance; and
   `blur_resolve` pairs opacity with an *effect* parameter rather than a transform. Uniform sampling
   alone reproduced #1 in a new disguise — a 0.9 s sweep on a 15 s comp falls between 1.36 s grid
   steps — so `sampleTimes` also samples every keyframe **and every midpoint**, making the check exact
   rather than lucky.

2. **A filmstrip, not three stills** (`filmstrip.ts`). The old pass rendered 35% / 70% / last. Timing,
   spacing, easing, overshoot and pacing are all *differences between adjacent frames*, and three
   samples five seconds apart contain none of that information — the most expensive stage of the loop
   was structurally blind to the only dimension that mattered. Now: 16–24 frames sampled at keyframe
   times **plus** every keyframe midpoint (where the easing shows; endpoints of an eased segment look
   the same whatever curve joins them) plus a sparse uniform grid, thinned by dropping the most
   closely-spaced samples first, composited into **one labelled grid image** — because frame spacing
   in a strip *is* velocity, visually. Plus velocity graphs: a critic reads "this curve is linear" off
   a plotted line instantly and cannot read it off a still at all.

3. Findings ride **with** the frames in one turn; when rendering fails (exactly the path a director run
   takes when it produces no frame) the findings still go out alone, so a run that cannot be looked at
   is not unchecked.

The critique prompt grants **full authority to make substantial revisions** — delete and rebuild a
weak element, change the palette, retime a whole scene — not just nudge positions.

---

## 9. The tool layer

`packages/ai-tools` is deliberately pure: no DOM, no zustand, no `@core`, no `@motion/*`. Handlers are
**injected by the host**. That is what lets Electron main, the renderer and NestJS read the same
schemas, and it is how the undo boundary is enforced — a handler can only touch what its `ToolContext`
hands it, and **the context has no access to the command history**. A handler physically cannot push
its own undo entry, so one prompt can never fragment into thirty undo steps.

- **62 tools** in four wire formats (OpenAI / Anthropic / Gemini / MCP), described once.
- `ToolKind` is `read | write | compose`, and **`compose` exists to make one number computable**: the
  share of a run's mutations that went through the technique library rather than hand-authored
  primitives. All 43 mutating tools used to share `kind: 'write'`, so the ratio could not be computed
  even in principle. Always test `mutates(kind)`, never `kind === 'write'` — a literal test silently
  drops all 16 compose tools from the pending-changes list, i.e. the tools doing the most visible work
  become the ones the user cannot review.
- **Aliases.** A library emitter produces its whole `ToolCall[]` up front with no model in the loop, so
  it cannot know the ids the engine will assign. It passes an `id` handle; the creating handler binds
  it in `ctx.aliases` (run-scoped, fresh per `createToolContext`) and every `nodeId` resolves through
  `resolveAlias`, falling through to the input so a real id is always accepted.
- **`ToolResult.content` is addressed to the model, not the user.** `"unknown nodeId 'ttl' — did you
  mean 'title_1'?"` is a repair instruction; `"Invalid input"` is not. Partial success is success — a
  batch with two bad entries applies the other 198 and says exactly what was wrong.
- **Provider quirks are the adapters' problem.** `tool_call` events are emitted **complete**, never as
  partial-JSON deltas (three providers fragment tool args three incompatible ways). Gemini 3+'s
  `thoughtSignature` is carried on `AiToolCall.signature` and echoed back — omitting it 400s the next
  request.

**`aiTransaction`** snapshots the whole document (scene + anim) before the run and pushes a single
`StoreSnapshotCommand` after. It **suspends the command history** for the duration, because other
subsystems push commands as a side effect of work the run triggers (lazily booting a comp's timeline
emits an "Add Track"), and a stray entry would be a second undo step that half-undoes the run. A
read-only run pushes nothing. Same machinery is exported as `beginDocumentTransaction` for imports —
without it a 23-layer Lottie import took **25** Ctrl+Z presses to walk back, leaving a half-deleted
scene on the way.

---

## 10. motion-back surface

| Endpoint | Guard | What it does |
|---|---|---|
| `GET /ai/models` | JWT | `ModelRouter.listCapabilities()` — the authoritative model list |
| `GET /ai/keys` | JWT | `{present, hint}` per provider. **No key read path exists.** |
| `PUT /ai/keys/:provider` | JWT | AES-256-GCM encrypt + store; refuses rather than storing plaintext if `AI_KEY_SECRET` is bad |
| `DELETE /ai/keys/:provider` | JWT | |
| `POST /ai/stream` | JWT | Attach key, call provider, **pipe SSE bytes verbatim**. Never parses SSE. |
| `POST /ai/image` | JWT | One image, returned as **base64 bytes**, not a URL |
| `POST /ai/director/run` | JWT | The director pipeline, SSE |
| `GET/POST/DELETE /ai/conversations…` | JWT | Thread list and turns |

There is **no global auth guard** — every private controller brings its own `JwtAuthGuard`.

**Resilience in `openStream`** (three tiers, in order): retry the requested model (429/503/529 +
dropped connections, 3 attempts, exponential backoff + jitter, and *only* if the wait ≤ 8 s — past
that it hands `retryAfterMs` to the client rather than sitting on the socket) → **same provider one
tier down** (`SECONDARY_MODELS`, with a naming-pattern fallback so a model released after this file
was last touched still cascades somewhere plausible) → **a different provider the user has a key for**.
Only `rate_limit | overloaded | network` cascade; auth and malformed requests fail identically
everywhere.

Both cascade tiers were previously **unreachable** — they sat after a retry loop whose every path
returned — and the model map was written entirely in 2024-era names, so it had no entry for a single
model the editor offers. The advertised overload recovery had never run once. The lesson is encoded:
the failure mode is now a degraded guess **plus a log line**, not silence.

`recordUsage` is fire-and-forget and always writes `creditsUsed: 0`. Bookkeeping must never fail a run
the user already got.

**Hosted "Motion AI" is deleted, not disabled.** The credit ledger, the atomic reserve/refund pair,
the plan gate on the assistant and the forced-model config are all gone; `'motion'` is out of
`ALL_PROVIDERS`, so the DTO validator refuses it at the door. The `creditsUsed` column stays only
because historical rows carry real numbers.

### 10.1 `platform/` — 1 292 LOC, two functions reachable

`PlatformModule` is imported and `PlatformService` (147 LOC, wiring 13 subsystems) has **zero
consumers**. Exactly two things are reached from outside the directory:

- `ModelRouter.listCapabilities()` — by `GET /ai/models`;
- `SafetyGuardrails.inspectPrompt()` — by `DirectorService.inspectPrompt`, which is the **only
  prompt-injection defence in either repo** and now actually runs (positive injection detection
  throws; softer threats are sanitized and logged, and everything downstream reads the *sanitized*
  prompt — passing `raw` on would make the inspection decorative).

Everything else — `ContextManager` token budgeting, `CircuitBreakerManager`, `PlatformCache`,
`SemanticRetrievalEngine`, `SpeculativeExecutionEngine`, `ExecutionScheduler`, `MetricsCollector`,
`CostOptimizer`, `PluginManager`, `StreamingEngine`, `HierarchicalMemoryManager`, `TaskClassifier` —
is unreachable. Roughly **1 000 LOC of dead weight**, down from ~7 900 before Phase 3.4.

---

## 11. The UI

### 11.1 `AiChatPanel.tsx` (883 LOC) — left-sidebar tab

Top → bottom: header (new chat / history) · scrolling thread · composer pinned at the bottom.

All chat state lives in `AiChatContext`, **hoisted above the dock tree**, so switching sidebar tabs
mid-run neither cancels the run nor rolls back a pending preview transaction.

The thread renders, in order:

- **Key banner** — only once `verified` is true (a live `/ai/keys` answer has landed). Guessing "no
  key" before the answer is what made the setup prompt feel like it never went away. Two states:
  "pick a connected provider" vs "connect one", the latter opening the in-editor settings tab (it used
  to link `#/dashboard?tab=settings`, a route the local edition never registers).
- **Empty state** — an honest experimental notice plus 7 quick-preset chips.
- **Messages**, assistant turns through `react-markdown`; error turns styled as warnings.
- **"Production plan"** — the 5 caster stages, `pending | active | done`.
- **"Build steps"** — one row per tool call, flipping to ✓ / ✗ live.
- **Activity row** — always shown while busy with no prose streaming, so a tool-heavy turn (which
  emits no text) never looks frozen.
- **Result preview card** (manual mode) — canvas snapshot + play/pause, the **filmstrip**, an
  "N changes pending" count, and **Apply / Decline**.

Composer: three **direction chips** — *look pack* (all 8, with intents, plus "let the AI choose"),
*shape* (energy 0–100, length 4–60 s, brand colour, each defaulting to "auto"), *variants*
(1 / 2 / 3 / 5, labelled "no extra model calls") — then the pill with the textarea (Enter sends,
paste-image supported, ≤3 attachments), a provider/model picker driven by the **backend's** model list
with `MODEL_SUGGESTIONS` as the offline fallback, and an **Auto / Manual** execution-mode picker.

`getModelLabel` matches longest-prefix-first, because these are substring tests: `claude-opus-5` must
be checked before any shorter `claude-opus`. The table had no entry for `claude-opus-5` — the default
model — so the most common case displayed its raw id while three retired models still had labels.

### 11.2 `useAiChat.ts` (836 LOC)

Owns: message list, streaming buffer, activity label, pipeline stages, plan items, filmstrip,
conversations (server-stored, ChatGPT-style, per project), the pending transaction, manual mode, and
direction.

- `TOOL_ACTIVITY` is a **table, not a switch**, so the mapped names are enumerable —
  `activityFor.test.ts` checks both directions against the live registry. The switch form drifted both
  ways: branches for tools that no longer existed, and no branch for tools that did, which showed
  "Working" through the most interesting part of a run.
- `PIPELINE_STAGE_LABELS` must match the `onActivity` strings `CasterRunner` emits, and for a long
  time did not — the list still described the deleted 10-stage client orchestrator, so every
  `matchStageIndex` returned −1 and the checklist never appeared. `pipelineStages.test.ts` is the
  drift guard.
- **Image history is pruned** to the last 2 image-bearing turns (`IMAGE_TURNS_KEPT`); history replay is
  capped at 24 turns.
- **A stale gate never blocks a working setup**: if `ready()` is false, one *forced* `/ai/keys` refresh
  settles it before spending a turn, held under `busy` so a second Enter cannot start a second run.
  Errors in `KEY_STATE_CODES` (`no_key`, `auth`, `coming_soon`, `upgrade_required`, `no_credits`)
  trigger a re-read that also re-points the selection, so the *next* prompt succeeds.
- `discardPending` clips the thread by **identity** (back to the last user message), not by
  `slice(0, -2)` — a turn that errored leaves one entry and one with images leaves three, so counting
  ate an unrelated earlier message.
- Failed turns are shown to the user but **filtered out of the model-facing history** on hydrate —
  replaying error copy would pollute the model's context.

### 11.3 `aiProviderStore.ts` (475 LOC)

Holds only the *choice* plus a non-secret status mirror (`{present, hint}` booleans and masked tails,
scoped by `userId`, 30-day max age). Three things make the gate actually work, all of which were once
missing:

1. **The persisted choice is read back.** This module is evaluated when `authStore` is imported — long
   before `Application.boot()` registers the SettingsManager — so `getSettingsManager()` threw on every
   launch and the `catch` reset the provider to `anthropic`. A user whose only key was OpenAI or Gemini
   got "Connect an AI provider" forever. `persistedValue` reads the same blob without requiring boot.
2. **The status is cached across launches**, so the gate is correct on the first frame and offline.
3. **A provider that cannot run is never left selected** — `applyStatus()` is the single funnel every
   status change ends in.

`inFlight` + `inFlightId` single-flight `/ai/keys`: the settings page, the chat hook and the billing
panel all refresh on mount, and without it the *oldest* answer could win.

---

## 12. End-to-end workflows

### 12.1 Generative prompt, caster path (the common case)

```
"a 12s launch teaser for Northwind, dark, restrained"
 └ classifyPrompt → 'generative'
 └ setRuntimeStyle(deriveStyleFromBrief(prompt))     ← brand colours in the brief beat the presets
 └ beginAiTransaction("AI: a 12s launch teaser…")    ← history suspended
 └ runCasterPipeline
     ① brief          "Writing the creative brief…"   1 model call (+ images, if any)
     ② sequence/validate                              0 calls
     ③ cast layouts   "Casting layouts…"              1 model call, all beats
     ④ cast motion    "Casting motion…"               1 model call, all beats
     ⑤ validate+repair, emit, lint ×≤2                0 calls
     ⑥ execute        "Building the composition…"     ~40–120 registry calls
     ⑦ fit critic     "Reviewing the result…"         1 model call over filmstrip + velocity graphs
 └ planExecuted = true → render frames → seed the direct loop with CRITIQUE_PROMPT (critiques = 1)
 └ direct loop, ≤2 further render→look→fix passes, full toolset
 └ auto mode: tx.commit()   |   manual mode: tx stays open → Apply / Decline
```

**Model calls: 4 + the polish turns.** Down from roughly thirty.

### 12.2 Trivial edit

`"make it blue"` → direct loop only. Preamble + tools, typically 1–3 turns, no render pass unless the
run actually changed something.

### 12.3 Caster fails

Recorded via `recordPathFailure('caster', …)` → `console.warn` + `window.__aiPathFailures` → director
attempted → its failure recorded too → direct loop with 1–2 intent-matched exemplars
(`buildExemplarBlock`) prepended, because when the model is *authoring* it should see the shape of
professional structure first.

A bare `catch {}` here is how ~13 k LOC of backend director stayed dead in production: every
generative prompt paid its latency, failed, and quietly degraded.

### 12.4 Failure semantics

`runAgent` **throws** on transport/auth failures — no silent fallback. "The old pipeline answered a
failed request with a canned fade-and-rise, which was indistinguishable from real work; a visible
error is strictly better than a plausible lie." Any throw rolls the transaction back: a half-applied
AI edit is worse than none, because the user cannot tell which half landed.

Cancel is real end-to-end: aborting the renderer's fetch closes the request, the gateway sees the
close and aborts its upstream provider call, so tokens stop billing. In the local edition, `ai:cancel`
aborts the main-process fetch, and the `finally` block cancels even on a consumer `break` — otherwise
the provider keeps streaming tokens the user pays for into a queue nobody reads.

---

## 13. What the system measures about itself

| Signal | Where | Read it via |
|---|---|---|
| Path failures (last 20) | `AgentLoop.recordPathFailure` | `window.__aiPathFailures` + user-facing summary |
| Tool mix per run (compose / primitive / read) | `AgentLoop.recordTally` | `window.__aiToolRatio`, console line |
| `techniqueCoverage`, `techniqueDiversity`, `templateDiversity`, `variantEntropy` | `CastReport.metrics` | caster report |
| `designScore`, `craftScore`, `uiMotionScore` (weighted pass rates 0..1) | 3 linters | caster report, variant ranking |
| Repairs applied | `CastReport.repairs` | caster report |
| Provider truncation | `LlmClient.extractTruncated` | backend logs + chunk halving |
| Usage rows | `AiUsage` (bytes in/out, provider, model) | Postgres |

Two notes on the metrics themselves. **Compose ratio measures the direct loop, not the caster** — and
`CastReport` says explicitly why it was replaced: with a small generic recipe set a high ratio means
every output came from the same handful of shapes, so it measured **homogeneity and reported it as
quality**. `variantEntropy` exists to catch "always variant 0", which is how a library with 20
techniques still produces 20 identical pieces.

---

## 14. Test results (run 2026-08-04)

```
AI + edition + workspace suites          33 suites, 520 tests   PASS
caster + 3 libraries                     14 project-runs,
                                          446 tests             PASS
```

Notable guards, each pinned to a bug that actually shipped:

- `caster.test.ts` — a stub returning nonsense still passes every linter (the thesis).
- `activityFor.test.ts` — registry ⇄ activity-table drift, **both directions**.
- `pipelineStages.test.ts` — `PIPELINE_STAGE_LABELS` ⇄ `CasterRunner` `onActivity` strings.
- `directorEditionGate.test.ts` — the director must read `aiRunsThroughBackend()`, **not**
  `aiEnabled()`; those were the same value one week and not the next.
- `editionAiSurface.test.ts` — asserts the surfaces, not the predicate.
- `verify.test.ts` — every false positive is written down as a test.
- `moduleAliases.test.ts`, `adapters.test.ts`, `spring.test.ts`, `registry.test.ts`.

Not covered by unit tests: real-provider behaviour (schema rejection, truncation, `thoughtSignature`)
— those are documented as *measured against a live key*, and a mock accepts every schema.

---

## 15. Open gaps (ranked, all verified in the current tree)

1. **`useAiChat.submit` has a stale-closure bug on `direction` and `projectId`.**
   `src/layout/Workspace/useAiChat.ts:799` — deps are `[busy, hasPendingTx, isManualMode, persist]`,
   but the body reads `direction` (line 692) and `projectId` (line 709). Setting a look pack, energy,
   accent, duration or variant count re-renders but does **not** recreate `submit`, so the next run
   sends the *previous* direction — the composer's whole direction bar is one edit behind, and on a
   first-ever setting sends nothing. Same for `projectId`, which silently defeats the director memory
   threading that was just added. Fix: add `direction` and `projectId` to the dep array (or read both
   from a ref).

2. **`DirectorRunDto.provider` accepts providers the director cannot speak.**
   `motion-back/src/ai/director/dto/director-run.dto.ts:177` validates against `ALL_PROVIDERS`, which
   includes `fal | runway | luma | tripo | meshy | elevenlabs`. `LlmClient.LlmProvider` is
   `openai | anthropic | gemini`; `buildRequest`'s switch has no case for the rest, so a run naming one
   (with a stored key) falls off the end and returns `undefined`, destructured into a TypeError →
   `run_failed`. Narrow the DTO to the three chat providers. (`/ai/stream` has the same DTO breadth but
   degrades gracefully — the gateway has a real endpoint and header for every one.)

3. **`generate_image` has no local-edition path.** `toolHandlers.ts:759` calls `api.generateImage` →
   `POST /ai/image`. There is no `ai:image` IPC counterpart in `electron/aiProxy.ts`. Harmless today
   (the local edition ships no assistant), but the caster's `art` direction depends on this tool, so
   flipping `aiEnabled()` back on for local would produce briefs whose imagery silently degrades to the
   template's placeholder panel.

4. **Conversation / motion / user-preference memory is process-local.** `MemoryStore` keeps them in
   `TtlCache` only (30–60 min). Project and brand memory persist to Postgres; these three do not
   survive a restart and are wrong behind more than one server instance. `saveUserPreference` still has
   no caller.

5. **~1 000 LOC of `platform/` remains unreachable.** Only `ModelRouter.listCapabilities` and
   `SafetyGuardrails.inspectPrompt` are called from outside the directory; `PlatformService` has zero
   consumers. `ContextManager` (token budgeting) and `CircuitBreakerManager` are the two whose absence
   is a real capability gap, not just dead weight.

6. **`recipes.ts` and `toolHandlers.ts` carry an unresolved F11 marker** — both files open with
   `eslint-disable no-restricted-syntax / TODO(F11): SUSPECTED DEFECT, NOT YET VERIFIED`: handlers do
   `defaultSceneGraph.getNode(id)` then write into `component.props` in place, and `SceneGraph` returns
   a fresh copy per read, so those writes are likely discarded and the affected tools may be silent
   no-ops. Deliberately not fixed blind (10 call sites, no coverage). The fix is `writeProp()` — which
   `generateImage` at `toolHandlers.ts:788` already uses correctly, so the pattern is available.

7. **Cosmetic:** `AgentLoop.ts:367` declares `let requestPrompt = prompt` and never reassigns it;
   `CasterRunner`'s `'Comparing N directions…'` activity matches no pipeline stage (harmless, returns
   −1); `MODEL_SUGGESTIONS.openai` is annotated as unverified against a live key.

---

## 16. Design rules worth preserving

Extracted from the code because they are the reasoning that keeps paying off:

- **Correct, don't re-request.** Every bad model response in the caster is repaired by a sort or an
  arithmetic fix. The constraint was already in the prompt; a model that violated it once will violate
  it again.
- **Filter, then ask.** 25 motion / 12 layout candidates, all valid. A list long enough to be
  comprehensive is long enough that the model picks from the top.
- **Enforce composition-wide budgets in code, not in the prompt.** Image cap, per-technique caps,
  clash rules, energy ceilings. A model asked whether five stock photos would be lazy says yes and then
  art-directs all five.
- **A score invites averaging, and averaging converges to the mean** — which is the naive output the
  architecture exists to escape. One critic, one adversarial question.
- **Report problems TO THE USER.** A console global nobody opens is not reporting. A run that
  substituted three techniques must not read as one that got what it asked for.
- **Gate by absence, not by a disabled state.** A "not available here" banner rendered exclusively to
  the users who are not experiencing the absence.
- **Test the surfaces, not the predicate.** A value whose readers have drifted away from it is not a
  gate.
- **Both sides of a boundary get the gate.** Hiding the AI panel in the renderer while `ai:stream`
  stays registered in main is a curtain, not a gate.

---

## 17. Delta since the 2026-07-28 audit

| Then | Now |
|---|---|
| motion-back `src/ai` = 14 175 LOC, **7 903 unreachable (56%)** | **7 726 LOC**, ~1 000 unreachable (13%). `knowledge`, `taste`, `motion-engine`, `design-engine`, `evaluation-engine` deleted |
| `/ai/director/run` bypassed plan gating, credit reservation and metering; `resolveApiKey` returned `process.env.MOTION_AI_API_KEY` | Hosted AI **deleted**. `'motion'` is out of `ALL_PROVIDERS`, so the DTO refuses it. `resolveApiKey` only fetches the user's own encrypted key. `recordUsage` runs on every director run |
| `AiSettingsSection` wrote **plaintext keys to `localStorage`** and re-uploaded them | Removed; `purgeLocalKeys.ts` cleans earlier builds; an ESLint rule fails the build on new credential-shaped writes |
| `SafetyGuardrails.inspectPrompt` — the only injection defence — had no call site | Called at `DirectorService.run` step 0; downstream reads the sanitized prompt |
| Director memory read-only; `saveProject/saveBrand/…` had zero callers; `projectId`/`conversationId` never passed | `persistRunMemory` writes; both ids threaded from `useAiChat` → `runAgent` → `runBackendDirector` |
| `PROVIDER_OPTIONS` omitted `'motion'` while the store/gateway/billing all handled it; `BillingSection` actively lied | Hosted AI gone from both sides; the Motion AI group is deleted from the picker rather than left selectable-and-400ing |
| Auto/Manual toggle was **write-only** (`preview: true` hardcoded) | `preview: isManualMode` |
| Three generative paths competing; client `PipelineOrchestrator` (~2 200 LOC) | Two paths. The client orchestrator is deleted — it was a second LLM-authors-keyframes pipeline behind the first |
| `getModelLabel` had no branch for the default model; `discardPending` did `slice(0,-2)`; `activityFor` mapped 3 non-existent tools | All fixed, each with a drift test |
| Tool registry: 45 tools | **62** (8 read / 38 write / 16 compose) |

---

## 18. File index

**motion-editor**
```
src/core/ai/
  AgentLoop.ts          orchestrator, path selection, sighted polish, tallies, path failures
  CasterRunner.ts       caster host adapter — prompts, schemas, coercion, fit critic
  DirectorRunner.ts     /ai/director/run client, SSE → registry execution
  aiTransport.ts        server vs local byte source (the ONLY edition branch)
  aiKeyStore.ts         server vs local key storage (same shape, no read path either side)
  aiTransaction.ts      one prompt = one undo entry
  buildContext.ts       SYSTEM_PROMPT + the ~400-token preamble
  toolHandlers.ts       1 554 LOC of handlers   craftHandlers.ts  advanced craft tools
  recipes.ts            compose-tool procedures  archetypes.ts  6 entrance archetypes
  design.ts             palette / type / motion tokens; deriveStyleFromBrief
  verify.ts             mechanical checks        filmstrip.ts   16–24 frame strip + velocity graphs
  renderFeedback.ts     critique frame renderer  exemplars/     intent-matched structure examples
  pipeline/Router.ts    classifyPrompt
packages/caster/src/    types · sequencer · cast · emit · run
packages/design-system/ color(OKLCH) · grid · type · depth · surface · shape · packs · compose ·
                        registry · lint · devices · stage · templates/*
packages/technique-library/ schema · emit · registry · lint · techniques/*
packages/product-motion/ choreography · shared-element · cursor · components · techniques · lint
packages/ai-tools/      types · registry · schema · spring · providers/* · tools/*
src/layout/AiChat/      AiChatPanel.tsx · AiChatContext.tsx
src/layout/Workspace/useAiChat.ts   src/layout/Settings/AiSettingsSection.tsx
src/stores/aiProviderStore.ts       src/core/config/edition.ts · flags.ts
electron/aiKeyVault.ts · aiProxy.ts · edition.ts
```

**motion-back**
```
src/ai/
  ai-gateway.controller.ts / .service.ts   keys, /ai/stream, /ai/image, cascade, usage
  ai.controller.ts / .service.ts           conversation threads
  key-crypto.ts                            AES-256-GCM + maskKey
  dto/                                     ai-gateway.dto.ts (BYOK_PROVIDERS) · ai.dto.ts
  director/
    director.controller.ts / .service.ts   SSE endpoint + 11-step orchestration
    core/                                  types · schemas · llm-client · memory.store · event-bus · director-base
    intent/ directors/ (6) composers/ (2) planners/ (2) critics/ (6) quality/ (2)
  platform/                                1 292 LOC; ModelRouter + SafetyGuardrails reachable
```
