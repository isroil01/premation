/* eslint-disable no-restricted-syntax -- F11 (`.props` writes mutate a copy):
 * every write here is to a node LITERAL that `makeNode` has just built and
 * `addChild` has not yet taken, so there is no copy to be discarded — the same
 * construct `sceneInsert`'s own insert helpers use. Nothing in this file reads a
 * node back with `getNode()` and mutates its props; the two places that change
 * an already-inserted node go through the scene-graph API (`setSolid`,
 * `setFxKey`, `setNodeMatte`) precisely because that one is not safe.
 */

/**
 * Realise an import plan in the live editor.
 *
 * The thin, impure half: everything that decides *what* the project becomes
 * already happened in `aepPlan.ts`, and this builds it. Kept deliberately
 * mechanical so the interesting failures are all in the pure layer, where a
 * test can reach them.
 *
 * ## Order is the whole design
 *
 * 1. **Every composition first, empty.** A layer can reference a comp declared
 *    after it in the file, and a comp layer needs its target to exist before it
 *    can point at one. Minting all the comps up front removes the ordering
 *    problem entirely instead of sorting for it.
 * 2. **Footage, relinked.** Each path is read from disk once and becomes one
 *    asset, shared by every layer that used it — a logo used in nine comps is
 *    one library entry, as it was in AE.
 * 3. **Layers, bottom of the stack first.** AE's layer 1 is on top and this
 *    scene graph paints later siblings last, so each comp's list is walked in
 *    reverse. Parenting and track mattes then run as separate passes, because
 *    both can point at a layer that is created after them.
 * 4. **Keyframes in one batch.** `setKeyframes` re-sorts and notifies per call;
 *    a project with ten thousand of them would otherwise spend the import
 *    re-rendering the timeline.
 *
 * ## Missing footage is imported, not skipped
 *
 * A path that cannot be read still produces its layer, at the right size, in
 * the right place, with its animation — carrying the original path so the
 * existing relink flow can find it later. A missing file should cost the user a
 * relink, never the work built around it.
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { makeNode } from '@core/scene/sceneInsert';
import { addCompositionRecord } from '@core/composition/compositionOps';
import { useProjectStore } from '@stores/projectStore';
import { bumpScene } from '@stores/sceneStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { addEffect, updateEffectParam, effectPropPath, getNodeEffects, type EffectType } from '@core/effects/effects';
import { addMaskPath, type MaskMode, type MaskPath } from '@core/effects/mask';
import { setNodeMatte } from '@core/effects/matte';
import { setNodeBlend, isBlendMode } from '@core/effects/blendMode';
import { setNodeLabelColor } from '@core/scene/labelColor';
import { toggleLayerFlag } from '@core/scene/layerFlags';
import { setGuideLayer } from '@core/scene/guideLayer';
import { setNodeMotionBlur } from '@core/effects/motionBlur';
import { importMediaFile, canImportFromDisk, fileNameOf } from '@core/assets/local/importFromDisk';
import { COMP_REF_PROP } from '@core/scene/compInstance';
import { shortId } from '@utils/lang';
import type { ImportedAsset } from '@stores/assetStore';
import type { SceneNode } from '@core/types';
import type { AepImportPlan, PlannedComp, PlannedLayer } from './aepPlan';

/** AE's label-colour indices, in AE's own palette order. */
const LABEL_COLORS: readonly string[] = [
  '', '#b4655a', '#e0e04a', '#6ad4d4', '#e09fd4', '#b4a0e0', '#e0b48c', '#7fd4b4',
  '#5a8cd4', '#5ab45a', '#8c5ad4', '#e08c3c', '#8c6a4a', '#d45ab4', '#4ad4e0', '#d4c8a0', '#3c7a3c',
];

export interface AepApplyResult {
  /** AE comp id → the composition created for it. */
  compIds: Map<number, string>;
  /** The comp the editor should open — the longest one, see `mainComp`. */
  openCompId: string | null;
  nodeCount: number;
  /** Footage paths that could not be read; the layers exist and need relinking. */
  missingFootage: string[];
  warnings: string[];
}

/**
 * Which comp to open once the import lands.
 *
 * AE has no "main comp" flag, so this uses the same heuristic a person does
 * when they open someone else's project: the one nothing else contains, and
 * among those the longest. A render comp is almost always both.
 */
function mainComp(plan: AepImportPlan): PlannedComp | undefined {
  const used = new Set<number>();
  for (const comp of plan.comps) {
    for (const layer of comp.layers) {
      if (layer.source?.kind === 'comp') used.add(layer.source.aepId);
    }
  }
  const roots = plan.comps.filter((c) => !used.has(c.aepId));
  const candidates = roots.length > 0 ? roots : plan.comps;
  return [...candidates].sort((a, b) => b.durationSeconds - a.durationSeconds || b.width - a.width)[0];
}

/** The transform component every `makeNode` result carries. */
function transformOf(node: SceneNode): { id: string; props: Record<string, unknown> } | undefined {
  return node.components.find((c) => c.type === 'Transform') as
    | { id: string; props: Record<string, unknown> }
    | undefined;
}

/**
 * Resolve every distinct footage path to a library asset, once.
 *
 * Sequential rather than parallel on purpose: each import reads a whole file
 * over IPC and decodes it to probe its size, and twenty of those at once on a
 * project full of 4K plates is how an import turns into a beachball.
 */
async function importFootage(
  plan: AepImportPlan,
  missing: string[],
): Promise<Map<number, ImportedAsset>> {
  const assets = new Map<number, ImportedAsset>();
  if (!canImportFromDisk()) {
    for (const f of plan.footage) if (f.path) missing.push(f.path);
    return assets;
  }

  // One import per PATH, not per item: AE lists a file once, but a project that
  // imported the same plate twice has two items pointing at one file.
  const byPath = new Map<string, ImportedAsset | null>();
  for (const item of plan.footage) {
    if (item.kind !== 'file' || !item.path) continue;
    if (!byPath.has(item.path)) {
      byPath.set(item.path, await importMediaFile(item.path));
    }
    const asset = byPath.get(item.path) ?? null;
    if (asset) assets.set(item.aepId, asset);
    else if (!missing.includes(item.path)) missing.push(item.path);
  }
  return assets;
}

/** Build one layer's node, unparented, with its static props written. */
function createNode(
  layer: PlannedLayer,
  comp: PlannedComp,
  assets: Map<number, ImportedAsset>,
  footageByAepId: Map<number, AepImportPlan['footage'][number]>,
  compIds: Map<number, string>,
): SceneNode {
  // A solid is a shape the engine flags as one; a placed comp is a `comp` node
  // carrying its reference. Everything else maps straight onto a node kind.
  const kind =
    layer.kind === 'solid' ? 'shape' : layer.kind === 'comp' ? 'comp' : layer.kind;
  const node = makeNode(kind as Parameters<typeof makeNode>[0], layer.name);
  const t = transformOf(node);
  if (!t) return node;

  for (const [key, value] of Object.entries(layer.staticProps)) t.props[key] = value;

  // Text belongs to the Text component, not the transform. Writing `content`
  // onto the transform is accepted silently and read by nothing, so an imported
  // text layer arrives saying "Text" — the placeholder `makeNode` seeded it
  // with — while every number on it is right.
  if (layer.text) {
    const text = node.components.find((c) => c.type === 'Text');
    if (text) {
      text.props.content = layer.text.text;
      if (layer.text.fontSize) text.props.fontSize = layer.text.fontSize;
      if (layer.text.font) text.props.fontFamily = layer.text.font;
      if (layer.text.faux?.bold) text.props.fontWeight = 700;
      if (layer.text.faux?.italic) text.props.fontStyle = 'italic';
      if (layer.text.justification) text.props.align = layer.text.justification;
      // AE measures tracking in thousandths of an em; this editor measures
      // letter spacing in pixels, so it only means anything against the size.
      if (layer.text.tracking) {
        text.props.letterSpacing = (layer.text.tracking / 1000) * (layer.text.fontSize ?? 32);
      }
      const fill = layer.text.fillColor;
      if (fill) {
        text.props.fill = `#${[fill.r, fill.g, fill.b]
          .map((c) => Math.max(0, Math.min(255, Math.round(c * 255))).toString(16).padStart(2, '0'))
          .join('')}`;
      }
    }
  }

  const source = layer.source;
  const footage = source?.kind === 'footage' ? footageByAepId.get(source.aepId) : undefined;
  // The layer's own box. AE draws footage at its native size and scales it with
  // the transform, so the box is the SOURCE's size — fitting it to the comp
  // here would double-apply a scale the file already states.
  const width = footage?.width || (source?.kind === 'comp' ? undefined : comp.width);
  const height = footage?.height || (source?.kind === 'comp' ? undefined : comp.height);
  if (width) t.props.width = width;
  if (height) t.props.height = height;

  if (source?.kind === 'footage') {
    const asset = assets.get(source.aepId);
    if (asset) {
      t.props.src = asset.src;
      t.props.assetId = asset.id;
      t.props.width = asset.metadata?.width ?? t.props.width;
      t.props.height = asset.metadata?.height ?? t.props.height;
    } else if (footage?.path) {
      // No asset, but keep the path: this is exactly the shape `missingAssets`
      // looks for, so the layer shows up in the relink flow rather than being
      // an untraceable blank.
      t.props.src = footage.path;
      t.props.missingSrc = footage.path;
    }
  }

  if (layer.solidColor) t.props.fill = layer.solidColor;

  if (source?.kind === 'comp') {
    const refId = compIds.get(source.aepId);
    if (refId) {
      node.components.push({
        id: `${node.id}_fx`,
        type: 'fx',
        props: { precomp: true, [COMP_REF_PROP]: refId, ...(layer.flags.collapse ? { compCollapse: true } : {}) },
      });
    }
  }

  node.transform.position.x = Number(t.props.x ?? 0);
  node.transform.position.y = Number(t.props.y ?? 0);
  node.visible = layer.flags.enabled;
  node.locked = layer.flags.locked;
  return node;
}

/** Masks, effects, blend, label, matte — everything that is not a prop write. */
function decorate(nodeId: string, layer: PlannedLayer, warnings: string[]): void {
  if (layer.solidColor) defaultSceneGraph.setSolid(nodeId, true);

  for (const mask of layer.masks) {
    const path: MaskPath = {
      id: `aep_mask_${shortId()}`,
      name: mask.name,
      mode: mask.mode as MaskMode,
      closed: mask.closed,
      points: mask.points,
      feather: mask.feather,
      opacity: mask.opacity,
      expansion: mask.expansion,
      inverted: mask.inverted,
    };
    addMaskPath(nodeId, path);
  }

  for (const effect of layer.effects) {
    // The id is minted here rather than read back: `addEffect` returns nothing,
    // and re-reading the layer's effect list to find "the one just added" is
    // ambiguous the moment a layer carries two of the same effect — which AE
    // projects do constantly (three blurs, two glows).
    const effectId = `aep_fx_${shortId()}`;
    addEffect(nodeId, effect.type as EffectType, effectId);
    const added = getNodeEffects(nodeId).some((e) => e.id === effectId);
    if (!added) {
      warnings.push(`"${layer.name}": the ${effect.type} effect could not be added`);
      continue;
    }
    for (const [key, value] of Object.entries(effect.params)) {
      updateEffectParam(nodeId, effectId, key, value);
    }
    for (const track of effect.tracks) {
      defaultAnimation.setKeyframes(nodeId, effectPropPath(effectId, track.prop), track.keyframes);
    }
  }

  if (isBlendMode(layer.blendMode)) setNodeBlend(nodeId, layer.blendMode);
  const label = LABEL_COLORS[layer.label];
  if (label) setNodeLabelColor(nodeId, label);

  const node = defaultSceneGraph.getNode(nodeId);
  if (node && layer.flags.solo) node.solo = true;

  // Each switch through the API that owns it. They are stored three different
  // ways — a node field, a component, an `fx` key — and writing a guessed key
  // straight onto the node produces a switch that reads back false, saves as
  // nothing, and cannot be undone.
  if (layer.flags.shy) toggleLayerFlag(nodeId, 'shy', true);
  if (layer.flags.guide) setGuideLayer(nodeId, true);
  if (layer.flags.motionBlur) setNodeMotionBlur(nodeId, true);
}

/**
 * Apply the plan.
 *
 * Async because footage is read from disk; everything else is synchronous, and
 * the scene is only bumped once at the end so the viewport re-renders a
 * finished project rather than every intermediate state of one.
 */
export async function applyAepPlan(plan: AepImportPlan): Promise<AepApplyResult> {
  const warnings = [...plan.warnings];
  const missingFootage: string[] = [];

  // 1 — every comp, empty, so anything can reference anything.
  const compIds = new Map<number, string>();
  for (const comp of plan.comps) {
    const id = addCompositionRecord({
      name: comp.name,
      width: comp.width,
      height: comp.height,
      fps: comp.fps,
      durationSeconds: comp.durationSeconds,
      background: comp.background,
    });
    compIds.set(comp.aepId, id);
  }

  // 2 — footage.
  const assets = await importFootage(plan, missingFootage);
  const footageByAepId = new Map(plan.footage.map((f) => [f.aepId, f]));

  // 3 — layers.
  const nodeByUid = new Map<string, string>();
  const tracks: Array<{ nodeId: string; prop: string; keyframes: PlannedLayer['tracks'][number]['keyframes'] }> = [];
  let nodeCount = 0;

  for (const comp of plan.comps) {
    const rootId = compIds.get(comp.aepId);
    if (!rootId) continue;
    // Reversed: AE's first layer is the top one, and a later sibling paints over
    // an earlier one here.
    for (const layer of [...comp.layers].reverse()) {
      const node = createNode(layer, comp, assets, footageByAepId, compIds);
      defaultSceneGraph.addChild(rootId, node);
      nodeByUid.set(layer.uid, node.id);
      nodeCount += 1;
      decorate(node.id, layer, warnings);
      for (const track of layer.tracks) {
        tracks.push({ nodeId: node.id, prop: track.prop, keyframes: track.keyframes });
      }
    }
  }

  // 4 — keyframes, in one batch and one notification.
  defaultAnimation.batch(() => {
    for (const t of tracks) defaultAnimation.setKeyframes(t.nodeId, t.prop, t.keyframes);
  });

  // 5 — parenting. A second pass because a parent may be BELOW its child in the
  // stack and therefore created after it. `preserveWorld: false` because the
  // plan's transforms are already parent-relative, exactly as AE stores them;
  // the world-preserving reparent would cancel the parent out and collapse the
  // child back to raw comp coordinates.
  for (const comp of plan.comps) {
    for (const layer of comp.layers) {
      if (!layer.parentUid) continue;
      const childId = nodeByUid.get(layer.uid);
      const parentId = nodeByUid.get(layer.parentUid);
      // `preserveWorld: false` is load-bearing. The default compensates the
      // child's local transform so it does not move on screen — correct when a
      // user drags a layer onto a parent, and wrong here, because AE already
      // stores the child's transform RELATIVE to that parent. Compensating
      // cancels the parent out and collapses the child back to raw comp
      // coordinates, which for a parented rig means every part lands on top of
      // the one it was offset from.
      if (childId && parentId) defaultSceneGraph.setParent(childId, parentId, { preserveWorld: false });
    }
  }

  // 6 — track mattes. Also a second pass: AE's pre-23 convention is "the layer
  // directly above", which can only be resolved once the stack exists.
  for (const comp of plan.comps) {
    comp.layers.forEach((layer, index) => {
      if (!layer.matte) return;
      const nodeId = nodeByUid.get(layer.uid);
      if (!nodeId) return;
      const aboveUid = layer.matte.sourceUid ?? comp.layers[index - 1]?.uid;
      const sourceId = aboveUid ? nodeByUid.get(aboveUid) : undefined;
      setNodeMatte(nodeId, {
        mode: layer.matte.mode,
        inverted: layer.matte.inverted,
        ...(sourceId ? { sourceId } : {}),
      });
    });
  }

  // 7 — timeline bars. Each comp's timeline is built from its own scene, then
  // each layer's bar trimmed to the window AE gave it.
  const controller = getTimelineController();
  for (const comp of plan.comps) {
    const compId = compIds.get(comp.aepId);
    if (!compId) continue;
    controller.syncFromScene(compId);
    for (const layer of comp.layers) {
      const nodeId = nodeByUid.get(layer.uid);
      if (!nodeId) continue;
      const clip = controller.getLayersForNode(nodeId)[0];
      if (!clip) continue;
      const { inSec, outSec } = layer.timing;
      if (outSec <= inSec) continue; // never visible; leave the bar whole
      controller.trimClipTo(clip.id, 'end', outSec);
      controller.trimClipTo(clip.id, 'start', inSec);
    }
  }
  controller.invalidateLayerIndex();

  // 8 — open the comp a person would have opened.
  const main = mainComp(plan);
  const openCompId = main ? compIds.get(main.aepId) ?? null : null;
  if (openCompId && main) {
    useProjectStore.getState().actions.openTab(openCompId, [openCompId], main.name);
    getTimelineController().syncFromScene(openCompId);
  }

  if (missingFootage.length > 0) {
    warnings.push(
      `${missingFootage.length} footage file${missingFootage.length === 1 ? '' : 's'} could not be found: ` +
        `${missingFootage.slice(0, 5).map(fileNameOf).join(', ')}${missingFootage.length > 5 ? '…' : ''}. ` +
        'Those layers were kept and can be relinked.',
    );
  }

  bumpScene();
  return { compIds, openCompId, nodeCount, missingFootage, warnings };
}
