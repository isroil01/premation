/**
 * Layer facts the Inspector's compositing, motion and 3D sections show, over
 * the document MIRROR (B4) — the twins of `getNodeMatte`, `readAutoOrientMode`,
 * `canAutoOrient`, `canBe3D`, `hasPathTangents`, `readNodeMaterial`,
 * `getNodeFaceMaterials`, `readNodeLayerStyles` (the overlays a surface colour
 * is shaded through), `readNodePolystar`, `readPathOps`, `readNodePrimitive`
 * and `ikChainFromTip`. Pure: they take a mirror reader and never touch the
 * engine.
 *
 * Where the editor has a NORMALISER for a stored record (a polystar config, a
 * path operator, a material, a primitive spec) the fields are gathered from
 * the layer's property tree and handed to that same normaliser as the one
 * component it reads, so the defaults and clamps stay single-sourced.
 */

import type { Keyframe, LayerInfo, PropertyInfo } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import type { TrackMatte } from '@core/effects/matte';
import type { AutoOrientMode } from '@core/scene/autoOrient';
import { AUTO_ORIENT_DEAD_KINDS } from '@core/scene/autoOrient';
import type { LayerStyles } from '@core/effects/layerStyles';
import type { FaceMaterials } from '@core/scene/faceMaterials';
import { readNodeMaterial, type MaterialOptions } from '@core/scene/material';
import { readNodePolystar, type Polystar } from '@core/scene/polystar';
import { readPathOps, type PathOp } from '@core/scene/pathOps';
import { readNodePrimitive, type PrimitiveSpec } from '@core/scene/primitiveLayer';
import { uiKindOf } from './layerKinds';
import { plainValue, type MirrorTreeLike } from './trackIndex';
import { channelsToHex } from './paintFields';
import { jsonField, type MirrorFieldRead } from './layerFields';

type FieldRead = Pick<MirrorFieldRead, 'layer' | 'property' | 'tree'>;

/** A record handed to an editor normaliser as the one component it reads (never written, never kept). */
function asNode(type: string, props: Record<string, unknown>): SceneNode {
  return { components: [{ id: `mirror:${type}`, type, props }] } as unknown as SceneNode;
}

/** The plain values of the direct property children of a tree group, keyed by their last path segment. */
function groupValues(tree: MirrorTreeLike | undefined, group: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const g = tree?.nodes.get(group);
  if (!g) return out;
  for (const p of g.children) {
    const info = tree!.nodes.get(p);
    if (!info || info.kind !== 'property') continue;
    out[p.slice(group.length + 1)] = plainValue(info.value);
  }
  return out;
}

// ── Compositing ──────────────────────────────────────────────────────

/** The layer's track matte in the editor's shape (the twin of `getNodeMatte`); undefined = none. */
export function mirrorMatte(layer: Pick<LayerInfo, 'matte'> | undefined): TrackMatte | undefined {
  const m = layer?.matte;
  if (!m || m.mode === 'none') return undefined;
  const mode = m.mode === 'luma' || m.mode === 'lumaInverted' ? 'luma' : 'alpha';
  const inverted = m.mode === 'alphaInverted' || m.mode === 'lumaInverted';
  return { mode, inverted, ...(m.layer ? { sourceId: m.layer } : {}) };
}

// ── Motion ───────────────────────────────────────────────────────────

/** Whether the layer has a Transform (the tree's `transform` group). */
export function mirrorHasTransform(tree: MirrorTreeLike | undefined): boolean {
  return !!tree?.nodes.has('transform');
}

/** The auto-orient mode in the editor's names (the twin of `readAutoOrientMode`). */
export function mirrorAutoOrientMode(layer: Pick<LayerInfo, 'switches'> | undefined): AutoOrientMode {
  const v = layer?.switches.autoOrient;
  if (v === 'alongPath') return 'path';
  if (v === 'towardsCamera') return 'camera';
  return 'off';
}

/** Whether Auto-Orient means anything on this layer (the twin of `canAutoOrient`). */
export function mirrorCanAutoOrient(layer: LayerInfo | undefined, tree: MirrorTreeLike | undefined): boolean {
  if (!layer || !mirrorHasTransform(tree)) return false;
  const kind = uiKindOf(layer);
  return kind !== null && !AUTO_ORIENT_DEAD_KINDS.has(kind);
}

/** Kinds that may live in 3D (threeD.ts `THREE_D_CAPABLE_KINDS`, not exported there). */
const THREE_D_CAPABLE_KINDS: ReadonlySet<string> = new Set(['shape', 'text', 'image', 'video', 'null', 'svg']);

/**
 * Whether the layer can be a 3D layer (the twin of `canBe3D`): a Transform and
 * a 3D-capable kind; a composition layer only while it is SEALED (a placed
 * composition that does not collapse its transformations).
 */
export function mirrorCanBe3D(layer: LayerInfo | undefined, tree: MirrorTreeLike | undefined): boolean {
  if (!layer || !mirrorHasTransform(tree)) return false;
  const kind = uiKindOf(layer);
  if (kind === 'comp') return !!layer.source && !layer.switches.collapse;
  return kind !== null && THREE_D_CAPABLE_KINDS.has(kind);
}

/** Position keys with spatial tangents or a non-linear spatial mode (the twin of `hasPathTangents`). */
export function mirrorHasPathTangents(m: { keyframes(layer: string, path: string): readonly Keyframe[] }, layer: string): boolean {
  const curved = (k: Keyframe): boolean =>
    k.spatialIn.length > 0 || k.spatialOut.length > 0 || (k.spatialInterp !== 'legacy' && k.spatialInterp !== 'linear');
  return ['transform/position', 'transform/position/x', 'transform/position/y'].some((p) => m.keyframes(layer, p).some(curved));
}

// ── Surfaces (3D) ────────────────────────────────────────────────────

/** Material Options (the twin of `readNodeMaterial(node)`), from the layer's `material/*` properties. */
export function mirrorMaterial(tree: MirrorTreeLike | undefined): MaterialOptions {
  const props: Record<string, unknown> = {};
  const g = tree?.nodes.get('material');
  for (const p of g?.children ?? []) {
    const info: PropertyInfo | undefined = tree!.nodes.get(p);
    // The match name IS the stored key (`shadingModel`, `displacementSubdiv`, `heightMapAssetId`…).
    if (info && info.kind === 'property') props[info.matchName] = plainValue(info.value);
  }
  return readNodeMaterial(asNode('Transform', props));
}

/** The per-face colour overrides (`material/faceMaterials`), {} when none. */
export function mirrorFaceMaterials(m: Pick<MirrorFieldRead, 'property'>, layer: string): FaceMaterials {
  const raw = jsonField<unknown>(m, layer, 'material/faceMaterials');
  return raw && typeof raw === 'object' ? (raw as FaceMaterials) : {};
}

/**
 * The overlay styles a surface colour is shaded through — Colour Overlay and
 * Gradient Overlay (`styledSurfaceFill`'s inputs), from `styles/<key>/<param>`.
 */
export function mirrorOverlayStyles(tree: MirrorTreeLike | undefined): LayerStyles {
  const out: LayerStyles = {};
  const num = (p: string, fb: number): number => {
    const v = plainValue(tree?.nodes.get(p)?.value);
    return typeof v === 'number' ? v : fb;
  };
  const hex = (p: string, fb: string): string => {
    const v = tree?.nodes.get(p)?.value;
    return v?.kind === 'color' ? channelsToHex(v.value) : fb;
  };
  const co = tree?.nodes.get('styles/colorOverlay');
  if (co) out.colorOverlay = { enabled: co.enabled, color: hex('styles/colorOverlay/color', '#000000'), opacity: num('styles/colorOverlay/opacity', 100) / 100 };
  const go = tree?.nodes.get('styles/gradientOverlay');
  if (go) {
    out.gradientOverlay = {
      enabled: go.enabled,
      from: hex('styles/gradientOverlay/colorA', '#ffffff'),
      to: hex('styles/gradientOverlay/colorB', '#000000'),
      opacity: num('styles/gradientOverlay/blend', 100) / 100,
      angle: num('styles/gradientOverlay/angle', 90),
    };
  }
  return out;
}

/** The primitive mesh spec (the twin of `readNodePrimitive`), null when the layer is not one. */
export function mirrorPrimitive(tree: MirrorTreeLike | undefined): PrimitiveSpec | null {
  if (!tree?.nodes.has('primitive')) return null;
  return readNodePrimitive(asNode('Primitive', groupValues(tree, 'primitive')));
}

// ── Shape contents ───────────────────────────────────────────────────

/** The layer's polystar (the twin of `readNodePolystar`), null when it has none. */
export function mirrorPolystar(tree: MirrorTreeLike | undefined): Polystar | null {
  if (!tree?.nodes.has('contents/polystar')) return null;
  const v = groupValues(tree, 'contents/polystar');
  const { type, ...rest } = v;
  return readNodePolystar(asNode('fx', { polystar: { ...rest, starType: type } }));
}

/** The layer's path operators in application order (the twin of `readPathOps`). */
export function mirrorPathOps(tree: MirrorTreeLike | undefined): PathOp[] {
  const contents = tree?.nodes.get('contents');
  if (!contents) return [];
  const raw: Array<Record<string, unknown>> = [];
  for (const p of contents.children) {
    const g = tree!.nodes.get(p);
    if (!g || !g.matchName.startsWith('pathop:')) continue;
    raw.push({ ...groupValues(tree, p), id: p.slice('contents/'.length), type: g.matchName.slice('pathop:'.length), enabled: g.enabled });
  }
  return raw.length > 0 ? readPathOps(asNode('fx', { pathOps: raw })) : [];
}

// ── Rigging (3D IK) ──────────────────────────────────────────────────

/**
 * The 3D IK chain ending at `tipId`, root → tip (the twin of `ikChainFromTip`):
 * consecutive 3D layers up the parent chain, stopping at an imported model's
 * root, at most `maxJoints` long.
 */
export function mirrorIkChainFromTip(m: FieldRead, tipId: string, maxJoints = 8): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  for (let id: string | null = tipId; id && !seen.has(id) && chain.length < maxJoints; ) {
    seen.add(id);
    const l = m.layer(id);
    if (!l || !l.switches.threeD) break;
    chain.unshift(id);
    if (isModelRoot(m, l)) break; // the imported root anchors the rig
    id = l.parent ?? null;
  }
  return chain;
}

/**
 * An imported model's ROOT (the layer holding the model file, `readNodeModelSource`):
 * a model layer that is not a primitive mesh and whose parent is not part of the
 * same import (every node of an import is a model layer).
 */
function isModelRoot(m: FieldRead, l: LayerInfo): boolean {
  if (l.kind !== 'model3d' || m.tree(l.id)?.nodes.has('primitive')) return false;
  const up = l.parent ? m.layer(l.parent) : undefined;
  return !up || up.kind !== 'model3d';
}

/** A layer's static field as a plain number, `fb` when absent. */
export function mirrorNumber(m: Pick<MirrorFieldRead, 'property'>, layer: string, path: string, fb: number): number {
  const v = plainValue(m.property(layer, path)?.value);
  return typeof v === 'number' && Number.isFinite(v) ? v : fb;
}
