/**
 * The tool vocabulary an LLM uses to author motion graphics.
 *
 * One definition per tool, emitted to four wire formats (OpenAI, Anthropic,
 * Gemini, MCP) — so a tool is described exactly once and can never drift
 * between providers, or between this editor and the backend.
 *
 * This package is deliberately pure: no DOM, no zustand, no `@core`, no
 * `@motion/*`. Handlers are **injected by the host** rather than defined here.
 * That is what lets Electron's main process, the renderer, and the NestJS
 * backend all read the same schemas, and it is also how the undo boundary is
 * enforced — a handler can only touch what its `ToolContext` hands it, and the
 * context has no access to the command history.
 */

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
 * document — use `mutates()` rather than testing `kind === 'write'`.
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

/** Scene reads + structural writes. No history access, by design. */
export interface SceneFacade {
  has(nodeId: string): boolean;
  /** Real hierarchy walk. Do not use SceneGraph.traverse — it is flat. */
  all(): readonly SceneNodeView[];
  get(nodeId: string): SceneNodeView | undefined;
  /** Closest existing ids to a bad one, for "did you mean" repair hints. */
  nearest(nodeId: string, limit?: number): string[];
  create(kind: string, name: string, at?: { x: number; y: number }): string;
  remove(nodeId: string): void;
  /** Re-parent a node. By default the node keeps its WORLD pose (local transform
   *  is recompensated). Pass `{ preserveWorld: false }` to keep the LOCAL
   *  transform instead — used by importers whose locals are already
   *  parent-relative (e.g. Lottie). */
  reparent(nodeId: string, parentId: string | null, options?: { preserveWorld?: boolean }): void;
  setProp(nodeId: string, prop: string, value: unknown): boolean;
  addEffect(nodeId: string, type: string): string;
  updateEffect(nodeId: string, effectId: string, amount: number): void;
  removeEffect(nodeId: string, effectId: string): void;
  selection(): readonly string[];
  setPuppet(nodeId: string, puppet: any): void;
  /** The layer's puppet pins (id + name), or undefined if the layer isn't rigged. */
  readPuppet(nodeId: string): { pins: readonly { id: string; name: string }[] } | undefined;
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

/** Animation reads + writes. Times here are LAYER time; convert via TimeFacade. */
export interface AnimFacade {
  isValidProp(nodeId: string, prop: string): boolean;
  setKeyframe(nodeId: string, prop: string, t: number, value: number, easing?: string): void;
  /**
   * Upsert a `points`-kind data keyframe (e.g. a puppet pin's position track,
   * `puppet.<pinId>.position`). `t` is LAYER time. Points are non-scalar, so they
   * go through the data-track engine rather than setKeyframe.
   */
  setPointsKeyframe(nodeId: string, prop: string, t: number, points: readonly { x: number; y: number }[]): void;
  removeKeyframe(nodeId: string, prop: string, t: number): void;
  setEasing(nodeId: string, prop: string, t: number, easing: string): void;
  setBezier(nodeId: string, prop: string, t: number, bezier: readonly number[]): void;
  setRoving(nodeId: string, prop: string, t: number, roving: boolean): void;
  setExpression(nodeId: string, prop: string, src: string): void;
  getExpressionError(nodeId: string, prop: string): string | null;
  tracks(nodeId: string): readonly { prop: string; keyframes: readonly KeyframeView[] }[];
  evaluate(nodeId: string, t: number): Record<string, number>;
  applyPreset(nodeId: string, name: string, atTime: number): boolean;
  listPresets(): readonly string[];
}

export interface KeyframeView {
  t: number;
  value: number;
  easing: string;
}

export interface CompFacade {
  get(): { width: number; height: number; fps: number; durationSeconds: number; background: string };
  update(patch: Partial<{ width: number; height: number; fps: number; durationSeconds: number; background: string }>): void;
  /** Current playhead, in composition seconds. */
  playhead(): number;
}

/**
 * Composition time ⇄ layer time. The engine stores keyframes in LAYER time, so
 * every keyframe write must go through here. Centralizing it is what stops the
 * class of bug where a value lands at one time and its easing lands at another.
 */
export interface TimeFacade {
  toLayerTime(nodeId: string, compSeconds: number): number;
  toCompTime(nodeId: string, layerSeconds: number): number;
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
  /** Aborts when the user cancels the run; long read tools should check it. */
  signal: AbortSignal;
  /** Attached reference images in the current turn. */
  images?: readonly { mediaType: string; dataBase64: string }[];
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

