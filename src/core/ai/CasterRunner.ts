/**
 * The caster's host adapter.
 *
 * `@motion/caster` is pure: it builds prompts, validates responses and emits
 * `ToolCall[]`, and calls nothing. This file supplies the two model-facing hooks
 * over the existing `/ai/stream` gateway, and executes the result through the
 * existing registry.
 *
 * ## Three invariants this file is responsible for
 *
 * 1. **One prompt = one undo entry.** The calls are executed against the same
 *    `ToolContext` the direct loop uses, inside whatever transaction the caller
 *    opened. Nothing here touches the command history.
 * 2. **The editor never holds a provider key.** Every call goes through
 *    `streamTurn`, which names a provider and lets the gateway attach the key.
 * 3. **Failures are recorded, never swallowed.** A malformed model response is a
 *    logged path failure and a deterministic fallback, not a silent empty run.
 *
 * ## Why the model's response is parsed leniently
 *
 * A caster response is a short JSON object of ids and seeds. Every field it can
 * get wrong is already validated and repaired downstream by `validateCasting` —
 * an unknown id falls back to the top-ranked candidate, an out-of-range param
 * falls back to its default. So the parser's job is to extract what it can and
 * hand the rest to a validator that expects to be lied to, rather than to be
 * strict and fail the run.
 */

import type { AiRequest, ToolContext, ToolRegistry } from '@motion/ai-tools';
import { LOOK_PACKS } from '@motion/design-system';
import {
  briefPrompt,
  fitCriticPrompt,
  runCaster,
  type CasterHooks,
  type CastReport,
  type CreativeBrief,
} from '@motion/caster';
import type { GatewayProviderId } from '@core/api/client';
import type { ProviderId } from '@motion/ai-tools';
import { streamTurn, recordAiPathFailure, type AgentEvents } from './AgentLoop';
import { renderCritiqueEvidence } from './filmstrip';

export interface CasterRunOptions {
  provider: GatewayProviderId;
  dialect: ProviderId;
  model: string;
  prompt: string;
  signal: AbortSignal;
  /**
   * The agent loop's own event shape, not a copy of it.
   *
   * A structurally-similar duplicate is how `onToolEnd`'s third argument
   * silently went missing — the copy declared two parameters and the real one
   * takes three, so the caster's progress reporting would have compiled and then
   * shown a blank summary for every step.
   */
  events?: AgentEvents;
}

export interface CasterRunResult {
  ok: boolean;
  toolCallCount: number;
  changes: string[];
  report: CastReport;
  /** Sequencer and casting problems, for the user-facing log. */
  problems: string[];
  /** The fit critic's prose, when one ran. Never a score — see runFitCritic. */
  critique?: string;
}

/** Pull the first balanced JSON object or array out of a model's prose. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Fenced block first — the most common wrapper and the cheapest to strip.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;

  const start = body.search(/[[{]/);
  if (start < 0) return undefined;
  const open = body[start]!;
  const close = open === '{' ? '}' : ']';

  // Balance-scan rather than a greedy regex: a prose tail after the object is
  // common, and `body.slice(start, body.lastIndexOf(close) + 1)` swallows it when
  // the prose itself contains a brace.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** One structured-output call. Returns the parsed value, or undefined. */
/**
 * A compact, human-readable sketch of a JSON schema.
 *
 * Used only on the schema-less retry path, where the model has to be told the
 * shape in prose. Generated FROM the schema rather than written by hand, so it
 * cannot drift out of step with it.
 */
function shapeHint(schema: unknown, depth = 0): string {
  if (!schema || typeof schema !== 'object' || depth > 4) return '...';
  const s = schema as Record<string, any>;
  if (s.type === 'array') return `[${shapeHint(s.items, depth + 1)}]`;
  if (s.type === 'object' && s.properties) {
    const required: string[] = Array.isArray(s.required) ? s.required : [];
    const parts = Object.entries(s.properties as Record<string, any>).map(([k, v]) => {
      const mark = required.includes(k) ? '' : '?';
      return `"${k}"${mark}: ${shapeHint(v, depth + 1)}`;
    });
    return `{ ${parts.join(', ')} }`;
  }
  if (Array.isArray(s.enum)) return s.enum.map((e: unknown) => JSON.stringify(e)).join('|');
  return String(s.type ?? 'any');
}

async function askJson(
  o: CasterRunOptions,
  system: string,
  user: string,
  responseSchema: AiRequest['responseSchema'],
): Promise<unknown> {
  const req: AiRequest = {
    model: o.model,
    system,
    messages: [{ role: 'user', content: user }],
    // No tools. The caster's model calls decide; they never act, and offering a
    // tool here is offering it a way to bypass the library.
    tools: [],
    ...(responseSchema ? { responseSchema } : {}),
  };

  /**
   * One attempt. Returns the text, or an error string.
   *
   * Separated from the retry below so the schema-less second attempt goes down
   * exactly the same path rather than a parallel one.
   */
  const attempt = async (request: AiRequest): Promise<{ text: string } | { error: string }> => {
    let text = '';
    try {
      for await (const ev of streamTurn(o.provider, o.dialect, o.model, request, o.signal)) {
        if (ev.type === 'text_delta') text += ev.text;
        else if (ev.type === 'error') return { error: `${ev.code}: ${ev.message}` };
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    return { text };
  };

  let res = await attempt(req);

  /**
   * Retry without the response schema when the provider rejects it.
   *
   * Structured output is not one feature — each provider implements a different
   * subset of JSON Schema, and Gemini's is the narrowest. Measured against a
   * live key: `BRIEF_SCHEMA` returns `400 INVALID_ARGUMENT`, and the same schema
   * with its nested `content` object removed succeeds. Nothing in the type
   * system says which shapes each provider will take, and the tests could not
   * have caught it — a mock accepts every schema.
   *
   * The schema is a convenience here, not a guarantee: `extractJson` already
   * balance-scans free-form text, and `coerceBrief` / `coercePicks` already
   * validate and repair whatever comes back, because a model can return
   * malformed JSON inside a schema-constrained response too. So dropping the
   * schema costs a little output stability and loses nothing that was load-
   * bearing.
   *
   * Recorded, never silent — a run that quietly degraded on every call would
   * look identical to one that never needed to.
   */
  if ('error' in res && req.responseSchema) {
    recordAiPathFailure('caster', `schema rejected by ${o.dialect} (${res.error}); retrying without it`);
    const { responseSchema: _dropped, ...withoutSchema } = req;
    res = await attempt({
      ...withoutSchema,
      // The schema carried the shape instruction, so the prompt has to carry it
      // instead — and "return JSON" is not enough.
      //
      // Measured: with only that instruction Gemini returned well-formed JSON
      // whose beats had EMPTY content objects, so every beat then failed layout
      // casting with "no layout can hold this beat's content". The request
      // stopped 400-ing and started succeeding at producing nothing usable,
      // which is the worse failure of the two because it looks like it worked.
      //
      // Spelling the shape out from the schema itself keeps the two in step —
      // a schema change cannot leave a stale hand-written example behind.
      system:
        `${system}

Return ONLY a single JSON object matching this shape — no prose, ` +
        `no code fences, and every listed key present:
${shapeHint(req.responseSchema)}`,
    });
  }

  if ('error' in res) {
    recordAiPathFailure('caster', res.error);
    return undefined;
  }

  const parsed = extractJson(res.text);
  if (parsed === undefined) {
    recordAiPathFailure('caster', `unparseable response (${res.text.length} chars): ${res.text.slice(0, 160)}`);
  }
  return parsed;
}

// ── Response schemas ──────────────────────────────────────────────────

const BRIEF_SCHEMA: AiRequest['responseSchema'] = {
  type: 'object',
  additionalProperties: false,
  required: ['lookPackId', 'energy', 'tone', 'totalDurationMs', 'beats'],
  properties: {
    lookPackId: { type: 'string' },
    accent: { type: 'string' },
    mode: { type: 'string', enum: ['dark', 'light'] },
    energy: { type: 'number', minimum: 0, maximum: 1 },
    tone: { type: 'string' },
    totalDurationMs: { type: 'number', minimum: 1000 },
    beats: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['purpose', 'weight', 'content'],
        properties: {
          purpose: { type: 'string' },
          weight: { type: 'number', minimum: 0.1, maximum: 10 },
          content: {
            type: 'object',
            additionalProperties: false,
            properties: {
              headline: { type: 'string' },
              subhead: { type: 'string' },
              support: { type: 'string' },
              overline: { type: 'string' },
              quote: { type: 'string' },
              attribution: { type: 'string' },
              cta: { type: 'string' },
              mediaAssetId: { type: 'string' },
              items: {
                type: 'array',
                maxItems: 6,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    value: { type: 'string' },
                    label: { type: 'string' },
                    title: { type: 'string' },
                    body: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const CAST_SCHEMA: AiRequest['responseSchema'] = {
  type: 'object',
  additionalProperties: false,
  required: ['picks'],
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['beatIndex', 'id'],
        properties: {
          beatIndex: { type: 'integer', minimum: 0 },
          id: { type: 'string' },
          seed: { type: 'integer', minimum: 0 },
          params: { type: 'object' },
        },
      },
    },
  },
};

/** A brief that is structurally valid whatever the model returned. */
function coerceBrief(raw: unknown, prompt: string): CreativeBrief {
  const o = (raw ?? {}) as Record<string, unknown>;
  const packIds = new Set(LOOK_PACKS.map((p) => p.id));
  const lookPackId = typeof o.lookPackId === 'string' && packIds.has(o.lookPackId)
    ? o.lookPackId
    : LOOK_PACKS[0]!.id;
  const beats = Array.isArray(o.beats) && o.beats.length
    ? (o.beats as Record<string, unknown>[]).map((b) => ({
        purpose: String(b.purpose ?? 'beat'),
        weight: typeof b.weight === 'number' && Number.isFinite(b.weight) ? b.weight : 1,
        content: (b.content ?? {}) as CreativeBrief['beats'][number]['content'],
      }))
    // A brief with no beats still has to render something. One beat carrying the
    // prompt as a headline is a worse piece than the model should have planned,
    // and an infinitely better outcome than a blank composition.
    : [{ purpose: 'hero', weight: 1, content: { headline: prompt.slice(0, 90) } }];

  return {
    lookPackId,
    ...(typeof o.accent === 'string' ? { accent: o.accent } : {}),
    ...(o.mode === 'dark' || o.mode === 'light' ? { mode: o.mode } : {}),
    energy: typeof o.energy === 'number' && Number.isFinite(o.energy)
      ? Math.max(0, Math.min(1, o.energy))
      : 0.5,
    tone: typeof o.tone === 'string' ? o.tone : prompt.slice(0, 120),
    totalDurationMs: typeof o.totalDurationMs === 'number' && o.totalDurationMs > 0
      ? Math.min(120_000, o.totalDurationMs)
      : 10_000,
    beats,
  };
}

function coercePicks(raw: unknown): { beatIndex: number; id: string; params?: Record<string, unknown>; seed?: number }[] {
  const container = (raw ?? {}) as Record<string, unknown>;
  // Accept both `{ picks: [...] }` and a bare array — models return both, and
  // failing over the wrapper would waste a call for nothing.
  const list = Array.isArray(container.picks) ? container.picks : Array.isArray(raw) ? raw : [];
  return (list as Record<string, unknown>[])
    .filter((p) => typeof p?.id === 'string')
    .map((p) => ({
      beatIndex: typeof p.beatIndex === 'number' ? p.beatIndex : 0,
      id: String(p.id),
      ...(p.params && typeof p.params === 'object' ? { params: p.params as Record<string, unknown> } : {}),
      ...(typeof p.seed === 'number' ? { seed: p.seed } : {}),
    }));
}

// ── The run ───────────────────────────────────────────────────────────

/**
 * Plan a piece with the caster and execute it.
 *
 * Three model calls: brief, cast-layouts, cast-motion. Every keyframe comes from
 * a library. The model never sees one.
 */
export async function runCasterPipeline(
  o: CasterRunOptions,
  ctx: ToolContext,
  registry: ToolRegistry,
  writeNames: Set<string>,
  tally?: (toolName: string) => void,
): Promise<CasterRunResult> {
  const comp = ctx.comp.get();

  const hooks: CasterHooks = {
    brief: async (system, userPrompt) => {
      o.events?.onActivity?.('Writing the creative brief…');
      const raw = await askJson(o, system, userPrompt, BRIEF_SCHEMA);
      return coerceBrief(raw, userPrompt);
    },
    cast: async (prompts, kind) => {
      o.events?.onActivity?.(kind === 'layout' ? 'Casting layouts…' : 'Casting motion…');
      // ONE call for all beats, not one per beat. A five-beat piece must not
      // become eleven model calls — the cost criterion is ≤4 for the whole run.
      const system = kind === 'layout'
        ? 'Choose one layout per beat. Return { picks: [{ beatIndex, id, seed }] } and nothing else.'
        : 'Choose one technique per beat. Return { picks: [{ beatIndex, id, params, seed }] } and nothing else.';
      const user = prompts.map((p) => p.prompt).join('\n\n───\n\n');
      const raw = await askJson(o, system, user, CAST_SCHEMA);
      return coercePicks(raw);
    },
  };

  const result = await runCaster({
    userPrompt: o.prompt,
    hooks,
    width: comp.width,
    height: comp.height,
    fps: comp.fps,
  });

  // ── Execute ─────────────────────────────────────────────────────────
  // Through the same registry the direct loop uses, so alias resolution, schema
  // validation and the undo boundary are all identical. A caster call and a
  // model call are indistinguishable by the time they reach a handler.
  o.events?.onActivity?.('Building the composition…');
  const changes: string[] = [];
  let executed = 0;

  for (const [i, call] of result.calls.entries()) {
    if (o.signal.aborted) break;
    const id = `cast_${i}`;
    o.events?.onToolStart?.({ id, name: call.name, args: call.args });
    const res = await registry.execute(call.name, call.args, ctx);
    o.events?.onToolEnd?.({ id, name: call.name, args: call.args }, res.ok, res.content);
    tally?.(call.name);
    if (res.ok) {
      executed++;
      if (writeNames.has(call.name)) changes.push(res.content);
    } else {
      // A rejected call is a library bug, not a model bug — the libraries emit
      // against the same schemas the registry enforces. Recording it is how that
      // shows up instead of silently producing a thinner piece.
      recordAiPathFailure('caster', `${call.name} rejected: ${res.content.slice(0, 160)}`);
    }
  }

  const problems = [
    ...result.problems.sequence.map((p) => `[sequence] ${p.message}`),
    ...result.problems.casting.map(
      (p) => `[cast beat ${p.beatIndex}] ${p.message}${p.replacedWith ? ` → used '${p.replacedWith}'` : ''}`,
    ),
    ...result.report.findings
      .filter((f) => f.severity === 'error')
      .map((f) => `[${f.source}/${f.rule}] ${f.message}`),
  ];

  // ── The fit critic ──────────────────────────────────────────────────
  // ONE call, ONE iteration, and only if something was actually built. Not six
  // critics scoring rubrics: averaged rubric scores converge to the mean, and
  // the mean is precisely the naive output this architecture exists to escape —
  // so the old loop's most expensive stage was pulling toward the problem.
  //
  // The craft floor is already deterministic. Iterating on it would be spending
  // a model turn to re-check arithmetic, so this asks the only question a vision
  // model can answer better than the linters can: does it serve the brief, and
  // can you name the stock template it resembles?
  let critique: string | undefined;
  if (executed > 0 && !o.signal.aborted) {
    critique = await runFitCritic(o, ctx, result.brief);
  }

  return {
    ok: executed > 0,
    toolCallCount: executed,
    changes,
    report: result.report,
    problems,
    ...(critique ? { critique } : {}),
  };
}

/**
 * One critique call over a filmstrip and velocity graphs.
 *
 * Returns prose, not a score. A score invites averaging and averaging is what
 * produced the problem; a sentence naming what it resembles is actionable.
 * Returns `undefined` if nothing could be rendered — a critique with no evidence
 * is a critique of nothing, and asking for one anyway is how a loop learns to
 * hallucinate about images it never saw.
 */
async function runFitCritic(
  o: CasterRunOptions,
  ctx: ToolContext,
  brief: CreativeBrief,
): Promise<string | undefined> {
  try {
    o.events?.onActivity?.('Reviewing the result…');
    const comp = ctx.comp.get();
    const evidence = await renderCritiqueEvidence(ctx, comp.durationSeconds);
    if (!evidence.length) {
      recordAiPathFailure('caster', 'fit critic skipped — no frames rendered');
      return undefined;
    }

    const req: AiRequest = {
      model: o.model,
      system: fitCriticPrompt({ tone: brief.tone, lookPackId: brief.lookPackId }),
      messages: [{
        role: 'user',
        content:
          'The first image is a filmstrip sampled around this piece\'s keyframe events, each cell ' +
          'labelled with its time. The second plots the speed of its hero properties. ' +
          'Frame spacing in the strip IS velocity — read it that way.',
        images: evidence,
      }],
      tools: [],
    };

    let text = '';
    for await (const ev of streamTurn(o.provider, o.dialect, o.model, req, o.signal)) {
      if (ev.type === 'text_delta') text += ev.text;
      else if (ev.type === 'error') {
        recordAiPathFailure('caster', `fit critic: ${ev.code}: ${ev.message}`);
        return undefined;
      }
    }
    return text.trim() || undefined;
  } catch (err) {
    recordAiPathFailure('caster', err);
    return undefined;
  }
}

/** The pack list, for a settings UI that wants to show what the caster can pick. */
export function casterPacks(): readonly { id: string; displayName: string; intent: string }[] {
  return LOOK_PACKS.map((p) => ({ id: p.id, displayName: p.displayName, intent: p.intent }));
}

/** Exposed so a caller can show the brief prompt without running anything. */
export function casterBriefPrompt(): string {
  return briefPrompt(LOOK_PACKS);
}

/**
 * Internals exposed for testing.
 *
 * Response parsing and the fallbacks are the only parts of the caster path not
 * already covered inside `@motion/caster`, and they are the parts a real model
 * will actually break — so they are reachable rather than inlined.
 */
export const __testables = { extractJson, coerceBrief, coercePicks };
