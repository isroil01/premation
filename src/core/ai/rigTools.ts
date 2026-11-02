/**
 * Rigging for Claude: `rig_character`, `render_rig_view`'s geometry and
 * `rig_cycle`.
 *
 * ## Joints in, an exact skeleton out
 *
 * The Auto-Rig presets (rig/rigPresets.ts) place limbs from proportions, and
 * by their own note the biped's limb roots are approximate. Here the caller
 * says where the joints ARE — Claude reads them off `render_rig_view`'s grid,
 * which is labelled in the same layer-local space the rig lives in — and each
 * bone's parent-local transform is solved from those world points, so every
 * root and tip lands on its joint. Joints not given come from proportions of
 * the layer's box (a front-view biped), placed in WORLD space and solved the
 * same way. Limbs are two-bone IK chains with a goal at the wrist / ankle and
 * the side each middle joint already bends to kept (bentJoint); extra chains (a tail, an antenna, a cape, a
 * quadruped's legs) are any polyline, optionally IK.
 *
 * Rotations: the stored rig is RADIANS (rig/skeleton.ts `fromTRS`); bone
 * rotation TRACKS are degrees (rigProps.ts). Both conversions happen here.
 */

import type { Command } from '@motion/engine-api';
import { secondsToFlicks } from '@motion/engine-api';
import { resolveAlias, type ToolContext } from '@motion/ai-tools';
import type { Bone } from '@core/rig/skeleton';
import type { IKTarget, SkeletonRig } from '@core/rig/skeletonCommands';
import { DEFAULT_CONTROLLER_SIZE, type RigController } from '@core/rig/controllers';
import { validateRig } from '@core/rig/rigPresets';
import { documentMirror } from '@stores/documentMirror';
import { uiKindOf } from '@core/mirror/layerKinds';
import { isRiggableKind } from '@core/scene/rigLogo';

export interface Pt { x: number; y: number }
export interface Box { x: number; y: number; width: number; height: number }

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function pt(v: unknown): Pt | null {
  if (Array.isArray(v) && isNum(v[0]) && isNum(v[1])) return { x: v[0], y: v[1] };
  const o = obj(v);
  return isNum(o.x) && isNum(o.y) ? { x: o.x, y: o.y } : null;
}

// ── Skeleton from world joints ─────────────────────────────────────────

/** A bone as world points: root → tip, under `parent`. */
export interface WorldBone {
  id: string;
  name: string;
  parent: string | null;
  root: Pt;
  tip: Pt;
}

/**
 * Parent-local transforms for bones given in world (layer) space. Parents
 * first; a bone's frame is its root, x along root → tip, unscaled.
 */
export function solveLocal(bones: readonly WorldBone[]): Bone[] {
  const frame = new Map<string, { o: Pt; a: number }>();
  const out: Bone[] = [];
  for (const b of bones) {
    const a = Math.atan2(b.tip.y - b.root.y, b.tip.x - b.root.x);
    const len = Math.max(1, Math.hypot(b.tip.x - b.root.x, b.tip.y - b.root.y));
    const p = b.parent ? frame.get(b.parent) : undefined;
    let x = b.root.x, y = b.root.y, rotation = a;
    if (p) {
      const dx = b.root.x - p.o.x, dy = b.root.y - p.o.y;
      const c = Math.cos(-p.a), s = Math.sin(-p.a);
      x = dx * c - dy * s;
      y = dx * s + dy * c;
      rotation = a - p.a;
    }
    // Keep local angles in (−π, π]: a key interpolates the short way from there.
    while (rotation > Math.PI) rotation -= 2 * Math.PI;
    while (rotation <= -Math.PI) rotation += 2 * Math.PI;
    frame.set(b.id, { o: b.root, a });
    out.push({ id: b.id, name: b.name, parentId: b.parent, length: len, x, y, rotation });
  }
  return out;
}

export const BIPED_JOINTS = [
  'head_top', 'neck', 'chest', 'hips',
  'shoulder_l', 'elbow_l', 'wrist_l', 'shoulder_r', 'elbow_r', 'wrist_r',
  'hip_l', 'knee_l', 'ankle_l', 'hip_r', 'knee_r', 'ankle_r',
] as const;
export type BipedJoint = typeof BIPED_JOINTS[number];

/** A front-view figure filling `box`; `_l` is SCREEN left (negative x), as the presets. */
export function defaultBipedJoints(box: Box): Record<BipedJoint, Pt> {
  const cx = box.x + box.width / 2, w = box.width, h = box.height;
  const at = (dx: number, fy: number): Pt => ({ x: cx + dx * w, y: box.y + fy * h });
  return {
    head_top: at(0, 0.03), neck: at(0, 0.19), chest: at(0, 0.3), hips: at(0, 0.52),
    shoulder_l: at(-0.16, 0.23), elbow_l: at(-0.24, 0.37), wrist_l: at(-0.28, 0.5),
    shoulder_r: at(0.16, 0.23), elbow_r: at(0.24, 0.37), wrist_r: at(0.28, 0.5),
    hip_l: at(-0.09, 0.54), knee_l: at(-0.1, 0.75), ankle_l: at(-0.1, 0.95),
    hip_r: at(0.09, 0.54), knee_r: at(0.1, 0.75), ankle_r: at(0.1, 0.95),
  };
}

/**
 * The side a two-bone chain bends to, as a point off the middle joint: the
 * side it already bends to, or — a straight chain has none — away from the
 * body's centre line (`awayX`), where a front-view elbow or knee goes.
 */
export function poleFor(root: Pt, mid: Pt, tip: Pt, awayX: number): Pt {
  const mx = (root.x + tip.x) / 2, my = (root.y + tip.y) / 2;
  let dx = mid.x - mx, dy = mid.y - my;
  const reach = Math.hypot(tip.x - root.x, tip.y - root.y) || 1;
  if (Math.hypot(dx, dy) < reach * 0.02) {
    // Perpendicular to the chain, toward `awayX`.
    const ux = (tip.x - root.x) / reach, uy = (tip.y - root.y) / reach;
    dx = -uy; dy = ux;
    if ((mid.x + dx - mid.x) * awayX < 0) { dx = -dx; dy = -dy; }
  }
  const n = Math.hypot(dx, dy) || 1;
  return { x: mid.x + (dx / n) * reach * 0.5, y: mid.y + (dy / n) * reach * 0.5 };
}

/**
 * The middle joint of a two-bone IK chain, nudged off a straight line.
 *
 * No pole is stored: without one the engine's two-bone solve keeps the side
 * the chain already bends to (rig_mesh.cpp `apply_ik`), which is exactly what
 * joints read off the picture say — a stored pole would be a second opinion
 * on a side the picture already gives (and, animated, something else to
 * keep in step). A straight chain has no side for the solver to keep: it
 * gets one, by 1.5% of its reach toward `poleFor`'s side. (The solver's pole
 * branch once measured the side with the opposite sign and bent every joint
 * away from its pole; fixed 2026-10-26, so create_skeleton_rig's `pole` is
 * trustworthy again.)
 */
export function bentJoint(root: Pt, mid: Pt, tip: Pt, awayX: number): Pt {
  const reach = Math.hypot(tip.x - root.x, tip.y - root.y) || 1;
  const mx = (root.x + tip.x) / 2, my = (root.y + tip.y) / 2;
  if (Math.hypot(mid.x - mx, mid.y - my) >= reach * 0.02) return mid;
  const p = poleFor(root, mid, tip, awayX);
  const dx = p.x - mid.x, dy = p.y - mid.y, n = Math.hypot(dx, dy) || 1;
  return { x: mid.x + (dx / n) * reach * 0.015, y: mid.y + (dy / n) * reach * 0.015 };
}

export interface ChainSpec {
  name: string;
  points: Pt[];
  /** Bone id the chain's first bone hangs from (null: a root). */
  parent: string | null;
  ik: boolean;
}

function limbController(prefix: string, side: 'left' | 'right' | 'centre', boneId: string): RigController {
  return { id: `ctrl_${prefix}`, name: `${prefix} IK`, shape: 'circle', side, size: DEFAULT_CONTROLLER_SIZE, link: { kind: 'ikTarget', boneId } };
}

/** The whole rig: an optional biped, then the chains. */
export function buildRig(o: { biped: Record<BipedJoint, Pt> | null; chains: readonly ChainSpec[]; centreX: number }): SkeletonRig {
  const world: WorldBone[] = [];
  const ik: IKTarget[] = [];
  const controllers: RigController[] = [];
  if (o.biped) {
    const j = o.biped;
    world.push(
      { id: 'hips', name: 'Hips', parent: null, root: j.hips, tip: j.chest },
      { id: 'chest', name: 'Chest', parent: 'hips', root: j.chest, tip: j.neck },
      { id: 'head', name: 'Head', parent: 'chest', root: j.neck, tip: j.head_top },
    );
    controllers.push({ id: 'ctrl_hips', name: 'Hips', shape: 'square', side: 'centre', size: DEFAULT_CONTROLLER_SIZE + 4, link: { kind: 'bone', boneId: 'hips' } });
    const limbs: [string, BipedJoint, BipedJoint, BipedJoint, string, 'left' | 'right'][] = [
      ['arm_l', 'shoulder_l', 'elbow_l', 'wrist_l', 'chest', 'left'],
      ['arm_r', 'shoulder_r', 'elbow_r', 'wrist_r', 'chest', 'right'],
      ['leg_l', 'hip_l', 'knee_l', 'ankle_l', 'hips', 'left'],
      ['leg_r', 'hip_r', 'knee_r', 'ankle_r', 'hips', 'right'],
    ];
    for (const [prefix, a, b, c, parent, side] of limbs) {
      j[b] = bentJoint(j[a], j[b], j[c], j[b].x - o.centreX);
      world.push(
        { id: `${prefix}_upper`, name: `${prefix} upper`, parent, root: j[a], tip: j[b] },
        { id: `${prefix}_lower`, name: `${prefix} lower`, parent: `${prefix}_upper`, root: j[b], tip: j[c] },
      );
      ik.push({ boneId: `${prefix}_lower`, x: j[c].x, y: j[c].y, chainLength: 2 });
      controllers.push(limbController(prefix, side, `${prefix}_lower`));
    }
  }
  for (const ch of o.chains) {
    if (ch.ik && ch.points.length === 3) ch.points[1] = bentJoint(ch.points[0]!, ch.points[1]!, ch.points[2]!, ch.points[1]!.x - o.centreX);
    for (let i = 0; i + 1 < ch.points.length; i++) {
      world.push({ id: `${ch.name}_${i + 1}`, name: `${ch.name} ${i + 1}`, parent: i === 0 ? ch.parent : `${ch.name}_${i}`, root: ch.points[i]!, tip: ch.points[i + 1]! });
    }
    const n = ch.points.length - 1;
    if (ch.ik && n >= 1) {
      const tip = ch.points[n]!;
      ik.push({ boneId: `${ch.name}_${n}`, x: tip.x, y: tip.y, chainLength: Math.min(8, Math.max(1, n)) });
      controllers.push(limbController(ch.name, 'centre', `${ch.name}_${n}`));
    }
  }
  return { bones: solveLocal(world), ikTargets: ik, controllers };
}

// ── Engine reads ───────────────────────────────────────────────────────

/** The layer's own box, layer space (the space pins, bones and IK goals are in). */
export async function layerBox(ctx: ToolContext, layer: string, t: number): Promise<Box | null> {
  const r = await ctx.engine.query({ type: 'getLayerBounds', layers: [layer], time: secondsToFlicks(t), space: 'layer', includeEffects: false } as never) as { bounds?: { layer: string; bounds: Box }[] };
  const b = r.bounds?.find((x) => x.layer === layer)?.bounds;
  return b && b.width > 0 && b.height > 0 ? b : null;
}

/** The comp-space corners of the layer box: (x0,y0 … x3,y3) for box corners TL, TR, BR, BL. */
async function compCorners(ctx: ToolContext, layer: string, t: number): Promise<number[] | null> {
  const r = await ctx.engine.query({ type: 'getLayerBounds', layers: [layer], time: secondsToFlicks(t), space: 'comp', includeEffects: false } as never) as { bounds?: { layer: string; corners: number[] }[] };
  const c = r.bounds?.find((x) => x.layer === layer)?.corners;
  return c && c.length >= 8 ? c : null;
}

/** Where a layer sits in the frame at a time: what a close-up of it (render_rig_view, the subject previews) is drawn from. */
export interface FrameGeometry {
  /** The comp region the image shows (the layer box with a margin), comp px. */
  crop: Box;
  /** Layer-local → comp: comp = o + x·ex + y·ey. */
  affine: { o: Pt; ex: Pt; ey: Pt };
  /** The layer's own box, layer px. */
  box: Box;
}

/** The layer's box, its local → comp affine and a crop round it at `t`; null when it draws nothing then. */
export async function layerFrameGeometry(ctx: ToolContext, layer: string, t: number): Promise<FrameGeometry | null> {
  const box = await layerBox(ctx, layer, t);
  const corners = await compCorners(ctx, layer, t);
  if (!box || !corners) return null;
  const c0 = { x: corners[0]!, y: corners[1]! }, c1 = { x: corners[2]!, y: corners[3]! }, c3 = { x: corners[6]!, y: corners[7]! };
  const ex = { x: (c1.x - c0.x) / box.width, y: (c1.y - c0.y) / box.width };
  const ey = { x: (c3.x - c0.x) / box.height, y: (c3.y - c0.y) / box.height };
  const o = { x: c0.x - box.x * ex.x - box.y * ey.x, y: c0.y - box.x * ex.y - box.y * ey.y };
  const xs = [0, 2, 4, 6].map((i) => corners[i]!), ys = [1, 3, 5, 7].map((i) => corners[i]!);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const margin = Math.max(maxX - minX, maxY - minY) * 0.12;
  const crop = { x: minX - margin, y: minY - margin, width: maxX - minX + 2 * margin, height: maxY - minY + 2 * margin };
  return { crop, affine: { o, ex, ey }, box };
}

async function storedJson(ctx: ToolContext, layer: string, path: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await ctx.engine.query({ type: 'getPropertyValues', props: [{ layer, path }], time: 0, evaluated: false } as never) as { values?: { value: { kind: string; value: unknown } }[] };
    const v = r.values?.[0]?.value;
    if (!v || v.kind !== 'json' || typeof v.value !== 'string') return null;
    const parsed: unknown = JSON.parse(v.value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function readSkeleton(ctx: ToolContext, layer: string): Promise<SkeletonRig | null> {
  const s = await storedJson(ctx, layer, 'layer/skeleton');
  return s && Array.isArray(s.bones) ? (s as unknown as SkeletonRig) : null;
}

// ── rig_character ──────────────────────────────────────────────────────


export async function rigCharacter(ctx: ToolContext, rawArgs: unknown): Promise<{ ok: boolean; text: string }> {
  const a = obj(rawArgs);
  const layer = resolveAlias(ctx, String(a.layerId ?? ''));
  if (!(await ctx.scene.has(layer))) return { ok: false, text: `No layer '${layer}' (describe_scene).` };
  const info = documentMirror().layer(layer);
  const kind = info?.kind ?? '';
  const ui = uiKindOf(info);
  if (ui && !isRiggableKind(ui)) return { ok: false, text: `'${layer}' is a ${ui} layer: a skeleton deforms one picture (a shape, image or SVG layer). Use "Rig Logo for Animation" to flatten a group or precomp first.` };
  const box = await layerBox(ctx, layer, 0);
  if (!box) return { ok: false, text: `'${layer}' has no drawn area to rig.` };

  const preset = a.preset === 'biped' ? 'biped' : a.preset === undefined || a.preset === 'none' ? null : 'bad';
  if (preset === 'bad') return { ok: false, text: 'preset must be "biped" or "none" (use chains for anything else: a tail, a quadruped\'s legs, an arm on its own).' };
  const given = obj(a.joints);
  const unknownJoints = Object.keys(given).filter((k) => !(BIPED_JOINTS as readonly string[]).includes(k));
  if (unknownJoints.length) return { ok: false, text: `Unknown joint(s): ${unknownJoints.join(', ')}. Joints: ${BIPED_JOINTS.join(', ')}.` };
  let biped: Record<BipedJoint, Pt> | null = null;
  const defaulted: string[] = [];
  if (preset === 'biped') {
    biped = defaultBipedJoints(box);
    for (const j of BIPED_JOINTS) {
      const p = pt(given[j]);
      if (p) biped[j] = p;
      else defaulted.push(j);
    }
  }
  const chains: ChainSpec[] = [];
  for (const raw of Array.isArray(a.chains) ? a.chains : []) {
    const c = obj(raw);
    const name = String(c.name ?? '').trim().replace(/[^A-Za-z0-9_]/g, '_');
    const points = (Array.isArray(c.points) ? c.points : []).map(pt).filter((p): p is Pt => !!p);
    if (!name || points.length < 2) return { ok: false, text: 'Each chain needs a name and at least two points [x, y] (layer-local, as render_rig_view labels them).' };
    chains.push({ name, points, parent: typeof c.parent === 'string' && c.parent ? c.parent : null, ik: c.ik === true });
  }
  if (!biped && chains.length === 0) return { ok: false, text: 'Nothing to rig: pass preset "biped" (with joints) and/or chains.' };

  const rig = buildRig({ biped, chains, centreX: box.x + box.width / 2 });
  const ids = new Set(rig.bones.map((b) => b.id));
  const orphan = chains.find((c) => c.parent && !ids.has(c.parent));
  if (orphan) return { ok: false, text: `Chain '${orphan.name}' hangs from '${orphan.parent}', which is not a bone of this rig (${[...ids].join(', ')}).` };
  const problems = validateRig(rig);
  if (problems.length) return { ok: false, text: `The rig is not valid: ${problems.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('; ')}` };
  const stored = kind === 'image' || kind === 'svg' ? { ...rig, meshMode: 'silhouette' } : rig;
  await ctx.engine.apply([{ type: 'setProperty', prop: { layer, path: 'layer/skeleton' }, value: { kind: 'json', value: JSON.stringify(stored) } } as Command]);

  const r1 = (v: number): number => Math.round(v);
  const lines = [
    `Rigged '${layer}': ${rig.bones.length} bones, ${rig.ikTargets?.length ?? 0} IK goal(s). It REPLACED any skeleton the layer had.`,
    `Layer box (layer-local): x ${r1(box.x)}…${r1(box.x + box.width)}, y ${r1(box.y)}…${r1(box.y + box.height)}.`,
    ...(defaulted.length && biped ? [`Joints from proportions (check them in render_rig_view and pass the real ones): ${defaulted.join(', ')}.`] : []),
    'Bones (id: parent, length, rest local rotation):',
    ...rig.bones.map((b) => `- ${b.id}: ${b.parentId ?? 'root'}, ${r1(b.length)}px, ${(b.rotation * DEG).toFixed(1)}°`),
    ...(rig.ikTargets?.length ? ['IK goals (animate ikTarget.<bone>.x / .y with set_keyframes, layer px; ikMode.<bone> 0 = FK, 1 = IK; each joint keeps the side it bends to here):', ...rig.ikTargets.map((t) => `- ${t.boneId} at (${r1(t.x)}, ${r1(t.y)})`)] : []),
    'FK: set_keyframes on bone.<id>.rotation — the LOCAL angle of the bone in degrees (the rest values above; a key replaces it) — or pose_skeleton. rig_cycle writes idle / wave / walk cycles on a biped. Check with render_rig_view at a few times.',
  ];
  return { ok: true, text: lines.join('\n') };
}

// ── render_rig_view's geometry ─────────────────────────────────────────

export interface RigView {
  time: number;
  /** The comp region the image shows (the layer box with a margin), comp px. */
  crop: Box;
  /** Layer-local → comp: comp = o + x·ex + y·ey. */
  affine: { o: Pt; ex: Pt; ey: Pt };
  box: Box;
  gridStep: number;
  bones: { id: string; root: Pt; tip: Pt }[];
  pins: { id: string; name: string; x: number; y: number }[];
  ik: { bone: string; x: number; y: number; pole: Pt | null; mode: string }[];
  text: string;
}

/** A round grid step giving about `lines` lines across `span`. */
export function niceStep(span: number, lines = 10): number {
  const raw = span / Math.max(1, lines);
  const p = 10 ** Math.floor(Math.log10(Math.max(1e-6, raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

export async function rigViewData(ctx: ToolContext, rawArgs: unknown): Promise<RigView | { error: string }> {
  const a = obj(rawArgs);
  const layer = resolveAlias(ctx, String(a.layerId ?? a.nodeId ?? ''));
  if (!(await ctx.scene.has(layer))) return { error: `No layer '${layer}' (describe_scene).` };
  const t = isNum(a.time) ? Math.max(0, a.time) : ctx.comp.playhead();
  const geom = await layerFrameGeometry(ctx, layer, t);
  if (!geom) return { error: `'${layer}' has no drawn area at ${t}s.` };
  const { crop, box, affine: { o, ex, ey } } = geom;

  const skel = await readSkeleton(ctx, layer);
  const len = new Map((skel?.bones ?? []).map((b) => [b.id, b.length] as const));
  const bones: RigView['bones'] = [];
  const ik: RigView['ik'] = [];
  if (skel) {
    const pose = await ctx.engine.query({ type: 'getRigPose', layer, time: secondsToFlicks(t), points: [] } as never) as {
      bones?: { id: string; world: number[] }[];
      ik?: { bone: string; x: number; y: number; pole: number[]; mode: string }[];
    };
    for (const b of pose.bones ?? []) {
      const [ma = 1, mb = 0, , , me = 0, mf = 0] = b.world;
      const l = len.get(b.id) ?? 0;
      bones.push({ id: b.id, root: { x: me, y: mf }, tip: { x: ma * l + me, y: mb * l + mf } });
    }
    for (const g of pose.ik ?? []) ik.push({ bone: g.bone, x: g.x, y: g.y, pole: g.pole.length >= 2 ? { x: g.pole[0]!, y: g.pole[1]! } : null, mode: g.mode });
  }
  const puppet = await storedJson(ctx, layer, 'layer/puppet');
  const pins = (Array.isArray(puppet?.pins) ? puppet.pins as Record<string, unknown>[] : [])
    .filter((p) => isNum(p.x) && isNum(p.y))
    .map((p) => ({ id: String(p.id ?? ''), name: String(p.name ?? p.id ?? ''), x: p.x as number, y: p.y as number, kind: typeof p.kind === 'string' ? p.kind : 'advanced' }));
  // The mesh itself is not drawable here (no mesh query); its settings and size are reported.
  const meshNote = puppet
    ? `Puppet mesh: ${String(puppet.meshMode ?? 'silhouette')}, density ${String(puppet.meshDensity ?? 'default')}, expansion ${String(puppet.meshExpansion ?? 0)}px, solver ${String(puppet.solver ?? 'arap')}` +
      (isNum(puppet.maxRotationDeg) ? `, max rotation ${puppet.maxRotationDeg}°` : '') + '. The mesh and bone weights are not drawn (the Rigging panel shows them).'
    : '';

  const gridStep = niceStep(Math.max(box.width, box.height));
  const r1 = (v: number): number => Math.round(v);
  const text = [
    `Rig view of '${layer}' at ${t.toFixed(2)}s. Grid labels are LAYER-LOCAL px — the space create_puppet_rig pins, rig_character joints / chains, IK goals and bone x/y use. Grid every ${gridStep}px.`,
    `Layer box: x ${r1(box.x)}…${r1(box.x + box.width)}, y ${r1(box.y)}…${r1(box.y + box.height)}.`,
    bones.length ? `Bones (root → tip, posed): ${bones.map((b) => `${b.id} (${r1(b.root.x)},${r1(b.root.y)})→(${r1(b.tip.x)},${r1(b.tip.y)})`).join('; ')}` : 'No skeleton.',
    ik.length ? `IK goals: ${ik.map((g) => `${g.bone} (${r1(g.x)},${r1(g.y)}) ${g.mode}`).join('; ')}` : '',
    pins.length ? `Puppet pins (rest): ${pins.map((p) => `${p.id} '${p.name}' ${p.kind} (${r1(p.x)},${r1(p.y)})`).join('; ')}` : 'No puppet pins.',
    meshNote,
  ].filter(Boolean).join('\n');
  return { time: t, crop, affine: { o, ex, ey }, box, gridStep, bones, pins, ik, text };
}

// ── rig_cycle ──────────────────────────────────────────────────────────

const DEG = 180 / Math.PI;

interface Key { prop: string; t: number; value: number }

function wrapDeg(d: number): number {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
}

/** A bone's rest world angle, degrees (the sum of its chain's local rotations; bones are unscaled). */
export function worldDeg(rig: SkeletonRig, id: string | null): number {
  let a = 0;
  const byId = new Map(rig.bones.map((b) => [b.id, b] as const));
  for (let b = id ? byId.get(id) : undefined, guard = 0; b && guard < 64; b = b.parentId ? byId.get(b.parentId) : undefined, guard++) a += b.rotation;
  return a * DEG;
}

/**
 * Cycles for a biped made by rig_character / Auto-Rig: keys at quarter
 * phases, eased in and out, repeated over the span. Offsets are relative to
 * the rest pose; amounts scale with `amount` (1 = a natural default).
 */
export function cycleKeys(rig: SkeletonRig, o: { cycle: 'idle' | 'wave' | 'walk'; startSec: number; durationSec: number; periodSec: number; amount: number; side: 'l' | 'r'; height: number }): Key[] {
  const rest = new Map(rig.bones.map((b) => [b.id, b] as const));
  const has = (id: string): boolean => rest.has(id);
  const restDeg = (id: string): number => (rest.get(id)?.rotation ?? 0) * DEG;
  const keys: Key[] = [];
  const steps = Math.max(1, Math.round(o.durationSec / o.periodSec * 4));
  const dt = o.durationSec / steps;
  const wave = (k: number, phase: number): number => Math.sin(((k / 4) + phase) * 2 * Math.PI);
  for (let k = 0; k <= steps; k++) {
    const t = o.startSec + k * dt;
    const A = o.amount;
    if (o.cycle === 'idle') {
      if (has('chest')) keys.push({ prop: 'bone.chest.rotation', t, value: restDeg('chest') + 1.5 * A * wave(k, 0) });
      if (has('head')) keys.push({ prop: 'bone.head.rotation', t, value: restDeg('head') + 2.5 * A * wave(k, 0.15) });
      if (has('hips')) keys.push({ prop: 'bone.hips.y', t, value: (rest.get('hips')?.y ?? 0) + o.height * 0.004 * A * wave(k, 0.25) });
    } else if (o.cycle === 'wave') {
      const up = `arm_${o.side}_upper`, low = `arm_${o.side}_lower`;
      if (!has(up) || !has(low)) continue;
      // The upper arm raised up and out on its screen side (world −50° / −130°,
      // y down), as a local angle under the chest; the forearm swings toward the head.
      const sign = o.side === 'r' ? -1 : 1;
      const world = o.side === 'r' ? -50 : -130;
      keys.push({ prop: `bone.${up}.rotation`, t, value: wrapDeg(world - worldDeg(rig, rest.get(up)?.parentId ?? null)) });
      keys.push({ prop: `bone.${low}.rotation`, t, value: sign * (30 + 25 * A * wave(k, 0)) });
    } else {
      // In place, front view: alternate foot lifts (IK goals), a hip bob at each contact, arms swinging against the legs.
      for (const [leg, phase] of [['leg_l', 0], ['leg_r', 0.5]] as const) {
        const goal = rig.ikTargets?.find((g) => g.boneId === `${leg}_lower`);
        if (!goal) continue;
        const lift = Math.max(0, wave(k, phase));
        keys.push({ prop: `ikTarget.${leg}_lower.y`, t, value: goal.y - o.height * 0.06 * A * lift });
      }
      if (has('hips')) keys.push({ prop: 'bone.hips.y', t, value: (rest.get('hips')?.y ?? 0) + o.height * 0.01 * A * Math.abs(wave(k, 0)) });
      for (const [arm, phase] of [['arm_l', 0.5], ['arm_r', 0]] as const) {
        if (has(`${arm}_upper`)) keys.push({ prop: `bone.${arm}_upper.rotation`, t, value: restDeg(`${arm}_upper`) + 14 * A * wave(k, phase) });
      }
    }
  }
  return keys;
}

export async function rigCycle(ctx: ToolContext, rawArgs: unknown): Promise<{ ok: boolean; text: string }> {
  const a = obj(rawArgs);
  const layer = resolveAlias(ctx, String(a.layerId ?? ''));
  if (!(await ctx.scene.has(layer))) return { ok: false, text: `No layer '${layer}' (describe_scene).` };
  const rig = await readSkeleton(ctx, layer);
  if (!rig) return { ok: false, text: `'${layer}' has no skeleton. rig_character it first.` };
  const cycle = a.cycle === 'wave' || a.cycle === 'walk' ? a.cycle : a.cycle === 'idle' ? 'idle' : null;
  if (!cycle) return { ok: false, text: 'cycle must be idle, wave or walk.' };
  const comp = await ctx.comp.get();
  const startSec = Math.max(0, isNum(a.startSec) ? a.startSec : 0);
  const durationSec = Math.max(0.2, Math.min(comp.durationSeconds - startSec, isNum(a.durationSec) ? a.durationSec : comp.durationSeconds - startSec));
  const periodSec = Math.max(0.2, isNum(a.periodSec) ? a.periodSec : cycle === 'idle' ? 3 : cycle === 'walk' ? 1 : 0.8);
  const amount = Math.max(0, Math.min(3, isNum(a.amount) ? a.amount : 1));
  const side = a.side === 'l' ? 'l' : 'r';
  const box = await layerBox(ctx, layer, startSec);
  const keys = cycleKeys(rig, { cycle, startSec, durationSec, periodSec, amount, side, height: box?.height ?? 400 });
  if (keys.length === 0) return { ok: false, text: `The rig has none of the bones a ${cycle} drives (biped ids: hips, chest, head, arm_l/r_upper/lower, leg_l/r_upper/lower — rig_character preset "biped").` };
  // An arm or leg the cycle poses by rotation must be FK for the span; IK for the walk's legs.
  const modes: Key[] = [];
  if (cycle === 'wave') modes.push({ prop: `ikMode.arm_${side}_lower`, t: startSec, value: 0 });
  if (cycle === 'walk') for (const arm of ['arm_l', 'arm_r']) if (rig.ikTargets?.some((g) => g.boneId === `${arm}_lower`)) modes.push({ prop: `ikMode.${arm}_lower`, t: startSec, value: 0 });
  const all = [...modes, ...keys];
  const rejected = new Set<string>();
  for (const k of all) {
    if (rejected.has(k.prop)) continue;
    if (!(await ctx.anim.isValidProp(layer, k.prop))) { rejected.add(k.prop); continue; }
  }
  const usable = all.filter((k) => !rejected.has(k.prop));
  const write = usable.map((k) => ({ nodeId: layer, prop: k.prop, t: k.t, value: k.value, easing: k.prop.startsWith('ikMode.') ? 'step' : 'easeInOut' }));
  if (ctx.anim.setKeyframes) await ctx.anim.setKeyframes(write);
  else for (const k of write) await ctx.anim.setKeyframe(k.nodeId, k.prop, k.t, k.value, k.easing);
  const props = [...new Set(usable.map((k) => k.prop))];
  return {
    ok: true,
    text: [
      `Wrote a ${cycle} cycle on '${layer}': ${usable.length} keys on ${props.length} track(s), ${startSec.toFixed(2)}–${(startSec + durationSec).toFixed(2)}s, period ${periodSec}s, amount ${amount}.`,
      `Tracks: ${props.join(', ')}.`,
      ...(rejected.size ? [`Skipped (not tracks of this rig): ${[...rejected].join(', ')}.`] : []),
      'Refine with read_tracks / set_keyframes / set_easing; look with render_rig_view or render_motion_sheet.',
    ].join('\n'),
  };
}
