# AI Chat — Working Architecture (motion-editor + motion-back)

**Status:** Actual implementation as shipped (verified against source 2026-07-20)
**Scope:** How the AI chat feature *actually works today*, end to end, across the two repos:
- `motion-editor/` — Electron + React renderer (chat UI, agent loop, all 29 tools, scene mutation)
- `motion-back/` — NestJS + Prisma backend (thin proxy gateway + conversation history)

> This is the "what is really wired" document. The aspirational, not-yet-built brain design lives in `AI_MOTION_INTELLIGENCE_ARCHITECTURE.md` — do not confuse the two.

---

## 0. One-paragraph summary

The **agent loop and every tool run in the editor (renderer)**. The backend is a **thin, security-owning proxy**: it stores the user's provider API key AES-encrypted at rest, and when the editor wants to talk to a model it POSTs a provider-native request body to `POST /api/ai/stream`; the backend attaches the decrypted key + auth headers and pipes the provider's SSE stream straight back — it never parses SSE, never interprets tools, and never returns a key to the client. The editor consumes that stream, extracts tool calls, executes them against the local scene graph, feeds the results back to the model, and loops until the model stops calling tools. One prompt = one undo entry. Conversation prose is persisted ChatGPT-style through a separate history controller.

---

## 1. The big picture

```
┌──────────────────────────── motion-editor (renderer) ────────────────────────────┐
│                                                                                   │
│  AiPromptBar.tsx ──uses──► useAiChat.ts ──calls──► AgentLoop.runAgent()           │
│   (chat UI shell)          (chat state,            (the loop)                      │
│                             history, persist)         │                           │
│                                                       │ each step:                 │
│                                                       ▼                            │
│   ToolRegistry (29 tools)  ◄──execute── AgentLoop ──streamTurn()──┐                │
│   toolHandlers.ts                          ▲                      │ raw fetch      │
│      │ mutate                              │ tool results         │ (byte stream)  │
│      ▼                                     │ pushed back          │                │
│   Scene graph + animation  ─render──► renderFeedback ──images──►  │                │
│   (local, in renderer)                (visual feedback loop)      │                │
│                                                                   │                │
└───────────────────────────────────────────────────────────────── │ ───────────────┘
                                                                    │ POST /api/ai/stream
                                                                    │ { provider, model, body }
                                                                    │ Authorization: Bearer <JWT>
                                                                    ▼
┌──────────────────────────── motion-back (NestJS) ────────────────────────────────┐
│                                                                                   │
│  AiGatewayController.stream()  ──►  AiGatewayService.openStream()                 │
│   - JwtAuthGuard                     - decrypt key (AES-256-GCM, AI_KEY_SECRET)    │
│   - AbortController on res close     - endpoint allowlist (SSRF guard)            │
│   - SSE headers, x-accel-buffering   - headersFor(provider) auth                  │
│   - pipe upstream bytes verbatim     - fetch(provider, redirect:'error')          │
│   - 120s idle watchdog               - retry 429/503/529 w/ backoff               │
│                                      - Motion AI: plan + atomic credit reserve    │
│                                              │                                    │
│                                              ▼                                    │
│                             OpenAI / Anthropic / Gemini  (provider-native SSE)    │
│                                                                                   │
│  AiController (separate)  ──►  AiService  ──►  Prisma: AiConversation / AiMessage  │
│   history CRUD, prose only                                                        │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Key correction to older notes:** the tool count is **29** (was 19), and structural ops run **in the renderer**, not server-side.

---

## 2. Request lifecycle — the life of one prompt

1. **User types a prompt** in `AiPromptBar.tsx` and hits Enter. `useAiChat.ts` records the display message and calls `AgentLoop.runAgent(prompt, opts)`.
2. **Setup** (`AgentLoop.ts:215-241`): grab the singleton `ToolRegistry` (`getAiRegistry`), build a `ToolContext`, open an undo transaction (`beginAiTransaction`), seed `messages` with the last 24 history turns + the current user turn, and prepend a small per-run **context preamble** (comp settings, playhead, selection, layer list).
3. **Step loop** (`MAX_STEPS = 22`). Each step:
   - Build `AiRequest` = `SYSTEM_PROMPT` + messages + all 29 tool schemas, `temperature 0.6`, `maxTokens 8192`.
   - `streamTurn()` does `fetch('${apiBaseUrl()}/ai/stream', { provider, model, body: adapter.buildBody(req) })`, reads the raw byte stream, feeds it to the provider's SSE `parser.push()`, and yields normalized `AiEvent`s (`text_delta`, `tool_call`).
   - **Backend proxies the call** (see §5) and streams provider-native SSE back verbatim.
   - Accumulate streamed text (→ live "typing" in the UI) and complete tool calls.
   - **If tool calls:** append the assistant turn, then `reg.execute(name, args, ctx)` for each. Each result becomes a `role:'tool'` message pushed back into `messages` so the next turn sees it. Write-tool successes go into `changes[]`.
   - **If no tool calls:** the model thinks it's done. If it actually changed something and hasn't hit `MAX_CRITIQUES = 2`, the **visual feedback loop** fires: render frames, push them back as a `CRITIQUE_PROMPT` user turn with images, and continue ("the AI has eyes"). Otherwise capture `finalText` and break.
   - **Loop guards:** identical tool calls are keyed by name+sorted-args; after 3 identical calls the loop nudges ("change your approach"), after 5 it aborts. On the final step it injects a "stop and summarize" nudge.
4. **Commit** (`AgentLoop.ts:350-362`): in **Auto** mode `tx.commit()` pushes a single `StoreSnapshotCommand` (one undo entry). In **Manual/preview** mode it returns the open transaction so the UI can Apply/Discard. Any throw → `tx.rollback()` (no half-applied edits).
5. **Persist** (`useAiChat.ts`): prose turns are appended to the backend thread via `POST /ai/conversations/:id/messages`. Tool traffic is deliberately *not* persisted.

---

## 3. The editor side (motion-editor)

### 3.1 Chat UI — `src/layout/Workspace/AiPromptBar.tsx`
The **entire** chat surface is this one component (there is no `components/chat` folder). It's a floating, draggable/resizable bar pinned bottom-center that expands into a chat panel; most of the file is pointer drag/resize bookkeeping persisted to `localStorage` (`motion_editor_ai_chat_pos/size/minimized`). The chat itself:
- Message list — user turns as plain text, assistant turns through `ReactMarkdown`, errors tinted red, live streaming text before it lands in `messages`, a "Thinking…" activity indicator.
- Input box + send/stop, provider/model `<select>`, Auto/Manual toggle, history drawer, new-chat/history buttons.
- All logic delegated to the `useAiChat()` hook.

> ⚠️ Known cosmetic bug: the model dropdown labels are stale/mislabeled vs the real ids in `MODEL_SUGGESTIONS` (e.g. `claude-opus-4-8` shows as "Claude 3.5 Opus", `gemini-3.5-flash` as "Gemini 3.5 Flash").

### 3.2 Chat state / history — `src/layout/Workspace/useAiChat.ts`
Two parallel transcripts:
- **Display** transcript — `messages` (`ChatMessage[]`), what the user sees.
- **Model-facing** transcript — `history` ref (`AiMessage[]`), includes tool traffic during a run. Replayed slice = last `HISTORY_TURNS = 24`. `pruneImageTurns` keeps images only on the last `IMAGE_TURNS_KEPT = 2` image turns to bound context cost.

Persistence is **backend, ChatGPT-style** (not localStorage for content): `persist()` → `POST /ai/conversations/:id/messages` (prose only). Threads listed/loaded/deleted per-project. localStorage stores only a **pointer** to the last-open thread per project (`motion_editor_ai_conv:<projectId>`).

### 3.3 The agent loop — `src/core/ai/AgentLoop.ts`
`runAgent()` is the loop described in §2. Key constants: `MAX_STEPS = 22`, `MAX_CRITIQUES = 2`, `LOOP_NUDGE = 3`, `LOOP_ABORT = 5`. `streamTurn()` uses a **raw `fetch`** (not the typed `api` client) because it needs the byte stream; it sends `Authorization: Bearer <JWT>` (localStorage `motion-editor.auth-token`) to `apiBaseUrl()` (= `API_URL` or `http://localhost:4000/api`).

### 3.4 The tool system — `packages/ai-tools/` + `src/core/ai/toolHandlers.ts`
- **Schema format:** hand-written JSON Schema fragments, one `AiToolDef` per tool (`{name, description, kind, inputSchema}`), pure (no DOM imports), in `packages/ai-tools/src/tools/`.
- **Wire emit:** `packages/ai-tools/src/emit/index.ts` converts to 4 function-calling formats — OpenAI `tools[].function.parameters`, Anthropic `tools[].input_schema`, Gemini `functionDeclarations` (strips `additionalProperties`/`$schema`/`default`), MCP `tools/list`.
- **Handlers:** bound to defs in `src/core/ai/toolHandlers.ts` (`buildAiTools`, `HANDLERS` map). The registry `execute()` **never throws** — errors become failed `ToolResult`s handed back to the model as repair instructions (e.g. "unknown nodeId 'ttl' — did you mean title_1?"). Partial success is success.

**The 29 tools:**

*READ (`tools/read.ts`, `kind:'read'`, exempt from undo) — 7:*
| Tool | Reads |
|---|---|
| `describe_scene` | Layers: kind, parent, transform, design read-back, which props are animated |
| `read_tracks` | Existing keyframes as `[t, value, easing]` per prop (comp time) |
| `evaluate_at` | A layer's actual animated values at a comp time (for relative moves) |
| `get_selection` | The user's current selection (resolves "this") |
| `list_capabilities` | Real vocabulary: animatable prop paths, effect params, text-animator params, easings, layer kinds |
| `list_presets` | Built-in animation preset names |
| `list_assets` | Imported media (id/type/dims) for `create_media` |

*WRITE (`tools/write.ts`, `kind:'write'`) — 16:*
| Tool | Mutates |
|---|---|
| `create_layer` | New layer (shape/text/solid/null/group/camera/light/adjustment/particle) |
| `delete_layer` | Removes layers + descendants |
| `reparent_layer` | Re-parents (keeps world position) |
| `update_layer` | Static props: name/visible/lock/text/fill/transform/3D/motionBlur/blendMode/track-matte |
| `set_keyframes` | Batch keyframe authoring (≤200/call); comp→layer time, value+easing+bezier |
| `remove_keyframes` | Removes keyframes or clears a track |
| `set_easing` | Changes easing/bezier/roving on existing keyframes |
| `set_expression` | Attaches a JS expression to a prop; compile-checks and rejects bad ones |
| `add_effect` | Adds an effect (28 types: blur/glow/drop-shadow/levels/curves/keylight/echo/…) |
| `update_effect` | Changes/removes an effect |
| `text_animator` | Per-character text animator (type-on, fly-in) |
| `create_media` | Places an imported asset as a layer |
| `create_media_from_attachment` | Decodes a prompt-attached base64 image, uploads, places it |
| `create_mask` | Rect/ellipse vector mask (spotlight/vignette/reveal) |
| `update_composition` | Comp width/height/fps/duration/background |
| `apply_preset` | Applies a named animation preset at a time |

*COMPOSE (`tools/compose.ts`, `kind:'write'`, high-level recipes the prompt tells the model to prefer) — 6:*
| Tool | Builds |
|---|---|
| `add_background` | Full-comp styled background + ambient drift |
| `add_title` | Headline/subtitle/tagline with staggered fade-and-rise (+glow) |
| `add_emblem` | Glowing circular badge with overshoot scale + pulse |
| `add_cards` | Centered staggered card row (feature/pricing grids) |
| `stagger_in` | Staggered fade-and-rise entrance for existing layers |
| `add_camera_move` | Cinematic push-in/pull-out across the scene |

### 3.5 The `ToolContext` sandbox — `src/core/ai/toolContext.ts`
The only surface handlers can touch: `scene`/`anim`/`comp`/`time` facades + `signal` + attached `images`. It deliberately has **no history/command access** — that's how "one prompt = one undo entry" is enforced structurally, not by convention.

### 3.6 One-prompt-one-undo — `src/core/ai/aiTransaction.ts`
`beginAiTransaction()` snapshots the whole document before the run (`sceneProjectIO.capture()` + `defaultAnimation.snapshot()`), lets all tool mutations land live on the canvas, **suspends the command history** during the run to swallow side-effect commands, and on `commit()` pushes a single `StoreSnapshotCommand(before, after)`. Read-only runs push nothing.

### 3.7 System prompt + context — `src/core/ai/buildContext.ts`
- `SYSTEM_PROMPT` — a "motion graphics director" persona with sections: HOW TO WORK, WHAT THIS EDITOR CAN DO, CRAFT, GO BEYOND THE OBVIOUS, WORKED EXAMPLES, NEVER DO THESE, CONSTRAINTS. Steers the model to prefer compose tools, plan first, read before editing, batch keyframes, use the visual-feedback pass.
- `buildContextPreamble(ctx)` — a small (~400 token) per-run preamble prepended to the user turn: comp settings, playhead, selection, layer counts; inlines the full layer list for ≤12-layer comps, otherwise names top-level layers and tells the model to call `describe_scene`.
- `CRITIQUE_PROMPT` — the senior-designer review checklist injected during visual feedback.

### 3.8 Provider/model/key selection — `src/stores/aiProviderStore.ts`
User's provider+model choice persists via `SettingsManager` key `aiProvider` (default `anthropic`). `dialect()` returns the wire format; `model()` falls back to the adapter default. **Keys never touch the client** — `refreshStatus()` calls `GET /ai/keys` and receives only `{present, hint}`. `provider:'motion'` is the metered first-party option; `openai`/`anthropic`/`gemini` are BYOK.

### 3.9 SSE consumption — `packages/ai-tools/src/providers/`
`sse.ts` `SseReader` buffers across arbitrary byte boundaries, normalizes CRLF, splits on blank lines. Each provider adapter has a `StreamParser` + `buildBody`. Example: `anthropic.ts` assembles tool-call JSON across `content_block_start → input_json_delta → content_block_stop`, maps error types to normalized codes, sends `system` as a top-level field, and merges consecutive `tool_result`s into one user message.

---

## 4. The backend side (motion-back)

Two cooperating halves in one NestJS module (`src/ai/ai.module.ts`):
- **Gateway** — `AiGatewayController` / `AiGatewayService`: encrypted BYOK keys + streaming proxy.
- **History** — `AiController` / `AiService`: ChatGPT-style conversation persistence.

All routes are under the global `/api` prefix.

| File | Role |
|---|---|
| `src/ai/ai.module.ts` | Module wiring (2 controllers, 2 services) |
| `src/ai/ai-gateway.controller.ts` | `/ai/keys` + `/ai/stream` |
| `src/ai/ai-gateway.service.ts` | Key crypto, provider proxy, credits/metering |
| `src/ai/key-crypto.ts` | AES-256-GCM encrypt/decrypt/mask |
| `src/ai/ai-policy.ts` | Motion AI plan/credit policy (env-driven) |
| `src/ai/ai.controller.ts` | Conversation history REST |
| `src/ai/ai.service.ts` | Conversation/message persistence |
| `src/ai/dto/ai-gateway.dto.ts` | `SaveKeyDto`, `StreamDto`, provider constants |
| `src/ai/dto/ai.dto.ts` | `AiMessageDto`, `AppendMessagesDto` |

### Routes
**Gateway** (`@Controller('ai')`, `JwtAuthGuard`):
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/ai/keys` | Per-provider `{present, hint}` + `motion` status. **Never returns a key.** |
| PUT | `/api/ai/keys/:provider` | Store a BYOK key → `{ok}` |
| DELETE | `/api/ai/keys/:provider` | Remove a stored key |
| POST | `/api/ai/stream` | The model call — streams SSE back |

**History** (`@Controller('ai')`, `JwtAuthGuard`):
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/ai/conversations` | Paginated thread list, optional `?projectId` |
| GET | `/api/ai/conversations/:id` | Thread + last 200 messages |
| POST | `/api/ai/conversations/:id/messages` | Append turns (creates thread on first write) |
| DELETE | `/api/ai/conversations/:id` | Delete thread |

---

## 5. `POST /api/ai/stream` — the proxy in detail

**Request body** (`StreamDto`):
```ts
{ provider: 'openai'|'anthropic'|'gemini'|'motion',
  model?: string,                  // Gemini carries model in URL; others in body
  body: Record<string, unknown> }  // provider-native body, built by the editor's adapter
```

**Streaming** = true SSE pass-through, not chunked JSON:
1. An `AbortController` is created; `res.on('close', () => controller.abort())` propagates client cancellation straight to the provider so tokens stop billing.
2. `gateway.openStream(...)` returns a typed error or the upstream `Response`. Error codes map to HTTP status: `no_key→400`, `coming_soon→403`, `upgrade_required/no_credits→402`, `auth→401`, `rate_limit→429`, `context_length→413`, `overloaded→503`, else `502`.
3. On success it sets `content-type: text/event-stream`, `cache-control: no-cache, no-transform`, `x-accel-buffering: no` (disables nginx buffering), then `flushHeaders()`.
4. Reads the upstream `ReadableStream` via `getReader()` and writes each raw chunk to `res` **verbatim** — *"this server never parses SSE — the editor's adapters do."*
5. **Idle watchdog** `IDLE_TIMEOUT_MS = 120_000` re-arms on every chunk; 120s of silence aborts.
6. `finally` always calls `res.end()` and fires `recordUsage(...)` with request/response byte counts.

**Forwarding** (`AiGatewayService`): native `fetch`, `redirect: 'error'` (refuses redirects so keys aren't re-sent to another host), `signal` for cancellation. Endpoint **allowlist** (SSRF guard — clients send a provider id, never a URL):
```
openai:    https://api.openai.com/v1/chat/completions
anthropic: https://api.anthropic.com/v1/messages
gemini:    https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse
```
Auth headers: openai `Authorization: Bearer`; anthropic `x-api-key` + `anthropic-version: 2023-06-01`; gemini `x-goog-api-key`.

**Retry:** up to `MAX_ATTEMPTS = 3` on `429/503/529` + dropped connections, exponential backoff (`BACKOFF_BASE_MS = 500`, doubling, + jitter) only if the wait ≤ `MAX_RETRY_WAIT_MS = 8_000`; otherwise returns a typed `rate_limit` with `retryAfterMs` so the editor backs off itself. Provider error bodies are deliberately not logged (they can echo request content).

---

## 6. Provider keys — BYOK security model

**Model** (`prisma/schema.prisma` — `AiProviderKey`): `ownerId`, `provider`, `encryptedKey`, `hint`, unique on `(ownerId, provider)`, cascade-delete from `User`.

**Crypto** (`key-crypto.ts`):
- AES-256-GCM. Secret from `process.env.AI_KEY_SECRET` (validated ≥24 chars at boot in `env.ts`/`assertEnv`; server refuses to start otherwise).
- Key derived via `scryptSync(secret, 'motion-ai-key-store', 32)` (hardcoded salt), cached in-process.
- Stored blob = `base64(iv).base64(authTag).base64(ciphertext)`, 12-byte random IV.
- `decryptKey` returns `null` on malformed blob or auth-tag mismatch (e.g. secret rotated).
- `maskKey` → the `hint` shown to the client, e.g. `"sk-…4f2a"`.

**Lifecycle:** Save = `encryptKey` + `maskKey` upserted (if `AI_KEY_SECRET` missing, save fails rather than storing plaintext). Decrypt happens per request in `getKey` — *"never leaves this process."* There is deliberately **no** endpoint that returns a plaintext key.

---

## 7. Motion AI (first-party) vs BYOK

- **BYOK** (`openai`/`anthropic`/`gemini`): user pays the provider directly; `creditsUsed = 0`; no plan gate.
- **Motion AI** (`provider:'motion'`): uses the server's own `MOTION_AI_API_KEY` (never in DB). Config from env (`motionConfig`): `HOSTED_AI_ENABLED === 'true'` && key present → enabled, else typed `coming_soon`. `MOTION_AI_DIALECT` (default `openai`) picks the wire adapter; `MOTION_AI_MODEL` is force-overridden into both `model` and `body.model` so a client can't pick an expensive model on Motion's bill.
- **Credits:** `reserveCredits` is a single atomic `updateMany` with `aiCredits >= cost` in the WHERE clause (check-and-decrement in one statement → no concurrent double-spend). `refundCredits` hands it back if the provider call never ran. Once streaming starts, the credit stays spent. Policy: `DEFAULT_SIGNUP_CREDITS = 25`, `CREDITS_PER_RUN = 1` (env-tunable via `MOTION_AI_MIN_PLAN`, `MOTION_AI_SIGNUP_CREDITS`).

---

## 8. Conversation persistence (history)

`AiService` stores **prose only** — tool calls/results are deliberately not persisted (they'd be stale snapshots).
- **list** — paginated, `orderBy updatedAt desc`, owner-scoped, optional `projectId`.
- **get** — owner-scoped `{id, ownerId}`, newest `MAX_THREAD_MESSAGES = 200` messages, ordered by `seq desc` then reversed to oldest-first (a batch shares one `createdAt` ms and would otherwise scramble).
- **append** — client supplies the conversation id (stable thread from first message); creates `AiConversation` if absent (title = provided or first message sliced to 60 chars), bulk `createMany`, then explicitly bumps `updatedAt`. Max 50 messages/call, content ≤20 000 chars.
- **delete** — `deleteMany({id, ownerId})` (owner-scoped).

**Prisma models:** `AiConversation` (`ownerId`, nullable `projectId`, `title`, `@@index([ownerId, updatedAt])`), `AiMessage` (`seq @default(autoincrement())` is the ordering key, `role` ∈ {user, assistant}, `content`, `isError`, `@@index([conversationId, seq])`), `AiUsage` (`provider`, `model?`, `requestBytes`, `responseBytes`, `creditsUsed` — 0 for BYOK). All cascade-delete from `User`, which also carries `plan`, `aiCredits`, `aiCreditsUsed`.

---

## 9. Auth, limits, cancellation

- **Auth:** no global auth guard; each private controller declares its own `@UseGuards(JwtAuthGuard)` (a thin `AuthGuard('jwt')`). Identity via `@CurrentUser()`.
- **Throttler is global:** `ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }])` — 300 req/60s/IP, in-memory. No tighter per-AI-route throttle; they share the global limit.
- **Body-parser limit:** `app.use(json({ limit: '10mb' }))` — raised from Express's 100kb default because a long thread's full history rides in `POST /ai/stream`.
- **Cancellation propagates end-to-end:** the editor's Stop button aborts the fetch → `res` close on the backend → `AbortController.abort()` → the provider fetch's `signal` → tokens stop billing.
- Global `ValidationPipe` (`whitelist: true, transform: true`).

---

## 10. Design invariants worth preserving

| Invariant | Enforced by |
|---|---|
| The backend never sees or interprets tool calls / SSE | Verbatim byte pass-through in `stream()` |
| The client never sees a plaintext key | `GET /ai/keys` returns `{present, hint}` only; decrypt stays in-process |
| No SSRF — client picks a provider id, not a URL | Endpoint allowlist + `redirect:'error'` |
| One prompt = one undo entry | `aiTransaction.ts` suspends history, pushes one `StoreSnapshotCommand` |
| Tool errors never crash the loop | `ToolRegistry.execute` converts throws to failed `ToolResult`s |
| Motion AI can't be gamed for an expensive model | `MOTION_AI_MODEL` force-override; atomic credit reserve |
| Context cost stays bounded | 24-turn replay, image pruning to last 2 image turns, small preamble |

---

## 11. Environment / config quick reference

**motion-back (required):** `AI_KEY_SECRET` (≥24 chars — server won't boot without it), `DATABASE_URL`, JWT secrets.
**motion-back (Motion AI, optional):** `HOSTED_AI_ENABLED`, `MOTION_AI_API_KEY`, `MOTION_AI_DIALECT` (default `openai`), `MOTION_AI_MODEL`, `MOTION_AI_MIN_PLAN`, `MOTION_AI_SIGNUP_CREDITS`.
**motion-editor:** `API_URL` (default `http://localhost:4000/api`); auth token in localStorage `motion-editor.auth-token`; provider choice in `SettingsManager` key `aiProvider` (default `anthropic`).
