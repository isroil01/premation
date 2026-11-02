/**
 * Roto Brush TOOL glue — turns the strokes painted on the viewport
 * (`rotoBrushStore`) into a matte on the layer, and hands "propagate
 * forward" to the engine.
 *
 * Both halves are ENGINE jobs (docs/TS_ENGINE_REMOVAL.md phase 4; the page
 * segmenter and propagator that ran on the TypeScript engine are gone):
 *
 *   segment     the `objectMatte` job — SAM on the real frame, the strokes'
 *               points as foreground / background prompts — written as the
 *               tool's "Roto Brush" Add mask, replacing the tool's previous
 *               outline in the same history entry.
 *   propagate   the `rotoBrush` job, started from the tool's SAM outline and
 *               re-seeded from every stroke's points as they ride the flow.
 *
 * ## Spaces
 *
 *   stroke points   layer-local px, centre origin (the mask path's space)
 *   job prompts     layer px, top-left origin (the footage's display size)
 */

import { secondsToFlicks } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { applyEngineJob, previewEngineJob, requireEngineJob, runEngineJob, startEngineJob } from '@core/engine/engineJobs';
import { documentMirror } from '@stores/documentMirror';
import { mirrorMaskHeaders } from '@core/mirror/effects';
import { plainValue } from '@core/mirror/trackIndex';
import type { RotoBox, RotoStroke } from '@stores/rotoBrushStore';
import { edit } from '@core/engine/uiEdits';
import { paths } from '@core/engine/propRefs';
import { objectMatteBake } from './objectMatteEffect';
import { FIRST_SUBJECT, subjectLocked, subjectOfOutline, subjectOutlineName } from './subjects';
import { t } from '@core/i18n';

/** The name every path this tool writes carries, so a re-segment replaces it. */
export const ROTO_PATH_NAME = 'Roto Brush';

/**
 * The name a FROZEN matte carries. After Effects' Freeze locks the Roto Brush
 * result so nothing recomputes it. Here the matte is a mask the tool finds by
 * name and REPLACES on every new stroke — which would throw away a propagated
 * matte (a path key per frame). Freezing renames it, so the tool no longer
 * owns it, and the tool refuses to segment or propagate on that layer until it
 * is unfrozen. The state is the document's own (the mask's name): it is saved
 * with the project and undo takes it back.
 */
export const ROTO_FROZEN_NAME = 'Roto Brush (Frozen)';

/** Why an edit is refused on a frozen layer: the subject, or the classic Roto Brush matte. */
function frozenMessage(nodeId: string): string {
  return rotoMattes(nodeId).subjectFrozen.length > 0
    ? t('workspace.subjects.frozenMessage', 'The subject is frozen. Unfreeze it (Properties ▸ Subject, or Freeze on the options bar) to change it.')
    : t('workspace.rotoBrush.frozenMessage', 'Roto Brush is frozen on this layer. Unfreeze it to change the matte.');
}

/** An edit of `subject` is refused while it is locked, or while the layer's classic Roto Brush matte is frozen. */
function refuseLocked(nodeId: string, subject: string): void {
  if (rotoMattes(nodeId).frozen.length > 0) throw new Error(frozenMessage(nodeId));
  if (subjectLocked(nodeId, subject)) {
    throw new Error(t('workspace.subjects.lockedMessage', 'This subject is locked. Unlock it in Properties ▸ Subjects to change it.'));
  }
}

/** The name of the first subject's outline (the "Object Matte" mask the subject edits and Follow write). */
export const SUBJECT_OUTLINE_NAME = 'Object Matte';

/**
 * The layer's roto mattes by state (mask ids). `subject` / `subjectFrozen`:
 * the subject's outline, frozen when it is locked — a subject's matte is the
 * stored picture, not the mask, so Freeze locks the outline rather than
 * renaming it (every edit and propagation refuses while it is locked).
 */
export function rotoMattes(nodeId: string): { live: string[]; frozen: string[]; subject: string[]; subjectFrozen: string[] } {
  const out = { live: [] as string[], frozen: [] as string[], subject: [] as string[], subjectFrozen: [] as string[] };
  const tree = documentMirror().tree(nodeId);
  for (const m of mirrorMaskHeaders(tree)) {
    if (m.name === ROTO_PATH_NAME) out.live.push(m.id);
    else if (m.name === ROTO_FROZEN_NAME) out.frozen.push(m.id);
    else if (subjectOfOutline(m.name) !== null) {
      const locked = plainValue(tree?.nodes.get(`masks/${m.id}/locked`)?.value) === true;
      (locked ? out.subjectFrozen : out.subject).push(m.id);
    }
  }
  return out;
}

export function isRotoFrozen(nodeId: string): boolean {
  const r = rotoMattes(nodeId);
  return r.frozen.length > 0 || r.subjectFrozen.length > 0;
}

/**
 * The engine edit that freezes / unfreezes the layer's Roto Brush matte: a
 * label and the commands, so the UI sends them itself (B3: UI code sends
 * engine commands rather than calling a helper that writes for it). Empty
 * `commands` when there is nothing to change.
 */
export function rotoFreezeEdit(
  nodeId: string,
  frozen: boolean,
): { label: string; commands: Extract<Parameters<typeof edit>[1], readonly unknown[]> } {
  const mattes = rotoMattes(nodeId);
  const ids = frozen ? mattes.live : mattes.frozen;
  const name = frozen ? ROTO_FROZEN_NAME : ROTO_PATH_NAME;
  const subject = frozen ? mattes.subject : mattes.subjectFrozen;
  return {
    label: frozen ? 'Freeze Roto Brush' : 'Unfreeze Roto Brush',
    commands: [
      ...ids.map((id) => ({ type: 'renamePropertyGroup' as const, group: { layer: nodeId, path: paths.maskGroup(id) }, name })),
      ...subject.map((id) => ({ type: 'setProperty' as const, prop: { layer: nodeId, path: `${paths.maskGroup(id)}/locked` }, value: { kind: 'bool' as const, value: frozen } })),
    ],
  };
}

/** Freeze / unfreeze as one undo step. False when there was nothing to change. */
export async function setRotoFrozen(nodeId: string, frozen: boolean): Promise<boolean> {
  const e = rotoFreezeEdit(nodeId, frozen);
  if (e.commands.length === 0) return false;
  return (await edit(e.label, e.commands)).ok;
}

export interface RotoPrompts {
  fg: Array<{ x: number; y: number }>;
  bg: Array<{ x: number; y: number }>;
}

/** What a propagation did (`frames` walked, `keyframes` written). */
export interface RotoBrushResult {
  keyframes: number;
  frames: number;
  status: 'completed' | 'cancelled';
}

/**
 * Stroke points → the job's prompts in layer px (top-left origin). Every
 * point of a stroke is a prompt: a stroke is how a brush says "all of this".
 */
export function strokesToPrompts(strokes: readonly RotoStroke[], layer: { width: number; height: number }): RotoPrompts {
  const out: RotoPrompts = { fg: [], bg: [] };
  for (const s of strokes) {
    // Thin dense strokes to at most ~24 prompts each — the segmenter's cost is
    // per prompt, and a slow drag records hundreds of near-identical points.
    const step = Math.max(1, Math.ceil(s.points.length / 24));
    for (let i = 0; i < s.points.length; i += step) {
      const p = s.points[i]!;
      const x = p.x + layer.width / 2;
      const y = p.y + layer.height / 2;
      if (x < 0 || y < 0 || x >= layer.width || y >= layer.height) continue;
      (s.kind === 'fg' ? out.fg : out.bg).push({ x, y });
    }
  }
  return out;
}

/** The strokes painted on the frame at `time` (strokes without a time belong to every frame). */
export function strokesAt(strokes: readonly RotoStroke[], time: number, fps = 30): RotoStroke[] {
  const half = 0.5 / Math.max(1, fps);
  return strokes.filter((s) => s.time === undefined || Math.abs(s.time - time) <= half);
}

/** A box (layer-local, centre origin) → the job's `box` Rect in layer px, top-left origin. */
export function boxToRect(box: RotoBox, layer: { width: number; height: number }): { x: number; y: number; width: number; height: number } {
  const x0 = Math.min(box.x0, box.x1) + layer.width / 2;
  const y0 = Math.min(box.y0, box.y1) + layer.height / 2;
  return { x: x0, y: y0, width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) };
}

/** The box when it was drawn on the frame at `time`, else null. */
export function boxAt(box: RotoBox | null | undefined, time: number, fps = 30): RotoBox | null {
  return box && Math.abs(box.time - time) <= 0.5 / Math.max(1, fps) ? box : null;
}

/**
 * The layer's box — the layer px the strokes, prompts, outlines and masks live
 * in: `layer/width` × `layer/height` (a resized footage layer's box is not its
 * picture's size), else the footage's own size. The objectMatte job maps the
 * picture onto the same box.
 */
export async function layerSize(nodeId: string): Promise<{ width: number; height: number } | null> {
  const box = await engine().query({
    type: 'getPropertyValues', props: [{ layer: nodeId, path: 'layer/width' }, { layer: nodeId, path: 'layer/height' }], time: 0, evaluated: true,
  });
  if (box.ok) {
    const [w, h] = box.value.values.map((v) => (v.value as { value?: unknown }).value);
    if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) return { width: w, height: h };
  }
  const res = await engine().query({ type: 'getSourceSize', layers: [nodeId] });
  const s = res.ok ? res.value.sizes[0] : undefined;
  return s && s.width > 0 && s.height > 0 ? { width: s.width, height: s.height } : null;
}

export interface SegmentStrokesOptions {
  featherPx?: number;
  /** Replace this path id if it is still on the layer. */
  replacePathId?: string | null;
  /** The Object Matte tool's marquee on this frame: a box prompt (it wins over points in the engine). */
  box?: RotoBox | null;
}

/** The objectMatte job of one frame, built from the tool's prompts (null when there is nothing to segment). */
async function singleFrameSpec(
  nodeId: string,
  strokes: readonly RotoStroke[],
  timeSec: number,
  opts: SegmentStrokesOptions,
): Promise<Parameters<typeof runEngineJob>[0] | null> {
  const size = await layerSize(nodeId);
  if (!size) return null;
  const prompts = strokesToPrompts(strokes, size);
  const rect = opts.box ? boxToRect(opts.box, size) : null;
  const box = rect && rect.width > 1 && rect.height > 1 ? rect : null;
  if (prompts.fg.length === 0 && !box) return null;
  // The tool's previous paths go: the one it wrote last (by id) and any other it left (by name).
  // Only masks still on the layer: a propagation or an undo may have taken the
  // remembered one away, and naming a missing mask fails the whole job.
  const headers = mirrorMaskHeaders(documentMirror().tree(nodeId));
  const replace = new Set<string>(opts.replacePathId && headers.some((m) => m.id === opts.replacePathId) ? [opts.replacePathId] : []);
  for (const m of headers) if (m.name === ROTO_PATH_NAME) replace.add(m.id);
  return {
    kind: 'objectMatte',
    value: {
      strokes: [],
      layer: nodeId,
      range: { start: secondsToFlicks(timeSec), duration: secondsToFlicks(1 / 30) },
      prompts: prompts.fg,
      backgroundPrompts: prompts.bg,
      encoderModel: '',
      decoderModel: '',
      maskName: ROTO_PATH_NAME,
      maskMode: 'add',
      feather: opts.featherPx ?? 2,
      replaceMasks: [...replace],
      ...(box ? { box } : {}),
    },
  };
}

/** A hover preview: the outline a click would write, held in the engine until applied or discarded. */
export interface ObjectMattePreview {
  /** Layer-local px (centre origin), x y pairs. */
  outline: number[];
  /** Write the held result (one undo entry). Resolves the mask id, or null when it could not. */
  apply(): Promise<string | null>;
  /** Drop the held result; nothing was written. */
  discard(): void;
}

/**
 * The Object Matte tool's hover (AE 26.2: hovering a subject previews its
 * matte). The job runs with `apply: false`; its summary carries the outline,
 * and a click on the same spot applies the held result instead of segmenting
 * again. Resolves null when there was nothing there, or when `isStale()`
 * turned true while it ran (the pointer moved on).
 */
export async function previewObjectMatte(
  nodeId: string,
  strokes: readonly RotoStroke[],
  timeSec: number,
  opts: SegmentStrokesOptions & { isStale?: () => boolean } = {},
): Promise<ObjectMattePreview | null> {
  if (isRotoFrozen(nodeId)) return null;
  const spec = await singleFrameSpec(nodeId, strokes, timeSec, opts);
  if (!spec) return null;
  const handle = await startEngineJob<{ outline?: number[] }>(spec, { apply: false });
  if (!handle) return null;
  const out = await handle.done;
  const drop = (): void => { if (!out.job.applied) handle.cancel(); };
  const outline = out.result?.outline;
  if (out.status !== 'done' || !Array.isArray(outline) || outline.length < 6 || opts.isStale?.()) {
    drop();
    return null;
  }
  let used = false;
  return {
    outline,
    apply: async () => {
      if (used) return null;
      used = true;
      if (!(await applyEngineJob(handle.id))) return null;
      // The summary names the mask only after apply; the newest tool path is it.
      const live = rotoMattes(nodeId).live;
      return live[live.length - 1] ?? null;
    },
    discard: () => {
      if (used) return;
      used = true;
      drop();
    },
  };
}

/**
 * Segment from the strokes and write the matte as the layer's roto mask
 * (replacing the tool's previous path; one undo entry). Resolves to the new
 * mask's id, or null when nothing usable came back or the layer is not
 * addressable. Throws when the engine does not run the job.
 */
export async function segmentStrokesToMask(
  nodeId: string,
  strokes: readonly RotoStroke[],
  timeSec: number,
  opts: SegmentStrokesOptions = {},
): Promise<string | null> {
  if (isRotoFrozen(nodeId)) throw new Error(frozenMessage(nodeId));
  if (!opts.box && !strokes.some((s) => s.kind === 'fg' && s.points.length > 0)) return null;
  const spec = await singleFrameSpec(nodeId, strokes, timeSec, opts);
  if (!spec) return null;
  const out = requireEngineJob(await runEngineJob<{ mask?: string }>(spec), 'Roto Brush');
  if (out.status !== 'done') {
    if (out.status === 'failed') throw new Error(out.error?.message ?? 'Roto Brush failed');
    return null;
  }
  return out.result?.mask ?? null;
}

/** One object the model found in a frame (Find Objects): layer-local px, centre origin. */
export interface FoundObject {
  /** Its outline, x y pairs. */
  outline: number[];
  /** Where a click selects it again (the grid click that found it). */
  seed: { x: number; y: number };
  /** Share of the frame, 0…1 (the smaller of two overlapping objects is the one under the pointer). */
  area: number;
  /** Its bounds, for a quick reject before the point-in-outline test. */
  bounds: { x0: number; y0: number; x1: number; y1: number };
}

/** The frames searched, newest last: a frame is searched once (the engine also keeps its encoding). */
const foundCache = new Map<string, FoundObject[]>();
const FOUND_CACHE_SIZE = 12;

/** The cache key: the layer, the frame and the layer's box (a resized layer's outlines are in its new box). */
const foundKey = (nodeId: string, timeSec: number, box: { width: number; height: number } | null): string =>
  `${nodeId}@${timeSec}@${box ? `${box.width}x${box.height}` : '-'}`;
/** The last key searched per layer@time, so a synchronous look-up finds it without the box. */
const lastFoundKey = new Map<string, string>();

/** The objects found in `nodeId`'s frame at `timeSec` when that search already ran (for the layer's box then), else undefined. */
export function foundObjectsCached(nodeId: string, timeSec: number): FoundObject[] | undefined {
  const key = lastFoundKey.get(`${nodeId}@${timeSec}`);
  return key ? foundCache.get(key) : undefined;
}

/**
 * Find Objects (Premiere's Object Mask hover): every object of the frame,
 * found once by the model, so the Object Matte tool's hover is a lookup —
 * all of them lit faintly, the one under the pointer strongly, at once.
 * Nothing is written. Null when the engine could not search the frame.
 */
export async function findObjects(nodeId: string, timeSec: number): Promise<FoundObject[] | null> {
  const key = foundKey(nodeId, timeSec, await layerSize(nodeId));
  const hit = foundCache.get(key);
  if (hit) {
    lastFoundKey.set(`${nodeId}@${timeSec}`, key);
    return hit;
  }
  const out = await previewEngineJob<{ objects?: Array<{ outline: number[]; seed: [number, number]; area: number }> }>({
    kind: 'objectMatte',
    value: {
      layer: nodeId,
      range: { start: secondsToFlicks(timeSec), duration: secondsToFlicks(1 / 30) },
      prompts: [],
      backgroundPrompts: [],
      encoderModel: '',
      decoderModel: '',
      replaceMasks: [],
      strokes: [],
      proposals: true,
    },
  });
  if (!out || out.status !== 'done') {
    if (out?.status === 'failed') throw new Error(out.error?.message ?? 'Object Matte failed');
    return null;
  }
  const objects: FoundObject[] = (out.result?.objects ?? []).map((o) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 1 < o.outline.length; i += 2) {
      x0 = Math.min(x0, o.outline[i]!); x1 = Math.max(x1, o.outline[i]!);
      y0 = Math.min(y0, o.outline[i + 1]!); y1 = Math.max(y1, o.outline[i + 1]!);
    }
    return { outline: o.outline, seed: { x: o.seed[0], y: o.seed[1] }, area: o.area, bounds: { x0, y0, x1, y1 } };
  });
  foundCache.set(key, objects);
  lastFoundKey.set(`${nodeId}@${timeSec}`, key);
  while (foundCache.size > FOUND_CACHE_SIZE) foundCache.delete(foundCache.keys().next().value!);
  return objects;
}

/** The found object under `p` (layer-local px): the smallest whose outline holds it, else null. */
export function objectAt(objects: readonly FoundObject[], p: { x: number; y: number }): FoundObject | null {
  let best: FoundObject | null = null;
  for (const o of objects) {
    const b = o.bounds;
    if (p.x < b.x0 || p.x > b.x1 || p.y < b.y0 || p.y > b.y1) continue;
    if (best && o.area >= best.area) continue;
    // Even-odd ray cast against the outline.
    let inside = false;
    const f = o.outline;
    for (let i = 0, j = f.length - 2; i + 1 < f.length; j = i, i += 2) {
      const xi = f[i]!, yi = f[i + 1]!, xj = f[j]!, yj = f[j + 1]!;
      if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) best = o;
  }
  return best;
}

/**
 * Every found object under `p`, the whole first: a person, then the jacket on
 * them, then its sleeve. The Object Matte tool steps through them (Tab) to
 * pick a part rather than the whole.
 */
export function objectsAt(objects: readonly FoundObject[], p: { x: number; y: number }): FoundObject[] {
  const hit: FoundObject[] = [];
  for (const o of objects) {
    const b = o.bounds;
    if (p.x < b.x0 || p.x > b.x1 || p.y < b.y0 || p.y > b.y1) continue;
    let inside = false;
    const f = o.outline;
    for (let i = 0, j = f.length - 2; i + 1 < f.length; j = i, i += 2) {
      const xi = f[i]!, yi = f[i + 1]!, xj = f[j]!, yj = f[j + 1]!;
      if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) hit.push(o);
  }
  return hit.sort((a, b) => b.area - a.area);
}

/** How a subject edit changes the frame's matte (the Object Matte tool group). */
export interface SubjectEditRequest {
  /** segment: the model from clicks / box / strokes; paint: the brush exactly; refine: soft alpha in the brush's band. */
  tool: 'segment' | 'paint' | 'refine';
  op: 'replace' | 'add' | 'subtract';
  /** Clicks, layer-local px (centre origin). */
  clicks?: ReadonlyArray<{ x: number; y: number }>;
  /** Points that are NOT the subject (a lasso's outside), layer-local px. */
  negatives?: ReadonlyArray<{ x: number; y: number }>;
  /** Brush strokes, layer-local px. */
  strokes?: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>;
  /** Brush radius, layer px. */
  radius?: number;
  /** Brush edge, 0…100 (100 = a hard disc; lower = a soft falloff over the outer part of the radius). Default 100. */
  hardness?: number;
  box?: RotoBox | null;
}

/** What a subject edit left: the frame's coverage (0…1) and its outline (layer-local px, x y pairs). */
export interface SubjectEditResult {
  coverage: number;
  outline: number[];
}

/**
 * The prompts a subject's frame has been given so far (layer-local px): a
 * Shift-click ADDS to what the earlier clicks and box described, so the model
 * is asked with all of them together — one object described by several points
 * — rather than with the new click alone merged in afterwards. Session state
 * (it mirrors the edits already in the document); a plain click starts over.
 */
export interface FramePrompts {
  clicks: Array<{ x: number; y: number }>;
  negatives: Array<{ x: number; y: number }>;
  box: RotoBox | null;
}

const framePrompts = new Map<string, FramePrompts>();
const FRAME_PROMPTS_KEEP = 64;

/** The key of a subject's frame: the layer, the subject and the frame (half a frame of slack at 240 fps). */
const framePromptsKey = (nodeId: string, subject: string, timeSec: number): string => `${nodeId}:${subject}:${Math.round(timeSec * 480)}`;

/**
 * The prompt set to send for this edit, and what to remember after it:
 *   replace            the request's own prompts (the frame starts over)
 *   add (segment)      every earlier positive and negative with the new ones, and the box
 *                      the selection started from, so the model sees one object
 *   subtract           the new click alone as the thing to take away (the earlier positives
 *                      would make the delta the whole subject); remembered as a negative,
 *                      so a later add keeps it out
 *   paint / refine     the request's own strokes; nothing remembered
 */
export function cumulativePrompts(prev: FramePrompts | undefined, req: SubjectEditRequest): { send: FramePrompts; keep: FramePrompts | null } {
  const clicks = [...(req.clicks ?? [])];
  const negatives = [...(req.negatives ?? [])];
  const own: FramePrompts = { clicks, negatives, box: req.box ?? null };
  if (req.tool !== 'segment') return { send: own, keep: prev ?? null };
  if (req.op === 'replace' || !prev) {
    const keep: FramePrompts = req.op === 'subtract' ? { clicks: [], negatives: [...clicks, ...negatives], box: null } : own;
    return { send: own, keep };
  }
  if (req.op === 'subtract') {
    return { send: own, keep: { clicks: prev.clicks, negatives: [...prev.negatives, ...clicks, ...negatives], box: prev.box } };
  }
  const all: FramePrompts = {
    clicks: [...prev.clicks, ...clicks],
    negatives: [...prev.negatives, ...negatives],
    box: req.box ?? prev.box,
  };
  return { send: all, keep: all };
}

/** Forget a frame's prompts (the subject was removed, or its selection undone). */
export function forgetFramePrompts(nodeId: string, subject?: string): void {
  for (const key of [...framePrompts.keys()]) {
    if (key.startsWith(subject === undefined ? `${nodeId}:` : `${nodeId}:${subject}:`)) framePrompts.delete(key);
  }
}

/**
 * Edit the layer's SUBJECT on the frame at `timeSec`: its soft matte (a
 * picture, not a mask path) is segmented, painted or refined and merged into
 * the layer's stored matte, one undo entry. The subject is a selection — the
 * footage stays whole until Remove Background; effects read it through Apply
 * To and text through Behind Subject. Null when there was nothing to edit.
 */
/**
 * How a job's edits reach the document. Absent: the engine applies the result
 * itself when the job finishes (one history entry) — but never while a gesture
 * is open (session_jobs.cpp), so a caller running INSIDE a gesture (the AI
 * turn, one gesture = one undo entry) hands in `applyResult`: the job is
 * started held (`apply: false`), it finishes at once, and the caller applies
 * the held result through its own session (`applyJobResult` in the gesture).
 */
export interface JobApplyOptions {
  applyResult?: (jobId: string) => Promise<void>;
}

export async function runSubjectEdit(
  nodeId: string,
  timeSec: number,
  req: SubjectEditRequest,
  subject: string = FIRST_SUBJECT,
  applyOpts: JobApplyOptions = {},
): Promise<SubjectEditResult | null> {
  refuseLocked(nodeId, subject);
  const size = await layerSize(nodeId);
  if (!size) return null;
  const toPx = (p: { x: number; y: number }) => ({ x: p.x + size.width / 2, y: p.y + size.height / 2 });
  const key = framePromptsKey(nodeId, subject, timeSec);
  const { send, keep } = cumulativePrompts(framePrompts.get(key), req);
  const rect = send.box ? boxToRect(send.box, size) : null;
  const box = rect && rect.width > 1 && rect.height > 1 ? rect : null;
  const strokes = (req.strokes ?? []).filter((s) => s.length > 0);
  if (!box && strokes.length === 0 && send.clicks.length === 0) return null;
  // The old tool's cut masks give way to the subject (a layer made before the subject was a matte).
  const replace = mirrorMaskHeaders(documentMirror().tree(nodeId)).filter((m) => m.name === ROTO_PATH_NAME).map((m) => m.id);
  const out = requireEngineJob(await runEngineJob<{ coverage?: number; outline?: number[] }>({
    kind: 'objectMatte',
    value: {
      layer: nodeId,
      range: { start: secondsToFlicks(timeSec), duration: secondsToFlicks(1 / 30) },
      prompts: send.clicks.map(toPx),
      backgroundPrompts: send.negatives.map(toPx),
      encoderModel: '',
      decoderModel: '',
      replaceMasks: replace,
      ...(box ? { box } : {}),
      strokes: strokes.map((s) => ({ time: secondsToFlicks(timeSec), points: s.map(toPx), background: false })),
      edit: { tool: req.tool, op: req.op, radius: Math.max(0.5, req.radius ?? 10), cut: false, hardness: Math.max(0, Math.min(100, req.hardness ?? 100)) },
      subject,
    },
  }, applyOpts.applyResult ? { apply: false } : {}), 'Object Matte');
  if (out.status !== 'done') {
    if (out.status === 'failed') throw new Error(out.error?.message ?? 'Object Matte failed');
    return null;
  }
  if (applyOpts.applyResult) await applyOpts.applyResult(out.job.id);
  if (keep) {
    framePrompts.delete(key);
    framePrompts.set(key, keep);
    while (framePrompts.size > FRAME_PROMPTS_KEEP) framePrompts.delete(framePrompts.keys().next().value!);
  } else {
    framePrompts.delete(key);
  }
  for (const l of subjectEditListeners) l(nodeId, subject, timeSec);
  return { coverage: out.result?.coverage ?? 0, outline: out.result?.outline ?? [] };
}

type SubjectEditListener = (nodeId: string, subject: string, timeSec: number) => void;
const subjectEditListeners = new Set<SubjectEditListener>();

/**
 * Told after every applied subject edit (a click, a brush, Refine Edge) with
 * the layer, the subject and the frame — the editor's automatic tracking
 * listens (layout/Workspace/autoTrack.ts). Returns the unsubscribe.
 */
export function onSubjectEdited(listener: SubjectEditListener): () => void {
  subjectEditListeners.add(listener);
  return () => { subjectEditListeners.delete(listener); };
}

/**
 * Propagate the matte forward from `fromSec` to `toSec` in the engine, from
 * the tool's current outline and every stroke (layer px).
 */
export async function propagateRotoForward(
  nodeId: string,
  strokes: readonly RotoStroke[],
  fromSec: number,
  toSec: number,
  fps: number,
  featherPx: number,
  onProgress?: (f: number) => boolean | void,
): Promise<RotoBrushResult> {
  if (isRotoFrozen(nodeId)) throw new Error(frozenMessage(nodeId));
  const size = await layerSize(nodeId);
  if (!size) throw new Error('Layer has no sized video source.');
  const prompts = strokesToPrompts(strokes, size);
  const seed = prompts.fg[0];
  if (!seed) throw new Error('Paint a foreground stroke first.');
  // Start from the tool's SAM outline when there is one (the matte the user
  // saw), and replace it: the propagated mask keys that frame too.
  const live = rotoMattes(nodeId).live;
  const startF = Math.round(fromSec * fps);
  const endF = Math.round(toSec * fps);
  let cancel: (() => void) | null = null;
  const handle = requireEngineJob(await startEngineJob<{ frames: number; keyframes: number }>(
    {
      kind: 'rotoBrush',
      value: {
        layer: nodeId,
        range: {
          start: secondsToFlicks(startF / Math.max(1, fps)),
          duration: secondsToFlicks(Math.max(1, endF - startF + 1) / Math.max(1, fps)),
        },
        seed,
        feather: featherPx,
        prompts: prompts.fg,
        backgroundPrompts: prompts.bg,
        ...(live.length > 0 ? { startMask: live[live.length - 1] } : {}),
        replaceMasks: live,
      },
    },
    {
      onProgress: (f) => {
        if (onProgress?.(f) === false) cancel?.();
      },
    },
  ), 'Roto Brush');
  cancel = handle.cancel;
  const out = await handle.done;
  if (out.status === 'cancelled') return { keyframes: 0, frames: 0, status: 'cancelled' };
  if (out.status !== 'done') throw new Error(out.error?.message ?? 'Roto Brush failed');
  return { keyframes: out.result?.keyframes ?? 0, frames: out.result?.frames ?? 0, status: 'completed' };
}

/**
 * Object Matte through the shot (AE parity 3.1 / 3.2): the `objectMatte`
 * job's video path. The strokes on the origin frame (the playhead) prompt it;
 * strokes on any other frame are corrections for that frame. The soft matte
 * of every frame is stored as the layer's cut-out (setLayerMatte) and its
 * outline keyed on an "Object Matte" mask; the tool's previous outlines go.
 */
export async function propagateObjectMatte(
  nodeId: string,
  strokes: readonly RotoStroke[],
  opts: {
    origin: number;
    start: number;
    end: number;
    fps: number;
    direction: 'forward' | 'backward' | 'both';
    featherPx: number;
    refine: { edgeRadius: number; decontaminate: number; motionBlur: boolean; choke: number; reduceChatter: number };
    /** The Object Matte tool's marquee on the origin frame. */
    box?: RotoBox | null;
    /** Which of the layer's subjects is followed (default the first). */
    subject?: string;
    /** Re-track only start…end (between two fixes): the subject's frames and outline keys outside it stay. */
    keepOutside?: boolean;
  } & JobApplyOptions,
  onProgress?: (f: number) => boolean | void,
): Promise<RotoBrushResult> {
  const subject = opts.subject ?? FIRST_SUBJECT;
  refuseLocked(nodeId, subject);
  const size = await layerSize(nodeId);
  if (!size) throw new Error('Layer has no sized video source.');
  const here = strokesToPrompts(strokesAt(strokes, opts.origin, opts.fps), size);
  const originBox = boxAt(opts.box, opts.origin, opts.fps);
  const rect = originBox ? boxToRect(originBox, size) : null;
  const box = rect && rect.width > 1 && rect.height > 1 ? rect : null;
  // No prompts here: the engine starts from the subject's stored matte (its frame nearest the origin).
  const outline = subjectOutlineName(subject);
  const hasSubject = mirrorMaskHeaders(documentMirror().tree(nodeId)).some((m) => m.name === outline);
  if (here.fg.length === 0 && !box && !hasSubject) throw new Error('Select the subject on this frame first: click it, or paint a foreground stroke.');
  const half = 0.5 / Math.max(1, opts.fps);
  const corrections = strokes
    .filter((s) => s.time !== undefined && Math.abs(s.time - opts.origin) > half)
    .map((s) => {
      const p = strokesToPrompts([s], size);
      return { time: secondsToFlicks(s.time!), points: s.kind === 'fg' ? p.fg : p.bg, background: s.kind === 'bg' };
    })
    .filter((c) => c.points.length > 0);
  const replace = new Set<string>(opts.keepOutside ? [] : rotoMattes(nodeId).live);
  if (!opts.keepOutside) for (const m of mirrorMaskHeaders(documentMirror().tree(nodeId))) if (m.name === outline) replace.add(m.id);
  // The layer's Object Matte effect card holds the bake settings once it exists (objectMatteEffect.ts).
  const bake = objectMatteBake(nodeId, { ...opts.refine, featherPx: opts.featherPx });
  let cancel: (() => void) | null = null;
  const handle = requireEngineJob(await startEngineJob<{ frames: number; status: string }>(
    {
      kind: 'objectMatte',
      value: {
        layer: nodeId,
        range: { start: secondsToFlicks(opts.start), duration: secondsToFlicks(Math.max(1 / opts.fps, opts.end - opts.start)) },
        prompts: here.fg,
        backgroundPrompts: here.bg,
        encoderModel: '',
        decoderModel: '',
        replaceMasks: [...replace],
        ...(box ? { box } : {}),
        direction: opts.direction,
        origin: secondsToFlicks(opts.origin),
        subject,
        ...(opts.keepOutside ? { keepOutside: true } : {}),
        strokes: corrections,
        matte: true,
        refine: {
          edgeRadius: bake.edgeRadius,
          decontaminate: bake.decontaminate / 100,
          motionBlur: bake.motionBlur,
          shutterAngle: 180,
          feather: bake.featherPx,
          choke: bake.choke,
          reduceChatter: bake.reduceChatter,
        },
      },
    },
    { onProgress: (f) => { if (onProgress?.(f) === false) cancel?.(); }, ...(opts.applyResult ? { apply: false } : {}) },
  ), 'Object Matte');
  cancel = handle.cancel;
  const out = await handle.done;
  if (out.status === 'cancelled') return { keyframes: 0, frames: 0, status: 'cancelled' };
  if (out.status !== 'done') throw new Error(out.error?.message ?? 'Object Matte failed');
  if (opts.applyResult) await opts.applyResult(out.job.id);
  const frames = out.result?.frames ?? 0;
  return { keyframes: frames, frames, status: 'completed' };
}
