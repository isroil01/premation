/**
 * The footage tools' handlers (packages/ai-tools/src/tools/media.ts): subjects
 * (the Object Matte tool group — find, select, refine, follow, style), point
 * tracking (Track Motion + Apply), transcription, an imported asset's
 * description and the editor's own state.
 *
 * They call the SAME core the editor's tools call — rotoBrushTool.ts for the
 * segmentation and the walk, the engine's trackMotion / trackApply /
 * transcribe jobs, captionEdit.ts for the caption layers — so a subject the
 * assistant selected is one the user refines in the Subjects panel and the
 * other way round. The Subjects panel's style presets live with the editor
 * and arrive through `subjectPort`.
 *
 * Coordinates at this boundary are FOOTAGE pixels from the top-left of the
 * picture (what place_behind_subject takes); the core speaks layer-local
 * centre-origin px of the layer's box (a resized layer's box is smaller than
 * its picture), so every point is mapped through `footageFrame`.
 *
 * Long work (follow_subject, transcribe) is a background job: `AI_JOBS` holds
 * what get_job_status answers; the Tasks panel shows the same job.
 */

import type { AiTool, ToolContext, ToolResult } from '@motion/ai-tools';
import { AiEngineError, resolveAlias } from '@motion/ai-tools';
import { flicksToSeconds, secondsToFlicks, type Command, type TrackApplyMode, type TrackSeries } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { requireEngineJob, runEngineJob, startEngineJob } from '@core/engine/engineJobs';
import { captionReplaceCommands } from '@core/engine/captionEdit';
import { settingsDurationSeconds, settingsFps, settingsSetWorkArea } from '@core/mirror/compFacts';
import { layersUsingItem } from '@core/mirror/docFacts';
import { uiKindOf } from '@core/mirror/layerKinds';
import { activeCompRootId } from '@core/scene/activeComp';
import { TranscribeError, transcribeCompositionDetailed, transcriptionAvailable } from '@core/captions/transcribe';
import { objectMatteCard } from '@core/workspace/objectMatteEffect';
import { findObjects, layerSize, propagateObjectMatte, runSubjectEdit, type FoundObject, type SubjectEditRequest } from '@core/workspace/rotoBrushTool';
import { layerSubjects, newSubjectId, subjectLocked, updateSubjectCommands, type SubjectEdge } from '@core/workspace/subjects';
import { subjectPort } from '@core/workspace/subjectPort';
import { fetchSubjectTracks, isTracked } from '@core/workspace/subjectTracks';
import { documentMirror } from '@stores/documentMirror';
import { useAssetStore } from '@stores/assetStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { usePropertySelectionStore } from '@stores/propertySelectionStore';
import { useRotoBrushStore } from '@stores/rotoBrushStore';
import { useSelectionStore } from '@stores/selectionStore';
import { activeSubjectId } from '@stores/subjectStore';
import { useUIStore } from '@stores/uiStore';
import { layerFrameGeometry, type FrameGeometry } from './rigTools';

const ok = (content: string, data?: unknown): ToolResult => ({ ok: true, content, data });
const fail = (content: string): ToolResult => ({ ok: false, content });

type Pt = { x: number; y: number };
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r1 = (v: number): number => Math.round(v * 10) / 10;

// ── Background jobs ────────────────────────────────────────────────────

export type AiJobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface AiJob {
  id: string;
  kind: 'follow_subject' | 'transcribe' | 'track_point';
  label: string;
  status: AiJobStatus;
  /** 0…1 while running. */
  progress: number;
  startedAt: number;
  finishedAt?: number;
  message?: string;
  /** The kind's summary, once done. */
  result?: unknown;
  cancel: () => void;
}

/** Jobs this assistant started, newest last; what get_job_status reads. */
export const AI_JOBS = new Map<string, AiJob>();
let jobSeq = 0;
const JOB_HISTORY = 40;

export function newAiJob(kind: AiJob['kind'], label: string, cancel: () => void): AiJob {
  const id = `${kind.replace(/_/g, '-')}-${(++jobSeq).toString(36)}`;
  const job: AiJob = { id, kind, label, status: 'running', progress: 0, startedAt: Date.now(), cancel };
  AI_JOBS.set(id, job);
  while (AI_JOBS.size > JOB_HISTORY) {
    const oldest = [...AI_JOBS.values()].find((j) => j.status !== 'running');
    if (!oldest) break;
    AI_JOBS.delete(oldest.id);
  }
  return job;
}

export function finishAiJob(job: AiJob, status: Exclude<AiJobStatus, 'running'>, message: string, result?: unknown): void {
  job.status = status;
  job.finishedAt = Date.now();
  job.message = message;
  if (result !== undefined) job.result = result;
  if (status === 'done') job.progress = 1;
}

export function jobLine(j: AiJob): string {
  const state = j.status === 'running' ? `running ${Math.round(j.progress * 100)}%` : j.status;
  return `- ${j.id} (${j.kind}, "${j.label}"): ${state}${j.message ? ` — ${j.message}` : ''}`;
}

/** Only the testable part of the Tasks panel's job: start / progress / finish, absent in a headless run. */
function uiJobs(): { start(id: string, label: string, cancel: () => void): void; progress(id: string, f: number): void; finish(id: string, status: 'done' | 'failed' | 'cancelled', message: string): void } {
  const api = (): ReturnType<typeof useUIStore.getState> | null => {
    try { return useUIStore.getState(); } catch { return null; }
  };
  return {
    start: (id, label, cancel) => api()?.startJob({ id, kind: 'analysis', label, progress: 0, cancel }),
    progress: (id, f) => api()?.updateJob(id, { progress: f }),
    finish: (id, status, message) => api()?.finishJob(id, { status, message }),
  };
}

// ── Footage geometry ───────────────────────────────────────────────────

interface FootageFrame {
  /** The picture's own size, px. */
  source: { width: number; height: number };
  /** The layer's box the matte lives in, px (a resized layer's is smaller). */
  box: { width: number; height: number };
  /** Footage px (top-left origin) → layer-local centre-origin px. */
  toLocal(p: Pt): Pt;
  /** Layer-local → footage px. */
  toFootage(p: Pt): Pt;
}

async function footageFrame(nodeId: string): Promise<FootageFrame | null> {
  const size = await engine().query({ type: 'getSourceSize', layers: [nodeId] });
  const s = size.ok ? size.value.sizes[0] : undefined;
  if (!s || !(s.width > 0) || !(s.height > 0)) return null;
  const box = (await layerSize(nodeId)) ?? { width: s.width, height: s.height };
  const source = { width: s.width, height: s.height };
  return {
    source,
    box,
    toLocal: (p) => ({ x: (p.x / source.width - 0.5) * box.width, y: (p.y / source.height - 0.5) * box.height }),
    toFootage: (p) => ({ x: (p.x / box.width + 0.5) * source.width, y: (p.y / box.height + 0.5) * source.height }),
  };
}

/** The layer's id resolved, or the repair sentence. */
async function footageLayer(ctx: ToolContext, raw: unknown): Promise<{ id: string } | { error: string }> {
  const id = resolveAlias(ctx, String(raw ?? ''));
  if (!id || !(await ctx.scene.has(id))) {
    const near = (await ctx.scene.nearest(id)).join(', ');
    return { error: `unknown layerId '${id}' — did you mean: ${near || '(no layers exist yet)'}?` };
  }
  const kind = uiKindOf(documentMirror().layer(id));
  if (kind !== 'video' && kind !== 'image') {
    return { error: `'${id}' is a ${kind ?? 'non-footage'} layer. Subjects and tracking work on video and image layers (describe_scene lists kinds).` };
  }
  return { id };
}

/** An outline's bounds (layer-local x y pairs) in footage px, rounded. */
function outlineBounds(outline: readonly number[], f: FootageFrame): { x: number; y: number; w: number; h: number } | null {
  if (outline.length < 4) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < outline.length; i += 2) {
    const p = f.toFootage({ x: outline[i]!, y: outline[i + 1]! });
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}

/** What the MCP host draws for a subject answer: the layer's frame geometry and labelled outlines (layer-local px). */
export interface SubjectView extends FrameGeometry {
  layer: string;
  time: number;
  outlines: { label: string; points: number[] }[];
}

async function subjectView(ctx: ToolContext, layer: string, time: number, outlines: SubjectView['outlines']): Promise<SubjectView | null> {
  const g = await layerFrameGeometry(ctx, layer, time);
  return g ? { ...g, layer, time, outlines } : null;
}

const timeArg = (ctx: ToolContext, v: unknown): number => (isNum(v) ? Math.max(0, v) : ctx.comp.playhead());

function pointsOf(v: unknown, f: FootageFrame, which: 'subject' | 'not' | 'all'): Pt[] {
  if (!Array.isArray(v)) return [];
  const out: Pt[] = [];
  for (const raw of v) {
    const p = raw as { x?: unknown; y?: unknown; label?: unknown };
    if (!isNum(p.x) || !isNum(p.y)) continue;
    const label = p.label === 'not' ? 'not' : 'subject';
    if (which !== 'all' && label !== which) continue;
    out.push(f.toLocal({ x: p.x, y: p.y }));
  }
  return out;
}

function boxOf(v: unknown, f: FootageFrame, time: number): SubjectEditRequest['box'] {
  const b = v as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | undefined;
  if (!b || !isNum(b.x) || !isNum(b.y) || !isNum(b.w) || !isNum(b.h) || b.w <= 0 || b.h <= 0) return null;
  const a = f.toLocal({ x: b.x, y: b.y });
  const c = f.toLocal({ x: b.x + b.w, y: b.y + b.h });
  return { x0: a.x, y0: a.y, x1: c.x, y1: c.y, time };
}

function describeFound(objects: readonly FoundObject[], f: FootageFrame, limit: number): Array<{ index: number; bounds: ReturnType<typeof outlineBounds>; areaPct: number; seed: Pt }> {
  return objects.slice(0, limit).map((o, index) => {
    const seed = f.toFootage(o.seed);
    return { index, bounds: outlineBounds(o.outline, f), areaPct: Math.round(o.area * 1000) / 10, seed: { x: Math.round(seed.x), y: Math.round(seed.y) } };
  });
}

function engineMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Apply a held job result through the TURN's session, so it lands in the
 * turn's gesture (one undo entry). The engine never applies a finished job by
 * itself while a gesture is open (session_jobs.cpp) — a job started with
 * `apply: true` inside an AI turn would wait for the gesture the turn is
 * waiting to close: the deadlock the live skater test found. A job whose
 * result wrote nothing has no held result; that is not an error here.
 */
function turnApplier(ctx: ToolContext): (jobId: string) => Promise<void> {
  return async (jobId) => {
    try {
      await ctx.engine.apply([{ type: 'applyJobResult', job: jobId } as Command]);
    } catch (err) {
      if (err instanceof AiEngineError && err.code === 'invalidArgument' && /no result to apply/.test(err.message)) return;
      throw err;
    }
  };
}

// ── Subjects ───────────────────────────────────────────────────────────

const findSubjects: AiTool['handler'] = async (input, ctx) => {
  const a = input as { layerId: string; time?: number; limit?: number };
  const layer = await footageLayer(ctx, a.layerId);
  if ('error' in layer) return fail(layer.error);
  const f = await footageFrame(layer.id);
  if (!f) return fail(`'${layer.id}' has no picture to search (its footage may be missing).`);
  const time = timeArg(ctx, a.time);
  let found: FoundObject[] | null;
  try {
    found = await findObjects(layer.id, time);
  } catch (err) {
    return fail(`Find Objects failed: ${engineMessage(err)}`);
  }
  if (!found) return fail('This engine could not search the frame (the Object Matte model may not be installed — Settings ▸ Models).');
  if (found.length === 0) return ok(`No objects found in '${layer.id}' at ${time.toFixed(2)}s. Try select_subject with your own points.`, { layerId: layer.id, time, candidates: [] });
  const limit = Math.max(1, Math.min(60, Math.round(a.limit ?? 20)));
  const candidates = describeFound(found, f, limit);
  const lines = candidates.map((c) => `- #${c.index}: ${c.areaPct}% of the frame, bounds x ${c.bounds?.x} y ${c.bounds?.y} ${c.bounds?.w}×${c.bounds?.h}, seed (${c.seed.x}, ${c.seed.y})`);
  const view = await subjectView(ctx, layer.id, time, found.slice(0, limit).map((o, i) => ({ label: `#${i}`, points: o.outline })));
  return ok(
    `${found.length} object(s) in '${layer.id}' at ${time.toFixed(2)}s (largest first; footage px, ${f.source.width}×${f.source.height}). Pick one with select_subject { candidate: N }.\n${lines.join('\n')}`,
    { layerId: layer.id, time, candidates, ...(view ? { view } : {}) },
  );
};

interface SelectSubjectInput {
  layerId: string;
  points?: unknown;
  box?: unknown;
  candidate?: number;
  name?: string;
  subject?: string;
  time?: number;
}

async function nameSubject(ctx: ToolContext, layer: string, subject: string, name: string): Promise<boolean> {
  await documentMirror().loadTree(layer);
  const cmds = updateSubjectCommands(layer, subject, { name: name.trim().slice(0, 60) });
  if (cmds.length === 0) return false;
  await ctx.engine.apply(cmds);
  return true;
}

const selectSubject: AiTool['handler'] = async (input, ctx) => {
  const a = input as SelectSubjectInput;
  const layer = await footageLayer(ctx, a.layerId);
  if ('error' in layer) return fail(layer.error);
  const f = await footageFrame(layer.id);
  if (!f) return fail(`'${layer.id}' has no picture to cut from (its footage may be missing).`);
  const time = timeArg(ctx, a.time);
  const clicks = pointsOf(a.points, f, 'subject');
  const negatives = pointsOf(a.points, f, 'not');
  const box = boxOf(a.box, f, time);
  if (isNum(a.candidate)) {
    let found: FoundObject[] | null;
    try {
      found = await findObjects(layer.id, time);
    } catch (err) {
      return fail(`Find Objects failed: ${engineMessage(err)}`);
    }
    const o = found?.[Math.round(a.candidate)];
    if (!o) return fail(`No candidate #${a.candidate} at ${time.toFixed(2)}s on '${layer.id}' (find_subjects lists ${found?.length ?? 0}).`);
    clicks.push(o.seed);
  }
  if (clicks.length === 0 && !box) return fail('Give `points` on the subject (footage px from the top-left), a `box` round it, or a `candidate` from find_subjects.');
  const existing = layerSubjects(layer.id);
  if (a.subject && !existing.some((s) => s.id === a.subject)) {
    return fail(`'${layer.id}' has no subject '${a.subject}'. Its subjects: ${existing.map((s) => `${s.id} "${s.name}"`).join(', ') || 'none'} — omit \`subject\` to make a new one.`);
  }
  const subject = a.subject ?? newSubjectId(layer.id);
  if (subjectLocked(layer.id, subject)) return fail(`Subject '${subject}' of '${layer.id}' is frozen (locked). Unfreeze it in the Subjects panel first.`);
  let res;
  try {
    res = await runSubjectEdit(layer.id, time, { tool: 'segment', op: 'replace', clicks, negatives, box }, subject, { applyResult: turnApplier(ctx) });
  } catch (err) {
    return fail(`Object Matte failed: ${engineMessage(err)}`);
  }
  if (!res) return fail(`Nothing was selected on '${layer.id}' at ${time.toFixed(2)}s — the points may be off the picture, or this engine does not run Object Matte.`);
  const named = a.name ? await nameSubject(ctx, layer.id, subject, a.name) : false;
  const bounds = outlineBounds(res.outline, f);
  const view = await subjectView(ctx, layer.id, time, [{ label: subject, points: res.outline }]);
  const coverage = Math.round(res.coverage * 1000) / 10;
  return ok(
    `Selected subject '${subject}'${named ? ` ("${a.name}")` : ''} on '${layer.id}' at ${time.toFixed(2)}s: ${coverage}% of the frame` +
      (bounds ? `, bounds x ${bounds.x} y ${bounds.y} ${bounds.w}×${bounds.h} (footage px of ${f.source.width}×${f.source.height})` : '') +
      '. It is a selection on this frame: refine_subject to correct it, follow_subject to carry it through the shot, apply_subject_style / place_behind_subject to use it.',
    { layerId: layer.id, subject, time, coverage: res.coverage, bounds, outlinePoints: res.outline.length / 2, ...(view ? { view } : {}) },
  );
};

interface RefineSubjectInput {
  layerId: string;
  subject?: string;
  time?: number;
  add?: unknown;
  subtract?: unknown;
  strokes?: Array<{ points: number[][]; op?: 'add' | 'subtract'; tool?: 'paint' | 'refine'; radius?: number }>;
  edge?: Partial<SubjectEdge>;
}

const refineSubject: AiTool['handler'] = async (input, ctx) => {
  const a = input as RefineSubjectInput;
  const layer = await footageLayer(ctx, a.layerId);
  if ('error' in layer) return fail(layer.error);
  const f = await footageFrame(layer.id);
  if (!f) return fail(`'${layer.id}' has no picture (its footage may be missing).`);
  const subjects = layerSubjects(layer.id);
  if (subjects.length === 0) return fail(`'${layer.id}' has no subject yet: select_subject first.`);
  const subject = a.subject ?? activeSubjectId(layer.id);
  if (!subjects.some((s) => s.id === subject)) return fail(`No subject '${subject}' on '${layer.id}'. Subjects: ${subjects.map((s) => s.id).join(', ')}.`);
  if (subjectLocked(layer.id, subject)) return fail(`Subject '${subject}' is frozen (locked). Unfreeze it in the Subjects panel first.`);
  const time = timeArg(ctx, a.time);
  const edits: SubjectEditRequest[] = [];
  const add = pointsOf(a.add, f, 'all');
  const sub = pointsOf(a.subtract, f, 'all');
  if (add.length) edits.push({ tool: 'segment', op: 'add', clicks: add, negatives: sub });
  if (sub.length) edits.push({ tool: 'segment', op: 'subtract', clicks: sub });
  // Brush radius is footage px; the layer's box may be scaled.
  const radiusScale = f.box.width / f.source.width;
  for (const s of a.strokes ?? []) {
    const pts = (s.points ?? []).filter((p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1])).map((p) => f.toLocal({ x: p[0]!, y: p[1]! }));
    if (pts.length === 0) continue;
    edits.push({ tool: s.tool === 'refine' ? 'refine' : 'paint', op: s.op === 'subtract' ? 'subtract' : 'add', strokes: [pts], radius: Math.max(0.5, (s.radius ?? 12) * radiusScale) });
  }
  const edge: Partial<SubjectEdge> = {};
  if (a.edge) {
    if (isNum(a.edge.feather)) edge.feather = Math.max(0, Math.min(200, a.edge.feather));
    if (isNum(a.edge.choke)) edge.choke = Math.max(-100, Math.min(100, a.edge.choke));
    if (isNum(a.edge.contrast)) edge.contrast = Math.max(0, Math.min(100, a.edge.contrast));
    if (isNum(a.edge.smooth)) edge.smooth = Math.max(0, Math.min(100, a.edge.smooth));
    if (typeof a.edge.invert === 'boolean') edge.invert = a.edge.invert;
  }
  if (edits.length === 0 && Object.keys(edge).length === 0) return fail('Nothing to refine: give `add` / `subtract` points, `strokes`, or `edge` settings.');
  let last: { coverage: number; outline: number[] } | null = null;
  let applied = 0;
  try {
    for (const e of edits) {
      const r = await runSubjectEdit(layer.id, time, e, subject, { applyResult: turnApplier(ctx) });
      if (r) { last = r; applied++; }
    }
  } catch (err) {
    return fail(`Object Matte failed after ${applied} edit(s): ${engineMessage(err)}`);
  }
  let edgeNote = '';
  if (Object.keys(edge).length) {
    await documentMirror().loadTree(layer.id);
    const cmds = updateSubjectCommands(layer.id, subject, edge);
    if (cmds.length) {
      await ctx.engine.apply(cmds);
      edgeNote = ` Edge: ${Object.entries(edge).map(([k, v]) => `${k} ${v}`).join(', ')} (every frame).`;
    }
  }
  const bounds = last ? outlineBounds(last.outline, f) : null;
  const view = last ? await subjectView(ctx, layer.id, time, [{ label: subject, points: last.outline }]) : null;
  const tracked = isTracked((await fetchSubjectTracks(layer.id)).find((s) => s.subject === subject)?.frames ?? [], settingsFps(documentMirror().comp(activeCompRootId())?.settings));
  return ok(
    `Refined subject '${subject}' on '${layer.id}' at ${time.toFixed(2)}s: ${applied} edit(s) applied` +
      (last ? `, now ${Math.round(last.coverage * 1000) / 10}% of the frame${bounds ? `, bounds x ${bounds.x} y ${bounds.y} ${bounds.w}×${bounds.h}` : ''}` : '') +
      `.${edgeNote}` +
      (tracked && applied ? ' This frame is now a fix; the editor re-tracks the frames around it automatically.' : ''),
    { layerId: layer.id, subject, time, applied, coverage: last?.coverage ?? null, bounds, edge, ...(view ? { view } : {}) },
  );
};

interface FollowSubjectInput { layerId: string; subject?: string; startSec?: number; endSec?: number; originSec?: number; wait?: boolean }

const followSubject: AiTool['handler'] = async (input, ctx) => {
  const a = input as FollowSubjectInput;
  const layer = await footageLayer(ctx, a.layerId);
  if ('error' in layer) return fail(layer.error);
  const subjects = layerSubjects(layer.id);
  if (subjects.length === 0) return fail(`'${layer.id}' has no subject yet: select_subject first.`);
  const subject = a.subject ?? activeSubjectId(layer.id);
  if (!subjects.some((s) => s.id === subject)) return fail(`No subject '${subject}' on '${layer.id}'. Subjects: ${subjects.map((s) => s.id).join(', ')}.`);
  if (subjectLocked(layer.id, subject)) return fail(`Subject '${subject}' is frozen (locked).`);
  const frames = (await fetchSubjectTracks(layer.id)).find((s) => s.subject === subject)?.frames ?? [];
  if (frames.length === 0) return fail(`Subject '${subject}' has no selection on any frame yet: select_subject first.`);
  const settings = documentMirror().comp(activeCompRootId())?.settings;
  const fps = settingsFps(settings);
  const wa = settingsSetWorkArea(settings);
  const start = isNum(a.startSec) ? Math.max(0, a.startSec) : wa ? wa.start : 0;
  const end = isNum(a.endSec) ? a.endSec : wa ? wa.end : settingsDurationSeconds(settings);
  if (!(end > start)) return fail(`endSec (${end}) must be after startSec (${start}).`);
  // From the frame it was selected on, by default: the playhead if that frame is a fix, else the nearest fix.
  const playhead = ctx.comp.playhead();
  const half = 0.5 / Math.max(1, fps);
  const origin = isNum(a.originSec)
    ? a.originSec
    : frames.some((fr) => fr.fix && Math.abs(fr.time - playhead) <= half)
      ? playhead
      : (frames.filter((fr) => fr.fix).sort((p, q) => Math.abs(p.time - playhead) - Math.abs(q.time - playhead))[0] ?? frames[0]!).time;
  if (uiKindOf(documentMirror().layer(layer.id)) !== 'video') {
    return ok(`'${layer.id}' is a still image: its subject holds on every frame already; nothing to follow.`, { layerId: layer.id, subject, still: true });
  }
  const store = useRotoBrushStore.getState();
  let cancelled = false;
  const job = newAiJob('follow_subject', `Following subject ${subject} of ${layer.id}`, () => { cancelled = true; });
  const ui = uiJobs();
  ui.start(job.id, 'Following the subject', job.cancel);
  const run = (async (): Promise<void> => {
    try {
      // Waited for: the result lands in this turn's gesture. Left running: the
      // turn ends first, and the engine applies it as its own entry when no
      // gesture is open (an open begin_edit group holds it until end_edit).
      const r = await propagateObjectMatte(layer.id, store.strokes, {
        origin, start, end, fps, direction: 'both', featherPx: store.featherPx, refine: store.refine, box: store.box, subject,
        ...(a.wait === true ? { applyResult: turnApplier(ctx) } : {}),
      }, (f) => {
        job.progress = f;
        ui.progress(job.id, f);
        return !cancelled && !ctx.signal.aborted;
      });
      if (r.status === 'cancelled') {
        finishAiJob(job, 'cancelled', 'Following cancelled');
        ui.finish(job.id, 'cancelled', 'Following cancelled');
      } else {
        finishAiJob(job, 'done', `Subject followed over ${r.frames} frames`, { frames: r.frames, start, end, origin });
        ui.finish(job.id, 'done', `Subject followed over ${r.frames} frames`);
      }
    } catch (err) {
      const message = engineMessage(err);
      finishAiJob(job, 'failed', message);
      ui.finish(job.id, 'failed', message);
    }
  })();
  const range = `${start.toFixed(2)}–${end.toFixed(2)}s from ${origin.toFixed(2)}s`;
  if (a.wait === true) {
    await run;
    if (job.status === 'done') return ok(`Followed subject '${subject}' of '${layer.id}' over ${range}: ${(job.result as { frames: number }).frames} frames. Its styles and Behind Subject now hold on every frame.`, { jobId: job.id, status: job.status, ...(job.result as object) });
    return fail(`Following subject '${subject}' ${job.status}: ${job.message ?? ''}`);
  }
  return ok(`Following subject '${subject}' of '${layer.id}' over ${range} (job ${job.id}, the Tasks panel shows it). Poll get_job_status { jobId: "${job.id}" }; other edits may continue meanwhile.`, { jobId: job.id, status: 'running', start, end, origin });
};

const BACKGROUND_STYLES = new Set(['background_blur', 'remove_background', 'keep_background']);

const applySubjectStyle: AiTool['handler'] = async (input, ctx) => {
  const a = input as { layerId: string; style: string; subject?: string; image?: string; fit?: 'fill' | 'fit' | 'stretch' };
  const layer = await footageLayer(ctx, a.layerId);
  if ('error' in layer) return fail(layer.error);
  // The layer's subjects and effects are read from its tree: loaded, whether or not the editor shows the layer.
  await documentMirror().loadTree(layer.id);
  const subjects = layerSubjects(layer.id);
  if (subjects.length === 0) return fail(`'${layer.id}' has no subject yet: select_subject first (then follow_subject on video).`);
  const subject = a.subject ?? activeSubjectId(layer.id);
  if (!subjects.some((s) => s.id === subject)) return fail(`No subject '${subject}' on '${layer.id}'. Subjects: ${subjects.map((s) => s.id).join(', ')}.`);
  const style = String(a.style ?? '');
  if (style === 'remove_background' || style === 'keep_background') {
    const card = objectMatteCard(layer.id);
    if (!card) return fail(`'${layer.id}' has no Object Matte effect yet (select_subject makes one).`);
    const remove = style === 'remove_background';
    await ctx.engine.apply([{ type: 'setGroupEnabled', groups: [{ layer: layer.id, path: `effects/${card.id}` }], enabled: remove } as Command]);
    return ok(remove
      ? `Background removed on '${layer.id}': the layer is cut to its subject(s) (the Object Matte effect is on). apply_subject_style { style: "keep_background" } restores it.`
      : `Background kept on '${layer.id}': the whole picture shows again (the Object Matte effect is off).`, { layerId: layer.id, cuts: remove });
  }
  const port = subjectPort();
  if (!port) return fail('Subject styles are not available in this editor.');
  const id = style === 'background_blur' ? 'portrait' : style;
  const info = port.styles().find((s) => s.id === id);
  if (!info) return fail(`Unknown style '${style}'. Styles: ${[...port.styles().map((s) => s.id), ...BACKGROUND_STYLES].join(', ')}.`);
  if (id === 'bgImage') {
    const item = a.image ? documentMirror().items.get(a.image) : undefined;
    if (!a.image) return fail('bgImage needs `image`: an image item id from list_assets.');
    if (item?.kind !== 'footage' || item.mediaType !== 'image') return fail(`'${a.image}' is not an image in the project (list_assets lists them).`);
  }
  const cmds = port.styleCommands(layer.id, subjects.length > 1 ? subject : null, id, { ...(a.image ? { image: a.image } : {}), ...(a.fit ? { fit: a.fit } : {}) });
  if (cmds.length === 0) return fail(`Style '${style}' produced no effects.`);
  await ctx.engine.apply(cmds);
  const effects = cmds.filter((c) => c.type === 'addEffect').map((c) => (c as { id?: string }).id).filter(Boolean);
  const video = uiKindOf(documentMirror().layer(layer.id)) === 'video';
  const tracked = !video || isTracked((await fetchSubjectTracks(layer.id)).find((s) => s.subject === subject)?.frames ?? [], settingsFps(documentMirror().comp(activeCompRootId())?.settings));
  return ok(
    `Applied "${info.label}" (${info.hint}) to subject '${subject}' of '${layer.id}': ${effects.length} effect(s) ${effects.join(', ')}, each reading that subject (editable with update_effect_param).` +
      (tracked ? '' : ' The subject is selected on one frame only — follow_subject so the style holds as it moves.'),
    { layerId: layer.id, subject, style: id, effectIds: effects },
  );
};

// ── Point tracking ─────────────────────────────────────────────────────

interface TrackSample { compTime: number; x: number; y: number; confidence: number; coasted: boolean }
interface HeldTrack {
  id: string;
  layer: string;
  tracks: TrackSample[][];
  sourceWidth: number;
  sourceHeight: number;
  status: string;
}

/** track_point results this session, for attach_to_track. */
export const HELD_TRACKS = new Map<string, HeldTrack>();
let trackSeq = 0;

type EngineSample = [number, number, number, number, number];
interface TrackSummary {
  status: 'completed' | 'lost' | 'partial';
  sourceWidth: number;
  sourceHeight: number;
  tracks: EngineSample[][];
  plan?: { x: number; y: number; featureHalf: number; searchHalf: number; motionPerFrame: number | null; companion: { x: number; y: number } | null };
}

const trackPoint: AiTool['handler'] = async (input, ctx) => {
  const a = input as { layerId: string; point: Pt; radius?: number; startSec?: number; endSec?: number; originSec?: number };
  const layer = await footageLayer(ctx, a.layerId);
  if ('error' in layer) return fail(layer.error);
  if (uiKindOf(documentMirror().layer(layer.id)) !== 'video') return fail(`'${layer.id}' is a still: nothing moves to track.`);
  if (!a.point || !isNum(a.point.x) || !isNum(a.point.y)) return fail('Give `point` { x, y } in footage px from the top-left.');
  const info = documentMirror().layer(layer.id);
  const settings = documentMirror().comp(activeCompRootId())?.settings;
  const fps = settingsFps(settings);
  const inPoint = info ? Math.max(0, flicksToSeconds(info.timing.inPoint)) : 0;
  const outPoint = info ? flicksToSeconds(info.timing.outPoint) : settingsDurationSeconds(settings);
  const start = isNum(a.startSec) ? Math.max(0, a.startSec) : inPoint;
  const end = isNum(a.endSec) ? a.endSec : outPoint;
  if (!(end > start)) return fail(`endSec (${end}) must be after startSec (${start}).`);
  const origin = Math.max(start, Math.min(end, timeArg(ctx, a.originSec)));
  const radius = isNum(a.radius) ? Math.max(4, Math.round(a.radius)) : 0;
  let handle;
  try {
    handle = requireEngineJob(await startEngineJob<TrackSummary>({
      kind: 'trackMotion',
      value: {
        layer: layer.id,
        kind: 'position',
        points: [{
          feature: { x: a.point.x, y: a.point.y, width: radius > 0 ? 2 * radius + 1 : 0, height: radius > 0 ? 2 * radius + 1 : 0 },
          search: { x: a.point.x, y: a.point.y, width: 0, height: 0 },
          attach: { x: 0, y: 0 },
        }],
        autoFeature: true,
        excludeMasks: [],
        range: { start: secondsToFlicks(start), duration: secondsToFlicks(Math.max(1 / fps, end - start)) },
        direction: 'both',
        origin: secondsToFlicks(origin),
        stabilize: false,
      },
    // Held, then applied through the turn (the tracker it saves on the layer lands in this undo step).
    }, { apply: false }), 'Tracking');
  } catch (err) {
    return fail(`Tracking could not start: ${engineMessage(err)}`);
  }
  const onAbort = (): void => handle.cancel();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const out = await handle.done;
  ctx.signal.removeEventListener('abort', onAbort);
  const res = out.result;
  if (out.status !== 'done' || !res) return fail(out.status === 'cancelled' ? 'Tracking was cancelled.' : `Tracking failed: ${out.error?.message ?? 'no result'}`);
  try {
    await turnApplier(ctx)(out.job.id);
  } catch (err) {
    return fail(`Tracked, but the tracker could not be saved on the layer: ${engineMessage(err)}`);
  }
  const tracks: TrackSample[][] = res.tracks.map((t) => t.map(([compTime, x, y, confidence, coasted]) => ({ compTime, x, y, confidence, coasted: coasted === 1 })));
  const primary = tracks[0] ?? [];
  if (primary.length < 2) return fail(`The feature at (${a.point.x}, ${a.point.y}) was lost immediately — pick a steadier, higher-contrast detail (a corner, a logo edge), or give a \`radius\` round it.`);
  const id = `track_${(++trackSeq).toString(36)}`;
  HELD_TRACKS.set(id, { id, layer: layer.id, tracks: tracks.filter((t) => t.length >= 2), sourceWidth: res.sourceWidth, sourceHeight: res.sourceHeight, status: res.status });
  const first = primary[0]!, last = primary[primary.length - 1]!;
  const coasted = primary.filter((s) => s.coasted).length;
  const lowest = Math.min(...primary.map((s) => s.confidence));
  return ok(
    `Tracked ${id} on '${layer.id}': ${primary.length} frames ${first.compTime.toFixed(2)}–${last.compTime.toFixed(2)}s (${res.status}${coasted ? `, ${coasted} predicted through occlusion` : ''}), ` +
      `from (${r1(first.x)}, ${r1(first.y)}) to (${r1(last.x)}, ${r1(last.y)}) footage px${tracks.length > 1 ? ', with a companion feature for rotation / scale' : ''}; lowest confidence ${lowest.toFixed(2)}. ` +
      `Now attach_to_track { trackId: "${id}", mode: "createNull" } (then parent layers to the null), or "follow" / "transform" onto a layer.`,
    { trackId: id, layerId: layer.id, frames: primary.length, status: res.status, start: first, end: last, companion: tracks.length > 1, plan: res.plan ?? null },
  );
};

interface TrackApplySummary { mode: TrackApplyMode; keyframes: number; nullIds: string[] }

const attachToTrack: AiTool['handler'] = async (input, ctx) => {
  const a = input as { trackId: string; mode: 'follow' | 'transform' | 'createNull' | 'stabilize' | 'effectPoint'; targetId?: string; effectPath?: string };
  const held = HELD_TRACKS.get(String(a.trackId ?? ''));
  if (!held) return fail(`No track '${a.trackId}' in this session. Tracks: ${[...HELD_TRACKS.keys()].join(', ') || 'none'} — run track_point first.`);
  if (!(await ctx.scene.has(held.layer))) return fail(`The tracked layer '${held.layer}' no longer exists.`);
  const series: TrackSeries[] = held.tracks.map((t) => ({ samples: t.map((s) => ({ time: secondsToFlicks(s.compTime), x: s.x, y: s.y, confidence: s.confidence, coasted: s.coasted })) }));
  let mode: TrackApplyMode;
  let target: string | undefined;
  let targetPath: string | undefined;
  let nullMode: TrackApplyMode | undefined;
  switch (a.mode) {
    case 'createNull':
      mode = 'createNull';
      nullMode = held.tracks.length > 1 ? 'transform' : 'follow';
      break;
    case 'stabilize':
      mode = 'stabilize';
      break;
    case 'follow':
    case 'transform':
    case 'effectPoint': {
      target = resolveAlias(ctx, String(a.targetId ?? ''));
      if (!target || !(await ctx.scene.has(target))) return fail(`mode "${a.mode}" needs \`targetId\`, the layer that receives the keys (${(await ctx.scene.nearest(target)).join(', ') || 'describe_scene'}).`);
      if (target === held.layer) return fail('Applying a track to the footage itself moves the footage under its own track. Use mode "createNull" and parent layers to the null, or "stabilize".');
      if (a.mode === 'transform' && held.tracks.length < 2) return fail('mode "transform" needs the companion feature, which this track lacks; use "follow".');
      mode = a.mode === 'transform' ? 'transform' : 'follow';
      if (a.mode === 'effectPoint') {
        if (!a.effectPath || !/^effects\/[^/]+\/[^/]+$/.test(a.effectPath)) return fail('mode "effectPoint" needs `effectPath` "effects/<effectId>/<param>" on the target.');
        targetPath = a.effectPath;
      }
      break;
    }
    default:
      return fail(`Unknown mode '${String(a.mode)}'.`);
  }
  let out;
  try {
    out = await runEngineJob<TrackApplySummary>({
      kind: 'trackApply',
      value: {
        layer: held.layer,
        mode,
        tracks: series,
        sourceWidth: held.sourceWidth,
        sourceHeight: held.sourceHeight,
        ...(target ? { target } : {}),
        ...(nullMode ? { nullMode } : {}),
        ...(targetPath ? { targetPath } : {}),
      },
    // Held, then applied through the turn: inside the turn's gesture, one undo step.
    }, { apply: false });
  } catch (err) {
    return fail(`Apply failed: ${engineMessage(err)}`);
  }
  if (!out) return fail('This engine does not apply tracks.');
  if (out.status !== 'done') return fail(`Apply ${out.status}: ${out.error?.message ?? ''}`);
  try {
    await turnApplier(ctx)(out.job.id);
  } catch (err) {
    return fail(`The track was planned but could not be written: ${engineMessage(err)}`);
  }
  const s = out.result;
  const nullId = s?.nullIds?.[0];
  if (nullId) {
    try { useSelectionStore.getState().set([nullId]); } catch { /* headless */ }
  }
  const what = a.mode === 'createNull'
    ? `a "Tracked Null" ${nullId ?? ''} carries the motion (${s?.keyframes ?? 0} keys) — reparent_layer layers to it`
    : a.mode === 'stabilize'
      ? `'${held.layer}' is stabilized against the motion (${s?.keyframes ?? 0} position keys)`
      : `${s?.keyframes ?? 0} keys written on '${target}'${targetPath ? ` (${targetPath})` : ''}`;
  return ok(`Applied ${held.id} as ${a.mode}: ${what}. One undo step.`, { trackId: held.id, mode: a.mode, keyframes: s?.keyframes ?? 0, nullIds: s?.nullIds ?? [], targetId: target ?? null });
};

// ── Transcription ──────────────────────────────────────────────────────

const transcribe: AiTool['handler'] = async (input, ctx) => {
  const a = input as { startSec?: number; endSec?: number; language?: string; createCaptions?: boolean; maxWords?: number };
  if (!transcriptionAvailable()) return fail('Transcription runs in the desktop app\'s engine, which this build does not have.');
  const root = activeCompRootId();
  const settings = documentMirror().comp(root)?.settings;
  const duration = settingsDurationSeconds(settings);
  const startSec = isNum(a.startSec) ? Math.max(0, a.startSec) : 0;
  const endSec = isNum(a.endSec) ? Math.min(duration, a.endSec) : duration;
  if (!(endSec > startSec)) return fail(`The range ${startSec}–${endSec}s is empty.`);
  const job = newAiJob('transcribe', `Transcribing ${startSec.toFixed(1)}–${endSec.toFixed(1)}s`, () => undefined);
  const ui = uiJobs();
  ui.start(job.id, 'Transcribing', job.cancel);
  let t;
  try {
    t = await transcribeCompositionDetailed({
      startSec, endSec, rootId: root,
      ...(a.language ? { language: a.language } : {}),
      onStart: (h) => {
        job.cancel = () => h.cancel();
        if (ctx.signal.aborted) h.cancel();
        else ctx.signal.addEventListener('abort', () => h.cancel(), { once: true });
      },
    });
  } catch (err) {
    const message = err instanceof TranscribeError ? `${err.message} (${err.code})` : engineMessage(err);
    finishAiJob(job, err instanceof TranscribeError && err.code === 'cancelled' ? 'cancelled' : 'failed', message);
    ui.finish(job.id, job.status === 'cancelled' ? 'cancelled' : 'failed', message);
    return fail(`Transcription failed: ${message}`);
  }
  const maxWords = Math.max(0, Math.min(4000, Math.round(a.maxWords ?? 600)));
  const words = t.words.slice(0, maxWords).map((w) => ({ t: r1(w.start), end: r1(w.end), text: w.text }));
  const cues = t.cues.slice(0, 400).map((c) => ({ start: r1(c.start), end: r1(c.end), text: c.text }));
  let captions = '';
  let added: string[] = [];
  if (a.createCaptions === true && t.cues.length > 0) {
    const m = documentMirror();
    const existing = (m.comp(root)?.layers ?? []).filter((id) => m.layer(id)?.caption === true);
    const plan = captionReplaceCommands(t.cues, { rootId: root, width: settings?.width ?? 1920, height: settings?.height ?? 1080 }, existing);
    if (plan.commands.length) {
      const res = await ctx.engine.apply(plan.commands);
      added = ((res.at(-1) as { layers?: string[] } | undefined)?.layers ?? []);
      captions = ` Captions: ${plan.added} text layer(s) added${plan.removed ? `, ${plan.removed} old caption(s) replaced` : ''}${plan.skipped ? `, ${plan.skipped} cue(s) skipped` : ''} (ids ${added.slice(0, 12).join(', ')}${added.length > 12 ? '…' : ''}).`;
    }
  }
  const summary = { cues: t.cues.length, words: t.words.length, startSec, endSec };
  finishAiJob(job, 'done', `${t.cues.length} cues, ${t.words.length} words`, summary);
  ui.finish(job.id, 'done', `${t.cues.length} cues, ${t.words.length} words`);
  const text = t.cues.map((c) => c.text).join(' ');
  return ok(
    `Transcribed ${startSec.toFixed(2)}–${endSec.toFixed(2)}s: ${t.cues.length} cue(s), ${t.words.length} word timing(s)${t.words.length === 0 ? ' (the provider gave none; cues only)' : ''}.${captions}\n` +
      `Text: ${text.slice(0, 2000)}${text.length > 2000 ? '…' : ''}`,
    { ...summary, text, cues, words: words.map((w) => [w.t, w.end, w.text]), wordsTruncated: t.words.length > words.length, captionIds: added },
  );
};

// ── Jobs ───────────────────────────────────────────────────────────────

const getJobStatus: AiTool['handler'] = async (input) => {
  const a = input as { jobId?: string; cancel?: boolean };
  if (a.jobId) {
    const j = AI_JOBS.get(a.jobId);
    if (!j) return fail(`No job '${a.jobId}'. Jobs this session: ${[...AI_JOBS.keys()].join(', ') || 'none'}.`);
    if (a.cancel === true && j.status === 'running') {
      j.cancel();
      return ok(`Cancelling ${j.id}; poll again for its final state.`, { id: j.id, status: j.status });
    }
    return ok(jobLine(j), { id: j.id, kind: j.kind, status: j.status, progress: j.progress, message: j.message ?? null, result: j.result ?? null });
  }
  const all = [...AI_JOBS.values()];
  if (all.length === 0) return ok('No background jobs this session.', { jobs: [] });
  return ok(all.map(jobLine).join('\n'), { jobs: all.map((j) => ({ id: j.id, kind: j.kind, status: j.status, progress: j.progress, message: j.message ?? null })) });
};

// ── Editor context ─────────────────────────────────────────────────────

const getEditorContext: AiTool['handler'] = async (_input, ctx) => {
  const m = documentMirror();
  const root = activeCompRootId();
  const settings = m.comp(root)?.settings;
  const fps = settingsFps(settings);
  const playhead = ctx.comp.playhead();
  const wa = settingsSetWorkArea(settings);
  const selection = ctx.scene.selection();
  const layers = await Promise.all(selection.map(async (id) => {
    const n = await ctx.scene.get(id);
    return { id, name: n?.name ?? id, kind: n?.kind ?? 'unknown' };
  }));
  let properties: Array<{ nodeId: string; prop: string }> = [];
  let keyframes = 0;
  let tool = 'select';
  try { properties = [...usePropertySelectionStore.getState().entries]; } catch { /* headless */ }
  try { keyframes = useKeyframeSelectionStore.getState().ids.size; } catch { /* headless */ }
  try { tool = useUIStore.getState().activeTool; } catch { /* headless */ }
  const subjects = selection
    .map((id) => ({ layerId: id, subjects: layerSubjects(id) }))
    .filter((s) => s.subjects.length > 0)
    .map((s) => ({ layerId: s.layerId, active: activeSubjectId(s.layerId), subjects: s.subjects.map((x) => ({ id: x.id, name: x.name, locked: x.locked === true })) }));
  const jobs = [...AI_JOBS.values()].filter((j) => j.status === 'running').map((j) => j.id);
  const payload = {
    composition: { id: root, name: settings?.name ?? root, width: settings?.width, height: settings?.height, fps, durationSeconds: settingsDurationSeconds(settings) },
    playhead: { seconds: r1(playhead), frame: Math.round(playhead * fps) },
    workArea: wa ? { startSec: r1(wa.start), endSec: r1(wa.end) } : null,
    selectedLayers: layers,
    selectedProperties: properties,
    selectedKeyframes: keyframes,
    subjects,
    activeTool: tool,
    runningJobs: jobs,
  };
  const lines = [
    `Composition "${payload.composition.name}" (${root}) ${settings?.width}×${settings?.height} @ ${fps} fps, ${payload.composition.durationSeconds}s.`,
    `Playhead ${payload.playhead.seconds}s (frame ${payload.playhead.frame}).${wa ? ` Work area ${payload.workArea!.startSec}–${payload.workArea!.endSec}s.` : ' No work area set.'}`,
    layers.length ? `Selected layers: ${layers.map((l) => `${l.id} "${l.name}" (${l.kind})`).join(', ')}.` : 'No layer selected.',
    properties.length ? `Selected properties: ${properties.map((p) => `${p.nodeId}.${p.prop}`).join(', ')}.` : '',
    keyframes ? `${keyframes} keyframe(s) selected in the timeline.` : '',
    subjects.length ? `Subjects on the selection: ${subjects.map((s) => `${s.layerId}: ${s.subjects.map((x) => `${x.id} "${x.name}"${x.id === s.active ? ' (active)' : ''}`).join(', ')}`).join('; ')}.` : '',
    `Active tool: ${tool}.`,
    jobs.length ? `Running jobs: ${jobs.join(', ')} (get_job_status).` : '',
  ].filter(Boolean);
  return ok(lines.join('\n'), payload);
};

// ── Assets ─────────────────────────────────────────────────────────────

/** What describe_asset found, and what the MCP host needs to draw the contact sheet. */
export interface AssetDescription {
  assetId: string;
  itemId: string | null;
  name: string;
  type: string;
  width: number | null;
  height: number | null;
  durationSec: number;
  fps: number | null;
  codec: string | null;
  container: string | null;
  hasAudio: boolean | null;
  audioChannels: number | null;
  hasAlpha: boolean | null;
  fileBytes: number | null;
  missing: boolean;
  usedBy: Array<{ id: string; name: string }>;
  cells: number;
}

const describeAsset: AiTool['handler'] = async (input) => {
  const a = input as { assetId: string; cells?: number };
  const assetId = String(a.assetId ?? '');
  let assets: ReturnType<typeof useAssetStore.getState>['assets'] = [];
  try { assets = useAssetStore.getState().assets; } catch { /* headless */ }
  const asset = assets.find((x) => x.id === assetId);
  const m = documentMirror();
  const item = m.item(assetId);
  if (!asset && !item) {
    const avail = assets.map((x) => x.id).join(', ') || '(none imported)';
    return fail(`No imported asset '${assetId}'. Call list_assets first. Available ids: ${avail}.`);
  }
  const meta = asset?.metadata;
  const rate = item?.frameRate && item.frameRate.den > 0 ? item.frameRate.num / item.frameRate.den : null;
  const durationSec = item && item.duration > 0 ? flicksToSeconds(item.duration) : meta?.duration ?? 0;
  const type = asset?.type ?? (item?.mediaType === 'video' ? 'video' : item?.mediaType === 'audio' ? 'audio' : 'image');
  const usedBy = layersUsingItem(assetId).map((id) => ({ id, name: m.layer(id)?.name ?? id }));
  const d: AssetDescription = {
    assetId,
    itemId: item ? item.id : null,
    name: asset?.name ?? item?.name ?? assetId,
    type,
    width: item?.width || meta?.width || null,
    height: item?.height || meta?.height || null,
    durationSec,
    fps: rate ?? meta?.fps ?? null,
    codec: item?.codec || meta?.codec || null,
    container: meta?.container ?? null,
    hasAudio: item ? item.hasAudio : meta?.hasAudioTrack ?? null,
    audioChannels: item?.audioChannels || meta?.audioChannels || null,
    hasAlpha: item ? item.hasAlpha : meta?.hasAlpha ?? null,
    fileBytes: item?.fileBytes ? Number(item.fileBytes) : asset?.size ?? null,
    missing: item?.missing === true,
    usedBy,
    cells: Math.max(1, Math.min(12, Math.round(a.cells ?? 6))),
  };
  const mb = d.fileBytes ? `${(d.fileBytes / 1048576).toFixed(1)} MB` : 'size unknown';
  const lines = [
    `${d.name} (${assetId}): ${d.type}${d.width && d.height ? ` ${d.width}×${d.height}` : ''}${d.durationSec > 0 ? `, ${d.durationSec.toFixed(2)}s` : ''}${d.fps ? ` @ ${r1(d.fps)} fps` : ''}, ${mb}${d.missing ? ' — FILE MISSING' : ''}.`,
    d.codec || d.container ? `Codec ${d.codec ?? '?'}${d.container ? ` in ${d.container}` : ''}.` : 'Codec not probed.',
    d.type !== 'image' ? `Audio: ${d.hasAudio === null ? 'not probed' : d.hasAudio ? `yes${d.audioChannels ? `, ${d.audioChannels} ch` : ''}` : 'none'}.` : '',
    d.type !== 'audio' ? `Alpha: ${d.hasAlpha === null ? 'not probed' : d.hasAlpha ? 'yes' : 'no'}.` : '',
    usedBy.length ? `Used by ${usedBy.map((u) => `${u.id} "${u.name}"`).join(', ')}.` : 'Not placed in any composition yet (create_media places it).',
  ].filter(Boolean);
  return ok(lines.join('\n'), d);
};

export const MEDIA_HANDLERS: Record<string, AiTool['handler']> = {
  find_subjects: findSubjects,
  select_subject: selectSubject,
  refine_subject: refineSubject,
  follow_subject: followSubject,
  apply_subject_style: applySubjectStyle,
  track_point: trackPoint,
  attach_to_track: attachToTrack,
  transcribe,
  get_job_status: getJobStatus,
  get_editor_context: getEditorContext,
  describe_asset: describeAsset,
};

/** The subject styles for list_capabilities (the port's presets plus the background switches). */
export function subjectStyleCatalog(): Array<{ id: string; label: string; hint: string; kind: string }> {
  const port = subjectPort();
  return [
    ...(port?.styles() ?? []),
    { id: 'background_blur', label: 'Background Blur', hint: 'The background blurred, the subject sharp (same as "portrait")', kind: 'background' },
    { id: 'remove_background', label: 'Remove Background', hint: 'Cut the layer to its subject (the Object Matte effect on)', kind: 'background' },
    { id: 'keep_background', label: 'Keep Background', hint: 'Show the whole picture again', kind: 'background' },
  ];
}
