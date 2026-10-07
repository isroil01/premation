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

import type { AiImage, AiRequest, ToolContext, ToolRegistry } from '@motion/ai-tools';
import { LOOK_PACKS } from '@motion/design-system';
import {
  fitCriticPrompt,
  runCaster,
  type CasterHooks,
  type CastReport,
  type CreativeBrief,
  type Direction,
} from '@motion/caster';
import type { GatewayProviderId } from '@core/api/client';
import type { ProviderId } from '@motion/ai-tools';
import { analyseSceneAudioForCaster } from './audioForCaster';
import { streamTurn, recordAiPathFailure, type AgentEvents } from './AgentLoop';
import { renderCritiqueEvidence } from './filmstrip';
import { askJson, extractJson } from './askJson';

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
  /**
   * Reference images the user attached to this turn.
   *
   * They reach the BRIEF call and nothing else. The brief is the only stage
   * making a judgement an image can inform — which look pack, which accent, what
   * the piece is about — and it was the one stage running blind: this file built
   * its own message array and never carried them, so pasting a moodboard and
   * typing "make it like this" fed the model the sentence and dropped the
   * picture, on every generative prompt.
   *
   * Deliberately NOT sent to the cast calls. Those choose from a pre-filtered id
   * list against constraints an image cannot speak to, and images are the
   * heaviest thing in a request by a wide margin.
   */
  images?: readonly AiImage[];
  /**
   * Direction the user set in the composer, which overrides the model's brief.
   *
   * `casterPacks()` has been exported for a UI to render since the caster
   * landed, and nothing called it — so every run guessed a look the user may
   * already have decided.
   */
  direction?: Direction;
  /** How many alternatives to emit. 1 keeps the previous single-result behaviour. */
  variants?: number;
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
  /** How many alternatives were emitted. 1 when the feature is off. */
  variantCount: number;
  /** Mean linter score per alternative, best first — the ranking that chose one. */
  variantScores: readonly number[];
}

/**
 * One structured-output call through the shared `askJson` (moved to
 * askJson.ts when author mode needed the same call). The caster's responses
 * are short, so a cut-off one is treated as unparseable.
 */
async function askJsonValue(
  o: CasterRunOptions,
  system: string,
  user: string,
  responseSchema: AiRequest['responseSchema'],
  images?: readonly AiImage[],
): Promise<unknown> {
  const res = await askJson(o, system, user, {
    ...(responseSchema ? { schema: responseSchema } : {}),
    ...(images?.length ? { images } : {}),
    path: 'caster',
  });
  return res.value;
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
          art: { type: 'string' },
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
        // Length-gated, not just type-gated. The backend's image DTO rejects a
        // prompt under 8 characters, so an `art: "yes"` would cost a round trip
        // to be told so — and a one-word subject was never art direction anyway.
        ...(typeof b.art === 'string' && b.art.trim().length >= 8 ? { art: b.art.trim() } : {}),
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
  const comp = await ctx.comp.get();

  // Decode in parallel with the brief — do not wait here.
  const audioPromise = analyseSceneAudioForCaster();

  const hooks: CasterHooks = {
    brief: async (system, userPrompt) => {
      o.events?.onActivity?.('Writing the creative brief…');
      // The one stage that gets the user's reference images. Naming them in the
      // prompt matters: without it a model handed an image and a schema tends to
      // describe the image back rather than treat it as direction.
      const withRefs = o.images?.length
        ? `${userPrompt}\n\nThe attached image${o.images.length > 1 ? 's are' : ' is'} REFERENCE for the ` +
          `look — read the palette, the type, the density and the mood from ${o.images.length > 1 ? 'them' : 'it'} ` +
          `and choose the pack and accent that come closest. Do not describe the image back.`
        : userPrompt;
      const raw = await askJsonValue(o, system, withRefs, BRIEF_SCHEMA, o.images);
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
      const raw = await askJsonValue(o, system, user, CAST_SCHEMA);
      return coercePicks(raw);
    },
  };

  const audio = await audioPromise;

  const result = await runCaster({
    userPrompt: o.prompt,
    hooks,
    width: comp.width,
    height: comp.height,
    fps: comp.fps,
    ...(audio ? { audio } : {}),
    ...(o.direction ? { direction: o.direction } : {}),
    ...(o.variants && o.variants > 1 ? { variants: o.variants } : {}),
  });

  if (result.variants.length > 1) {
    // Say which one was applied and how the others scored. Emitting several and
    // silently keeping the best would spend the work and hide the choice — and
    // the choice is the feature.
    o.events?.onActivity?.(`Comparing ${result.variants.length} directions…`);
  }

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
    // Errors AND warnings.
    //
    // This filtered to `severity === 'error'`, and the deterministic repair pass
    // also only acts on errors — so a warning was computed, discarded here, and
    // never fixed anywhere. `PRIMITIVE_ONLY` spent its whole life in that gap:
    // it fired on every run, its message named the exact ceiling on the output's
    // quality, and nobody ever saw it.
    //
    // Warnings are judgement calls, so they are labelled as such rather than
    // presented as failures. The person who can act on "nothing in this
    // composition is a picture" is the one typing the prompt.
    ...result.report.findings
      .filter((f) => f.severity === 'error')
      .map((f) => `[${f.source}/${f.rule}] ${f.message}`),
    ...result.report.findings
      .filter((f) => f.severity === 'warn')
      .map((f) => `[${f.source}/${f.rule}, judgement call] ${f.message}`),
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
    variantCount: result.variants.length,
    variantScores: result.variants.map((v) =>
      Number(((v.report.designScore + v.report.craftScore + v.report.uiMotionScore) / 3).toFixed(3)),
    ),
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
    const comp = await ctx.comp.get();
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

/**
 * Internals exposed for testing.
 *
 * Response parsing and the fallbacks are the only parts of the caster path not
 * already covered inside `@motion/caster`, and they are the parts a real model
 * will actually break — so they are reachable rather than inlined.
 */
export const __testables = { extractJson, coerceBrief, coercePicks };
