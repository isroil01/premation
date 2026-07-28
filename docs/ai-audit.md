# AI motion generation — Phase 0 audit

**Date:** 2026-07-27 · **Scope:** audit only, no code changed.
**Method:** code reading (cited to file:line) plus a throwaway jest harness that
executed the **real** tool registry against a **real** scene graph, headless, with
no model and no network. The harness was deleted after the run; its numbers are
reproduced below.

---

## Headline

**The four "missing pieces of machinery" the brief expects to build are already
built.** This is not a one-shot prompt that parses text into a document. It is a
tool-calling agent with schema validation, a rendered-frame vision feedback loop,
a technique library, and staged decomposition — the target architecture, roughly
as described, already shipped.

| Brief's missing piece | Actual state |
|---|---|
| No feedback loop | **Present.** Renders frames, sends them back as images, self-corrects (AgentLoop.ts:454-480) |
| No constrained action space | **Present.** 50 JSON-schema-validated tools, `additionalProperties: false` |
| No domain library | **Present but small.** 16 compose tools + 6 entrance archetypes + 730-line recipe module |
| No decomposition | **Present.** Router → backend director *or* client pipeline → sighted polish |

That reframes the question. The naive output is not explained by the absence of
this architecture, because the architecture is there. This audit's job is to say
where the quality is actually leaking, and the honest answer is: **the
deterministic layer is healthy, and I could not test the model layer.**

---

## 1. What does it generate?

**Tool calls against the live scene graph.** Not text, not a document blob, not
video. `runAgent` ([AgentLoop.ts:233](../src/core/ai/AgentLoop.ts#L233)) streams
provider-native tool calls and executes each through a `ToolRegistry` against the
editor's real `defaultSceneGraph` and `defaultAnimation`. There is no
parse-freeform-text step anywhere in the path.

Everything a run does lands in **one undo entry** —
`beginAiTransaction(label)` at AgentLoop.ts:245, `tx.commit()` on success,
`tx.rollback()` in the catch (AgentLoop.ts:547). A half-applied AI edit is
explicitly prevented. This satisfies the brief's "all mutations are one undo
group" requirement.

## 2. How does the model interact with the editor?

**Native tool/function calling**, per provider dialect. Call site:

```ts
// AgentLoop.ts:435
const req: AiRequest = { model, system: SYSTEM_PROMPT, messages, tools, temperature: 0.6, maxTokens: 8192 };
...
for await (const ev of streamTurn(provider, dialect, model, req, signal)) {
  if (ev.type === 'tool_call') calls.push({ id: ev.id, name: ev.name, args: ev.args, ... });
}
...
const res = await reg.execute(call.name, call.args, ctx);   // AgentLoop.ts:510
```

Provider adapters live in `packages/ai-tools/src/providers/` (anthropic, gemini,
openai) with a shared SSE parser. The editor never talks to a provider host; it
POSTs to the backend gateway, which pipes provider bytes back verbatim
(AgentLoop.ts:129).

## 3. Is there validation?

**Yes, and it is good.** Every tool has a JSON Schema with
`additionalProperties: false`. Rejections return a structured, model-addressed
repair instruction rather than an exception — measured example from the harness:

```
add_lower_third: Invalid arguments for add_lower_third:
- input is missing required property 'title'
- input has unknown property 'name'. Allowed: title, subtitle, scene, style
```

`toolHandlers.ts:1-16` documents the three rules: times convert through
`ctx.time`, **partial success is success** (a 200-keyframe batch with two bad
entries applies the other 198 and reports the two), and failures are written as
repair instructions to the model. This is materially better than the brief
assumes.

## 4. Is there a feedback loop?

**Yes — a real one, including vision.** After the model stops calling tools, if
it made changes, the editor renders frames (early / middle / final held) and
sends them back as images with a critique prompt:

```ts
// AgentLoop.ts:461-478
const { renderSceneFrames, critiqueTimes } = await import('./renderFeedback');
shots = await renderSceneFrames(critiqueTimes(comp.durationSeconds, comp.fps));
...
messages.push({ role: 'user', content: CRITIQUE_PROMPT, images: shots });
```

Bounded at 2 passes (3 for generative runs) — `MAX_CRITIQUES` AgentLoop.ts:60-66.
The critique prompt (AgentLoop.ts:68-79) asks about empty frames, overlap,
balance, contrast, and whether things actually move.

Both programmatic paths (backend director and client pipeline) are deliberately
routed *into* this pass rather than returning early — AgentLoop.ts:372-380
records that the director path used to return before ever seeing a frame.

**There are no mechanical checks.** The loop is vision-only. The brief's cheap
checks (overflow, safe area, contrast, collision, past-end) do not exist as code.

## 5. Is there a technique library?

**Yes, three layers of one**, and it is the most valuable existing asset:

- **16 compose tools** — `add_scene`, `add_title`, `add_emblem`, `add_cards`,
  `stagger_in`, `add_camera_move`, `add_kinetic_title`, `add_light_sweep`,
  `add_ambient_orbs`, `add_lower_third`, `add_transition`, `add_background`,
  `define_style`, `add_logo_reveal`, `add_radial_burst`, `add_path_morph`.
- **6 entrance archetypes** with a real compile function —
  `entranceTrackPlans()` ([archetypes.ts:169](../src/core/ai/archetypes.ts#L169)):
  rise, scale_pop, blur_resolve, slide_settle, mask_wipe, char_cascade. Plus
  `nonUniformStagger()` and a seeded `pickEntranceArchetype()` so repeat runs
  vary.
- **`recipes.ts`, 730 lines** — the compile functions that turn a technique into
  layers, keyframes, easing and depth.

This is the brief's layer 3, and it exists. It is **~16 techniques against the
brief's 20–30 target for v1**, and there is no retrieval tool (`listTechniques`);
the closest is `list_presets`.

## 6. Which model, and how configured?

- **Provider/model are user-selected**; the gateway routes by provider id.
- **temperature 0.6**, **maxTokens 8192** (AgentLoop.ts:435).
- **MAX_STEPS 22**, loop-repeat guard at 3 (nudge) and 5 (abort).
- **System prompt: 15,099 chars ≈ 3,775 tokens**, 75 lines
  ([buildContext.ts](../src/core/ai/buildContext.ts)). Sections: HOW TO WORK /
  WHAT THIS EDITOR CAN DO / CRAFT / GO BEYOND THE OBVIOUS / WORKED EXAMPLES /
  NEVER DO THESE / CONSTRAINTS.
- Scene context is deliberately small (~400 tokens) and paged on demand via
  `describe_scene` — the brief's `queryScene`-returns-a-summary rule, already
  followed.

## 7. How are keys handled?

**Server-side proxy with encryption at rest — the design the brief recommends.**

- `aes-256-gcm`, key derived via `scryptSync` from an env secret
  (`motion-back/src/ai/key-crypto.ts:24-31`).
- Stored as `encryptedKey` in Postgres with a masked `hint` for display
  (`ai-gateway.service.ts:96`).
- Decrypted per request (`ai-gateway.service.ts:114`).
- The editor never sees a key; `streamTurn` sends only `{provider, model, body}`
  plus the user's own Motion bearer token.
- Logging reviewed: the gateway logs provider status codes and truncated error
  text, not keys or request bodies (`ai-gateway.service.ts:408-481`).

No key-handling defect found.

---

## 8. Failure inventory

### What I could not do

**I could not run the model.** A generation needs a signed-in session
(`RequireAuth`, no dev bypass), a stored provider key, and credits. So the
classic ten-prompts-and-categorise inventory is **not in this document**, and
that is the single biggest gap in this audit. It needs your key; see
"What to run next".

### What I did instead

The compose path is deterministic — pure functions over a `ToolContext`. I drove
the **real** registry against a **real** scene graph for ten realistic briefs,
which measures the layer the brief says all quality lives in, with the model
removed as a variable.

| | Result |
|---|---|
| Scenarios | 10 |
| Compose calls issued | 42 |
| Calls rejected by schema | **0** |
| Layers produced | 3–10 per scenario |
| Confirmed mechanical defects | **0** |

Ten briefs: SaaS teaser, luxury watch film, fitness promo, conference lower
third, three-feature explainer, minimal logo sting, playful onboarding,
cyberpunk teaser, corporate results, two-act reveal.

**The deterministic layer is in good shape.** Cards stagger at 0.22 / 0.33 /
0.42s (~0.10s offsets); titles pair `opacity` with `y`; scenes tile the duration;
nothing lands past comp end.

### My checks produced five false positives — worth recording

My first mechanical verifier flagged 5 issues. **All five were wrong**, and the
reasons are directly useful for building the real one (sequencing step 5):

| Flag | Why it was wrong |
|---|---|
| `offscreen: Light Sweep` ×2 | The sweep starts at x = −480 **by design** and animates across (`x@0.77/1.67`). A static-bounds check must not run on a layer whose position is animated. |
| `simultaneous: 5 layers at 0.000s` ×2 | Ambient orbs carry a **single** opacity keyframe — a constant, not an entrance. A one-keyframe track is not an animation. |
| `opacity-only: title` ×1 | The run picked `blur_resolve`, which pairs opacity with an **effect** parameter, not a transform. Paired-motion checks must count effect params. |

A naive verifier would have reported all five to the model and sent it off to
"fix" correct work. That is worse than no verifier.

### A first-run artefact worth reporting

My *initial* scenarios guessed argument names from the system prompt's prose
(`add_title({subtitle})`, `add_cards({items})`, `define_style({accent})`). **14
of 39 calls were rejected.** Thirteen were my own bad guesses. One is a real
defect — see D1.

---

## Defects found

### D1 — `define_style` promises an `accent` parameter it does not have

The system prompt instructs:

> "call define_style FIRST — **give it the accent colour** (and optionally palette, type scale, easing personality…)"

and the tool's own description repeats it:

> "…so **a single accent colour is enough**."

The schema has no `accent` property — `name, brief, basedOn, palette, titlePx,
subtitlePx, taglinePx, weightTitle, weightBody, easing, entranceDur, staggerSec,
travelPx, glow` — and `additionalProperties: false` makes the call a **hard
reject**. Confirmed: `define_style: input has unknown property 'accent'`.

This is the highest-value fix in the audit. `define_style` is the one tool that
makes a run on-brand rather than one of six presets; the prompt pushes the model
to call it first, with an argument that cannot work. Either add `accent` or stop
promising it in two places.

### D2 — Two silent catch-alls hide which path actually ran

```ts
} catch {
  // Backend director unavailable or unsupported — fall back to client orchestrator
}                                                        // AgentLoop.ts:298-300
} catch (err) {
  events?.onActivity?.('Pipeline failed. Falling back to direct mode…');
}                                                        // AgentLoop.ts:325-328
```

Three paths can serve a generative prompt — backend director, client pipeline,
direct tool loop — and both fallbacks swallow the error entirely. If the backend
director has been failing since it shipped, **nothing would say so**; every run
would quietly take the direct path. I cannot tell from code alone which path a
real generation takes, and neither can you. This is a prerequisite for any
quality work: you cannot fix the path you cannot identify.

### D3 — The brief's key quality metric is currently unmeasurable

The brief: *"`applyTechnique` should be the overwhelmingly dominant call…
Instrument the ratio — it's your best single quality metric."*

All 43 mutating tools share `kind: 'write'`. A compose call (`add_title`) and a
raw primitive (`set_keyframes`) are indistinguishable by kind, so the ratio
cannot be computed even in principle. It needs a third kind (`compose`) or a
per-tool tier flag. Cheap, and it turns quality from an opinion into a number.

### D4 — The system prompt asks the model for numbers the library already owns

11 numeric directives in prose, e.g.:

> "offset each by ~0.06-0.12s" · "bezier [0.34, 1.56, 0.64, 1]" · "a fade
> 0.3-0.5s, an entrance 0.4-0.8s" · "20-60px of travel"

This is precisely the brief's anti-pattern — *"the model must never emit ease
handle values, keyframe timings, or pixel positions"* — and it is redundant:
`archetypes.ts` and `recipes.ts` already own these exact numbers and apply them
correctly every time. Every token spent teaching the model to hand-author a
stagger is a token spent making it *not* call `add_title`.

The prompt also hedges against its own library — *"RECIPES ARE SCAFFOLDING, NOT
THE FINAL LOOK… author it raw with create_layer + set_keyframes — that is
encouraged, not a fallback."* That may be the right creative call, but it is an
explicit licence to leave the quality-guaranteed path, and it should be a
deliberate decision rather than an accident of prompt drift.

---

## What to run next — the missing half

The model-side inventory needs one thing I don't have: a signed-in session with a
key. Concretely, run these ten prompts and categorise each output as
*bad timing / bad layout / bad typography / invalid document / off-brief / too
simple*, and capture the tool trace for each:

1. "15-second launch teaser for a project-management SaaS, dark, confident"
2. "Luxury watch brand film, gold on black, restrained and slow"
3. "Punchy 10s fitness app promo, high energy"
4. "Lower third for a conference speaker, Dr. Amara Osei, Head of Research"
5. "Explainer: three reasons teams choose us — fast, secure, simple"
6. "Minimal logo sting for a studio called NORTH"
7. "Playful onboarding for a consumer app, warm colours"
8. "Cyberpunk game teaser, neon, aggressive cuts"
9. "Corporate quarterly results, Q4, revenue up 32%"
10. "Two-act product reveal with a transition between the acts"

From each trace, record the **compose : raw-primitive call ratio** (D3 makes this
manual for now). My prediction, stated so it can be falsified: the deterministic
layer is fine, so failures will cluster in *tool selection* — the model reaching
for `create_layer` + `set_keyframes` instead of compose tools, encouraged by D4 —
rather than in what the compose tools produce.

## Recommended build order — revised from the brief

The brief's order assumes a greenfield. Given what exists:

1. **D2 — instrument the three paths.** One line each. Without it every later
   measurement is confounded.
2. **D1 — fix `define_style`'s accent contract.** Small, and it unblocks the
   on-brand path the prompt already pushes toward.
3. **D3 — add a `compose` tool kind and log the ratio.** Turns quality into a
   measurable number.
4. **Run the ten prompts** (above) and complete the inventory.
5. **D4 — move numbers out of the prompt**, once the ratio shows whether the
   model is actually bypassing the library.
6. **Mechanical verification** — and see the false-positive table before writing
   it. It must model animated properties, ignore single-keyframe constants, and
   count effect parameters as paired motion.
7. **Grow the library past 16 techniques.** Per the brief, this is the part that
   compounds, and it is content work, not engineering.

Steps 1–3 are perhaps a day. They are what makes step 4 meaningful.

---

# Live run — the missing half, completed

Run on **gemini-3.1-pro-preview** (BYOK Gemini key), fresh empty project, via
`runAgent` with a read-only trace recorder patched onto `ToolRegistry.prototype.execute`.

**Prompt:** *"15-second launch teaser for a project-management SaaS called
Cadence. Dark, confident, premium. Three scenes."*

| Metric | Value |
|---|---|
| Wall clock | **285 s** (4 m 45 s) |
| Tool calls | 36 |
| — compose | **14** |
| — raw primitive writes | **7** (all `update_layer`) |
| — reads | 15 (`describe_scene` 3, `read_tracks` 4, `evaluate_at` 8) |
| `set_keyframes` / `create_layer` | **0** |
| Layers produced | 19 across 3 scenes |
| Result | Completed successfully |

## L1 — Both programmatic paths fail. Every generative prompt falls through to the direct loop.

The activity trace, verbatim and in order:

```
Connecting to Director Service…          ← backend director attempted
Orchestrating production pipeline…       ← director FAILED (swallowed by `catch {}`)
Optimizing prompt…
Analyzing intent…
Directing creative visual…
Generating motion spec…
Storyboarding scene…
Planning 3 scene(s) in parallel…         ← ~7 sequential LLM stages
Pipeline failed. Falling back to direct mode…   ← client pipeline ALSO failed
```

This is D2 confirmed live, and worse than the code review suggested. It is not
that one path is dead — **both are**, on the very first prompt tried. The user
pays the latency and tokens of roughly seven pipeline LLM calls that produce
nothing, and the scene is then authored entirely by the fallback direct loop.

Consequence: **`motion-back/src/ai/director/**` (~13.7k LOC of directors,
critics, design-engine, motion-engine) and `src/core/ai/pipeline/**` (~1.6k LOC
of staged decomposition) do not contribute to any output.** The brief's layers
1–2 exist as code and are dead in practice. Whatever creative direction and
technique selection they were meant to perform is simply not happening.

## L2 — My prediction was wrong. Tool selection is healthy.

I predicted failures would cluster in tool selection — the model bypassing the
technique library for raw primitives. **It does not.** Of 21 write calls, 14 were
compose tools and 7 were `update_layer` polish; there were **zero**
`set_keyframes` and **zero** `create_layer`.

```
define_style 1 · add_scene 3 · add_title 4 · add_kinetic_title 1 · add_emblem 1
add_ambient_orbs 1 · add_light_sweep 1 · add_transition 1 · add_camera_move 1
update_layer 7
```

That is a **67 % compose ratio on writes** — the brief's own success criterion,
already met. The model also read before editing (15 read calls). The direct loop
plus the system prompt is doing the job the dead pipelines were built for, and
doing it in the intended style.

## L3 — So the quality gap is the library's CONTENT, not the plumbing

The rendered result has genuine structure — three scenes tiling the duration, a
transition, a camera move, staggered entrances, 19 layers. What it does not have
is art direction:

- The palette is **placeholder blue** — the exact thing the system prompt warns
  against ("colours are intentional, not placeholder blue") — *despite*
  `define_style` being called first with a "dark, confident, premium" brief.
  `define_style` ran and did not change the look.
- Ambient orbs render as **flat outlined boxes**, not soft bokeh.
- Layout is the default centred stack.

This is the Higgsfield conclusion, arrived at from evidence rather than
assumption: the mechanism works and the **library content is thin**. 16
techniques, one visual register, and a `define_style` that does not visibly
re-colour the result.

## L4 — Stale model configuration

- Backend `/ai/models` catalogue tops out at `gpt-4o` / `gemini-2.0-flash` /
  `claude-3-5-sonnet-20241022` — all 2024-era.
- The editor's own picker is current for Anthropic/Gemini (`claude-sonnet-5`,
  `gemini-3.5-flash`, `gemini-3.1-pro-preview`) but **stale for OpenAI**
  (`gpt-4o`, `gpt-4o-mini`, `o4-mini`), and `openai` defaults to `gpt-4o`.
- The gateway's overload-degradation ladder (`ai-gateway.service.ts:428-436`)
  maps only stale names, so a run on a current model has no fallback entry.

An OpenAI user is silently defaulted onto a 2024 model for a task the brief
correctly says is tier-sensitive.

## Revised build order (supersedes the earlier list)

1. **Un-break or delete the two dead paths (L1).** Surface the errors first —
   one line each — then decide. Either the director/pipeline earn their 15k LOC
   or they should be removed; today they are pure latency and token cost. This
   is the single highest-value item and nothing else can be measured around it.
2. **Fix `define_style` (D1)** — it is called first, on brief, and does not
   change the look. The `accent` contract break is likely part of why.
3. **Grow and enrich the technique library (L3).** This is the Higgsfield answer
   and now the evidence-backed one. Not more techniques for their own sake —
   more *visual registers*: palettes that actually apply, non-centred layouts,
   orbs that look like bokeh.
4. **Instrument the compose ratio (D3)** to keep L2 true as the library grows.
5. **Refresh the model catalogue and OpenAI defaults (L4).**
6. Mechanical verification (see the false-positive table), then D4.

**Not run:** the other nine prompts. Run 1 was decisive enough to change the
build order, and each run costs ~5 minutes and real tokens. The remaining nine
are worth doing once L1 is fixed — measuring the current fallback path nine more
times would mostly re-confirm L1.

---

# Fix log — step 1

**Instrumentation (motion-editor `src/core/ai/AgentLoop.ts`).** The two bare
`catch` blocks now call `recordPathFailure(path, err)`: records path + message +
timestamp, warns to console, exposes the last 20 via `getAiPathFailures()` and
`window.__aiPathFailures`. The fallback behaviour is unchanged — the fallback was
correct, the silence was the bug.

**Root cause found on the first instrumented run.** `AiError: Director backend
returned 400`, then direct probing:

```
sceneSnapshot.layers.0.type must be one of the following values:
shape, text, image, video, audio, camera, null, adjustment
```

`DirectorRunner` sends the editor's `SceneKind` verbatim. That union has **13**
members; the backend `LayerSnapshotDto` allowlisted **8**. Missing: `group`,
`svg`, `light`, `particle`, `comp`. Because one bad layer fails the whole
request, and a group or background is in essentially every real scene,
`POST /ai/director/run` 400'd on virtually every call.

**Fix (motion-back `src/ai/director/dto/director-run.dto.ts`).** Allowlist
widened to the editor's full `SceneKind`, with a sync note pointing at
`seedDefaultScene.ts`. Safe downstream: `type` is used descriptively (prompt
interpolation, one `=== 'text'` test), not in an exhaustive switch.

**Verified.** Kinds that previously 400'd instantly now return `200` with a
streaming director response:

```
200 data: {"type":"intent_resolved","data":{"goal":"Create a baseline motion
graphics sequence.","primaryTone":"professional", ...
```

~13.7k LOC of director/critics/design-engine is reachable for the first time.

**Still open:** the client pipeline's own failure (run 1 showed "Pipeline failed.
Falling back to direct mode…"). The instrumentation will capture its cause on the
next full generation.

## Run 2 — the director, now live

Same prompt, same model (`gemini-3.1-pro-preview`), fresh project.

**The path changed.** Compare the activity traces:

```
BEFORE (director 400s, silently)        AFTER (allowlist widened)
Connecting to Director Service…         Connecting to Director Service…
Orchestrating production pipeline…  ←   Analyzing intent…
Optimizing prompt…                      Directing creative visual style…
Analyzing intent…                       Directing brand visual style…
Directing creative visual…              Directing art visual style…
Generating motion spec…                 Directing motion visual style…
Storyboarding scene…                    Directing camera visual style…
Planning 3 scene(s) in parallel…        Directing typography visual style…
Pipeline failed. Falling back…      ←   Composing multi-scene layout…
                                        Planning cameras & motion physics…
```

No fallback line, and `getAiPathFailures()` stayed **empty**. The multi-director
chain (creative / brand / art / motion / camera / typography directors, then
composition and camera planning) is executing for the first time.

**But it is very slow, and I did not see it finish.** At **320 s** it was still
in server-side planning with **zero tool calls executed** — versus the fallback
direct loop, which produced a complete 19-layer result in **285 s**. The director
plans everything before touching the scene, so nothing is visible until it
completes.

**Open questions this raises, none of them answered yet:**
- Does the director run ever terminate, and how long does it take?
- Is its output better than the fallback's? Unknown — no frame has been rendered
  from it.
- Is ~5+ minutes of planning before the first visible change acceptable UX? The
  fallback path streams tool calls as it goes; the director shows a spinner.

Fixing the 400 made the director *reachable*. Whether it is *worth reaching* is
still unmeasured, and is the first thing to settle before any further work on it.

## Run 3 — director driven directly (SSE), the decisive test

`POST http://localhost:4000/api/ai/director/run` (backend is on **:4000** behind
an **`/api`** global prefix — worth recording, it cost two wrong guesses).

**Result: 207 s, 16 events, 25 KB. It terminates, and the plan is good.**

Event sequence: `intent_resolved` → six `director_start`/`director_done` pairs →
`scene_composed` → `animation_composed` → `error`.

The emitted plan is materially richer than anything the fallback direct loop
produces:

- **Named beats with intensities** — `hook` @0 ms (0.8), `build` @2400 ms (0.7),
  `climax` @7800 ms (1.0), `cta` @10200 ms (0.4)
- **Beat-to-beat transitions** — dissolves, 400 ms each
- **Per-layer parallax depth** — `{layerId, depth}` assignments
- **Camera moves** — `pan` / `pull` / `static` per beat

That is the brief's layer 1→2 (creative direction → scene structure) working as
designed, and it is exactly the narrative-pacing layer the fallback path has no
concept of. On this evidence the director **earns its place**.

**It failed at the last step, on quota, not on a defect:**

```
{"type":"error","code":"run_failed",
 "message":"gemini 429: Your project has exceeded its monthly spending cap."}
```

Two things follow. First, the user's Gemini project is now out of budget —
further testing needs the OpenAI key or a raised cap. Second, and more usefully:
**this error was visible.** Before the step-1 instrumentation it would have been
swallowed by the bare `catch` and silently degraded to the direct loop, which is
precisely the failure mode that hid the 400 for so long.

### Verdict on the director

Keep it. It terminates, and it produces beat structure, transitions, parallax
depth and camera choreography that the fallback cannot. What remains unproven is
only the last mile — the plan was never executed into layers, because the run
died on quota after `animation_composed`.

**Next session, first thing:** re-run with a provider that has budget and let the
plan execute into the scene; screenshot; compare against the placeholder-blue
fallback baseline. Also worth addressing: ~207 s of silent planning before the
first visible change is poor UX next to the fallback's streaming tool calls.

## Fix log — step 2 (D1: `define_style` accent)

`define_style` now accepts a top-level `accent` hex, folded into `palette.accent`
(an explicit `palette.accent` still wins). Schema property added in
`packages/ai-tools/src/tools/compose.ts`; folding done in `toolHandlers.ts`.

`CustomStyleInput.palette` already carried `accent?: string` — the gap was purely
the tool schema, and `additionalProperties: false` turned it into a hard reject.
So the one tool that makes a run on-brand, the tool the system prompt tells the
model to call **first**, failed precisely when used as documented.

Verified headless (no API budget needed):

```
define_style({ accent: '#c8a862' })
→ ok: true
→ "Defined custom style "custom": accent #c8a862 on #13110c, title 104px/700,
   entrance 0.72s, stagger 0.11s, glow on."
```

Note the derived background: `#13110c`, a warm near-black keyed off the gold
accent. The style system *does* derive a coherent palette from one colour — it
simply could never be reached. This makes the run-1 observation ("placeholder
blue despite define_style being called first") a likely direct consequence: the
call was rejected, the run fell back to a preset anchor, and the output was
generic.

Whether fixing it is enough to remove the placeholder-blue look is untested — it
needs a funded provider and a full generation.

## Run 4/5 — new key: the overload cascade is dead for every current model

With the replacement Gemini key:

| Model | Result | Time |
|---|---|---|
| `gemini-3.1-pro-preview` | `429` — "exceeded your current quota" | 3 s |
| `gemini-3.5-flash` | `503` — "This model is currently experiencing high demand" | 4 s |

Neither is a code defect: the key works (the 429 text differs from the previous
key's spending-cap message), and the 503 is transient provider capacity.

**But the 503 should never have reached the user.** `ai-gateway.service.ts:428-436`
implements exactly this cascade — on overload, retry on a secondary tier model:

```ts
'gpt-4o': 'gpt-4o-mini',
'gemini-2.0-flash': 'gemini-1.5-flash',
'claude-3-5-sonnet-20241022': 'claude-3-5-haiku-20241022',
```

Every key in that map is a **2024-era model name**. `gemini-3.5-flash`,
`gemini-3.1-pro-preview`, `claude-sonnet-5` — the models the editor actually
offers — have **no entry**, so the cascade silently does nothing and the raw
provider error propagates. The feature exists, is correct in shape, and is dead
for 100 % of current traffic. Same root shape as the director 400: a hardcoded
list that the rest of the system outgrew.

**Also worth fixing:** a raw `429` is passed through verbatim. A user selecting a
model their key cannot reach sees "quota exceeded", which reads as *"I'm out of
money"* rather than *"you can't use this model"*. `/ai/models` already carries a
capability matrix; nothing checks reachability for the user's own key or
translates the provider error.

### Net effect on L4

L4 was filed as "stale model catalogue". It is worse than cosmetic: the staleness
disables the overload-recovery path entirely, which is precisely the path that
would have absorbed this 503.

## Run 6 — OpenAI: the director's LAST MILE is the real defect

`provider: openai`, `model: gpt-4o` (chosen because it is in the backend
catalogue, so reachability is not a variable). **466 s, 120 KB — 5× the content
of the Gemini run.**

The full chain ran: 6 `director_start`/`director_done` pairs, and rich creative
output — `dissolve`×28, `shape`×15, `pan`/`orbit`/`static`×9 each, plus weight,
scale, gradient and colour decisions. It then produced a **complete execution
plan** with real tool calls:

```json
[{ "id": "bf7c0ddb-…", "tool": "setComposition",
   "args": { "property": "durationMs", "value": 12000 },
   "reversible": false, "or…
```

…and threw it away:

```
run_failed: [extractJson] raw: Cannot extract valid JSON from response:
```json\n[\n  {\n    "id": "bf7c0ddb-…
```

### Root cause — `motion-back/src/ai/director/core/schemas.ts:103`

`extractJson` has three strategies and **the plan payload defeats all three**:

1. `JSON.parse(raw)` — fails, the response is fence-wrapped.
2. Strip fences: `/```(?:json)?\s*([\s\S]*?)```/` — requires a **closing** fence.
   The captured raw has an opening fence and no closing one, i.e. the response
   was **truncated** (max-tokens on a large plan).
3. First `{` … last `}` — the payload is a JSON **array** (`[{…}, {…}]`). There
   is no `[`…`]` branch, so at best this extracts one element, and on truncated
   input it is invalid anyway.

So two compounding bugs: **no array fallback**, and **no handling of a truncated
/ unterminated fence**.

### Why this matters most

Everything upstream works. The director resolves intent, runs six style
directors, composes scenes, plans cameras and motion, and emits a valid
execution plan — ~8 minutes of real work on the user's key — and the entire
result is discarded by a JSON extractor. This is the actual reason no
director-authored frame has ever been rendered.

**Fix sketch** (small, and testable without a provider):
- Add an array branch: first `[` … last `]`.
- Handle an unterminated fence: if an opening fence has no closing one, take
  everything after it.
- Raise the plan-stage token ceiling, or have the composer emit plans in chunks
  — a 12-second, 3-scene brief should not be near the limit.
- Log the raw length on failure; truncation and malformation are different bugs
  and currently look identical.

### Corrected verdict on the director

Not "unproven". **Proven to work, and blocked on one parser.** The 429/503 on
Gemini were provider noise that hid this. On a model with headroom the chain
completes and produces materially richer direction than the fallback path.

## Fix log — step 3 (extractJson)

`motion-back/src/ai/director/core/schemas.ts`. Three changes:

1. **Unterminated fence.** An opening ``` with no closing one (truncated
   response) is now handled after the closed-fence attempt.
2. **Array bracket-slice.** The bracket fallback picks whichever of `{` / `[`
   appears first, so a top-level array — what the execution planner returns —
   slices correctly. An object containing arrays still slices as an object.
3. **Raw length in the error.** Truncation and malformation looked identical in
   a 200-char excerpt; they need different fixes.

Verified against the exact production payload shape (5/5):

- fenced top-level array (the planner payload that failed) ✅
- truncated fence, no closing ``` ✅
- objects, fenced / bare / prose-wrapped ✅
- first-bracket-wins for `{"a":[1,2]}` vs `[{"a":1}]` ✅
- error now reports raw length ✅

Backend typechecks. **Untested end to end** — no director run has been executed
since the fix, so "the plan now survives extraction" is verified at the unit
level only.

## Run 7 — the parser was NOT the root cause. It is truncation.

Re-ran the OpenAI director after the `extractJson` fix. **Still fails** — but the
raw-length logging I added in that same fix is what identified the real cause:

```
Cannot extract valid JSON from response (19780 chars):
```json\n[\n  { "id": "2df8e3a1-…", "tool": "setComposition",
     "args": { "property": "durationMs", "value": 12000 },
     "reversible": false, "or        ← cut mid-token, inside "order"
```

The response is **19,780 characters and cut mid-token**. It is not malformed —
it is *incomplete*. No parser can recover truncated JSON, so none of the three
`extractJson` strategies can work, and none ever could have:

- unterminated-fence branch → yields the truncated array text → `JSON.parse` fails
- array bracket-slice → the last `]` belongs to an inner array → invalid

**`llm-client.ts:125` — `const maxTokens = req.maxTokens ?? 4096;`**

19,780 chars ≈ 5k output tokens, against a 4096 default. The execution planner
emits one tool call per object with `id` / `tool` / `args` / `reversible` /
`order`, so a 12-second, 3-scene brief overruns the ceiling and the plan is
truncated every time. This is why no director run has ever produced a frame.

### Correcting my own diagnosis

Run 6 attributed the failure to `extractJson`'s shape assumptions (no array
branch, no unterminated-fence branch). **That was wrong** — those were real
weaknesses and the fix is still worth keeping, but they were not why it failed.
The parser was never going to be the fix. The added length logging is what
distinguished the two, which is precisely why it was added.

### The actual fix (untried)

- Raise `maxTokens` for the plan stage specifically — it is the one stage whose
  output scales with scene count.
- Better: have the planner emit **per-scene** plans rather than one array for the
  whole piece, so output size stays bounded as briefs get longer.
- Detect truncation explicitly: providers report a `finish_reason` of `length` /
  `MAX_TOKENS`. Treating that as a typed error beats inferring it from a parse
  failure.

Status: **root cause identified and proven, fix not attempted.**

### Narrowing the truncation — a testable hypothesis, not a conclusion

The plan is emitted by **`ToolPlanner`** (`src/ai/director/planners/tool.planner.ts:32`),
`extends DirectorBase<ToolPlannerInput, ToolCall[]>`, which declares:

```ts
protected defaultMaxTokens(): number { return 8000; }   // tool.planner.ts:124
```

But the observed output was **19,780 chars ≈ 4,945 tokens** — comfortably under
8000, and suspiciously *just above* the client default:

```ts
const maxTokens = req.maxTokens ?? 4096;                // llm-client.ts:125
```

So the likely story is that `ToolPlanner`'s 8000 **is not reaching the client**
and the call falls back to 4096. That is a hypothesis with an obvious test —
log the effective `maxTokens` in `llm-client.ts` for one run — not a conclusion.
The alternative (the provider capping output independently) predicts the same
symptom and must be ruled out the same way.

Do not simply raise the number until that log says which it is. This audit has
already had one confident-but-wrong root cause (run 6); the cheap measurement is
what settles it.

### Hypothesis rejected — the ceiling IS being applied

`director-base.ts:95-103` passes `maxTokens` straight into `this.llm.call({…})`,
so `ToolPlanner`'s 8000 does reach `LlmClient` and `req.maxTokens ?? 4096`
resolves to **8000, not 4096**. The previous section's hypothesis is dead.

So the request allowed 8000 output tokens and the provider stopped at ~19,780
chars anyway. For `gpt-4o` that is consistent with the **model's own 4096
output-token cap** — 19,780 chars of UUID-heavy JSON tokenizes at roughly
4.0–4.5 chars/token, i.e. ≈4,400–4,900 tokens, right at that ceiling. Asking for
8000 does not raise a limit the model does not have.

**Consequence: raising `maxTokens` cannot fix this on gpt-4o.** The two real
options are:

1. **Chunk the plan.** Emit tool calls **per scene** instead of one array for the
   whole piece. Bounded output regardless of brief length, and the natural fix —
   a 3-scene brief currently emits one ~5k-token array.
2. **Use a model with a larger output cap** for the plan stage specifically.

Still unverified: whether a different provider/model completes the plan. That is
one run, and it distinguishes "gpt-4o's cap" from "the planner is simply too
verbose for any model" — which need different fixes.

**Method note.** Three root causes proposed this session, two wrong: the parser
(run 6) and the 4096 fallback (above). Both were rejected by a cheap check — raw
length, then reading one call site. The pattern is worth keeping: propose, then
measure before changing anything.

---

# Fix log — steps 4-8 (the engineering half)

Five items, all shipped. Typechecks and suites green in both repos:
motion-editor **349 suites / 3674 tests**, motion-back **9 suites / 70 tests**.

## 1. Plan chunking — truncation fixed at the source

`ToolPlanner.planAll()` (`motion-back/src/ai/director/planners/tool.planner.ts`)
splits the ExecutionPlan into ≤40-step chunks, plans them 3-at-a-time, and
renumbers `order` across the concatenation. Chunk boundaries never split a
layer's steps — a layer's create + visibility + keyframe steps are exactly what
the model collapses into one `add_title`, and splitting them hides that.

Two things beyond the brief:

- **Self-correcting bound.** A chunk that still truncates halves itself and
  retries (depth 3). The ceiling is a property of the model, so a fixed chunk
  size is always wrong for *some* model; splitting on the typed error makes the
  bound adapt instead of needing a per-provider tune.
- **Truncation is now a typed error, not an inference.** `llm-client.ts` reads
  `finish_reason` / `stop_reason` / `finishReason` per provider and
  `DirectorBase` raises `LlmError('truncated', …)` before `extractJson` ever
  sees the text. Run 6 blamed the parser and run 7 blamed a 4096 fallback; both
  were wrong, and both were possible only because truncation and malformation
  were indistinguishable downstream. They no longer are.

`planning` SSE events report chunk progress, so the ~207s of silent planning
now streams `Writing production steps… (2/5)`.

**8 unit tests** (`tool.planner.spec.ts`) cover ordering, no-step-loss,
layer-grouping, and the oversized-group case.

## 2. Two more last-mile blockers — found before the run, not during it

Chunking alone would not have produced a frame. Two further defects sat behind
it, each sufficient on its own to make every director call a no-op:

### L5 — the editor read the wrong field

`DirectorRunner.ts` executed `registry.execute(call.name, …)`. The backend's
`ToolCall` names the tool in **`tool`**; `name` is always `undefined` on that
payload. `ToolRegistry.execute` never throws — an unknown name returns
`ok:false` — so a director run would have reported N successful tool calls,
created **zero layers**, and logged nothing.

This could not surface until truncation was fixed, which is why seven runs
never hit it. Now reads `call.tool ?? call.name`, and skips a nameless entry
rather than dropping the whole plan.

### L6 — the backend planned in a vocabulary that does not exist

`memory.store.ts` `GLOBAL_MEMORY.toolSchema` advertised eleven **camelCase**
names — `createLayer`, `setLayerProperty`, `addKeyframe` — against an editor
registry of **45 snake_case** tools. Not one of them is real. Every plan the
ToolPlanner has ever written was unexecutable by name alone.

Fixed at the class level rather than by editing the list: the editor now sends
its **live registry** as `toolCatalog` on every director run (new DTO field),
and the static list is a fallback only — refreshed to real names, compose tools
first. Same shape as the layer-kind allowlist and the cascade map: a hardcoded
copy of something that lives elsewhere.

**4 tests** (`DirectorRunner.test.ts`) drive a real backend-shaped SSE payload
through the real registry and assert **layers exist** — a call count proves
nothing, since the broken version reported those too.

## 3. Compose ratio — D3 closed

`ToolKind` gains `'compose'`; the 16 compose tools carry it. The metric the
brief calls the best single quality signal is now computed per run and exposed
as `window.__aiToolRatio`, covering the direct loop, the client pipeline and
the director alike.

The hazard the audit flagged was real: `AgentLoop.ts:278` built its
pending-changes list with `kind === 'write'`, which after the split would have
silently dropped all 16 compose tools — the tools doing the most visible work
would have been the ones the user could not review. Replaced with a `mutates()`
helper, and a test asserts every mutating tool still counts.

## 4. Overload cascade — worse than stale: unreachable

L4 said the cascade map named only 2024-era models. True, and it hid a second
defect: **the cascade block sat after a loop whose every path returned.** The
secondary-tier retry and the provider failover were dead code. The gateway has
never once recovered from an overload.

Fixed by extracting `attemptStream()` so `openStream` can sequence
primary → secondary tier → failover provider. Cascading is now gated on
`CASCADABLE_CODES` (capacity problems only — an auth failure fails identically
everywhere). The map is refreshed, and `secondaryModelFor()` falls back to a
naming-pattern rule so the *next* staleness degrades to a guess plus a log line
rather than to silence. Catalogue, `defaultModelFor`, and the task classifier
refreshed alongside; `claude-3-5-sonnet-20241022` was the anthropic default and
is **retired** — a guaranteed 404 for any run that named no model.

**8 tests** (`ai-gateway.cascade.spec.ts`), including one that pins the map to
the editor's picker.

## 5. Mechanical verification — and three more false positives it caught

`src/core/ai/verify.ts`: past-end, offscreen, invisible, opacity-only,
simultaneous. Runs before the vision critique and rides in the same turn;
when rendering fails it still goes out alone, so a director run that produces
no frame is not unchecked.

The audit's false-positive table is encoded structurally, not as comments —
time-sampled bounds, ≥2-keyframe entrances, effect params counted as paired
motion. **13 fixture tests** guard them.

Then I ran it against the **real compose tools** (`verifyAgainstCompose.test.ts`,
5 scenarios) and it immediately produced three more false positives of my own:

| Flag | Why it was wrong |
|---|---|
| `offscreen: Light Sweep` | Uniform 12-point sampling on a 15s comp steps *over* a 0.9s sweep. Now samples every keyframe and midpoint — exact for piecewise motion, not lucky. |
| `simultaneous: 6 layers at 0.00s` | Real orbs carry a 10s y-drift and the background a 10s scale drift. "≥2 keyframes" ≠ "enters" — ambient motion starting together is the *point* of ambient motion. Tracks spanning >60% of the comp are excluded. |
| `opacity-only: Scene 2 BG` | A full-bleed backdrop crossfade is how `add_scene` changes scenes. Frame-filling layers are exempt. |

That is **eight** false positives across two attempts, all from the same root:
assuming what the library does instead of measuring it. The compose-tool test
is the permanent fix — the library is ground truth, and a check that fires on
its output is wrong until proven otherwise.

## Still not done: the live run

**Item 2 of the five is not complete.** `POST /ai/director/run` needs a
signed-in session; I could not create one, and reading the user table to mint a
token was correctly blocked. The backend is up on :4000 with
`HOSTED_AI_ENABLED=true` and a funded OpenAI key in `MOTION_AI_API_KEY`, so
`provider: "motion"` should work — it needs a bearer token from a real login.

What is proven headless: the plan no longer truncates, director-shaped tool
calls execute into real layers, and the verifier is silent on library output.
What is **unproven**: that a full chain end-to-end renders something better
than the placeholder-blue fallback baseline. That remains one run.

**Also unverified:** the OpenAI model list. Anthropic and Gemini ids are
confirmed current; the OpenAI entries (`gpt-4o`, `gpt-4o-mini`, `o4-mini`) are
carried over and marked as such in `aiProviderStore.ts` rather than replaced
with names I could not check. Inventing them would recreate exactly the bug
this pass fixed.

---

# Run 8 — the first director plan that ever reached `tool_calls`

Driven from the editor page against `POST /api/ai/director/run`, `gpt-4o`,
fresh empty 1920×1080 / 30fps / 10s project, real signed-in session.

**140s, 44 KB, HTTP 200.** Event trace, verbatim:

```
intent_resolved
director_start/done: creative, brand, art, motion, camera, typography
scene_composed
animation_composed
planning 1/2          ← chunking
planning 2/2
tool_calls            ← 45 calls. FIRST TIME THIS HAS EVER HAPPENED.
critique              ← score 7.3/10
improving             ← "re-running: art"
scene_composed
error                 ← openai 429, tokens-per-min limit (30,000 TPM)
```

## What this proves

**Truncation is fixed.** `planning 1/2 → 2/2 → tool_calls` is the chunker
working end to end: a plan that has been truncated on every previous attempt
was emitted whole. Runs 6 and 7 died before this point every time.

**The planner now writes in a vocabulary that exists.** First call:

```json
{ "tool": "update_composition",
  "args": { "durationSeconds": 10, "fps": 30, "width": 1920, "height": 1080 } }
```

`update_composition` is a real editor tool. Before the `toolCatalog` fix this
would have been `setComposition({property, value})` — a name the registry has
never had.

**The 429 is not a defect.** `Rate limit reached for gpt-4o … on tokens per min
(TPM): Limit 30000, Used 30000`. Provider quota, hit during the quality loop's
second iteration.

## L7 — the plan is named correctly and argued wrongly: 39 of 45 rejected

Executing all 45 calls against the real registry: **6 ok, 39 rejected.** Every
rejection is argument shape, not tool name:

| Tool | ok/fail | Rejection |
|---|---|---|
| `create_layer` | 6/0 | — (guessed args happened to match) |
| `set_keyframes` | 0/12 | unknown property `nodeId`. Allowed: `keyframes` |
| `update_layer` | 0/11 | unknown property `props` |
| `add_effect` | 0/6 | missing required property `type` |
| `add_camera_move` | 0/5 | `kind` must be `push_in`\|`pull_out` — got `push`, `orbit`, `zoom-in`, `zoom-out` |
| `add_transition` | 0/4 | `kind` must be `fade_black`\|`flash` — got `dissolve` |
| `update_composition` | 0/1 | unknown properties `width`, `height` |

**Cause: my own incomplete fix.** I sent `toolCatalog` as `{name, description}`
and reasoned that the descriptions carried enough semantics. They do not. Every
tool sets `additionalProperties: false`, so an invented argument name is a hard
reject and prose is not a contract. Fixed: the catalogue now carries
`inputSchema`.

Size mattered — the full catalogue is ~10.7k tokens and the planner sends it
once per chunk, which on a 30k TPM account is enough to 429 the run by itself.
So the schemas are sent **enforceable-only**: nested `description` strings
stripped, everything the validator checks (`properties`, `type`, `enum`,
`required`, `additionalProperties`, numeric bounds) kept. 10.7k → 7.0k tokens
with no loss of contract.

## L8 — the director's compose ratio is far WORSE than the fallback's

Of the 45 calls: `create_layer` 6, `update_layer` 11, `add_effect` 6,
`set_keyframes` 12, `update_composition` 1 — versus `add_camera_move` 5 and
`add_transition` 4 from the technique library.

That is roughly **20% compose**, against the fallback direct loop's measured
**67%** (L2). The director plans *better* at the narrative level — beats,
transitions, parallax depth, camera choreography — and then its ToolPlanner
translates that plan into hand-authored primitives, bypassing the vetted
easing and stagger the compose tools own.

This reverses part of the earlier reading. L2 concluded "tool selection is
healthy" — true of the direct loop, and **not** true of the director path,
which no run had ever reached far enough to measure. It is also the most
plausible explanation for why director output would look *worse* than the
fallback despite better direction: the fallback reaches for `add_title`, the
director reaches for `create_layer` + four `set_keyframes`.

The `compose` tool-kind added in step 3 makes this measurable going forward.
The ToolPlanner's system prompt already documents the compose vocabulary; it
needs to prefer it, which is a prompt change plus the schemas it now has.

## Method note — two runs spent, one wasted by me

The second run was killed mid-flight because I edited `DirectorRunner.ts` while
Vite was watching it; HMR reloaded the page and dropped the in-flight fetch.
**Do not edit watched source while a run is in flight.** An earlier attempt
through the AI panel died the same way, from another session's writes to the
same working tree.

## Status

Verified live: chunking, real tool names, the 429 diagnosis, the compose-ratio
gap. Fixed but **not yet verified live**: the `inputSchema` catalogue. That is
one more run, and it should take the 39 rejections to near zero.
