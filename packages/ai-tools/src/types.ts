/**
 * The tool vocabulary an LLM uses to author motion graphics.
 *
 * One definition per tool, emitted to four wire formats (OpenAI, Anthropic,
 * Gemini, MCP) — so a tool is described exactly once and can never drift
 * between providers, or between this editor and the backend.
 *
 * This package is deliberately pure: no DOM, no zustand, no `@core`. Its one
 * dependency is the engine API's TYPES (`@motion/engine-api`, type-only): a
 * handler talks to the engine through the `ToolContext`. Handlers are
 * **injected by the host** rather than defined here. That is what lets Electron's main process, the renderer, and the NestJS
 * backend all read the same schemas, and it is also how the undo boundary is
 * enforced — a handler can only touch what its `ToolContext` hands it, and the
 * context has no access to the command history.
 */

import type { Command, CommandResult, EngineClient, Origin, QueryOf, QueryResults, QueryType } from '@motion/engine-api';

/** A JSON Schema fragment. Structural only — validation lives in schema.ts. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
}

/**
 * Read tools never mutate, so they are exempt from the undo transaction and
 * are safe to call speculatively. Write and compose tools both mutate the live
 * document — use `mutates` rather than testing `kind === 'write'`.
 *
 * `compose` exists to make one number computable: the share of a run's
 * mutations that went through the technique library rather than hand-authoring
 * primitives. That ratio is the single best proxy for whether output will look
 * authored — `add_title` applies an entrance archetype with vetted timing,
 * where `create_layer` + `set_keyframes` asks the model to invent easing and
 * stagger it has no way to judge.
 *
 * All 43 mutating tools used to share `kind: 'write'`, so a compose call and a
 * raw primitive were indistinguishable and the ratio could not be computed even
 * in principle.
 */
export type ToolKind = 'read' | 'write' | 'compose';

/**
 * Does this tool change the document?
 *
 * Prefer this to `kind === 'write'`, which silently stopped meaning "mutates"
 * when `compose` was added.
 */
export function mutates(kind: ToolKind): boolean {
  return kind !== 'read';
}

/** The wire-facing half of a tool: exactly MCP's `tools/list` entry shape. */
export interface AiToolDef {
  name: string;
  description: string;
  kind: ToolKind;
  inputSchema: JsonSchema;
}

/**
 * What a tool call reports back.
 *
 * `content` goes to the *model*, not the user — on failure it must say what to
 * do differently ("keyframes[2].t must be >= 0", "unknown nodeId 'ttl' — did
 * you mean 'title_1'?"). A tool that fails silently teaches the model nothing
 * and it will make the same call again.
 */
export interface ToolResult {
  ok: boolean;
  content: string;
  /** Structured payload for read tools; serialized into `content` by the loop. */
  data?: unknown;
}

// ── The engine seam (NATIVE_CORE_PLAN §5 B5, ENGINE_API.md §12) ─────
//
// Every facade below is ASYNC. A tool handler never assumes a write has landed
// in the same tick, and never reads the document behind the engine's back: a
// write is a command sent to the engine, a read-back is a query (or, until the
// B4 mirror, a host read of the mirror the engine keeps current). That is what
// lets the same handlers drive the TypeScript engine today and the C++ engine
// process tomorrow — the host swaps the `EngineClient`, not the tools.

/**
 * The engine session one AI turn (or one script run) writes through.
 *
 * The host opens it around the turn: a gesture labelled after the turn, so the
 * whole turn is ONE undo entry and one replayable stretch of the command log,
 * and cancelling it (`endGesture{commit:false}`) is the rollback. Handlers do
 * not see the gesture — they only `apply` commands and `query`.
 */
export interface AiEngineSession {
  /** The engine every request goes to. Requests carry `origin` (`ai`, `script`). */
  readonly client: EngineClient;
  /** Who is asking: `ai` for a turn, `script` for a user script. */
  readonly origin: Origin;
  /**
   * Apply edit commands NOW, inside the turn. One command is sent as is; more
   * than one as ONE batch (all-or-nothing). A typed engine error throws
   * `AiEngineError` — nothing changed — which the registry hands to the model
   * as a failed tool call.
   */
  apply(commands: readonly Command[], label?: string): Promise<CommandResult[]>;
  /** Read (read-back after a write). A typed error throws `AiEngineError`. */
  query<T extends QueryType>(query: QueryOf<T>): Promise<QueryResults[T]>;
  /**
   * Record that a write went AROUND the engine (a legacy writer the engine API
   * cannot express yet), naming the gap. The host then commits the turn as a
   * whole-document snapshot entry instead of an engine entry: still one undo
   * step, but not replayable from the command log.
   */
  legacy(gap: string): void;
  /** The gaps recorded so far this turn (empty = the turn is engine-only). */
  readonly legacyGaps: readonly string[];
}

/** A typed engine refusal, thrown by `AiEngineSession.apply` / `query`. */
export class AiEngineError extends Error {
  readonly code: string;
  readonly commandIndex: number | undefined;
  constructor(code: string, message: string, commandIndex?: number) {
    super(message);
    this.name = 'AiEngineError';
    this.code = code;
    this.commandIndex = commandIndex;
  }
}

/**
 * Scene reads + structural writes. No history access, by design.
 *
 * Reads describe the document as the engine left it after every write this
 * turn has awaited. Writes resolve once the engine applied them.
 */
export interface SceneFacade {
  has(nodeId: string): Promise<boolean>;
  /** Real hierarchy walk, parents before children. */
  all(): Promise<readonly SceneNodeView[]>;
  get(nodeId: string): Promise<SceneNodeView | undefined>;
  /** Closest existing ids to a bad one, for "did you mean" repair hints. */
  nearest(nodeId: string, limit?: number): Promise<string[]>;
  create(kind: string, name: string, at?: { x: number; y: number }): Promise<string>;
  remove(nodeId: string): Promise<void>;
  /** Re-parent a node. By default the node keeps its WORLD pose (local transform
   *  is recompensated). Pass `{ preserveWorld: false }` to keep the LOCAL
   *  transform instead. */
  reparent(nodeId: string, parentId: string | null, options?: { preserveWorld?: boolean }): Promise<void>;
  setProp(nodeId: string, prop: string, value: unknown): Promise<boolean>;
  /**
   * Add an effect, returning its id.
   *
   * `id` requests a specific one. A deterministic emitter cannot read a return
   * value — it produces a flat `ToolCall[]` with no execution between calls — so
   * without this it has no way to keyframe `effect.<id>.<param>` on an effect it
   * just added. Ignored if the node already carries an effect with that id.
   */
  addEffect(nodeId: string, type: string, id?: string): Promise<string>;
  updateEffect(nodeId: string, effectId: string, amount: number): Promise<void>;
  /**
   * Set a **named** effect parameter (`updateEffect` only reaches the primary
   * one; a drop shadow has distance / angle / softness / colour / opacity).
   */
  updateEffectParam(nodeId: string, effectId: string, key: string, value: number | string | boolean): Promise<void>;
  /** Effects currently on a layer, so a handler can find one it did not create. */
  listEffects(nodeId: string): Promise<readonly { id: string; type: string }[]>;
  removeEffect(nodeId: string, effectId: string): Promise<void>;
  /** Wrap layers into a nested composition and return the new composition LAYER's id. */
  precompose(nodeIds: readonly string[], name: string): Promise<string>;
  /** Enable/disable time remapping on a group/precomp layer. */
  setTimeRemapEnabled(nodeId: string, enabled: boolean): Promise<boolean>;
  /** The editor's layer selection. Editor state, not document state — synchronous. */
  selection(): readonly string[];
  setPuppet(nodeId: string, puppet: unknown): Promise<void>;
  /** The layer's puppet pins (id + name), or undefined if the layer isn't rigged. */
  readPuppet(nodeId: string): Promise<{ pins: readonly { id: string; name: string }[] } | undefined>;
}

export interface SceneNodeView {
  id: string;
  name: string;
  kind: string;
  parent: string | null;
  visible: boolean;
  locked: boolean;
  x: number;
  y: number;
  rotation: number;
  opacity: number;
  /**
   * Design read-back — what the layer actually LOOKS like, so the model isn't
   * choosing colour and layout blind. Absent when a layer has no such prop
   * (e.g. width on a null, text on a shape).
   */
  fill?: string;
  width?: number;
  height?: number;
  text?: string;
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  /** Prop paths that already carry keyframes — stops the model clobbering work. */
  animated: readonly string[];
}

/**
 * Animation reads + writes.
 *
 * Every time here is COMPOSITION seconds — the engine API's own axis. The
 * engine converts to each property's stored keyframe axis (trim, split,
 * stretch, precomp nesting) in ONE place, for the value and its easing alike,
 * which is the whole of bug B1's fix: a handler can no longer convert one and
 * forget the other, because it converts neither.
 */
export interface AnimFacade {
  isValidProp(nodeId: string, prop: string): Promise<boolean>;
  setKeyframe(nodeId: string, prop: string, t: number, value: number, easing?: string): Promise<void>;
  /**
   * Upsert a `points`-kind data keyframe (e.g. a puppet pin's position track,
   * `puppet.<pinId>.position`).
   */
  setPointsKeyframe(nodeId: string, prop: string, t: number, points: readonly { x: number; y: number }[]): Promise<void>;
  removeKeyframe(nodeId: string, prop: string, t: number): Promise<void>;
  setEasing(nodeId: string, prop: string, t: number, easing: string): Promise<void>;
  setBezier(nodeId: string, prop: string, t: number, bezier: readonly number[]): Promise<void>;
  setRoving(nodeId: string, prop: string, t: number, roving: boolean): Promise<void>;
  setExpression(nodeId: string, prop: string, src: string): Promise<void>;
  getExpressionError(nodeId: string, prop: string): Promise<string | null>;
  /**
   * Does the expression currently DRIVE the property? (A disabled expression
   * keeps its enabled state across a rewrite, so writing one is not the same
   * claim as "this now overrides the keyframes".)
   */
  isExpressionEnabled(nodeId: string, prop: string): Promise<boolean>;
  /** Keyframes per animated prop; `t` in composition seconds. */
  tracks(nodeId: string): Promise<readonly { prop: string; keyframes: readonly KeyframeView[] }[]>;
  /** Animated values at composition time `t`. */
  evaluate(nodeId: string, t: number): Promise<Record<string, number>>;
  applyPreset(nodeId: string, name: string, atTime: number): Promise<boolean>;
  listPresets(): Promise<readonly string[]>;
}

export interface KeyframeView {
  /** Composition seconds. */
  t: number;
  value: number;
  easing: string;
}

export interface CompSettingsView {
  width: number; height: number; fps: number; durationSeconds: number; background: string;
}

export interface CompFacade {
  get(): Promise<CompSettingsView>;
  update(patch: Partial<CompSettingsView>): Promise<void>;
  /** Current playhead, in composition seconds. Transport state — synchronous. */
  playhead(): number;
  /**
   * Composition-level motion blur: shutter angle, phase, and sample count.
   * 180° is the film default; 16+ samples is what stops a fast move banding.
   */
  motionBlur(): Promise<{ enabled: boolean; shutterAngle: number; shutterPhase: number; samples: number }>;
  setMotionBlur(patch: Partial<{ enabled: boolean; shutterAngle: number; shutterPhase: number; samples: number }>): Promise<void>;
}

/**
 * Composition time ⇄ a property's STORED keyframe axis. Handlers no longer need
 * it to write (the AnimFacade speaks composition time); it remains for the few
 * that must predict where the engine will put a key — `set_keyframes` warns when
 * two requested times collapse onto one frame.
 */
export interface TimeFacade {
  toLayerTime(nodeId: string, compSeconds: number): Promise<number>;
  toCompTime(nodeId: string, layerSeconds: number): Promise<number>;
}

/**
 * Everything a handler is allowed to touch. Note the absence: no command
 * system, no history. A handler physically cannot push its own undo entry, so
 * one prompt can never fragment into thirty undo steps.
 */
export interface ToolContext {
  scene: SceneFacade;
  anim: AnimFacade;
  comp: CompFacade;
  time: TimeFacade;
  /** The turn's engine session: commands, queries, and the legacy-gap record. */
  engine: AiEngineSession;
  /** Aborts when the user cancels the run; long read tools should check it. */
  signal: AbortSignal;
  /** Attached reference images in the current turn. */
  images?: readonly { mediaType: string; dataBase64: string }[];
  /**
   * Caller-supplied handle → real engine id, for one run.
   *
   * A library emitter produces its entire `ToolCall[]` up front with no model in
   * the loop, so it cannot know the ids the engine will assign. It passes an
   * `id` handle on creation and refers to that handle afterwards; the creating
   * handler records the binding here and every `nodeId` is resolved through it.
   *
   * Run-scoped and created fresh by `createToolContext`, so two runs can use the
   * same handles without colliding.
   */
  aliases: Map<string, string>;
}

/**
 * Resolve a possibly-aliased node id to a real engine id.
 *
 * Falls through to the input when there is no binding, so a real id is always
 * accepted — the model does not have to know whether a given id came from an
 * alias or from the engine.
 */
export function resolveAlias(ctx: ToolContext, id: string): string {
  return ctx.aliases.get(id) ?? id;
}

/** Record a handle for a freshly created layer. Ignores an empty handle. */
export function bindAlias(ctx: ToolContext, handle: string | undefined, realId: string): void {
  if (handle && realId) ctx.aliases.set(handle, realId);
}

export type ToolHandler<I = unknown> = (
  input: I,
  ctx: ToolContext,
) => ToolResult | Promise<ToolResult>;

/** A definition bound to its host-supplied handler. */
export interface AiTool<I = unknown> extends AiToolDef {
  handler: ToolHandler<I>;
}

// ── Provider-neutral streaming ────────────────────────────────────

export type ProviderId = 'openai' | 'anthropic' | 'gemini';

export type AiErrorCode =
  | 'auth'          // key rejected — never retry
  | 'rate_limit'    // 429 — retry with backoff
  | 'overloaded'    // 503/529 — retry with backoff
  | 'context_length'
  | 'network'
  | 'bad_response'  // provider sent something unparseable
  | 'no_key'
  | 'cancelled'
  | 'unknown';

/**
 * The normalized stream. Every provider is flattened to this so the agent loop
 * never learns a vendor's wire format.
 *
 * `tool_call` is emitted **complete**, never as partial-JSON deltas — the three
 * providers fragment tool arguments in three incompatible ways, and assembling
 * them is each adapter's job, not the loop's.
 */
export type AiEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown; signature?: string }
  | { type: 'stop'; reason: 'end_turn' | 'tool_use' | 'max_tokens' }
  | { type: 'error'; code: AiErrorCode; message: string; retryAfterMs?: number };

export interface AiToolCall {
  id: string;
  name: string;
  args: unknown;
  /**
   * Opaque provider metadata that must be echoed back verbatim on the follow-up
   * turn. Gemini 3+ returns a `thoughtSignature` on each functionCall and rejects
   * the next request (400) if it isn't returned. Unused by other providers.
   */
  signature?: string;
}

/**
 * An image attached to a user turn — a reference frame, a sketch the user
 * drew and screenshotted, a brand board. All three providers accept inline
 * base64, so this stays provider-neutral.
 */
export interface AiImage {
  /** e.g. 'image/png', 'image/jpeg', 'image/webp' */
  mediaType: string;
  /** Raw base64 payload — no `data:` prefix. */
  dataBase64: string;
}

/** One turn in the conversation, in provider-neutral form. */
export type AiMessage =
  | { role: 'user'; content: string; images?: readonly AiImage[] }
  | { role: 'assistant'; content: string; toolCalls?: readonly AiToolCall[] }
  | { role: 'tool'; id: string; name: string; content: string; isError: boolean };

export interface AiRequest {
  model: string;
  system: string;
  messages: readonly AiMessage[];
  tools: readonly AiToolDef[];
  maxTokens?: number;
  temperature?: number;
  responseSchema?: JsonSchema;
}

