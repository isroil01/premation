/**
 * Author mode's host adapter: the model writes the composition.
 *
 * `@motion/author` is pure — prompts, coercion, the compiler, the advisors.
 * This file makes the model calls over the existing gateway (`askJson`),
 * executes the compiled calls through the same registry and ToolContext the
 * direct loop uses, looks at the result, and revises the beats that fail.
 *
 * ```
 * design ─▶ beats (≤3 per call, resumed when cut off) ─▶ coerce ─▶ compile ─▶ advise
 *   ─▶ execute ─▶ look (verify + filmstrips) ─▶ critique ─▶ revise failing beats
 *   ─▶ wipe their roots + replay ─▶ look again …   (≤ MAX_AUTHOR_ROUNDS revisions)
 * ```
 *
 * ## Invariants
 *
 * 1. **One prompt = one undo entry.** Every call runs on the caller's
 *    ToolContext inside the transaction `runAgent` opened; a revision is a
 *    wipe and a replay inside the same transaction, not a second entry.
 * 2. **The editor never holds a provider key.** Every call is `askJson` →
 *    `streamTurn` → the gateway or the shell.
 * 3. **Failures are recorded, never swallowed.** A call the engine rejects is
 *    a path failure AND evidence for the critique; an unusable design is a
 *    failed run, so `runAgent` falls back to the caster.
 */

import type { AiImage, ProviderId, ToolContext, ToolRegistry } from '@motion/ai-tools';
import { LOOK_PACKS } from '@motion/design-system';
import {
  IdPool,
  TAIL_ROOT,
  adviseScript,
  authorSystemPrompt,
  beatRootId,
  beatsPrompt,
  coerceBeat,
  coerceCritique,
  coerceDesign,
  compileScript,
  critiquePrompt,
  critiqueSystemPrompt,
  designPrompt,
  rebuildCalls,
  revisePrompt,
  type AuthorBrief,
  type Beat,
  type CompiledScript,
  type Critique,
  type DesignResult,
  type Repair,
  type SceneScript,
  type ToolCall,
} from '@motion/author';
import type { Direction as CasterDirection } from '@motion/caster';
import type { GatewayProviderId } from '@core/api/client';
import { recordAiPathFailure, type AgentEvents } from '../AgentLoop';
import { askJson, extractJsonArrayItems } from '../askJson';
import { renderCritiqueEvidence, renderFilmstripWindow } from '../filmstrip';
import { AUTHOR_STAGE_LABELS } from './stages';

export { AUTHOR_STAGE_LABELS };

/** Revise passes after the first build. Each costs a critique, N revise calls and a render. */
export const MAX_AUTHOR_ROUNDS = 2;
/** Beats written per model call. Three keeps a chunk well inside one response. */
export const BEAT_CHUNK = 3;
/** Re-asks for the beats a cut-off chunk did not finish. */
const MAX_RESUMES = 3;

const TOKENS = { design: 8_000, beats: 16_000, critique: 4_000, revise: 12_000 } as const;

/**
 * What the runner needs from the editor besides the model: something to look
 * with. Injectable so the run can be tested without a renderer.
 */
export interface AuthorHost {
  /** Mechanical checks of the built scene (verify.ts), formatted, or null when clean. */
  verify(ctx: ToolContext): Promise<string | null>;
  /** Images for the critic, each with a one-line caption. */
  evidence(ctx: ToolContext, beats: readonly { name: string; startSec: number; endSec: number }[], durationSec: number): Promise<{ images: AiImage[]; notes: string[] }>;
}

export const defaultAuthorHost: AuthorHost = {
  async verify(ctx) {
    try {
      const { verifyScene, formatFindings } = await import('../verify');
      return formatFindings(await verifyScene(ctx));
    } catch (err) {
      recordAiPathFailure('author', `verify failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  },
  async evidence(ctx, beats, durationSec) {
    const images: AiImage[] = [];
    const notes: string[] = [];
    const whole = await renderCritiqueEvidence(ctx, durationSec);
    if (whole[0]) { images.push(whole[0]); notes.push('Filmstrip of the whole piece, cells labelled with their time; spacing between cells is velocity.'); }
    if (whole[1]) { images.push(whole[1]); notes.push('Speed of the hero properties over time.'); }
    for (const [i, b] of beats.entries()) {
      const strip = await renderFilmstripWindow(b.startSec, b.endSec, 8);
      if (strip) { images.push(strip); notes.push(`Beat ${i} "${b.name}" (${b.startSec}–${b.endSec}s), eight evenly spaced frames.`); }
    }
    return { images, notes };
  },
};

export interface AuthorRunOptions {
  provider: GatewayProviderId;
  dialect: ProviderId;
  model: string;
  prompt: string;
  signal: AbortSignal;
  events?: AgentEvents;
  /** Reference images: the design call only. */
  images?: readonly AiImage[];
  /** The composer's direction (the caster's shape, translated here). */
  direction?: CasterDirection;
  /** Imported assets to offer, one line each. */
  assets?: readonly string[];
  host?: Partial<AuthorHost>;
  /** Override MAX_AUTHOR_ROUNDS (tests, the eval harness). */
  maxRounds?: number;
}

export interface AuthorRunResult {
  ok: boolean;
  toolCallCount: number;
  changes: string[];
  /** Repairs, rejected calls and advisor errors, for the user-facing summary. */
  problems: string[];
  script?: SceneScript;
  /** Revision passes actually run. */
  rounds: number;
  /** Beat indices revised, per round. */
  revised: number[][];
  /** The last critique's overall sentence. */
  critique?: string;
}

/** The composer's direction in the words the author brief takes. */
function briefDirection(d: CasterDirection | undefined): AuthorBrief['direction'] {
  if (!d) return undefined;
  const pack = d.lookPackId ? LOOK_PACKS.find((p) => p.id === d.lookPackId) : undefined;
  const energy = d.energy === undefined ? undefined : d.energy < 0.35 ? 'restrained, slow, a lot of air' : d.energy > 0.65 ? 'energetic, fast, punchy' : 'balanced';
  const mood = [pack ? `${pack.displayName} — ${pack.intent}` : '', energy ?? ''].filter(Boolean).join('; ');
  return {
    ...(mood ? { mood } : {}),
    ...(d.accent ? { accent: d.accent } : {}),
    ...(d.mode ? { mode: d.mode } : {}),
  };
}

/** Chunk beat indices into groups of `size`. */
function chunks(n: number, size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i += size) out.push(Array.from({ length: Math.min(size, n - i) }, (_, k) => i + k));
  return out;
}

/** The raw beat objects a beats-call answered with, by outline index. */
function beatsByIndex(items: readonly unknown[], asked: readonly number[]): Map<number, unknown> {
  const out = new Map<number, unknown>();
  items.forEach((item, k) => {
    if (!item || typeof item !== 'object') return;
    const idx = (item as { index?: unknown }).index;
    // A model that drops `index` still answers in the order it was asked.
    const i = typeof idx === 'number' && asked.includes(idx) ? idx : asked[k];
    if (i !== undefined && !out.has(i)) out.set(i, item);
  });
  return out;
}

export async function runAuthorPipeline(
  o: AuthorRunOptions,
  ctx: ToolContext,
  registry: ToolRegistry,
  writeNames: Set<string>,
  tally?: (toolName: string) => void,
): Promise<AuthorRunResult> {
  const host: AuthorHost = { ...defaultAuthorHost, ...o.host };
  const target = { provider: o.provider, dialect: o.dialect, model: o.model, signal: o.signal };
  const comp = await ctx.comp.get();
  const coerceCtx = { durationSec: comp.durationSeconds, width: comp.width, height: comp.height };
  const brief: AuthorBrief = {
    prompt: o.prompt,
    width: comp.width,
    height: comp.height,
    fps: comp.fps,
    durationSec: comp.durationSeconds,
    ...(briefDirection(o.direction) ? { direction: briefDirection(o.direction) } : {}),
    ...(o.assets?.length ? { assets: o.assets } : {}),
    ...(o.images?.length ? { imageCount: o.images.length } : {}),
  };
  const system = authorSystemPrompt(brief);
  const result: AuthorRunResult = { ok: false, toolCallCount: 0, changes: [], problems: [], rounds: 0, revised: [] };
  const repairs: Repair[] = [];

  // ── 1. Design ─────────────────────────────────────────────────────────
  o.events?.onActivity?.('Designing the piece…');
  const designRes = await askJson(target, system, designPrompt(brief), { images: o.images, maxTokens: TOKENS.design, path: 'author' });
  const design = coerceDesign(designRes.value, coerceCtx);
  repairs.push(...design.repairs);
  if (!design.value.beats.length) {
    recordAiPathFailure('author', `design unusable${designRes.truncated ? ' (cut off)' : ''}: ${design.repairs.map((r) => r.message).slice(0, 3).join('; ')}`);
    result.problems.push('The design came back without usable beats.');
    return result;
  }
  const d: DesignResult = design.value;

  // ── 2. Beats, three at a time, resumed when a response is cut off ────
  o.events?.onActivity?.('Writing the beats…');
  const reserved = [...d.beats.map((_, i) => beatRootId(i)), TAIL_ROOT, ...d.globals.map((g) => g.id)];
  const pool = new IdPool(reserved);
  const beats: Beat[] = d.beats.map((b) => ({ ...b, layers: [] }));
  const written: Beat[] = [];
  const queue = chunks(d.beats.length, BEAT_CHUNK);
  let resumesLeft = MAX_RESUMES * queue.length;
  while (queue.length) {
    if (o.signal.aborted) return result;
    const pending = queue.shift()!;
    const res = await askJson(target, system, beatsPrompt(brief, d, pending, written), { maxTokens: TOKENS.beats, path: 'author' });
    const answered = res.value && typeof res.value === 'object' ? (res.value as { beats?: unknown }).beats : undefined;
    const items = Array.isArray(answered) ? answered : res.truncated ? extractJsonArrayItems(res.text, 'beats') : [];
    const got = beatsByIndex(items, pending);
    for (const [i, raw] of got) {
      const c = coerceBeat(raw, d.beats[i]!, d, pool, coerceCtx, i);
      repairs.push(...c.repairs);
      beats[i] = c.value;
      written.push(c.value);
    }
    const missing = pending.filter((i) => !got.has(i));
    if (!missing.length) continue;
    // Only a cut-off answer earns a resume: a complete answer that skipped a
    // beat would skip it again.
    if (!res.truncated) {
      recordAiPathFailure('author', `beats ${missing.join(', ')} missing from the answer`);
      continue;
    }
    if (resumesLeft-- <= 0) {
      recordAiPathFailure('author', `beats ${missing.join(', ')} still cut off after every resume — left empty`);
      continue;
    }
    // Cut off with nothing complete: the chunk is too big for one answer, so
    // its beats go one at a time. Otherwise ask again for just the rest.
    if (got.size === 0 && missing.length > 1) queue.unshift(...missing.map((i) => [i]));
    else queue.unshift(missing);
  }
  const script: SceneScript = { ...d, beats };
  if (!beats.some((b) => b.layers.length)) {
    recordAiPathFailure('author', 'no beat came back with usable layers');
    result.problems.push('No beat came back with usable layers.');
    return result;
  }

  // ── 3. Compile, advise, execute ───────────────────────────────────────
  o.events?.onActivity?.('Building the scene…');
  let compiled = compileScript(script);
  let advice = adviseScript(script, compiled, { width: comp.width, height: comp.height, fps: comp.fps });
  const rejected: Repair[] = [];
  let n = 0;
  const execute = async (calls: readonly ToolCall[], beatOf: (i: number) => number): Promise<void> => {
    for (const [i, call] of calls.entries()) {
      if (o.signal.aborted) return;
      const id = `author_${n++}`;
      o.events?.onToolStart?.({ id, name: call.name, args: call.args });
      const res = await registry.execute(call.name, call.args, ctx);
      o.events?.onToolEnd?.({ id, name: call.name, args: call.args }, res.ok, res.content);
      tally?.(call.name);
      if (res.ok) {
        result.toolCallCount++;
        if (writeNames.has(call.name)) result.changes.push(res.content);
      } else {
        const b = beatOf(i);
        rejected.push({ path: b >= 0 ? `beats[${b}]` : 'globals', message: `${call.name} rejected: ${res.content.slice(0, 240)}` });
        recordAiPathFailure('author', `${call.name} rejected: ${res.content.slice(0, 160)}`);
      }
    }
  };
  const beatOfIndexIn = (c: CompiledScript) => (i: number) => c.byBeat.find((r) => i >= r.start && i < r.end)?.beatIndex ?? -1;
  await execute(compiled.calls, beatOfIndexIn(compiled));
  if (result.toolCallCount === 0) {
    result.problems.push('Every compiled call was rejected.');
    return result;
  }
  result.ok = true;
  result.script = script;

  // ── 4. Look, critique, revise ─────────────────────────────────────────
  const maxRounds = o.maxRounds ?? MAX_AUTHOR_ROUNDS;
  let critique: Critique | undefined;
  for (let round = 0; round <= maxRounds && !o.signal.aborted; round++) {
    o.events?.onActivity?.('Reviewing the frames…');
    const mechanical = await host.verify(ctx);
    let evidence: { images: AiImage[]; notes: string[] } = { images: [], notes: [] };
    try {
      evidence = await host.evidence(ctx, script.beats, comp.durationSeconds);
    } catch (err) {
      recordAiPathFailure('author', `evidence failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // A critique with no evidence is a critique of nothing.
    if (!evidence.images.length && !mechanical) {
      recordAiPathFailure('author', 'critique skipped — no frames rendered and no mechanical findings');
      break;
    }
    const cRes = await askJson(
      target,
      critiqueSystemPrompt(),
      critiquePrompt({ brief, design: d, evidenceNotes: evidence.notes, mechanical, advice: advice.findings, repairs: [...repairs, ...rejected] }),
      { images: evidence.images, maxTokens: TOKENS.critique, temperature: 0, path: 'author' },
    );
    critique = coerceCritique(cRes.value, script.beats.length);
    const failing = critique.beats.filter((b) => b.verdict === 'revise').map((b) => b.index);
    // The last pass only looks: there is no budget left to act on it.
    if (!failing.length || round === maxRounds) break;

    o.events?.onActivity?.('Revising beats…');
    const revisedNow: number[] = [];
    for (const i of failing) {
      if (o.signal.aborted) break;
      const others = script.beats.flatMap((b, j) => (j === i ? [] : b.layers.map((l) => l.id)));
      const findings = critique.beats.find((b) => b.index === i)!.findings;
      const res = await askJson(
        target,
        system,
        revisePrompt(brief, d, i, script.beats[i]!, findings, advice.byBeat.get(i) ?? [], others),
        { maxTokens: TOKENS.revise, path: 'author' },
      );
      const c = coerceBeat(res.value, script.beats[i]!, d, new IdPool([...reserved, ...others]), coerceCtx, i);
      if (!c.value.layers.length) {
        recordAiPathFailure('author', `revision of beat ${i} came back empty${res.truncated ? ' (cut off)' : ''} — kept the built beat`);
        continue;
      }
      repairs.push(...c.repairs);
      script.beats[i] = { ...c.value, startSec: script.beats[i]!.startSec, endSec: script.beats[i]!.endSec };
      revisedNow.push(i);
    }
    if (!revisedNow.length) break;
    const next = compileScript(script);
    const rebuild = rebuildCalls(next, revisedNow);
    rejected.length = 0;
    // The rebuild's first call wipes; the rest are the revised beats' ranges then the tail.
    await execute(rebuild, () => -1);
    compiled = next;
    advice = adviseScript(script, compiled, { width: comp.width, height: comp.height, fps: comp.fps });
    result.rounds++;
    result.revised.push(revisedNow);
  }

  if (critique?.overall) result.critique = critique.overall;
  result.problems.push(
    ...repairs.slice(0, 12).map((r) => `[repair ${r.path}] ${r.message}`),
    ...rejected.map((r) => `[rejected ${r.path}] ${r.message}`),
    ...advice.findings.filter((f) => f.severity === 'error').slice(0, 8).map((f) => `[${f.source}/${f.rule}] ${f.message}`),
  );
  return result;
}

/** Internals for tests. */
export const __testables = { briefDirection, chunks, beatsByIndex };
