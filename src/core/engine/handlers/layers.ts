/** Layers family (ENGINE_API.md §4.4). */

import { defaultAnimation, type NodeAnimSnapshot } from '@motion/animation';
import type { LayerSwitchesPatch, DocumentFragment } from '@motion/engine-api';
import { useProjectStore, type CompositionSettings } from '@stores/projectStore';
import { useAssetStore } from '@stores/assetStore';
import { canReparent, reparentNode, setParentPreservingWorld } from '@core/scene/parenting';
import { deleteLayerNode } from '@core/scene/deleteLayerNode';
import { cloneLayerNode } from '@core/scene/cloneLayerNode';
import { layerFlagAvailable } from '@core/scene/layerFlags';
import { set3DEnabled } from '@core/scene/threeD';
import { setGuideLayer } from '@core/scene/guideLayer';
import { setCompCollapse } from '@core/scene/precomp';
import { setContinuousRaster } from '@core/scene/continuousRaster';
import { collapseSwitchKind } from '@core/scene/layerFlags';
import { readCompRef, wouldCreateCompCycle, COMP_REF_PROP } from '@core/scene/compInstance';
import { setNodeFxEnabled } from '@core/effects/effects';
import { setNodeMotionBlur } from '@core/effects/motionBlur';
import { setNodeAdjustment } from '@core/effects/adjustment';
import { setNodePreserveTransparency } from '@core/effects/preserveTransparency';
import { setNodeQuality } from '@core/effects/layerQuality';
import { updateNodeLayerTime } from '@core/scene/layerTime';
import { setAutoOrientMode } from '@core/scene/autoOrient';
import { isBlendMode, setNodeBlend, type LayerBlendMode } from '@core/effects/blendMode';
import { setNodeMatte } from '@core/effects/matte';
import { VIDEO_AUDIO_MUTED_PROP } from '@core/audio/audioScene';
import { readNodeKind } from '@core/scene/sceneDerive';
import { getTimelineController } from '@core/timeline/TimelineController';
import { writeTransformProps } from '@core/scene/transformWrite';
import type { SceneNode } from '@core/types';
import { fail, check } from '../errors';
import { canonicalStringify } from '../canonical';
import { graph, compOfLayer, requireLayer, requireComp, layerIdsOfComp, isCompItem, apiParentOf } from '../doc';
import { K, documentScope, newScope, scopeLayer, scopeTimeline } from '../state';
import { catalogFor, requireBinding, writeStatic } from '../props';
import { labelColorOf, barsOf } from '../model';
import { flicksToFrames, compFps, checkTime, flicksToSeconds } from '../time';
import type { HandlerTable, HandlerCtx } from '../handler';
import { ensureTimeline, geomsOf, writeGeoms, layersScope, requireLayersInOneComp, moveInStack, plural, remintKeyIds } from './common';
import { makeLayerNode } from './layerFactory';

function compSettingsRecord(comp: string): CompositionSettings {
  const c = useProjectStore.getState().comps[comp];
  if (!c) fail('notFound', `no composition '${comp}'`, { item: comp });
  return c;
}

/** Validate a timing triple against the comp and write the new layer's bar. */
function applyInitialTiming(comp: string, id: string, inPoint?: number, outPoint?: number, startTime?: number): void {
  if (inPoint === undefined && outPoint === undefined && startTime === undefined) return;
  const fps = compFps(comp);
  const cur = geomsOf(id, comp)[0];
  if (!cur) return;
  const start = inPoint !== undefined ? flicksToFrames(inPoint, fps) : cur.start;
  const end = outPoint !== undefined ? flicksToFrames(outPoint, fps) : cur.start + cur.duration;
  const origin = startTime !== undefined ? flicksToFrames(startTime, fps) : start - cur.sourceIn;
  writeGeoms(comp, id, [{ ...cur, start, duration: Math.max(1, end - start), sourceIn: Math.max(0, start - origin) }]);
}

function validateTiming(inPoint?: number, outPoint?: number, startTime?: number): void {
  for (const [v, n] of [[inPoint, 'inPoint'], [outPoint, 'outPoint'], [startTime, 'startTime']] as const) if (v !== undefined) checkTime(v, n);
  if (inPoint !== undefined && outPoint !== undefined && outPoint <= inPoint) fail('invalidArgument', 'outPoint must be after inPoint');
}

/** Children of `id` that are not themselves being removed: un-parent them keeping their world transform. */
function orphanChildren(id: string, doomed: Set<string>): void {
  const node = graph.getNode(id);
  if (!node) return;
  const target = node.parent ?? compOfLayer(id);
  for (const child of [...graph.getChildOrder(id)]) {
    if (doomed.has(child) || !target) continue;
    setParentPreservingWorld(child, target);
  }
}

export const layerHandlers: HandlerTable = {
  createLayer: (cmd, ctx) => {
    requireComp(cmd.comp);
    const settings = compSettingsRecord(cmd.comp);
    validateTiming(cmd.inPoint, cmd.outPoint, cmd.startTime);
    let asset;
    let refComp;
    if (['image', 'video', 'audio', 'svg', 'sequence'].includes(cmd.kind)) {
      if (!cmd.source) fail('invalidArgument', `a ${cmd.kind} layer needs a source item`);
      asset = useAssetStore.getState().assets.find((a) => a.id === cmd.source);
      if (!asset) fail('notFound', `no footage item '${cmd.source}'`, { item: cmd.source });
    }
    if (cmd.kind === 'precomp') {
      if (!cmd.source || !isCompItem(cmd.source)) fail('notFound', `no composition '${cmd.source ?? ''}'`, { item: cmd.source });
      if (wouldCreateCompCycle(graph, cmd.comp, cmd.source)) fail('cycle', 'that composition already contains this one');
      refComp = { id: cmd.source, settings: compSettingsRecord(cmd.source) };
    }
    const parentId = cmd.parent ?? cmd.comp;
    if (cmd.parent) {
      requireLayer(cmd.parent);
      if (compOfLayer(cmd.parent) !== cmd.comp) fail('invalidArgument', 'the parent must be a layer of the same composition', { layer: cmd.parent });
    }
    const count = layerIdsOfComp(cmd.comp).length;
    if (cmd.index !== undefined && cmd.index > count) fail('outOfRange', `index ${cmd.index} is past the ${count} layers of the composition`);
    const id = ctx.mintId('layer_');
    const node = makeLayerNode({ kind: cmd.kind, id, name: cmd.name, comp: settings, asset, refComp });
    ensureTimeline(cmd.comp);
    const scope = newScope();
    scopeLayer(scope, id);
    scope.keys.add(K.node(parentId));
    scope.keys.add(K.node(cmd.comp));
    scopeTimeline(scope, cmd.comp);
    scope.keys.add(K.order);
    return {
      scope,
      label: `New ${cmd.kind.charAt(0).toUpperCase()}${cmd.kind.slice(1)} Layer`,
      apply: () => {
        node.parent = parentId;
        graph.addChild(parentId, node);
        getTimeline().syncFromScene(cmd.comp);
        moveInStack(cmd.comp, [id], cmd.index ?? 0);
        applyInitialTiming(cmd.comp, id, cmd.inPoint, cmd.outPoint, cmd.startTime);
        if (cmd.init.length > 0) {
          const cat = catalogFor(id);
          for (const init of cmd.init) writeStatic(id, requireBinding(cat, init.path), init.value);
        }
        return { layer: id };
      },
    };
  },

  deleteLayers: (cmd) => {
    requireLayersInOneComp(cmd.layers);
    for (const id of cmd.layers) {
      if (graph.getNode(id)?.locked) fail('locked', `layer '${id}' is locked`, { layer: id });
    }
    return {
      scope: documentScope(),
      label: `Delete ${plural(cmd.layers.length, 'Layer')}`,
      apply: () => {
        const doomed = new Set(cmd.layers);
        for (const id of cmd.layers) orphanChildren(id, doomed);
        for (const id of cmd.layers) {
          if (!graph.getNode(id)) continue;
          if (!deleteLayerNode(id)) fail('internal', `could not delete '${id}'`, { layer: id });
        }
        return {};
      },
    };
  },

  duplicateLayers: (cmd, ctx) => {
    const comp = requireLayersInOneComp(cmd.layers);
    const newIds = cmd.layers.map(() => ctx.mintId('layer_'));
    return {
      scope: documentScope(),
      label: `Duplicate ${plural(cmd.layers.length, 'Layer')}`,
      apply: () => {
        cmd.layers.forEach((src, i) => {
          const id = newIds[i]!;
          if (!cloneLayerNode(src, id)) fail('internal', `could not duplicate '${src}'`, { layer: src });
          const srcNode = graph.getNode(src)!;
          const copy = graph.getNode(id)!;
          // Switches the clone helper does not carry.
          if (srcNode.solo) copy.solo = true;
          if (srcNode.shy) copy.shy = true;
          if (srcNode.color) copy.color = srcNode.color;
          if (srcNode.name) copy.name = srcNode.name;
          remintKeyIds(id, ctx);
          getTimeline().syncFromScene(comp);
          writeGeoms(comp, id, geomsOf(src, comp));
        });
        return { layers: newIds };
      },
    };
  },

  reorderLayers: (cmd) => {
    requireComp(cmd.comp);
    const comp = requireLayersInOneComp(cmd.layers);
    if (comp !== cmd.comp) fail('invalidArgument', 'the layers are not in that composition');
    const count = layerIdsOfComp(cmd.comp).length;
    if (cmd.toIndex > count) fail('outOfRange', `toIndex ${cmd.toIndex} is past the ${count} layers`);
    const parent = graph.getNode(cmd.layers[0]!)!.parent!;
    for (const id of cmd.layers) {
      if (graph.getNode(id)!.parent !== parent) fail('invalidArgument', 'layers moved together must share a parent (parenting is nesting in this engine)', { layer: id });
    }
    const scope = newScope();
    scope.keys.add(K.node(parent));
    return {
      scope,
      label: 'Reorder Layers',
      apply: () => {
        moveInStack(cmd.comp, cmd.layers, cmd.toIndex);
        return {};
      },
    };
  },

  setParent: (cmd) => {
    const comp = requireLayersInOneComp(cmd.layers);
    if (cmd.parent) {
      requireLayer(cmd.parent);
      if (compOfLayer(cmd.parent) !== comp) fail('invalidArgument', 'parent and child must be in the same composition', { layer: cmd.parent });
      for (const id of cmd.layers) {
        if (!canReparent(id, cmd.parent)) fail('cycle', `parenting '${id}' to '${cmd.parent}' would create a cycle`, { layer: id });
      }
    }
    return {
      scope: documentScope(),
      label: cmd.parent ? 'Parent' : 'Unparent',
      apply: () => {
        for (const id of cmd.layers) {
          if ((apiParentOf(id) ?? null) === (cmd.parent ?? null)) continue;
          // B3z: Parent & Link JUMP (Shift) — relink, then land on the parent's anchor at `time`.
          const opts = cmd.jump && cmd.parent ? { jump: true, time: flicksToSeconds(cmd.time ?? 0) } : { preserveWorld: cmd.keepWorldTransform };
          if (!reparentNode(id, cmd.parent ?? null, opts)) {
            fail('cycle', `could not parent '${id}'`, { layer: id });
          }
        }
        return {};
      },
    };
  },

  renameLayer: (cmd) => {
    requireLayer(cmd.layer);
    if (cmd.name.trim() === '') fail('invalidArgument', 'a layer name cannot be empty');
    const scope = scopeLayer(newScope(), cmd.layer);
    return {
      scope,
      label: 'Rename Layer',
      apply: () => {
        graph.getNode(cmd.layer)!.name = cmd.name;
        return {};
      },
    };
  },

  setLayerComment: (cmd) => {
    requireLayer(cmd.layer);
    return {
      scope: scopeLayer(newScope(), cmd.layer),
      label: 'Layer Comment',
      apply: () => {
        graph.setFxKey(cmd.layer, 'comment', cmd.comment === '' ? undefined : cmd.comment);
        return {};
      },
    };
  },

  setLayerSwitches: (cmd) => {
    const comp = requireLayersInOneComp(cmd.layers);
    const p = cmd.patch;
    for (const id of cmd.layers) validateSwitches(graph.getNode(id)!, p);
    const scope = layersScope(cmd.layers, comp);
    return {
      scope,
      label: 'Layer Switches',
      apply: () => {
        for (const id of cmd.layers) applySwitches(id, p);
        return {};
      },
    };
  },

  setBlendMode: (cmd) => {
    requireLayersInOneComp(cmd.layers);
    if (!isBlendMode(cmd.mode)) fail('unsupported', `blend mode '${cmd.mode}' is not implemented by the TypeScript renderer`);
    const scope = newScope();
    for (const id of cmd.layers) scopeLayer(scope, id);
    return {
      scope,
      label: 'Blending Mode',
      apply: () => {
        for (const id of cmd.layers) setNodeBlend(id, cmd.mode as LayerBlendMode);
        return {};
      },
    };
  },

  setTrackMatte: (cmd) => {
    const node = requireLayer(cmd.layer);
    void node;
    const m = cmd.matte;
    // B3z: no `matte.layer` = AE's classic positional matte (the layer directly
    // above in the stack), stored without a sourceId.
    if (m.mode !== 'none' && m.layer) {
      requireLayer(m.layer);
      if (m.layer === cmd.layer) fail('invalidArgument', 'a layer cannot be its own matte');
      if (compOfLayer(m.layer) !== compOfLayer(cmd.layer)) fail('invalidArgument', 'the matte must be in the same composition', { layer: m.layer });
    }
    return {
      scope: scopeLayer(newScope(), cmd.layer),
      label: 'Track Matte',
      apply: () => {
        if (m.mode === 'none') setNodeMatte(cmd.layer, undefined);
        else setNodeMatte(cmd.layer, {
          mode: m.mode.startsWith('luma') ? 'luma' : 'alpha',
          inverted: m.mode.endsWith('Inverted'),
          ...(m.layer ? { sourceId: m.layer } : {}),
        });
        return {};
      },
    };
  },

  replaceLayerSource: (cmd) => {
    const node = requireLayer(cmd.layer);
    const comp = compOfLayer(cmd.layer)!;
    const isComp = readCompRef(node) !== null;
    if (isComp) {
      if (!isCompItem(cmd.source)) fail('notFound', `no composition '${cmd.source}'`, { item: cmd.source });
      if (wouldCreateCompCycle(graph, comp, cmd.source)) fail('cycle', 'that composition already contains this one');
    } else {
      const kind = readNodeKind(node);
      if (!['image', 'video', 'audio', 'svg'].includes(kind)) fail('invalidArgument', 'only footage and precomp layers have a source', { layer: cmd.layer });
      if (!useAssetStore.getState().assets.some((a) => a.id === cmd.source)) fail('notFound', `no footage item '${cmd.source}'`, { item: cmd.source });
    }
    return {
      scope: scopeLayer(newScope(), cmd.layer),
      label: 'Replace Layer Source',
      apply: () => {
        const n = graph.getNode(cmd.layer)!;
        const fx = n.components.find((c) => c.type === 'fx');
        const t = n.components.find((c) => c.type === 'Transform');
        if (isComp) {
          if (fx) graph.writeProp(cmd.layer, fx.id, COMP_REF_PROP, cmd.source);
          if (!cmd.keepSize && t) {
            const s = useProjectStore.getState().comps[cmd.source]!;
            writeTransformProps(cmd.layer, [{ prop: 'width', value: s.width }, { prop: 'height', value: s.height }], 'Replace Layer Source');
          }
          return {};
        }
        const a = useAssetStore.getState().assets.find((x) => x.id === cmd.source)!;
        const audio = n.components.find((c) => c.type === 'Audio');
        if (audio) {
          graph.writeProp(cmd.layer, audio.id, '__assetId', a.id);
          graph.writeProp(cmd.layer, audio.id, '__src', a.src);
        } else if (t) {
          graph.writeProp(cmd.layer, t.id, 'assetId', a.id);
          graph.writeProp(cmd.layer, t.id, 'src', a.src);
          if (!cmd.keepSize) {
            writeTransformProps(cmd.layer, [
              { prop: 'width', value: Math.round((a.metadata?.width ?? 400) * (a.interpret?.par ?? 1)) },
              { prop: 'height', value: a.metadata?.height ?? 400 },
            ], 'Replace Layer Source');
          }
        }
        return {};
      },
    };
  },

  groupLayers: (cmd, ctx) => {
    const comp = requireLayersInOneComp(cmd.layers);
    const parent = graph.getNode(cmd.layers[0]!)!.parent!;
    for (const id of cmd.layers) {
      if (graph.getNode(id)!.parent !== parent) fail('invalidArgument', 'grouped layers must share a parent', { layer: id });
    }
    const id = ctx.mintId('group_');
    const settings = compSettingsRecord(comp);
    return {
      scope: documentScope(),
      label: 'Group Layers',
      apply: () => {
        const order = graph.getChildOrder(parent);
        const front = Math.max(...cmd.layers.map((l) => order.indexOf(l)));
        const node = makeLayerNode({ kind: 'group', id, name: cmd.name || 'Group', comp: settings });
        node.parent = parent;
        graph.addChild(parent, node);
        // Group at the front-most member's slot.
        const kids = graph.getChildOrder(parent).filter((x) => x !== id);
        const slot = kids.filter((x, i) => i <= front && !cmd.layers.includes(x)).length;
        kids.splice(slot, 0, id);
        graph.setChildOrder(parent, kids);
        // Back to front, so the group keeps their relative order.
        const members = order.filter((x) => cmd.layers.includes(x));
        for (const m of members) setParentPreservingWorld(m, id);
        getTimeline().syncFromScene(comp);
        return { layer: id };
      },
    };
  },

  ungroupLayer: (cmd) => {
    const node = requireLayer(cmd.group);
    if (readNodeKind(node) !== 'group') fail('invalidArgument', `'${cmd.group}' is not a group layer`, { layer: cmd.group });
    const comp = compOfLayer(cmd.group)!;
    return {
      scope: documentScope(),
      label: 'Ungroup',
      apply: () => {
        const parent = graph.getNode(cmd.group)!.parent!;
        const members = graph.getChildOrder(cmd.group);
        const slot = graph.getChildOrder(parent).indexOf(cmd.group);
        for (const m of members) setParentPreservingWorld(m, parent);
        // Members take the group's place in the stack.
        const kids = graph.getChildOrder(parent).filter((x) => !members.includes(x));
        const at = Math.max(0, kids.indexOf(cmd.group));
        kids.splice(at, 0, ...members);
        graph.setChildOrder(parent, kids);
        void slot;
        deleteLayerNode(cmd.group);
        getTimeline().syncFromScene(comp);
        return { layers: [...members].reverse() };
      },
    };
  },

  pasteLayers: (cmd, ctx) => {
    requireComp(cmd.comp);
    const frag = decodeFragment(cmd.fragment);
    if (cmd.time !== undefined) checkTime(cmd.time);
    const count = layerIdsOfComp(cmd.comp).length;
    if (cmd.index !== undefined && cmd.index > count) fail('outOfRange', `index ${cmd.index} is past the ${count} layers`);
    for (const l of frag.layers) {
      if (l.row.components.some((c) => (c.props as Record<string, unknown>)[COMP_REF_PROP] === cmd.comp)) fail('cycle', 'a pasted precomp layer would contain its own composition');
    }
    if (cmd.parent !== undefined) {
      requireLayer(cmd.parent);
      if (compOfLayer(cmd.parent) !== cmd.comp) fail('invalidArgument', 'the parent must be a layer of the same composition', { layer: cmd.parent });
    }
    const root = cmd.parent ?? cmd.comp;
    const idMap = new Map<string, string>();
    for (const l of frag.layers) idMap.set(l.row.id, ctx.mintId('layer_'));
    return {
      scope: documentScope(),
      label: `Paste ${plural(frag.layers.length, 'Layer')}`,
      apply: () => {
        const fps = compFps(cmd.comp);
        const minIn = Math.min(...frag.layers.map((l) => l.bars[0]?.start ?? 0));
        const shift = cmd.time !== undefined ? flicksToFrames(cmd.time, fps) - (Number.isFinite(minIn) ? minIn : 0) : 0;
        // Parents before children (fragment order is stack/tree order).
        const siblings = new Map<string, string[]>();
        for (const l of frag.layers) {
          const id = idMap.get(l.row.id)!;
          const parent = l.row.parent && idMap.has(l.row.parent) ? idMap.get(l.row.parent)! : root;
          const components = l.row.components.map((c) => ({ ...structuredClone(c), id: `${id}_${c.type}` }));
          for (const c of components) remapLayerRefs(c, idMap);
          const row: SceneNode = {
            ...structuredClone(l.row),
            id,
            parent,
            children: [],
            components,
          };
          graph.addChild(parent, row);
          if (l.anim) defaultAnimation.restoreNode(id, remapAnim(l.anim, id));
          remintKeyIds(id, ctx);
          siblings.set(parent, [...(siblings.get(parent) ?? []), id]);
        }
        // Fragment order is FRONT-first (copyLayers visits children front to
        // back); addChild appended each one in front of the last, which
        // reversed the stacking. Put every pasted sibling run back: the first
        // in the fragment is the front-most (AE keeps the copied stacking).
        for (const [parent, run] of siblings) {
          const pasted = new Set(run);
          const others = graph.getChildOrder(parent).filter((c) => !pasted.has(c));
          graph.setChildOrder(parent, [...others, ...[...run].reverse()]);
        }
        getTimeline().syncFromScene(cmd.comp);
        for (const l of frag.layers) {
          const id = idMap.get(l.row.id)!;
          if (l.bars.length > 0) writeGeoms(cmd.comp, id, l.bars.map((b) => ({ ...b, start: b.start + shift })));
        }
        const tops = frag.layers.filter((l) => !l.row.parent || !idMap.has(l.row.parent)).map((l) => idMap.get(l.row.id)!);
        if (tops.length > 0) moveInStack(cmd.comp, tops, cmd.index ?? 0, new Set(idMap.values()));
        return { layers: frag.layers.map((l) => idMap.get(l.row.id)!) };
      },
    };
  },

  convertLayer: (cmd) => {
    requireLayer(cmd.layer);
    return fail('unsupported', `'${cmd.conversion}' needs font outlines / evaluation the TypeScript engine only offers through editor dialogs today; it moves into the engine with E3`);
  },

  separateLayer: (cmd) => {
    requireLayer(cmd.layer);
    return fail('unsupported', 'Separate (break apart) is not implemented by the TypeScript engine');
  },

  autoTrace: (cmd) => {
    requireLayer(cmd.layer);
    return fail('unsupported', 'Auto-trace reads rendered pixels; in the TypeScript engine it runs from the editor (a job in phase E)');
  },
};

const getTimeline = getTimelineController;

// ── Switches ─────────────────────────────────────────────────────────

function validateSwitches(node: SceneNode, p: LayerSwitchesPatch): void {
  if (p.threeD === true && !layerFlagAvailable(node, 'threeD')) fail('invalidArgument', `layer '${node.id}' cannot be 3D`, { layer: node.id });
  if (p.collapse !== undefined && collapseSwitchKind(node) === null && p.collapse) fail('invalidArgument', `layer '${node.id}' has no collapse/continuous-rasterize switch`, { layer: node.id });
  if (p.frameBlend !== undefined && p.frameBlend !== 'off' && !layerFlagAvailable(node, 'frameBlend')) fail('invalidArgument', `layer '${node.id}' has no frames to blend`, { layer: node.id });
  if (p.quality !== undefined && !layerFlagAvailable(node, 'quality') && p.quality !== 'best') fail('invalidArgument', `layer '${node.id}' has no quality switch`, { layer: node.id });
  if (p.autoOrient === 'towardsPointOfInterest') fail('unsupported', 'Orient Towards Point of Interest is a camera/light option the TypeScript engine does not have');
  if (p.label !== undefined && p.label > 0 && !labelColorOf(p.label)) fail('outOfRange', `label ${p.label} does not exist`);
}

function applySwitches(id: string, p: LayerSwitchesPatch): void {
  const n = graph.getNode(id)!;
  if (p.visible !== undefined) n.visible = p.visible;
  if (p.solo !== undefined) n.solo = p.solo;
  if (p.locked !== undefined) n.locked = p.locked;
  if (p.shy !== undefined) n.shy = p.shy;
  if (p.label !== undefined) n.color = labelColorOf(p.label);
  if (p.audioEnabled !== undefined) {
    const kind = readNodeKind(n);
    const comp = kind === 'audio' ? n.components.find((c) => c.type === 'Audio') : kind === 'video' ? n.components.find((c) => c.type === 'Transform') : undefined;
    if (comp) graph.writeProp(id, comp.id, kind === 'audio' ? '__muted' : VIDEO_AUDIO_MUTED_PROP, p.audioEnabled ? undefined : true);
  }
  if (p.collapse !== undefined) {
    const kind = collapseSwitchKind(n);
    if (kind === 'collapse') setCompCollapse(id, p.collapse);
    else if (kind === 'raster') setContinuousRaster(id, p.collapse);
  }
  if (p.quality !== undefined) setNodeQuality(id, p.quality);
  if (p.effectsEnabled !== undefined) setNodeFxEnabled(id, p.effectsEnabled);
  if (p.motionBlur !== undefined) setNodeMotionBlur(id, p.motionBlur);
  if (p.adjustment !== undefined) setNodeAdjustment(id, p.adjustment);
  if (p.threeD !== undefined) set3DEnabled(id, p.threeD);
  if (p.guide !== undefined) setGuideLayer(id, p.guide);
  if (p.frameBlend !== undefined) updateNodeLayerTime(id, { frameBlend: p.frameBlend === 'frameMix' ? 'mix' : p.frameBlend === 'pixelMotion' ? 'pixelMotion' : 'none' });
  if (p.autoOrient !== undefined) setAutoOrientMode(id, p.autoOrient === 'alongPath' ? 'path' : p.autoOrient === 'towardsCamera' ? 'camera' : 'off');
  if (p.preserveTransparency !== undefined) setNodePreserveTransparency(id, p.preserveTransparency);
}

// ── Fragments (copyLayers / pasteLayers) ──────────────────────────────

export interface FragmentLayer {
  row: SceneNode;
  anim: NodeAnimSnapshot | null;
  /** Bar geometry in frames of the source comp. */
  bars: Array<{ start: number; duration: number; sourceIn: number; sourceDuration: number | null }>;
}

export interface FragmentData {
  layers: FragmentLayer[];
}

export const FRAGMENT_VERSION = 1;

export function encodeFragment(layers: string[]): DocumentFragment {
  const out: FragmentLayer[] = [];
  const visit = (id: string): void => {
    const n = graph.getNode(id);
    if (!n) return;
    const row = JSON.parse(JSON.stringify({
      id: n.id, name: n.name, children: [...n.children], parent: n.parent, transform: n.transform,
      components: n.components, visible: n.visible, locked: n.locked, solo: n.solo,
      ...(n.shy ? { shy: true } : {}), ...(n.color ? { color: n.color } : {}),
    })) as SceneNode;
    out.push({ row, anim: defaultAnimation.snapshotNode(id), bars: barsOf(id).map((b) => b.clip.toJSON()) });
    for (const c of [...graph.getChildOrder(id)].reverse()) if (!layers.includes(c)) visit(c);
  };
  for (const id of layers) visit(id);
  // Canonical key order (canonical.ts): the same bytes the C++ engine writes.
  const json = canonicalStringify({ layers: out } satisfies FragmentData);
  return { version: FRAGMENT_VERSION, data: new TextEncoder().encode(json) };
}

function decodeFragment(f: DocumentFragment): FragmentData {
  if (f.version !== FRAGMENT_VERSION) fail('unsupported', `fragment version ${f.version} is not understood`);
  try {
    const data = JSON.parse(new TextDecoder().decode(f.data)) as FragmentData;
    check(Array.isArray(data.layers) && data.layers.length > 0, 'invalidArgument', 'the fragment holds no layers');
    return data;
  } catch (err) {
    if (err instanceof Error && err.name === 'EngineFail') throw err;
    return fail('decode', 'the fragment is not a copyLayers payload');
  }
}

/**
 * pasteLayers: references BETWEEN pasted layers follow the copies (AE does
 * this for parenting and track mattes). Parenting is the row's `parent`
 * (nesting); every other stored layer reference lives in a component's props,
 * at exactly these places (any component — the stores do not depend on its
 * type, except the last):
 *
 *   matte.sourceId                      track matte source (fx)
 *   effects[*].params[*]                a string param (the layer-valued params:
 *                                       Set Matte, Displacement Map, Compound
 *                                       Blur, audio effects, plugin `layer`
 *                                       params, Layer Control) — by VALUE, since
 *                                       plugin schemas are not in every engine
 *   __cloner.pathLayerId                cloner path layer
 *   __cloner.falloff.layerId            cloner falloff field layer
 *   __audioDriver[*].sourceLayerId      audio-driven property source
 *   paint.strokes[*].cloneSourceId      clone-stamp source layer
 *   pluginLayer:* component, top-level  a plugin layer's `layer` props
 *     string props not named `__…`
 *
 * A value is replaced only when it is a string equal to the id of a layer IN
 * the fragment; references to other layers are kept. Expressions address
 * layers by NAME (AE) and are not rewritten. native handlers_layers2.cpp
 * `remap_layer_refs` is the same walk.
 */
export function remapLayerRefs(c: { type: string; props: unknown }, idMap: ReadonlyMap<string, string>): void {
  const p = c.props as Record<string, unknown> | null;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return;
  const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const swap = (o: Record<string, unknown> | null, k: string): void => {
    if (!o) return;
    const v = o[k];
    if (typeof v === 'string' && idMap.has(v)) o[k] = idMap.get(v)!;
  };
  swap(obj(p.matte), 'sourceId');
  if (Array.isArray(p.effects)) {
    for (const e of p.effects) {
      const params = obj(obj(e)?.params);
      if (params) for (const k of Object.keys(params)) swap(params, k);
    }
  }
  const cloner = obj(p.__cloner);
  swap(cloner, 'pathLayerId');
  swap(obj(cloner?.falloff), 'layerId');
  const drivers = obj(p.__audioDriver);
  if (drivers) for (const k of Object.keys(drivers)) swap(obj(drivers[k]), 'sourceLayerId');
  const strokes = obj(p.paint)?.strokes;
  if (Array.isArray(strokes)) for (const s of strokes) swap(obj(s), 'cloneSourceId');
  if (c.type.startsWith('pluginLayer:')) {
    for (const k of Object.keys(p)) if (!k.startsWith('__')) swap(p, k);
  }
}

function remapAnim(anim: NodeAnimSnapshot, nodeId: string): NodeAnimSnapshot {
  return {
    tracks: structuredClone(anim.tracks),
    expressions: structuredClone(anim.expressions),
    data: Object.fromEntries(Object.entries(anim.data).map(([k, t]) => [k, { ...structuredClone(t), nodeId }])),
  };
}

export type { HandlerCtx };
