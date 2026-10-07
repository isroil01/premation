# AI Author mode — plan

Status: approved 2026-10-07. Order M1 → M2 → M3 → M4 → M5, one commit per
milestone (`feat(ai-author): M<n> …`).

## Why

The generative path today is the caster: three model calls that pick a look
pack, one layout template per beat and one technique per beat from ~37
templates and ~62 techniques. Every keyframe comes from a library, so the
craft floor is deterministic, and so is the ceiling. The libraries draw
rectangles, text and one gradient. Nothing the caster can emit uses the
engine's 3D, its 212 effects, particles, depth of field, text animators, path
operators or the user's footage. Prompts that ask for different films get
the same handful of compositions.

Author mode lets the model write the whole composition against the engine's
real vocabulary, render it, look at it, and revise the beats that fail. The
caster stays: it is the fallback when an author run fails, and it is the
baseline the eval harness (M4) compares against.

Pixel generation (generated video) is phase three. It is a layer inside an
authored composition, never the composition itself, so typography, brand and
data stay editable.

## Decisions (settled)

| Decision | Value |
| --- | --- |
| Default generative mode | `author`; `library` (caster) is the user-selectable alternative and the fallback |
| Default authoring model | `claude-opus-5` |
| Video generation | mocked (no fal key); real provider is a later swap behind the same interface |
| Imagery in the author vocabulary | `generate_image`, `import_svg` from M3 |
| The compiler | NEVER designs. No template defaults, no palette or layout substitution. It repairs invalid input only and reports every repair |
| Critique | structured JSON per beat, never a score to average |
| Rounds | at most `MAX_AUTHOR_ROUNDS = 2` revise passes |
| Layering | `packages/author` is pure (no `src/**`, no React, no Zustand); the runner lives in `src/core/ai/author` |

## Architecture

```
prompt
  ├─▶ [LLM] DESIGN            prompts.designPrompt      → script header + beat outline
  ├─▶ [LLM] BEATS (≤3/call)   prompts.beatsPrompt       → layers per beat, resumed on truncation
  ├─▶ [code] COERCE           coerce.coerceScript       → valid SceneScript + repair notes
  ├─▶ [code] COMPILE          compile.compileScript     → ToolCall[] + per-beat ranges
  ├─▶ [code] ADVISE           advisors.adviseScript     → design / timing / UI findings per beat
  ├─▶ [host] EXECUTE          registry.execute          → inside the run's open transaction
  ├─▶ [host] LOOK             verifyScene + critique evidence + per-beat filmstrips
  ├─▶ [LLM] CRITIQUE          prompts.critiquePrompt    → { beats: [{ index, verdict, findings }] }
  └─▶ [LLM] REVISE failing beats → wipe beat roots → replay their calls   (≤2 rounds)
```

One prompt is still one undo entry: every call runs on the turn's engine
session inside the transaction `runAgent` opened.

### The scene script (`packages/author/src/types.ts`)

A JSON document the model writes and the compiler reads.

- **Header**: `title`, `intent` (one sentence), `durationSec`, `background`,
  `palette` (named swatches the author chooses, referenced as `$name`),
  `grid` (`columns`, `gutter`, `margin`, `baseline`, px), `type` (named
  type styles: family, weight, size, tracking, leading).
- **Beats**: `name`, `purpose`, `startSec`, `endSec`, `layers[]`.
- **Layers**: `id` (unique in the script), `kind`, `name`, optional `parent`,
  static properties (geometry, transform, fill, stroke, type, blend, matte,
  3D, material), optional `inSec`/`outSec`, and the motion: `keys` (prop →
  keyframes), `effects[]` (type, params, keyed params), `textAnimators[]`,
  `trim`, `repeater`, `pathOps[]`, `masks[]`, `expressions`, `light`,
  `image` (generate_image prompt), `svg` (markup), `video` (M5).
- **Time**: every time inside a beat is BEAT-LOCAL seconds (0 = the beat's
  start). The compiler converts to composition seconds. A revised beat can
  then be retimed without touching its keys.

### The compiler (`compile.ts`)

Deterministic: the same script compiles to the same calls, byte for byte.

- Per beat it emits a null root `beat_<i>` at the origin, timed to the beat,
  and parents the beat's top-level layers to it. Wiping a beat for revision
  is one `delete_layer` on its root; replaying is its call range.
- Layers get a bar: `set_layer_timing` with the layer's `inSec`/`outSec`, or
  the beat's bounds.
- Effects get stable ids (`add_effect { id }`), trims and repeaters get
  operator handles (`set_trim_path { id }`, M1), so keyframes on them are in
  the same batch.
- Output: `{ calls, byBeat: [{ beatIndex, start, end }], problems }`.

What the compiler may do: resolve `$palette` references, convert beat-local
time, clamp a value outside its schema range, drop a field the schema does
not take, and say so. What it may not do: choose a colour, a size, a
position, a font, an ease or a duration the script did not state.

### Coercion (`coerce.ts`)

The model output is untrusted. Coercion turns any JSON into a valid
`SceneScript` plus a list of repairs:

- unknown effect types → the nearest effect by type and label over
  `EFFECT_CATALOG`, unknown params → nearest param key or dropped;
- unknown props → a small alias table (`positionX` → `x`), else dropped;
- bad numbers → dropped, out-of-range → clamped; duplicate ids → suffixed;
- beats out of order or overlapping → sorted, never re-spaced.

### Advisors (`advisors.ts`)

The caster's three linters, unchanged, run over the compiled calls:
`lintDesign` (via `sceneFromCalls` and the script's own grid), `lintTiming`
and `lintUiMotion` (only when a layer is tagged `role: "ui"`). Findings are
mapped back to beats through the layer → beat map. They are advice for the
critique and the revise prompt, not automatic fixes.

### Prompts (`prompts.ts`, `vocabulary.ts`, `exemplars.ts`)

- The craft and never-do rules move out of `src/core/ai/buildContext.ts`
  into `packages/ai-tools/src/craftRules.ts` so the direct loop and author
  mode share one copy.
- `vocabularyCard()` is the engine vocabulary as a compact card: layer
  kinds, settable and animatable props, every AI-reachable effect with its
  numeric params and ranges, text animator params, easings, blend modes,
  path operators.
- Three exemplars converted from `src/core/ai/exemplars` into full scene
  scripts, used as few-shot references.

### The runner (`src/core/ai/author/AuthorRunner.ts`)

`runAuthorPipeline(options, ctx, registry, writeNames, tally)`:

1. Design call (images attached here only).
2. Beat chunks of at most three beats; a truncated chunk (`stop: max_tokens`)
   keeps its complete beats via `extractJsonArrayItems` and asks again for
   the rest.
3. Coerce, compile, advise, execute.
4. Look: `verifyScene`, `renderCritiqueEvidence`, a filmstrip per beat
   (`renderFilmstripWindow`).
5. Critique (structured JSON). Beats with `verdict: "revise"` get one revise
   call each with the beat's spec, the critique findings and the advisor
   findings.
6. Wipe each revised beat's root, replay its compiled calls. Up to
   `MAX_AUTHOR_ROUNDS` rounds.

Stages report through `AUTHOR_STAGE_LABELS`; the chat panel's checklist reads
`PIPELINE_STAGE_LABELS_BY_MODE`.

`askJson` moves out of `CasterRunner` into `src/core/ai/askJson.ts` and
returns `{ value, truncated }`, reading the stop event.

### Routing

`runAgent` takes `mode: 'library' | 'author'` (default `authorModeDefault()`).
Author runs before the caster; on failure it records
`recordPathFailure('author', …)` and the caster runs. After a successful
author run the sighted polish loop gets `maxCritiques = 1`, because the
author pipeline has already looked at its work.

## Milestones

### M1 — engine vocabulary the author needs

- `set_layer_timing { items: [{ nodeId, startSec?, inSec?, outSec? }] }`
  (`packages/ai-tools/src/tools/write.ts`), handled by
  `hostWrites.applyLayerTiming` → one engine `setLayerTiming` in flicks.
- `id` handles on `set_trim_path` and `add_repeater`; the registry rewrites
  `pathop.<handle>.…` and `opId`.
- `update_layer`: `anchorX`, `anchorY`, `skew`, `skewAxis`, `fillOpacity`,
  `stroke`, `strokeWidth`, `strokeOpacity`.
- `isAnimatableProp`: an explicit `SAMPLED_LAYER_PROPS` set, gated by
  `animatableCatalog.native.test.ts`.
- Done when: registry, handler and activity-label tests pass;
  `layerTiming.native.test.ts` and `animatableCatalog.native.test.ts` are
  written (they run on a machine with the engine built).

### M2 — `packages/author` (pure)

- Scaffolding copied from `packages/caster`; registered in `tsconfig.json`,
  `vite.config.ts`, `jest.config.cjs`.
- `types.ts`, `schema.ts`, `coerce.ts`, `compile.ts`, `advisors.ts`,
  `prompts.ts`, `vocabulary.ts`, `exemplars.ts`; `craftRules.ts` in
  `packages/ai-tools`.
- Done when: compile is deterministic and covers every layer feature;
  coerce repairs the listed failure shapes; advisors attribute findings to
  beats; a src-side test proves every vocabulary prop passes
  `isAnimatableProp` and every vocabulary effect is in the `add_effect` enum.

### M3 — the runner, routing and UI

- `askJson.ts`, `author/AuthorRunner.ts`, `AgentLoop` mode branch,
  `flags.authorModeDefault()`, `useAiChat` `AiDirection.mode` and
  `PIPELINE_STAGE_LABELS_BY_MODE`, the Author / Library chip in
  `AiChatPanel`, the image-model ladder in `electron/aiProxy.ts`
  (`gpt-image-1` → `dall-e-3`, `imagen-4.0` → `imagen-3.0`).
- Tests through a `setTransportOverride` seam in `aiTransport.ts`.
- Done when: a scripted transport drives a full author run (design, chunked
  beats with one truncation, critique, one revision) and the stage, routing
  and direction tests pass.

### M4 — eval harness

- `src/core/ai/author/eval`, skipped unless `AI_EVAL=1`; runs on
  `setupAppEngine({ gpu: true })`.
- Record / replay transport (fixtures on disk), 15 prompts, a pngjs contact
  sheet per run, two vision judges with fixed rubrics, JSON artifacts per
  run, `scripts/ai-eval/compare.mjs` for author vs. library.
- Done when: the harness typechecks, replay is deterministic, and compare
  produces a table from two artifact folders.

### M5 — generated video as a layer

- `generate_video` gains `aspect`, `startSec`, `model`, `fit`.
- `FAL_VIDEO_MODELS`, `aiMediaMock.ts` (the mock provider), `aiMediaCache.ts`
  (same request, same asset, no second charge), placement through
  `applyLayerTiming`, a default video model in Settings.
- Follow-up outside this repo: motion-back parity for the video gateway.

## Risks

- **Output size.** A five-beat script with effects is large; chunking and
  resume bound one response, not the run. Measured in M4.
- **Untested provider shapes.** Structured output differs per provider; the
  author calls ask for JSON in text and parse it leniently, with the schema
  as a hint.
- **Native suites.** The `*.native.test.ts` files need the engine; they are
  written against the harness and run on the Windows machine.
