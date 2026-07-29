# MYA Motion — Full AI Architecture Analysis (Editor + Backend + UI/UX)

**Scope:** `Desktop/motion-editor` (Electron + Vite + React renderer) and `Desktop/motion-back` (NestJS + Postgres/Prisma).
**Date of analysis:** 2026-07-28
**Method:** direct read of every AI-related module on both sides, plus the wire contracts between them and the UI surfaces that expose them. Nothing here is inferred from documentation comments alone — where a comment and the code disagree, the code is reported.

---

## 0. One-paragraph summary

The AI system is a **two-headed architecture**. The *editor* owns the document, the tool registry (45 tools), the agent loop, the visual self-critique loop, and the undo transaction. The *backend* owns the provider API keys (AES-256-GCM at rest), the endpoint allowlist, credit metering, conversation persistence, and a second, much larger **multi-director planning pipeline**. A generative prompt can therefore be served by any of **three** independent code paths, tried in order: backend director → client pipeline → direct tool loop. All three converge on the same tool registry and the same sighted polish pass. The design is coherent and unusually well-defended (SSRF allowlist, atomic credit reservation, single-undo transactions, typed error codes end to end). Its problems are not architectural — they are **~7,900 LOC of never-invoked backend subsystems**, a **credit/plan bypass on the director endpoint**, a **plaintext API key written to localStorage by the settings UI**, and a set of **UI controls wired to nothing**.

---

## 1. System map

```
┌──────────────────────────── motion-editor (renderer) ─────────────────────────────┐
│                                                                                    │
│  AiChatPanel.tsx ──▶ AiChatContext ──▶ useAiChat.ts  (chat state, threads, Apply)   │
│                                            │                                       │
│                                            ▼                                       │
│                                    core/ai/AgentLoop.ts   ◀── the orchestrator      │
│                                            │                                       │
│           ┌────────────────────────────────┼────────────────────────────────┐      │
│           ▼ (1)                            ▼ (2)                            ▼ (3)  │
│   DirectorRunner.ts             pipeline/PipelineOrchestrator        direct loop    │
│   POST /ai/director/run         10 client-side LLM stages            model↔tools    │
│           │                                │                                │      │
│           └────────────┬───────────────────┴────────────────────────────────┘      │
│                        ▼                                                           │
│              @motion/ai-tools ToolRegistry  (45 tools: 7 read / 25 write / 13 compose)
│                        │                                                           │
│                        ▼                                                           │
│         toolContext.ts ── SceneFacade / AnimFacade / CompFacade / TimeFacade        │
│                        │                                                           │
│                        ▼        aiTransaction.ts  ── ONE undo entry per prompt      │
│              live scene graph + animation engine                                   │
│                        │                                                           │
│                        ▼                                                           │
│         renderFeedback.ts ─ renders 3 frames ─▶ back into the model as images       │
└────────────────────────────────────────────────────────────────────────────────────┘
                         │ HTTPS + Bearer JWT
┌────────────────────────▼──────────────── motion-back (NestJS) ─────────────────────┐
│  AiModule                                                                          │
│   ├── AiGatewayController   /ai/keys, /ai/stream, /ai/models                        │
│   ├── AiGatewayService      key crypto, endpoint allowlist, retry, cascade, credits │
│   ├── AiController          /ai/conversations…  (thread persistence)                │
│   └── DirectorModule        /ai/director/run  (SSE multi-director pipeline)         │
│        ├── LIVE:  IntentEngine → 6 Directors → SceneComposer → AnimationComposer    │
│        │          → ExecutionPlanner → ToolPlanner → QualityLoop (6 critics × 5)     │
│        └── DEAD:  PlatformModule, KnowledgeModule, TasteModule,                     │
│                   MotionEngine, DesignEngine, EvaluationEngine   (~7 900 LOC)       │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### Code-size ledger

| Area | LOC (excl. tests) | Status |
|---|---:|---|
| `motion-back/src/ai` — gateway + history | ~1 137 | **live** |
| `motion-back/src/ai/director` — core pipeline | 5 135 | **live** |
| `motion-back/src/ai/platform` | 1 292 | **never invoked** |
| `motion-back/src/ai/knowledge` | 735 | boot-seeded, never queried |
| `motion-back/src/ai/taste` | 942 | **never invoked** |
| `motion-back/src/ai/director/motion-engine` | 2 010 | **never invoked** |
| `motion-back/src/ai/director/design-engine` | 1 392 | **never invoked** |
| `motion-back/src/ai/director/evaluation-engine` | 1 532 | **never invoked** |
| `motion-editor/src/core/ai` | 7 318 | live (2 195 of it is the client pipeline) |
| `motion-editor/packages/ai-tools` | ~2 460 | live |

**~7 903 of 14 175 backend AI lines (56 %) are unreachable at runtime.**

---

## 2. Backend architecture (`motion-back`)

### 2.1 The AI Gateway — `src/ai/ai-gateway.service.ts` (566 LOC)

This is the load-bearing security boundary and the best-engineered file in the AI subsystem.

**Key custody.** `AiProviderKey` rows hold `encryptedKey` (AES-256-GCM, `iv.authTag.ciphertext`, base64) plus a `hint` (`sk-…4f2a`) computed once at save time. The master key is `scryptSync(process.env.AI_KEY_SECRET, 'motion-ai-key-store', 32)`. **There is deliberately no read endpoint** — `GET /ai/keys` returns `{present, hint}` only. If `AI_KEY_SECRET` is missing, `saveKey` throws and the controller answers `{ok:false, reason:'unavailable'}` rather than storing plaintext.

**SSRF defence.** Clients send a *provider id*, never a URL. `ENDPOINTS` is a hardcoded 9-entry allowlist (openai, anthropic, gemini, fal, runway, luma, tripo, meshy, elevenlabs). `redirect: 'error'` on the fetch prevents a provider from bouncing the auth header to another host.

**Resilience ladder**, in order:
1. `attemptStream` — up to 3 attempts, exponential backoff + jitter, retrying only 429/503/529 and network drops, and only when the wait is ≤ 8 s (otherwise it hands `retryAfterMs` back so the client backs off instead of holding a socket).
2. **Model cascade** — `secondaryModelFor()` drops one capability tier (`claude-opus-5 → claude-opus-4-8 → claude-sonnet-5 → claude-haiku-4-5`; `gemini-*-pro → *-flash`; `gpt-4o → gpt-4o-mini`), with a naming-pattern fallback so an unlisted new model still degrades to a guess **plus a log line** rather than silently doing nothing.
3. **Provider failover** — if the user has a second BYOK key, retry there with no model override.

Only `rate_limit | overloaded | network` are cascaded (`CASCADABLE_CODES`); auth/context-length failures fail identically everywhere and cascading them would only double latency.

**Streaming.** `/ai/stream` pipes raw upstream bytes: `res.write(value)` in a reader loop. The server never parses SSE — the editor's per-provider adapters do. `res.on('close') → controller.abort()` propagates cancel to the provider so tokens genuinely stop. A 120 s idle timer kills stalled streams.

### 2.2 Credits & plan gating — `src/ai/ai-policy.ts`

Two meters, two audiences:

- **BYOK** (`openai|anthropic|gemini|…`) — user's key, user's bill. `creditsUsed: 0` always. Logged in `AiUsage` for their own visibility only.
- **`motion`** (hosted) — *our* env key (`MOTION_AI_API_KEY`), forced model (`MOTION_AI_MODEL`), metered at `CREDITS_PER_RUN = 1`.

Credits are **reserved before the provider call** with a single atomic statement:

```ts
prisma.user.updateMany({
  where: { id: ownerId, aiCredits: { gte: cost } },
  data:  { aiCredits: { decrement: cost }, aiCreditsUsed: { increment: cost } },
})
```

The balance check is inside the `WHERE`, so ten concurrent streams cannot all pass a read-then-charge race. `refundCredits` hands the reservation back only when the provider call never got off the ground. Both paths invalidate the `/auth/me` cache tag so the UI counter doesn't lag behind the charge.

Commercial dials are env-only, so pricing changes need no deploy of new code: `HOSTED_AI_ENABLED`, `MOTION_AI_MIN_PLAN` (`free`|`pro`), `MOTION_AI_SIGNUP_CREDITS` (default 25).

Typed refusals map cleanly to HTTP: `no_key`→400, `coming_soon`→403, `upgrade_required`/`no_credits`→402, `auth`→401, `rate_limit`→429, `context_length`→413, `overloaded`→503, else 502.

### 2.3 The Director pipeline — `POST /ai/director/run` (SSE)

`DirectorService.run()` is a 10-stage orchestration streamed as typed SSE events:

| # | Stage | LLM? | Notes |
|---|---|---|---|
| 1 | Resolve API key | — | BYOK from DB, or `MOTION_AI_API_KEY` |
| 2 | `MemoryStore.assembleRunMemory` | — | global + project + conversation + brand + motion + preference |
| 3 | `IntentEngine` | ✅ | emits `intent_resolved` |
| 4 | **Directors, in dependency order** | ✅ ×6 | `creative + brand` (parallel) → `art + motion + camera` (parallel, fed the *real* creative directive) → `typography` (fed the *real* art directive) |
| 5 | `SceneComposer` | ❌ deterministic | pure merge + conflict resolution; duration extension, palette reconciliation (brand wins), pacing/stagger coherence warnings |
| 6 | `AnimationComposer` | ✅ | |
| 7 | `ExecutionPlanner` | ❌ deterministic | |
| 8 | `ToolPlanner` | ✅ chunked | the **only** module that knows editor tool names; 40 steps/chunk, concurrency 3, halving retry on truncation (`MAX_SPLIT_DEPTH 3`) |
| 9 | `QualityLoop` | ✅ ×6 critics | visual/motion/composition/typography/camera/brand, `Promise.allSettled`, neutral 7.0 fallback per failed critic |
| 10 | Targeted re-run | ✅ | only `directorsToRerun`, with `critiqueFeedback` injected; up to 5 iterations or score ≥ 9.5 |

**`DirectorBase`** gives every director/critic: own system prompt, own parser, JSON extraction, schema validation, **2 parse retries with the validation error fed back as correction context**, a 90 s per-call timeout, and an explicit `truncated` short-circuit. That last one is notable — `LlmClient.extractTruncated()` reads the provider's own signal (`finish_reason:'length'`, `stop_reason:'max_tokens'`, `finishReason:'MAX_TOKENS'`) rather than inferring truncation from a downstream parse failure. The file comments record that inferring it cost two wrong root causes.

**`LlmClient`** is a deliberately thin non-streaming wrapper: build provider-native body, call, extract text/usage/truncation, retry 429/503/529 with backoff ≤ 10 s. Zero business logic, no JSON parsing.

**`EventBus` → SSE** in `DirectorController`, with a 180 s idle timer and `res.on('close') → abort`.

### 2.4 Memory — `core/memory.store.ts`

Six scopes, each with its own TTL cache, and **typed accessors so no module can read the whole memory**:

| Scope | Backing | TTL |
|---|---|---|
| Global (tool schema, editor conventions) | hardcoded constant | ∞ |
| Project | `Project.aiMemory` (Json) | 10 min |
| Conversation | in-process only | 30 min |
| Brand | `User.brandMemory` (Json) | 60 min |
| Motion | in-process only | 30 min |
| User preference | in-process only | 60 min |

`GLOBAL_MEMORY.toolSchema` is explicitly labelled **fallback only** — the editor now ships its live registry as `toolCatalog` on every run.

### 2.5 Persistence — `AiService` + Prisma

- `AiConversation` / `AiMessage` with an **`seq Int @default(autoincrement())`** ordering column. The schema comment explains why: `createMany` stamps a whole exchange with the same millisecond, so `orderBy: createdAt` would let the reply sort before the question.
- Thread fetch is bounded to the newest 200 messages, fetched `seq desc` then reversed, with a separate `_count` so the UI knows the true length.
- Prose only — tool calls and results are deliberately **not** stored: they are snapshots of a document that has since changed, so replaying them would be expensive and actively misleading.
- `isError` marks failed turns so they rehydrate as warnings and are never replayed to the model as assistant prose.
- Deletes are scoped with `deleteMany({ where: { id, ownerId } })` — an id alone cannot reach another account's thread.
- `AiUsage` records `provider, model, requestBytes, responseBytes, creditsUsed` per stream.

### 2.6 The dead half

Six fully-built subsystems are constructor-injected into `DirectorService` and **never referenced in any method body**:

```ts
constructor(
  private readonly memoryStore: MemoryStore,           // ✅ used
  private readonly gateway: AiGatewayService,          // ✅ used
  private readonly platformService: PlatformService,       // ❌ never called
  private readonly knowledgeService: KnowledgeService,     // ❌ never called
  private readonly designEngineService: DesignEngineService,     // ❌
  private readonly motionEngineService: MotionEngineService,     // ❌
  private readonly evaluationEngineService: EvaluationEngineService, // ❌
  private readonly tasteService: TasteService,          // ❌
) {}
```

A repo-wide grep finds no other call site. What is lost:

- **PlatformService** (1 292 LOC) — `SafetyGuardrails.inspectPrompt` (prompt-injection heuristics + sanitisation), `TaskClassifier`, `ModelRouter.selectOptimalModel`, `ContextManager` token budgeting, `CircuitBreakerManager`, `CostOptimizer`, `MetricsCollector`, `HierarchicalMemoryManager`, `ExecutionScheduler` (DAG), `SemanticRetrievalEngine`, `SpeculativeExecutionEngine`, `PluginManager`. **The only prompt-injection defence in the codebase sits here and never runs.**
- **KnowledgeService** (735 LOC) — 5 knowledge domains *are* seeded on `onModuleInit` (so they cost boot time and memory), but `queryKnowledge` / `recordResult` are never called. The graph is built and never read.
- **TasteService** (942 LOC) — a 5-reviewer Taste Board (luxury/film/typography/motion/advertising) plus originality, attention, emotion, craftsmanship, consensus, alternative-explorer, taste memory.
- **MotionEngineService** (2 010 LOC) — motion grammar/language/energy, physics profiles, adaptive timing, recipe and pattern libraries, transition + camera intelligence, micro-motion.
- **DesignEngineService** (1 392 LOC) — style DNA, style mixer, colour/composition/depth/spacing/typography/rhythm engines, design critic, brand design memory.
- **EvaluationEngineService** (1 532 LOC) — **10** specialist critics (adds lighting, colour, story, accessibility, UX over the live 6), multi-frame analyzer, temporal consistency, visual diff/regression guard, targeted improvement planner, failure detector, learning system.

Note the duplication: the live `QualityLoop` runs 6 critics from `director/critics/`; the dead `EvaluationEngine` runs 10 from `director/evaluation-engine/critics/`, four of which have the *same filenames*. Two parallel critic hierarchies exist; only the smaller one runs.

`GET /ai/models` (backed by `ModelRouter.listCapabilities()`) is also a **dead endpoint** — no editor client method calls it.

---

## 3. Editor architecture (`motion-editor`)

### 3.1 `@motion/ai-tools` — the shared vocabulary (~2 460 LOC)

A deliberately pure package: no DOM, no zustand, no `@core`, no `@motion/*`. **Handlers are injected by the host**, which is what lets Electron main, the renderer, and NestJS all read the same schemas.

- **One definition → four wire formats** (OpenAI, Anthropic, Gemini, MCP). A tool is described exactly once and cannot drift between providers.
- **`ToolKind = 'read' | 'write' | 'compose'`** with a `mutates()` helper. The `compose` kind exists to make one number computable: the share of a run's mutations that used the vetted technique library instead of hand-authored primitives.
- **`ToolContext` has no command system and no history** — a handler *physically cannot* push its own undo entry. This is how one prompt is guaranteed to be one undo step.
- **`AiEvent`** normalises all three providers; `tool_call` is emitted *complete*, never as partial-JSON deltas, because the three providers fragment tool arguments in three incompatible ways.
- **Gemini 3+ `thoughtSignature`** is carried through as `AiToolCall.signature` and echoed back — omitting it 400s the next request.

**The 45-tool catalogue:**

| Kind | n | Tools |
|---|---:|---|
| read | 7 | `describe_scene`, `read_tracks`, `evaluate_at`, `get_selection`, `list_capabilities`, `list_presets`, `list_assets` |
| compose | 13 | `define_style`, `add_scene`, `add_background`, `add_title`, `add_kinetic_title`, `add_lower_third`, `add_cards`, `add_emblem`, `add_light_sweep`, `add_ambient_orbs`, `add_camera_move`, `add_transition`, `stagger_in` |
| write | 25 | `create_layer`, `update_layer`, `delete_layer`, `reparent_layer`, `set_keyframes`, `remove_keyframes`, `set_easing`, `set_expression`, `add_effect`, `update_effect`, `text_animator`, `create_media`, `create_media_from_attachment`, `create_mask`, `update_composition`, `apply_preset`, `create_puppet_rig`, `set_puppet_pin_keyframes`, `create_skeleton_rig`, `pose_skeleton`, `merge_paths`, `set_trim_path`, `add_repeater`, `add_path_operator`, `set_text_on_path` |

`ToolResult.content` is addressed **to the model, not the user** — failures must say what to do differently (`"unknown nodeId 'ttl' — did you mean 'title_1'?"`).

### 3.2 `AgentLoop.ts` — the orchestrator (713 LOC)

**Three generation paths, tried in order.** For a prompt the `Router` classifies as `generative`:

1. **Backend director** (`runBackendDirector`) — POSTs prompt + scene snapshot + **the live tool registry with `inputSchema`** to `/ai/director/run`, consumes SSE, executes each `tool_calls` entry against the live document.
2. **Client pipeline** (`PipelineOrchestrator`) — 10 LLM stages entirely in the renderer, producing an execution plan the loop then runs.
3. **Direct tool loop** — classic model↔tool ReAct loop, up to `MAX_STEPS = 22`.

Crucially, paths 1 and 2 **do not return early**. Both set `planExecuted` and fall through into the **sighted polish pass**, so no path ships work that nothing has looked at.

**Path-failure recording.** Falling back is correct behaviour, so `runAgent` cannot throw; instead failures are *recorded* in `pathFailures` and exposed as `window.__aiPathFailures`. The comment is explicit that a bare `catch {}` here is how "~13k LOC of backend director stayed dead in production without anyone noticing."

**The visual feedback loop** — the single biggest quality lever:
1. Model stops calling tools (believes it's done).
2. **Mechanical verification first** (`verify.ts`) — pure arithmetic over the scene graph, so it costs nothing and catches defects a vision pass shouldn't spend a render on.
3. **`renderFeedback.ts`** renders 3 frames at 35 % / 70 % / last-frame via the *same deterministic offline path* as "Save Frame As" and video export, downscaled to 1280 px JPEG.
4. Findings + frames go back as **one** user turn with `CRITIQUE_PROMPT`, which grants "FULL authority to make substantial revisions."
5. Budget: `MAX_CRITIQUES = 2`, or **3** for generative runs (their first critique is the seeded review of the plan-executed scene).

The premature answer is pushed into the *model's* `messages` but **not** into `produced`, so the saved thread only ever shows the final answer.

**Loop protection.** `callKey()` hashes tool name + key-order-stable args. At `LOOP_NUDGE = 3` the loop injects a synthetic failure telling the model to change approach; at `LOOP_ABORT = 5` it throws.

**Compose-ratio telemetry.** Every executed call is tallied `compose | primitive | read`, logged, and exposed as `window.__aiToolRatio`. Recorded *before* the preview branch, so a discarded run is still measured.

**Transaction discipline.** The whole run is wrapped in `beginAiTransaction`. On any throw → `tx.rollback()`, because "a half-applied AI edit is worse than none."

### 3.3 `aiTransaction.ts` — one prompt, one undo

Deliberately coarse: `structuredClone` of the whole `ProjectFile` + `AnimSnapshot` before and after, pushed as a single `StoreSnapshotCommand`. During the run `history.suspend()` blocks other subsystems (e.g. `TimelineController` emitting "Add Track") from littering the undo stack. A read-only run that produces an identical snapshot pushes nothing.

### 3.4 The client pipeline (2 195 LOC)

`PipelineOrchestrator` runs stages, each with `executeStageWithValidation`: run → `validate(schema, result)` → on failure, a **self-repair retry** that shows the model its own invalid JSON plus the validation errors at temperature 0.1.

Stages: prompt optimizer → intent → creative → motion spec → storyboard → **scene plans (parallel per beat)** → **animation + camera plans (parallel × parallel)** → timeline → tool plan → `verifyPipelineOutput` → critique repair (and hard-fail if the second verification still fails).

Two model tiers: `strong` (user's chosen model) and `fast` (`gpt-4o-mini` / `gemini-3.5-flash` / `claude-haiku-4-5-20251001`).

Tool-plan steps may reference layers as `"role:hero_title"`; `resolveRoles()` in `AgentLoop` maps those to real node ids, and newly-created layers are registered into the map as they are created.

### 3.5 Context construction — `buildContext.ts`

`SYSTEM_PROMPT` (~75 lines) is a genuine motion-design brief, not a tool manifest: compose-tools-first policy, "recipes are scaffolding, not the final look", scene-sequencing rules (3–5 scenes tiling the duration, `scene: N` on every content call), craft rules (two keyframes minimum, stagger 0.06–0.12 s, 20–60 px travel, easing choice), a "NEVER DO THESE" section, worked examples, and an explicit **media-is-opt-in** rule.

`buildContextPreamble()` is deliberately ~400 tokens: comp settings with a computed aspect label (`wide/landscape`, `portrait/vertical`, `square`), playhead, layer counts, selection, and — only for comps of ≤ 12 layers — a full inline layer listing with fill/text/font. Past that, top-level names only plus "call `describe_scene` for detail." The model **pages through** the document rather than swallowing it.

---

## 4. Wire contracts

### `POST /ai/stream`
```jsonc
{ "provider": "anthropic|openai|gemini|fal|…|motion",
  "model": "claude-opus-5",
  "isPipeline": true,          // set when req.responseSchema is present
  "body": { /* provider-native, built by the editor's adapter */ } }
```
→ `200 text/event-stream` (raw upstream bytes) or `{code, message, retryAfterMs}` with a typed status.

### `POST /ai/director/run`
```jsonc
{ "provider", "model", "prompt", "projectId?", "conversationId?",
  "toolCatalog": [{ "name", "description", "inputSchema" }],   // live registry
  "sceneSnapshot": { "durationMs", "resolution", "fps", "layers[]", "playheadMs" } }
```
→ SSE: `intent_resolved` → `director_start/done` ×6 → `scene_composed` → `animation_composed` → `planning{done,total}` → `tool_calls` → `critique` → `improving` → `finish` | `error`.

Two hard-won details are encoded in this contract:

- **`LayerSnapshotDto.type`** must list all 13 editor `SceneKind`s. It once listed 8; because *any* unlisted kind fails validation for the whole request, and a group or solid is in essentially every real scene, this endpoint 400'd on virtually every call — and the editor's bare `catch` swallowed it.
- **`inputSchema` is required in practice.** Sending names alone was measured: the planner emitted 45 correctly-named calls and **39 were rejected**, because every tool sets `additionalProperties: false` and the planner had to invent argument names. `DirectorRunner.enforceableSchema()` strips per-property `description` prose (10.7k → ~7k tokens) while keeping every rule a call can be rejected for.

---

## 5. UI / UX analysis

### 5.1 `AiChatPanel.tsx` — the assistant (651 LOC)

Docked as a left-sidebar tab; state is hoisted into `AiChatContext` **above the dock tree**, so switching tabs mid-run neither cancels the run nor rolls back a pending preview.

Layout, top → bottom:
- **Header** — new chat (`+`), history toggle.
- **History list** — title + relative timestamp (`now` / `12m ago` / `3h ago` / date) + per-row delete.
- **Thread** — markdown-rendered messages, user turns with image thumbnails.
- **Empty state** — 7 one-click "Quick Motion Presets" (SaaS Explainer, Apple Minimal Reveal, Cyberpunk Kinetic, Broadcast Lower Third, Trim-Path Logo Reveal, Radial Repeater Burst, Organic Path Morph), each a full brief that submits immediately. This is the strongest onboarding surface in the app.
- **Two live progress cards** — "Production plan" (11 canonical pipeline stages, ✓/spinner/pending) and "Build steps" (one row per tool call, flipping to ✓ / ✗). Plus an always-on activity row so a tool-heavy turn with no prose never looks frozen.
- **Result preview card** — canvas snapshot (`canvas.toDataURL`, 240×135, captured 150 ms after the transaction opens), a play button driving the real `TimelineController`, an "N changes pending" count, and **Apply / Decline**.
- **Composer pill** — textarea (Enter sends, Shift+Enter newline), image attach (click or paste, max 3), a provider/model popover with brand-accurate inline SVG icons and `no key` tags on unconfigured providers, an Auto/Manual mode popover, and a send/stop button.

`activityFor()` maps every tool name to a human phrase — "Painting the background", "Staggering entrances", "Revealing trim-path outlines" — instead of a generic spinner. Genuinely good detail.

### 5.2 `AiSettingsSection.tsx` — key management

Lives in the Settings page (not a modal). Per provider: a lock icon when connected, the masked hint, a model `<select>` seeded from `MODEL_SUGGESTIONS`, an "Active" badge or a "Use this" button, Remove, and a deep link to where the key is actually issued. Saving a key auto-activates that provider — "that is why you connected it."

### 5.3 `useAiChat.ts` — chat state

- **`HISTORY_TURNS = 24`** replayed to the model.
- **`pruneImageTurns`** keeps images on only the **2** most recent image-bearing turns — images dominate context cost and an old reference isn't worth re-sending every turn.
- Failed turns are filtered out of the model-facing history on rehydrate.
- Per-project thread pointer in `localStorage` (`motion_editor_ai_conv:<projectId>`); on project switch everything resets and any pending transaction is rolled back.
- `describeError()` turns every typed `AiError` code into plain user copy.

---

## 6. Findings

### 6.1 Critical

**F1 — `/ai/director/run` bypasses plan gating, credit reservation, and usage metering.**
`DirectorService.resolveApiKey()`:
```ts
if (provider === 'motion') {
  const key = process.env.MOTION_AI_API_KEY;
  if (!key) throw new Error('Motion AI key not configured');
  return key;                 // ← no planAllows, no reserveCredits, no recordUsage
}
```
Every protection `/ai/stream` enforces — `HOSTED_AI_ENABLED`, `motionAiPolicy().minPlan`, the atomic credit reservation, the `AiUsage` row — is absent here. A director run is also **far** more expensive than a single stream: intent + 6 directors + animation composer + N tool-plan chunks + 6 critics, × up to 5 iterations. `DirectorRunDto` accepts `@IsIn(ALL_PROVIDERS)`, which includes `'motion'`. The `isPipeline && provider === 'motion'` guard exists only on `/ai/stream` and does not cover this endpoint. Today this is masked by `motion` being unreachable in the UI (F5), but the endpoint is authenticated and directly callable.

**F2 — The settings UI writes plaintext provider API keys to `localStorage`.**
`AiSettingsSection.save()` does `localStorage.setItem('motion_editor_local_ai_key_' + id, key)`, and `refresh()` reads them back and re-uploads. This directly contradicts the documented posture stated in the same file's header, in `aiProviderStore.ts`, in `AgentLoop.ts`, and in `AiGatewayController` — "the editor never holds a key." The keys survive sign-out, are readable by any code with renderer scope (including plugins — see `docs/PLUGINS.md`), and persist on disk in the Electron profile. The encrypted-at-rest server store is bypassed as a durability mechanism.

### 6.2 High

**F3 — 7 903 LOC (56 % of backend AI) is unreachable.** Six services injected, none called. Consequences beyond dead weight:
- `SafetyGuardrails.inspectPrompt` is the **only** prompt-injection defence in either codebase, and it never executes.
- `ContextManager` token budgeting never runs, so nothing bounds context growth before a provider 413.
- `CircuitBreakerManager` never runs, so a hard-down provider is retried on every request.
- `MetricsCollector` / `CostOptimizer` never run, so per-user AI cost is only knowable from `AiUsage` byte counts.
- The 10-critic `EvaluationEngine` duplicates the live 6-critic `QualityLoop` — two parallel critic hierarchies with four same-named files.
- `KnowledgeService.onModuleInit` still seeds 5 domains and snapshots the graph at boot, so the dead subsystem costs startup time and resident memory.

**F4 — The director pipeline's memory scopes are never populated from real runs.** `AgentLoop` calls `runBackendDirector({ provider, model, prompt, signal, events })` — it never passes `projectId` or `conversationId`, both of which `DirectorRunDto` accepts and `assembleRunMemory` keys on. So `project` and `conversation` memory are always `undefined`, and `previousIntents` / `userCorrections` are always empty. `MemoryStore.saveProject` / `saveBrand` / `saveConversation` / `saveMotion` / `saveUserPreference` have **no call sites at all** — nothing in the pipeline ever writes memory back. The entire memory subsystem is read-only against data nothing produces. `useAiChat` holds a live `conversationId` and `useCloudProjectStore` a live `projectId`; both are simply not threaded through.

### 6.3 Medium

**F5 — Motion AI is fully built end to end and unreachable from the UI.** `PROVIDER_OPTIONS` in `AiChatPanel.tsx` lists only anthropic / openai / gemini. `getModelLabel` handles `'motion'`, `renderProviderIcon` handles `'motion'`, `providerReady` handles `'motion'`, the store's `dialect()`/`model()`/`ready()` all handle `'motion'`, `motionStatus` returns credits/plan/hint — and no control ever sets it. `AiSettingsSection`'s header comment promises "Two ways to power the assistant… Motion AI," but the component renders only the three BYOK rows.

**F6 — Credit UI contradicts the backend.** `BillingSection.tsx` states: *"The AI assistant runs entirely on your own API key — there are no platform AI credits to manage."* The backend grants 25 signup credits (`DEFAULT_SIGNUP_CREDITS`), tracks `aiCredits` / `aiCreditsUsed` on `User`, returns them on `/ai/keys`, and `motionStatus` computes a `"N credits left"` hint. `AiMotionStatus.credits` is typed in the API client and rendered nowhere.

**F7 — The Auto/Manual execution-mode control is write-only.** `useAiChat.submit` hardcodes `preview: true` (`// Always run in preview transaction mode so Apply/Discard works`). `isManualMode` is in the callback's dependency array but never read in the body. Choosing "Auto (Direct apply) — AI changes apply immediately" still shows the Apply/Decline card. The toggle persists to `localStorage` and changes nothing.

**F8 — Three generative paths is one too many.** The client `PipelineOrchestrator` (2 195 LOC, 10 stages) and the backend director (5 135 LOC, 10 stages) are near-identical designs — intent → creative → motion → storyboard/scene → animation → camera → timeline → tool plan → critique — differing mainly in where they run and that only the backend has explicit critics. Every generative prompt pays the backend director's latency first and silently degrades on failure. Since `Router.classify()` returns `'generative'` for anything that isn't a short imperative edit, that is most prompts.

**F9 — `Router.classify()` is a regex, not a classifier.** It returns `'trivial_edit'` only for prompts under 50 chars starting with `make|change|set|delete|move|hide|show|rename|update|align` *and* containing `this|selection|layer|color|title|text|opacity`. Everything else — including "why is my title flickering?" — routes to the full generative pipeline. `RouterOptions` (provider/dialect/model/signal) is accepted and discarded (`constructor(_options)`), so the class is a function wearing an LLM-shaped interface.

### 6.4 Low

- **F10** — `getModelLabel` in `AiChatPanel` has no branch for `claude-opus-5` (the first entry in `MODEL_SUGGESTIONS.anthropic`), so the default Claude selection renders as the raw id. It still carries branches for retired `gemini-1.5-*`, `claude-3-5-sonnet`, `claude-3-7-sonnet`.
- **F11** — `activityFor()` maps `add_logo_reveal`, `add_radial_burst`, `add_path_morph` — none of which are registered tools. Harmless (they fall through to "Working") but misleading.
- **F12** — Error copy points at **"Customize → AI"** (`useAiChat.describeError`) while the in-panel banner links to **`#/dashboard?tab=settings`**. Two names, two destinations, one setting.
- **F13** — `GET /ai/models` is implemented and has no client. `MODEL_SUGGESTIONS` is a hand-maintained editor constant duplicating `ModelRouter.CAPABILITY_MATRIX`; the file comment in `ai-gateway.service.ts` already warns that `SECONDARY_MODELS` "will go stale again."
- **F14** — `AiProviderKey.provider` is a bare `String` with a comment listing only three providers, while `BYOK_PROVIDERS` has nine. Storage allows all nine; only three have any UI.
- **F15** — `PROVIDER_OPTIONS` (chat) and `PROVIDERS` (settings) are two independent hardcoded provider lists that must be kept in sync by hand.
- **F16** — `discardPending()` does `setMessages(m => m.slice(0, -2))`, which assumes exactly two trailing messages. If a run appended an error turn or the user submitted while a transaction was open, this clips the wrong rows.

---

## 7. What is genuinely well done

Worth stating plainly, because the finding list above is longer than it deserves:

1. **The key-custody boundary.** Provider id in, never a URL; allowlist server-side; `redirect: 'error'`; no read path for keys; masked hints computed at write time. (Undermined only by F2, which is a UI-layer regression against an otherwise correct design.)
2. **Atomic credit reservation.** Check-and-decrement in one statement, reserved before the provider call, refunded only when the call never happened, cache invalidated on both paths. This is the correct order and most implementations get it wrong.
3. **The sighted feedback loop.** Rendering through the *same deterministic path as export* and feeding real frames back, cheap mechanical checks before expensive vision checks, findings and frames in one turn, a bounded critique budget. This is the highest-leverage part of the whole system.
4. **`ToolContext` as a capability boundary.** No history access means one prompt cannot fragment into thirty undo steps — enforced structurally, not by convention.
5. **One definition → four wire formats**, with complete (never partial-JSON) tool calls and Gemini `thoughtSignature` passthrough.
6. **Truncation read from the provider, not inferred.** `finish_reason === 'length'` short-circuits before the JSON extractor ever sees incomplete output.
7. **Failures are recorded, not swallowed.** `window.__aiPathFailures`, `window.__aiToolRatio`, and the "no secondary tier known — cascade skipped" warning all exist because a silent fallback previously hid a dead subsystem for months.
8. **The `seq` column.** Recognising that `createMany` ties `createdAt` across a batch, and that ordering by it would scramble an exchange, is the kind of detail most schemas get wrong.
9. **The system prompt is a design brief.** Compose-first policy, scene tiling, "recipes are scaffolding not the final look", craft numbers, media-is-opt-in — it teaches taste, not API syntax.
10. **The comments carry postmortems.** Multiple files record the wrong diagnosis that was tried first. That is unusually honest and directly useful.

---

## 8. Suggested order of work

| Priority | Item | Findings |
|---|---|---|
| 1 | Gate `/ai/director/run` through the same plan/credit/usage path as `/ai/stream` | F1 |
| 2 | Delete the `localStorage` key mirror from `AiSettingsSection` | F2 |
| 3 | Decide the fate of the 6 dead services: wire in, or delete (at minimum, wire `SafetyGuardrails` and `ContextManager`) | F3 |
| 4 | Thread `projectId` + `conversationId` into `runBackendDirector`, and add memory write-back | F4 |
| 5 | Either expose Motion AI (picker + credits UI) or remove the half-built client surface | F5, F6 |
| 6 | Make Auto/Manual mode real, or remove the control | F7 |
| 7 | Pick **one** generative pipeline; keep the other only as an explicit offline fallback | F8, F9 |
| 8 | Single source of truth for the model list — serve `/ai/models` to the editor | F10, F13, F15 |
| 9 | Unify the settings entry-point naming and the two provider lists | F12, F15 |
| 10 | Fix `discardPending` to clip by identity rather than by count | F16 |

---

*Sources read for this document: `motion-back/src/ai/**` (all 137 files), `motion-back/prisma/schema.prisma`, `motion-editor/src/core/ai/**`, `motion-editor/packages/ai-tools/src/**`, `motion-editor/src/layout/AiChat/**`, `motion-editor/src/layout/Workspace/useAiChat.ts`, `motion-editor/src/layout/Settings/AiSettingsSection.tsx`, `motion-editor/src/stores/aiProviderStore.ts`, `motion-editor/src/core/api/client.ts`.*
