/**
 * The agent loop: model → tool calls → results → model, until it answers.
 *
 * It runs in the editor, on purpose: tools mutate the scene graph, which lives
 * here. The model call itself does NOT — it goes through the backend AI
 * gateway (`POST /ai/stream`), which holds the user's provider key encrypted
 * server-side, owns the endpoint allowlist, and pipes the provider's SSE bytes
 * back verbatim. The editor never sees a key and never talks to a provider
 * host directly.
 *
 * Everything the run changes lands in ONE undo entry (see aiTransaction).
 */

import { ToolRegistry, getAdapter, mutates } from '@motion/ai-tools';
import type { AiEvent, AiImage, AiMessage, AiRequest, AiToolCall, ProviderId } from '@motion/ai-tools';
import { buildAiTools } from './toolHandlers';
import { createToolContext } from './toolContext';
import { beginAiTransaction, type AiTransaction } from './aiTransaction';
import { SYSTEM_PROMPT, buildContextPreamble } from './buildContext';
import type { GatewayProviderId } from '@core/api/client';
import { classifyPrompt } from './pipeline';
import { runBackendDirector } from './DirectorRunner';
import { runCasterPipeline } from './CasterRunner';
import { exportCompositionVideo } from './aiExport';
import type { Direction as CasterDirection } from '@motion/caster';
import { casterEnabled } from '@core/config/flags';
import { streamProviderBytes, AiTransportError } from './aiTransport';
import { deriveStyleFromBrief, setRuntimeStyle } from './design';
import { buildExemplarBlock } from './exemplars';

/**
 * Enough for look → plan → act → LOOK (render + self-critique) → fix → answer,
 * with room to recover. Raised from 12 once the visual-feedback loop was added:
 * a full multi-layer piece plus a render-and-critique pass burns turns, and a
 * tight cap was starving authoring.
 */
const MAX_STEPS = 22;
/** Identical calls before we intervene / give up. */
const LOOP_NUDGE = 3;
const LOOP_ABORT = 5;

/**
 * Which generation path a run actually took, and why the earlier ones were
 * skipped.
 *
 * Three paths can serve a generative prompt — backend director, client
 * pipeline, direct tool loop — and the first two used to fail into bare
 * `catch` blocks. Nothing recorded the failure, so a path could be dead in
 * production indefinitely while every run silently paid its latency and token
 * cost before degrading. `runAgent` cannot throw on these (the fallback is the
 * correct behaviour), so the failure has to be *recorded* instead.
 *
 * Readable from the console as `window.__aiPathFailures` for diagnosis.
 */
export interface AiPathFailure {
  path: 'backend-director' | 'generative-path' | 'caster';
  message: string;
  at: number;
}

const pathFailures: AiPathFailure[] = [];

/** The last 20 path failures, newest last. */
export function getAiPathFailures(): readonly AiPathFailure[] {
  return pathFailures;
}

/**
 * Record a path failure.
 *
 * Exported so the caster host can use the same channel. A caster failure that
 * logged somewhere else would be invisible to the one console command everyone
 * already knows to run.
 */
export function recordAiPathFailure(path: AiPathFailure['path'], err: unknown): void {
  recordPathFailure(path, err);
}

function recordPathFailure(path: AiPathFailure['path'], err: unknown): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  pathFailures.push({ path, message, at: Date.now() });
  if (pathFailures.length > 20) pathFailures.shift();

  console.warn(`[ai] ${path} failed, falling back:`, err);
  if (typeof window !== 'undefined') {
    (window as unknown as { __aiPathFailures?: readonly AiPathFailure[] }).__aiPathFailures = pathFailures;
  }
}

/**
 * How a run spent its tool calls.
 *
 * The brief's key quality metric: compose calls should dominate the writes. A
 * compose call applies a vetted entrance archetype with timing the library owns;
 * a raw primitive asks the model to invent easing curves and stagger offsets it
 * has no way to evaluate. When the ratio drops, output starts looking
 * hand-assembled — which is the failure this whole audit is chasing.
 *
 * Recorded rather than argued about: it was previously uncomputable, because
 * every mutating tool shared one `kind`.
 */
export interface ToolCallTally {
  compose: number;
  primitive: number;
  read: number;
}

/** Compose share of MUTATING calls, 0–1. `null` when a run wrote nothing. */
export function composeRatio(tally: ToolCallTally): number | null {
  const writes = tally.compose + tally.primitive;
  return writes === 0 ? null : tally.compose / writes;
}

const runTallies: Array<ToolCallTally & { at: number; ratio: number | null }> = [];

/** The last 20 runs' call tallies, newest last. Also `window.__aiToolRatio`. */
export function getAiToolTallies(): ReadonlyArray<ToolCallTally & { at: number; ratio: number | null }> {
  return runTallies;
}

function recordTally(tally: ToolCallTally): void {
  const ratio = composeRatio(tally);
  runTallies.push({ ...tally, ratio, at: Date.now() });
  if (runTallies.length > 20) runTallies.shift();

  console.info(
    `[ai] tool mix — compose ${tally.compose}, primitive ${tally.primitive}, read ${tally.read}` +
    (ratio === null ? ' (no writes)' : ` → compose ratio ${(ratio * 100).toFixed(0)}%`),
  );
  if (typeof window !== 'undefined') {
    (window as unknown as { __aiToolRatio?: unknown }).__aiToolRatio = runTallies;
  }
}

let registry: ToolRegistry | null = null;

/** The registry is built once — tool defs and handlers never change at runtime. */
export function getAiRegistry(): ToolRegistry {
  if (!registry) {
    registry = new ToolRegistry();
    for (const tool of buildAiTools()) registry.register(tool);
  }
  return registry;
}

export interface AgentEvents {
  /** Assistant prose, streamed. */
  onText?: (delta: string) => void;
  /** A tool is about to run — drives the "Reading the scene…" affordance. */
  onToolStart?: (call: AiToolCall) => void;
  onToolEnd?: (call: AiToolCall, ok: boolean, summary: string) => void;
  onStep?: (step: number) => void;
  /** A free-form status the loop wants shown, e.g. "Reviewing the result…". */
  onActivity?: (label: string) => void;
}

/** How many times a single run may render, look at its work, and self-correct. */
const MAX_CRITIQUES = 2;
/**
 * Generative runs get one more: their first "critique" is the seeded review of
 * the plan-executed scene, so 3 keeps at least two genuine render→look→fix
 * passes on the paths that author the most.
 */
const MAX_CRITIQUES_GENERATIVE = 3;

const CRITIQUE_PROMPT =
  'Here are rendered frames of what you just built (roughly early, middle, and the final held frame). ' +
  'Look at them critically, the way a senior motion designer reviews a junior\'s work against the brief:\n' +
  '- Is any frame empty or nearly empty? Is anything off-screen, clipped, or overlapping badly?\n' +
  '- Is the composition balanced and centred, with sensible spacing — or are elements piled at one spot or the default centre?\n' +
  '- Contrast and legibility: does text read clearly against what is behind it? Are colours intentional, not placeholder blue?\n' +
  '- Motion: across the three frames, are things actually moving, staggered and eased — or static and flat?\n' +
  '- Does it match the brief\'s mood and look finished, not like a first draft?\n' +
  'If you see ANY problem, fix it now with tools (reposition, resize, restyle, re-time, add missing pieces). ' +
  'You have FULL authority to make substantial revisions — delete and rebuild a weak element, change the palette, ' +
  'retime a whole scene — not just nudge positions. ' +
  'Only if it genuinely looks good: briefly tell the user what you made, and stop.';

export interface AgentResult {
  /** The assistant's final prose. */
  text: string;
  /** Turns to append to the conversation, so the next prompt has context. */
  messages: AiMessage[];
  toolCallCount: number;
  /**
   * In preview mode, the still-open transaction — the caller decides whether to
   * commit (Apply) or rollback (Discard). Absent in auto mode (already
   * committed).
   */
  tx?: AiTransaction;
  /** Plain-language summaries of each write the run made, for the preview list. */
  changes: string[];
  /**
   * How the run split its calls between the technique library and raw
   * primitives. See `composeRatio`.
   */
  tally: ToolCallTally;
}

export class AiError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'AiError';
  }
}

/**
 * Stream one turn: POST the provider-native body to the backend gateway,
 * parse the provider's SSE bytes it pipes back, yield normalized events.
 *
 * Aborting the signal aborts this fetch; the gateway sees the request close
 * and aborts its upstream provider call, so cancel truly stops the tokens.
 */
export async function* streamTurn(
  provider: GatewayProviderId,
  dialect: ProviderId,
  model: string,
  req: AiRequest,
  signal: AbortSignal,
): AsyncGenerator<AiEvent> {
  // `provider` names WHOSE key to use; `dialect` is the wire format that key
  // speaks. They were only ever different for Motion AI — the gateway held our
  // key for whichever provider we bought capacity from — so with hosted AI gone
  // they are always the same value. Both parameters stay because the caller-facing
  // distinction is still meaningful, and collapsing them would be a rename across
  // every call site for no behaviour change.
  const adapter = getAdapter(dialect);

  // Where the bytes come from is the transport's problem: motion-back's gateway in
  // the server edition, the Electron main process in the local one. Either way the
  // renderer holds no provider key and the parsing below is identical.
  const chunks = streamProviderBytes(
    {
      provider,
      model,
      body: adapter.buildBody(req),
      isPipeline: req.responseSchema !== undefined,
    },
    signal,
  );

  const parser = adapter.createParser();

  const emit = function* (events: readonly AiEvent[]): Generator<AiEvent> {
    for (const ev of events) {
      if (ev.type === 'error') throw new AiError(ev.code, ev.message, ev.retryAfterMs);
      yield ev;
    }
  };

  try {
    for await (const text of chunks) {
      yield* emit(parser.push(text));
    }
    yield* emit(parser.end());
  } catch (err) {
    // One translation point. The transports throw AiTransportError with the same
    // codes AiError uses, so this preserves them rather than flattening every
    // failure to 'network' — which is what would hide an auth error behind
    // "check your connection".
    if (err instanceof AiTransportError) throw new AiError(err.code, err.message, err.retryAfterMs);
    if (err instanceof AiError) throw err;
    if (signal.aborted) throw new AiError('cancelled', 'Cancelled.');
    throw new AiError('network', err instanceof Error ? err.message : 'The stream failed.');
  }
}

/** Stable key for loop detection — same tool, same args, regardless of key order. */
function callKey(call: AiToolCall): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]));
    }
    return v;
  };
  return `${call.name}:${JSON.stringify(stable(call.args))}`;
}

export interface RunAgentOptions {
  /** Whose key the gateway should use: a BYOK provider, or 'motion' (ours). */
  provider: GatewayProviderId;
  /** The wire format to speak — differs from `provider` only for Motion AI. */
  dialect: ProviderId;
  model: string;
  /** Prior turns, so the assistant is not amnesiac between prompts. */
  history?: readonly AiMessage[];
  /** Reference images attached to THIS prompt (sketches, screenshots, frames). */
  images?: readonly AiImage[];
  /**
   * Manual mode: don't commit. Apply the run live so the canvas previews it, but
   * return the open transaction so the caller can Apply or Discard. Auto mode
   * (default) commits automatically.
   */
  preview?: boolean;
  /**
   * Render the result and let the model see + self-correct before answering.
   * Default on. Disable for a text-only turn or where no renderer exists.
   */
  visualFeedback?: boolean;
  signal: AbortSignal;
  events?: AgentEvents;
  /**
   * The project and conversation this run belongs to.
   *
   * Both are forwarded to `/ai/director/run`, whose DTO has always accepted them
   * and whose `assembleRunMemory` keys on them — but no call site ever supplied
   * one, so project memory and conversation memory have been permanently
   * `undefined`. Every run has started from nothing.
   *
   * `useCloudProjectStore` holds the live projectId; `useAiChat` holds the live
   * conversationId. Both are passed in by the caller rather than read here,
   * because this module is deliberately store-free.
   */
  projectId?: string;
  conversationId?: string;
  /**
   * Direction from the composer, which overrides whatever the brief chose.
   *
   * Generative path only — a trivial edit has no brief to override.
   */
  direction?: CasterDirection;
  /**
   * How many alternatives the caster should emit for the user to choose between.
   *
   * Emit is pure and seeded, so this multiplies the CHEAP half of a run: three
   * directions are one cast plus three pure re-emits, not three more model
   * turns.
   */
  variants?: number;
  /**
   * After a successful generative run (caster/director), automatically export
   * the composition to video. Useful for "make me a video and export it" prompts.
   */
  exportAfterGenerative?: boolean | { format?: 'mp4' | 'webm' | 'gif'; quality?: 'high' | 'medium' | 'draft' };
}

/**
 * Run one user prompt to completion.
 *
 * Throws `AiError` on transport/auth failures — there is no silent fallback.
 * The old pipeline answered a failed request with a canned fade-and-rise, which
 * was indistinguishable from real work; a visible error is strictly better than
 * a plausible lie.
 */
export async function runAgent(prompt: string, opts: RunAgentOptions): Promise<AgentResult> {
  const { provider, dialect, model, signal, events } = opts;

  const reg = getAiRegistry();
  const ctx = createToolContext(signal, opts.images);
  const tools = reg.list();
  // Which tools mutate the document — only these feed the "pending changes"
  // preview list; read calls ("describe_scene") are not changes to review.
  //
  // `mutates`, not `kind === 'write'`: compose tools are now their own kind,
  // and a literal 'write' test would have quietly dropped all sixteen of them
  // from the pending-changes list — i.e. the tools that do the most visible
  // work would have been the ones the user could not review.
  const writeNames = new Set(tools.filter((t) => mutates(t.kind)).map((t) => t.name));
  const composeNames = new Set(tools.filter((t) => t.kind === 'compose').map((t) => t.name));
  const changes: string[] = [];
  const callTally: ToolCallTally = { compose: 0, primitive: 0, read: 0 };
  /** Classify every executed call, wherever in the run it was issued from. */
  const tally = (name: string): void => {
    if (composeNames.has(name)) callTally.compose++;
    else if (writeNames.has(name)) callTally.primitive++;
    else callTally.read++;
  };

  const label = `AI: ${prompt.length > 48 ? `${prompt.slice(0, 48)}…` : prompt}`;
  const tx = beginAiTransaction(label);

  const requestPrompt = prompt;
  /**
   * True once a programmatic plan (backend director OR client pipeline) has
   * executed against the scene. Both paths then flow into the SAME sighted
   * polish pass below — no path ships work nothing has looked at.
   */
  let planExecuted = false;
  let planSummary = '';
  /** How many render→look→fix passes this run may take. */
  let maxCritiques = MAX_CRITIQUES;
  let isGenerative = false;
  /** The caster's fit-critic verdict, if one ran. Shown with the answer. */
  let casterCritique = '';
  /** Frames rendered after a successful plan run — seeds the polish pass. */
  let pipelineReviewShots: AiImage[] = [];
  let finalText = '';
  let toolCallCount = 0;
  const produced: AiMessage[] = [];

  // Runtime palette: when the brief itself names brand colours, derive the
  // run's style from THEM so compose defaults are on-brief instead of one of
  // the six anchors. Explicit preset names in tool calls still win.
  setRuntimeStyle(deriveStyleFromBrief(prompt));

  try {
    // 1. Router Classification & Pipeline Orchestration
    try {
      const classification = classifyPrompt(prompt);

      if (classification === 'generative') {
        isGenerative = true;
        maxCritiques = MAX_CRITIQUES_GENERATIVE;
        let backendRan = false;

        // ── The caster ────────────────────────────────────────────────────
        // Three model calls, and none of them authors a keyframe: the brief
        // picks a look and the beats, the cast picks a layout and a technique
        // per beat, and every keyframe comes from a hand-authored library that
        // the timing, design and UI linters have already verified.
        //
        // Tried FIRST, and the director is kept as the fallback rather than
        // deleted — until the caster has carried real traffic, a path that has
        // shipped is worth more than a path that has passed tests.
        if (casterEnabled()) {
          try {
            const cast = await runCasterPipeline(
              {
                provider, dialect, model, prompt, signal, events,
                // The brief is the only caster stage an image can inform, and it
                // was the only one not receiving them.
                ...(opts.images?.length ? { images: opts.images } : {}),
                ...(opts.direction ? { direction: opts.direction } : {}),
                ...(opts.variants && opts.variants > 1 ? { variants: opts.variants } : {}),
              },
              ctx, reg, writeNames, tally,
            );
            if (cast.ok) {
              backendRan = true;
              planExecuted = true;
              toolCallCount += cast.toolCallCount;
              changes.push(...cast.changes);
              planSummary =
                `Cast ${cast.report.beats} beats in the '${cast.report.lookPackId}' look ` +
                `(${cast.report.techniques.length} techniques, ${cast.toolCallCount} steps).`;
              // Emitting several and silently keeping the best would spend the
              // work and hide the choice, and the choice is the point.
              if (cast.variantCount > 1) {
                planSummary +=
                  ` Compared ${cast.variantCount} directions and applied the strongest ` +
                  `(scores ${cast.variantScores.join(', ')}).`;
              }
              // Problems are reported, never hidden — and "reported" has to mean
              // TO THE USER. They went only to `recordPathFailure`, which writes
              // a console global nobody opening the app will ever look at, so a
              // run that quietly substituted three techniques read as one that
              // got exactly what it asked for. That is the failure mode this
              // rule exists to prevent, reintroduced one layer up.
              //
              // The console record stays: it carries the full object for
              // debugging. The summary carries the short version, because the
              // person who can act on "your look pack forbade the technique the
              // brief asked for" is the one typing the prompt.
              for (const p of cast.problems) recordPathFailure('caster', p);
              if (cast.problems.length) {
                const shown = cast.problems.slice(0, 3).map((p) => `• ${String(p)}`);
                const more = cast.problems.length - shown.length;
                const NL = String.fromCharCode(10);
                planSummary +=
                  NL + NL + 'Substitutions made while casting:' + NL + shown.join(NL) +
                  (more > 0 ? NL + '• …and ' + more + ' more.' : '');
              }
              // The fit critic's verdict, carried into the answer. It is the one
              // judgement in the run that a linter could not make, so burying it
              // in a console log would waste the only call that produced it.
              if (cast.critique) casterCritique = cast.critique;
            }
          } catch (err) {
            recordPathFailure('caster', err);
          }
        }

        // The director only runs if the caster did not. Guarding here rather
        // than throwing a sentinel keeps the catch below meaning exactly one
        // thing — "the director failed" — which is what its message says.
        if (!backendRan) {
        events?.onActivity?.('Connecting to Director Service…');
        try {
          const dirRes = await runBackendDirector(
            {
              provider, model, prompt, signal, events,
              // Without these the backend's memory lookups key on `undefined`
              // and every run starts cold. This is what makes run #10 better
              // than run #1.
              ...(opts.projectId ? { projectId: opts.projectId } : {}),
              ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
            },
            ctx,
            reg,
            writeNames,
            tally,
          );
          if (dirRes.ok) {
            // Do NOT return here. The director authored the scene blind; the
            // sighted polish pass below is what turns "executed" into "looks
            // right". Same treatment as the surrounding generative path.
            backendRan = true;
            planExecuted = true;
            toolCallCount += dirRes.toolCallCount;
            changes.push(...dirRes.changes);
            planSummary = `Executed ${dirRes.toolCallCount} director production steps.`;
          }
        } catch (err) {
          // Backend director unavailable or unsupported — fall back to the
          // client orchestrator, but NEVER silently. A bare `catch {}` here is
          // how ~13k LOC of backend director stayed dead in production without
          // anyone noticing: every generative prompt paid its latency, failed,
          // and quietly degraded to the direct loop.
          recordPathFailure('backend-director', err);
        }
        }

        // The client PipelineOrchestrator used to sit here as a third
        // generative path. It is deleted (Phase 3.4): it was a second
        // LLM-authors-keyframes pipeline behind the first, so when it ran at all
        // it produced exactly the output the caster exists to replace — and when
        // it did not, it was ~2,200 lines of latency nobody could see.
        //
        // Two paths remain and the fallback order is deliberate: the caster,
        // whose craft floor is deterministic; then the backend director; then the
        // direct tool loop below, which at least lets the model see the scene.
      }
    } catch (err) {
      // Fail-safe fallback to the direct tool loop. Same rule as above: the
      // fallback is fine, the silence is not.
      recordPathFailure('generative-path', err);
      events?.onActivity?.('Pipeline failed. Falling back to direct mode…');
    }

    /** Appended to the answer when auto-export runs after a generative plan. */
    let exportNote = '';
    if (planExecuted && !signal.aborted) {
      const exportCfg = opts.exportAfterGenerative;
      const wantsExport =
        exportCfg === true
        || typeof exportCfg === 'object'
        || (exportCfg === undefined && /\b(export|render out|deliver|download|save as mp4|save as video)\b/i.test(prompt));
      if (wantsExport) {
        const cfg = typeof exportCfg === 'object' ? exportCfg : {};
        events?.onActivity?.('Exporting video…');
        const exp = await exportCompositionVideo({ ...cfg, signal });
        exportNote = !exp.ok
          ? `\n\nExport failed: ${exp.message}`
          : exp.mode === 'queue'
            ? `\n\nQueued ${cfg.format ?? 'mp4'} export in the Render Queue (job ${exp.jobId})${exp.started ? ' and started it.' : '.'}`
            : `\n\nExported the composition as ${cfg.format ?? 'mp4'}${exp.videoCodec ? ` (${exp.videoCodec})` : ''}.`;
      }
    }

    // 3. Sighted polish pass — a plan (backend director OR client pipeline)
    // authored the scene, but nothing has LOOKED at it yet. Render key frames
    // and fall through into the direct loop seeded with those shots + the
    // critique prompt, so the model can fix what the plan got wrong (overlaps,
    // contrast, dead zones) with the full toolset. Previously the backend-
    // director path returned before ever seeing a frame — the visual loop was
    // dead on exactly the path most generative prompts take. If rendering
    // fails or feedback is off, the plan result stands on its own (the old
    // behavior).
    if (planExecuted) {
      if (opts.visualFeedback !== false && changes.length > 0 && !signal.aborted) {
        events?.onActivity?.('Reviewing the result');
        try {
          const { renderSceneFrames, critiqueTimes } = await import('./renderFeedback');
          const comp = ctx.comp.get();
          pipelineReviewShots = await renderSceneFrames(critiqueTimes(comp.durationSeconds, comp.fps));
        } catch {
          pipelineReviewShots = [];
        }
      }
      if (!pipelineReviewShots.length) {
        finalText = (casterCritique ? `${planSummary}

${casterCritique}` : planSummary) + exportNote;
        const assistantTurn: AiMessage = { role: 'assistant', content: finalText };
        produced.push(assistantTurn);

        // A programmatic run that never got a frame to critique still spent
        // tool calls, and this is the path a director run takes when rendering
        // fails — precisely the run whose tool mix is most worth knowing.
        recordTally(callTally);

        if (opts.preview) {
          return { text: finalText, messages: produced, toolCallCount, tx, changes, tally: callTally };
        }
        tx.commit();
        return { text: finalText, messages: produced, toolCallCount, changes, tally: callTally };
      }
    }

    // Fallback: The preamble is rebuilt per run so the model sees the document
    // as it is now. When the model is AUTHORING (no plan ran), 1–2 intent-
    // matched exemplars show it the shape of professional structure first.
    const exemplarBlock = isGenerative && !planExecuted ? buildExemplarBlock(requestPrompt) : '';
    const messages: AiMessage[] = [
      ...(opts.history ?? []),
      {
        role: 'user',
        content: `${buildContextPreamble(ctx)}${exemplarBlock}\n\n---\n\n${requestPrompt}`,
        ...(opts.images?.length ? { images: opts.images } : {}),
      },
    ];
    const seen = new Map<string, number>();
    let critiques = 0;
    // Plan handoff: the plan already executed — tell the model what was
    // built and show it the rendered frames, so its first turn is a sighted
    // review, not a blind re-author. Counts as the first critique so the
    // total number of render passes stays bounded.
    if (planExecuted && pipelineReviewShots.length) {
      messages.push({
        role: 'assistant',
        content: `I executed a planned production sequence. Changes applied:\n${changes.map((c) => `- ${c}`).join('\n')}`,
      });
      messages.push({ role: 'user', content: CRITIQUE_PROMPT, images: pipelineReviewShots });
      critiques = 1;
    }
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) throw new AiError('cancelled', 'Cancelled.');
      events?.onStep?.(step);

      const req: AiRequest = { model, system: SYSTEM_PROMPT, messages, tools, temperature: 0.6, maxTokens: 8192 };

      let text = '';
      const calls: AiToolCall[] = [];
      for await (const ev of streamTurn(provider, dialect, model, req, signal)) {
        if (ev.type === 'text_delta') {
          text += ev.text;
          events?.onText?.(ev.text);
        } else if (ev.type === 'tool_call') {
          // Carry the provider signature (Gemini 3+ thoughtSignature) so it can
          // be echoed back on the next turn — omitting it 400s the request.
          calls.push({ id: ev.id, name: ev.name, args: ev.args, ...(ev.signature ? { signature: ev.signature } : {}) });
        }
      }

      // No tool calls → the model believes it has answered. Before we accept
      // that, if it actually built something, let it SEE the result and fix
      // what's wrong. This is the difference between authoring blind and
      // authoring with eyes — the single biggest lever on output quality.
      if (!calls.length) {
        const madeChanges = changes.length > 0;
        const budgetLeft = critiques < maxCritiques && !signal.aborted;

        if (madeChanges && budgetLeft) {
          // Mechanical checks first: they are arithmetic over the scene graph,
          // so they cost nothing and they catch the class of defect a vision
          // pass shouldn't be spending a render on. Read verify.ts before
          // trusting a finding — its checks are shaped by three false positives
          // that a naive version produced against correct output.
          let mechanical: string | null = null;
          try {
            const { verifyScene, formatFindings } = await import('./verify');
            mechanical = formatFindings(verifyScene(ctx));
          } catch (err) {
            // A broken verifier must never take the run down with it.

            console.warn('[ai] mechanical verification failed:', err);
          }

          let shots: AiImage[] = [];
          if (opts.visualFeedback !== false) {
            events?.onActivity?.('Reviewing the result');
            try {
              const { renderSceneFrames, critiqueTimes } = await import('./renderFeedback');
              const comp = ctx.comp.get();
              shots = await renderSceneFrames(critiqueTimes(comp.durationSeconds, comp.fps));
            } catch {
              shots = [];
            }
          }

          // One turn, not two: findings ride along with the frames when we have
          // them. When rendering fails — which is exactly the path a director
          // run takes when it produces no frame — the findings still go out on
          // their own, so a run that can't be looked at is not unchecked.
          if ((shots.length || mechanical) && !signal.aborted) {
            critiques++;
            // Keep the premature answer in the MODEL's context so the critique
            // turn has something to react to — but NOT in `produced`, so the
            // saved/visible thread only ever shows the final answer.
            messages.push({ role: 'assistant', content: text });
            const prompt = shots.length
              ? mechanical ? `${CRITIQUE_PROMPT}\n\n${mechanical}` : CRITIQUE_PROMPT
              : mechanical!;
            messages.push({ role: 'user', content: prompt, ...(shots.length ? { images: shots } : {}) });
            continue;
          }
        }

        finalText = casterCritique && !text.includes(casterCritique)
          ? `${text}

${casterCritique}`
          : text;
        const turn: AiMessage = { role: 'assistant', content: text };
        messages.push(turn);
        produced.push(turn);
        break;
      }

      const assistantTurn: AiMessage = { role: 'assistant', content: text, toolCalls: calls };
      messages.push(assistantTurn);
      produced.push(assistantTurn);

      for (const call of calls) {
        if (signal.aborted) throw new AiError('cancelled', 'Cancelled.');

        // A model stuck re-issuing the same call will burn the budget in
        // silence. Tell it once; stop it if it doesn't listen.
        const key = callKey(call);
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        if (n >= LOOP_ABORT) {
          throw new AiError('unknown', `The model repeated the same ${call.name} call ${n} times without progressing. Stopping.`);
        }

        events?.onToolStart?.(call);
        toolCallCount++;
        tally(call.name);
        const res =
          n >= LOOP_NUDGE
            ? { ok: false, content: `You have called ${call.name} with these exact arguments ${n} times. It will not return anything different. Change your approach or answer the user.` }
            : await reg.execute(call.name, call.args, ctx);
        events?.onToolEnd?.(call, res.ok, res.content);
        if (res.ok && writeNames.has(call.name)) changes.push(res.content);

        const toolTurn: AiMessage = { role: 'tool', id: call.id, name: call.name, content: res.content, isError: !res.ok };
        messages.push(toolTurn);
        produced.push(toolTurn);
      }

      if (step === MAX_STEPS - 1) {
        // Don't just cut it off mid-thought — let it summarize what it did.
        const nudge: AiMessage = {
          role: 'user',
          content: 'You have reached the step limit. Stop calling tools and tell the user what you accomplished.',
        };
        messages.push(nudge);
        const req2: AiRequest = { model, system: SYSTEM_PROMPT, messages, tools: [], temperature: 0.6, maxTokens: 1024 };
        for await (const ev of streamTurn(provider, dialect, model, req2, signal)) {
          if (ev.type === 'text_delta') {
            finalText += ev.text;
            events?.onText?.(ev.text);
          }
        }
        produced.push({ role: 'assistant', content: finalText });
      }
    }

    // Recorded before the preview branch so a run the user later discards is
    // still measured — the metric is about what the model chose to call, not
    // about what survived review.
    recordTally(callTally);

    // Manual mode: leave the transaction open so the user can Apply or Discard
    // after seeing the result on the canvas. Auto mode commits now.
    if (opts.preview) {
      return { text: finalText, messages: produced, toolCallCount, tx, changes, tally: callTally };
    }
    tx.commit();
    return { text: finalText, messages: produced, toolCallCount, changes, tally: callTally };
  } catch (err) {
    // A half-applied AI edit is worse than none — the user can't tell which
    // half landed, and undo would only reach part of it.
    tx.rollback();
    throw err;
  }
}

