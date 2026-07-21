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

import { ToolRegistry, getAdapter } from '@motion/ai-tools';
import type { AiEvent, AiImage, AiMessage, AiRequest, AiToolCall, ProviderId } from '@motion/ai-tools';
import { buildAiTools } from './toolHandlers';
import { createToolContext } from './toolContext';
import { beginAiTransaction, type AiTransaction } from './aiTransaction';
import { SYSTEM_PROMPT, buildContextPreamble } from './buildContext';
import { apiBaseUrl, getToken, type GatewayProviderId } from '@core/api/client';
import { Router, PipelineOrchestrator } from './pipeline';

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

const CRITIQUE_PROMPT =
  'Here are rendered frames of what you just built (roughly early, middle, and the final held frame). ' +
  'Look at them critically, the way a senior motion designer reviews a junior\'s work against the brief:\n' +
  '- Is any frame empty or nearly empty? Is anything off-screen, clipped, or overlapping badly?\n' +
  '- Is the composition balanced and centred, with sensible spacing — or are elements piled at one spot or the default centre?\n' +
  '- Contrast and legibility: does text read clearly against what is behind it? Are colours intentional, not placeholder blue?\n' +
  '- Motion: across the three frames, are things actually moving, staggered and eased — or static and flat?\n' +
  '- Does it match the brief\'s mood and look finished, not like a first draft?\n' +
  'If you see ANY problem, fix it now with tools (reposition, resize, restyle, re-time, add missing pieces). ' +
  'Only if it genuinely looks good: briefly tell the user what you made, and stop.';

export interface AgentResult {
  /** The assistant's final prose. */
  text: string;
  /** Turns to append to the conversation, so the next prompt has context. */
  messages: AiMessage[];
  toolCallCount: number;
  /**
   * In preview mode, the still-open transaction — the caller decides whether to
   * commit() (Apply) or rollback() (Discard). Absent in auto mode (already
   * committed).
   */
  tx?: AiTransaction;
  /** Plain-language summaries of each write the run made, for the preview list. */
  changes: string[];
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
  const token = getToken();
  if (!token) throw new AiError('auth', 'Sign in to use the assistant — AI runs through your Motion account.');

  // `provider` names WHOSE key the gateway should use; `dialect` is the wire
  // format that key speaks. They differ only for Motion AI, where the gateway
  // holds our own key for whichever provider we buy capacity from.
  const adapter = getAdapter(dialect);

  let res: Response;
  try {
    const isPipeline = req.responseSchema !== undefined;
    res = await fetch(`${apiBaseUrl()}/ai/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        provider,
        model,
        isPipeline,
        body: adapter.buildBody(req),
      }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw new AiError('cancelled', 'Cancelled.');
    throw new AiError('network', err instanceof Error ? err.message : 'Could not reach the AI gateway.');
  }

  if (!res.ok) {
    // The gateway answers failures with typed JSON: { code, message, retryAfterMs }.
    let body: { code?: string; message?: string; retryAfterMs?: number } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* non-JSON error body — fall through to the status-based default */
    }
    throw new AiError(
      body.code ?? (res.status === 401 ? 'auth' : 'network'),
      body.message ?? `AI gateway returned ${res.status}.`,
      body.retryAfterMs,
    );
  }
  if (!res.body) throw new AiError('bad_response', 'The AI gateway returned an empty body.');

  const parser = adapter.createParser();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (signal.aborted) throw new AiError('cancelled', 'Cancelled.');
        throw new AiError('network', err instanceof Error ? err.message : 'The stream failed.');
      }
      const events = chunk.done
        ? parser.end()
        : parser.push(decoder.decode(chunk.value, { stream: true }));
      for (const ev of events) {
        if (ev.type === 'error') throw new AiError(ev.code, ev.message, ev.retryAfterMs);
        yield ev;
      }
      if (chunk.done) break;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
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
  const writeNames = new Set(tools.filter((t) => t.kind === 'write').map((t) => t.name));
  const changes: string[] = [];

  const label = `AI: ${prompt.length > 48 ? `${prompt.slice(0, 48)}…` : prompt}`;
  const tx = beginAiTransaction(label);

  let requestPrompt = prompt;
  let pipelinePlan: any = null;
  /** Frames rendered after a successful pipeline run — seeds the polish pass. */
  let pipelineReviewShots: AiImage[] = [];
  let finalText = '';
  let toolCallCount = 0;
  const produced: AiMessage[] = [];

  try {
    // 1. Router Classification & Pipeline Orchestration
    try {
      const router = new Router({ provider, dialect, model, signal });
      const classification = await router.classify(prompt);
      
      if (classification === 'generative') {
        events?.onActivity?.('Orchestrating production pipeline…');
        const orchestrator = new PipelineOrchestrator({
          provider,
          dialect,
          model,
          history: opts.history,
          images: opts.images,
          signal,
          existingLayerNames: ctx.scene.all().map((n) => n.name),
          events: {
            onActivity: (label) => events?.onActivity?.(label),
          },
        });

        const compPreamble = buildContextPreamble(ctx);
        const planContext = await orchestrator.execute(prompt, compPreamble);
        
        if (planContext.toolPlan) {
          pipelinePlan = planContext.toolPlan.executionPlan;
        }
      }
    } catch (err) {
      // Fail-safe fallback to legacy direct path on pipeline error
      events?.onActivity?.('Pipeline failed. Falling back to direct mode…');
    }

    // 2. Programmatic Execution Turn (Stage 10)
    if (pipelinePlan) {
      events?.onActivity?.('Executing planned production steps…');
      const roleToNodeId = new Map<string, string>();
      for (const layer of ctx.scene.all()) {
        roleToNodeId.set(layer.name, layer.id);
        roleToNodeId.set(layer.name.toLowerCase(), layer.id);
      }

      for (const step of pipelinePlan) {
        if (signal.aborted) throw new AiError('cancelled', 'Cancelled.');
        
        const resolvedArgs = resolveRoles(step.args, roleToNodeId);
        events?.onToolStart?.({ id: `step_${step.stepIndex}`, name: step.tool, args: resolvedArgs });
        toolCallCount++;
        
        const res = await reg.execute(step.tool, resolvedArgs, ctx);
        events?.onToolEnd?.({ id: `step_${step.stepIndex}`, name: step.tool, args: resolvedArgs }, res.ok, res.content);
        
        if (!res.ok) {
          throw new AiError('unknown', `Failed execution step ${step.stepIndex} (${step.tool}): ${res.content}`);
        }
        
        if (step.tool === 'create_layer' && res.data && typeof res.data === 'object') {
          const createdId = (res.data as any).id;
          if (createdId && step.args.name) {
            roleToNodeId.set(step.args.name, createdId);
            roleToNodeId.set(step.args.name.toLowerCase(), createdId);
          }
        }
        
        if (writeNames.has(step.tool)) {
          changes.push(res.content);
        }
        
        const toolTurn: AiMessage = { role: 'tool', id: `step_${step.stepIndex}`, name: step.tool, content: res.content, isError: false };
        produced.push(toolTurn);
      }

      // 3. Sighted polish pass — the pipeline authored the scene, but nothing
      // has LOOKED at it yet. Render key frames and fall through into the
      // direct loop seeded with those shots + the critique prompt, so the
      // model can fix what the plan got wrong (overlaps, contrast, dead
      // zones) with the full toolset. Previously the pipeline path returned
      // here without ever seeing a frame — the visual loop only guarded the
      // fallback path, i.e. it was dead on exactly the path most generative
      // prompts take. If rendering fails or feedback is off, the plan result
      // stands on its own (the old behavior).
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
        finalText = `Successfully executed ${pipelinePlan.length} planned production steps.`;
        const assistantTurn: AiMessage = { role: 'assistant', content: finalText };
        produced.push(assistantTurn);

        if (opts.preview) {
          return { text: finalText, messages: produced, toolCallCount, tx, changes };
        }
        tx.commit();
        return { text: finalText, messages: produced, toolCallCount, changes };
      }
    }

    // Fallback: The preamble is rebuilt per run so the model sees the document as it is now.
    const messages: AiMessage[] = [
      ...(opts.history ?? []),
      {
        role: 'user',
        content: `${buildContextPreamble(ctx)}\n\n---\n\n${requestPrompt}`,
        ...(opts.images?.length ? { images: opts.images } : {}),
      },
    ];
    const seen = new Map<string, number>();
    let critiques = 0;
    // Pipeline handoff: the plan already executed — tell the model what was
    // built and show it the rendered frames, so its first turn is a sighted
    // review, not a blind re-author. Counts as the first critique so the
    // total number of render passes stays bounded.
    if (pipelinePlan && pipelineReviewShots.length) {
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
        const worthReviewing =
          opts.visualFeedback !== false &&
          changes.length > 0 &&
          critiques < MAX_CRITIQUES &&
          !signal.aborted;

        if (worthReviewing) {
          events?.onActivity?.('Reviewing the result');
          let shots: AiImage[] = [];
          try {
            const { renderSceneFrames, critiqueTimes } = await import('./renderFeedback');
            const comp = ctx.comp.get();
            shots = await renderSceneFrames(critiqueTimes(comp.durationSeconds, comp.fps));
          } catch {
            shots = [];
          }
          if (shots.length && !signal.aborted) {
            critiques++;
            // Keep the premature answer in the MODEL's context so the critique
            // turn has something to react to — but NOT in `produced`, so the
            // saved/visible thread only ever shows the final answer.
            messages.push({ role: 'assistant', content: text });
            messages.push({ role: 'user', content: CRITIQUE_PROMPT, images: shots });
            continue;
          }
        }

        finalText = text;
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

    // Manual mode: leave the transaction open so the user can Apply or Discard
    // after seeing the result on the canvas. Auto mode commits now.
    if (opts.preview) {
      return { text: finalText, messages: produced, toolCallCount, tx, changes };
    }
    tx.commit();
    return { text: finalText, messages: produced, toolCallCount, changes };
  } catch (err) {
    // A half-applied AI edit is worse than none — the user can't tell which
    // half landed, and undo would only reach part of it.
    tx.rollback();
    throw err;
  }
}

function resolveRoles(val: any, mapping: Map<string, string>): any {
  if (typeof val === 'string') {
    if (val.startsWith('role:')) {
      const role = val.slice(5);
      return mapping.get(role) ?? mapping.get(role.toLowerCase()) ?? role;
    }
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => resolveRoles(item, mapping));
  }
  if (val && typeof val === 'object') {
    const copy: any = {};
    for (const [k, v] of Object.entries(val)) {
      copy[k] = resolveRoles(v, mapping);
    }
    return copy;
  }
  return val;
}
