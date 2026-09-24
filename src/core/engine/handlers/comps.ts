/** Compositions (ENGINE_API.md §4.3). */

import { defaultAnimation } from '@motion/animation';
import { Marker } from '@motion/timeline';
import type { CompSettingsPatch, Color } from '@motion/engine-api';
import { useProjectStore, DEFAULT_COMP_SETTINGS, type CompositionSettings } from '@stores/projectStore';
import { useAssetStore } from '@stores/assetStore';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { precomposeNow } from '@core/composition/precompose';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readCompRef, COMP_REF_PROP } from '@core/scene/compInstance';
import { channelsToColor } from '@core/effects/effects';
import { readStaticPropertyValue, writeStaticPropertyValue } from '@core/inspector/propertyValue';
import type { SceneNode } from '@core/types';
import { fail } from '../errors';
import { graph, requireComp, isCompItem, layerIdsOfComp, requireLayer } from '../doc';
import { K, documentScope, newScope, scopeTimeline, type Scope } from '../state';
import { compFps, flicksToFrames, rationalToFps, flicksToSeconds, framesToFlicks, checkTime } from '../time';
import { compDurationFrames } from '../model';
import type { HandlerTable, HandlerCtx } from '../handler';
import { ensureTimeline, geomsOf, writeGeoms, remintKeyIds, requireLayersInOneComp } from './common';
import { makeLayerNode } from './layerFactory';

type ExtraComp = CompositionSettings & {
  folderId?: string;
  comment?: string;
  label?: number;
  renderer3d?: string;
  dropFrame?: boolean;
  preserveFrameRate?: boolean;
  preserveResolution?: boolean;
};

function colorHex(c: Color): string {
  return channelsToColor(c.r, c.g, c.b, c.a);
}

/** A CompSettingsPatch validated and turned into store fields (no writes). */
function patchToStore(p: CompSettingsPatch): Partial<ExtraComp> {
  const out: Partial<ExtraComp> = {};
  if (p.name !== undefined) {
    if (p.name.trim() === '') fail('invalidArgument', 'a composition name cannot be empty');
    out.name = p.name;
  }
  if (p.width !== undefined) { if (!(p.width >= 4 && p.width <= 30000)) fail('outOfRange', 'width must be 4…30000'); out.width = p.width; }
  if (p.height !== undefined) { if (!(p.height >= 4 && p.height <= 30000)) fail('outOfRange', 'height must be 4…30000'); out.height = p.height; }
  if (p.pixelAspect !== undefined) { if (!(p.pixelAspect > 0)) fail('outOfRange', 'pixel aspect must be positive'); out.pixelAspect = p.pixelAspect; }
  if (p.frameRate !== undefined) {
    const fps = rationalToFps(p.frameRate);
    if (!(fps >= 1 && fps <= 999)) fail('outOfRange', 'frame rate must be 1…999');
    out.fps = fps;
  }
  if (p.duration !== undefined) {
    checkTime(p.duration, 'duration');
    if (p.duration <= 0) fail('outOfRange', 'duration must be positive');
    out.durationSeconds = flicksToSeconds(p.duration);
  }
  if (p.startTimecode !== undefined) checkTime(p.startTimecode, 'startTimecode');
  if (p.background !== undefined) out.background = colorHex(p.background);
  if (p.backgroundGradient !== undefined) fail('unsupported', 'gradient backgrounds are set through the Composition Settings dialog until B3 types FillPaint');
  if (p.clearBackgroundGradient) out.backgroundPaint = undefined;
  // B3z: the background PAINT as the editor stores it (FillPaint JSON); '' clears it.
  if (p.backgroundPaint !== undefined) {
    if (p.backgroundPaint === '') {
      out.backgroundPaint = undefined;
    } else {
      const paint = parseJsonField(p.backgroundPaint, 'backgroundPaint') as { type?: unknown; stops?: unknown };
      if (!paint || typeof paint !== 'object' || !['linear', 'radial', 'solid'].includes(String(paint.type))) {
        fail('invalidArgument', 'backgroundPaint must be a FillPaint (type linear / radial / solid)');
      }
      if (paint.type !== 'solid' && !Array.isArray(paint.stops)) fail('invalidArgument', 'a gradient backgroundPaint needs stops');
      out.backgroundPaint = paint as ExtraComp['backgroundPaint'];
    }
  }
  if (p.transparent !== undefined) out.transparent = p.transparent;
  if (p.renderer3d !== undefined) out.renderer3d = p.renderer3d;
  if (p.globalLightAngle !== undefined) out.globalLightAngle = p.globalLightAngle;
  if (p.globalLightAltitude !== undefined) {
    if (!(p.globalLightAltitude >= 0 && p.globalLightAltitude <= 90)) fail('outOfRange', 'global light altitude must be 0…90');
    out.globalLightAltitude = p.globalLightAltitude;
  }
  if (p.dropFrame !== undefined) out.dropFrame = p.dropFrame;
  if (p.preserveFrameRate !== undefined) out.preserveFrameRate = p.preserveFrameRate;
  if (p.preserveResolution !== undefined) out.preserveResolution = p.preserveResolution;
  if (p.world !== undefined) {
    let w: Record<string, unknown>;
    try { w = JSON.parse(p.world) as Record<string, unknown>; } catch { return fail('invalidArgument', 'world must be JSON'); }
    for (const k of ['defaultEnvPreset', 'groundLevel', 'showSkyBackdrop', 'ssao'] as const) {
      if (k in w) (out as Record<string, unknown>)[k] = w[k];
    }
  }
  return out;
}

function parseJsonField(text: string, field: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail('invalidArgument', `${field} must be JSON`);
  }
}

/** Composition-root props the patch writes (Responsive Time, template fields — stored on the root's meta component). */
const ROOT_PROPS = { responsiveTime: '__responsiveTime', templateFields: '__templateFields' } as const;

/** The validated root-prop writes of a patch: prop → value (undefined = clear). */
function rootPropWrites(p: CompSettingsPatch): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  if (p.responsiveTime !== undefined) {
    if (p.responsiveTime === '') {
      out.push([ROOT_PROPS.responsiveTime, undefined]);
    } else {
      const v = parseJsonField(p.responsiveTime, 'responsiveTime') as { authoredDurationSec?: unknown; protectedRegions?: unknown };
      if (!v || typeof v !== 'object' || typeof v.authoredDurationSec !== 'number' || !Array.isArray(v.protectedRegions)) {
        fail('invalidArgument', 'responsiveTime needs a number authoredDurationSec and an array protectedRegions');
      }
      out.push([ROOT_PROPS.responsiveTime, v]);
    }
  }
  if (p.templateFields !== undefined) {
    if (p.templateFields === '') {
      out.push([ROOT_PROPS.templateFields, undefined]);
    } else {
      const v = parseJsonField(p.templateFields, 'templateFields');
      if (!Array.isArray(v)) fail('invalidArgument', 'templateFields must be an array');
      out.push([ROOT_PROPS.templateFields, v]);
    }
  }
  return out;
}

function compRootNode(id: string, name: string): SceneNode {
  return {
    id, name, parent: null, children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true, locked: false,
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  };
}

function createCompRecord(id: string, fields: Partial<ExtraComp>): void {
  const record: ExtraComp = { ...DEFAULT_COMP_SETTINGS, name: 'Composition', ...fields, id } as ExtraComp;
  const comps = { ...useProjectStore.getState().comps, [id]: record };
  useProjectStore.getState().actions.replaceComps(comps);
  graph.addNode(compRootNode(id, record.name));
  getTimelineController().timelineForComp(id);
}

/** Apply store fields + the timeline side (rate keeps bar timing, duration, loop). */
function applyCompFields(comp: string, fields: Partial<ExtraComp>, startTimecode?: number): void {
  const cur = useProjectStore.getState().comps[comp]!;
  const next: ExtraComp = { ...cur, ...fields } as ExtraComp;
  if (startTimecode !== undefined) next.startFrame = flicksToFrames(startTimecode, next.fps);
  for (const [k, v] of Object.entries(fields)) if (v === undefined) delete (next as unknown as Record<string, unknown>)[k];
  useProjectStore.getState().actions.replaceComps({ ...useProjectStore.getState().comps, [comp]: next });
  if (fields.name !== undefined) graph.getNode(comp)!.name = fields.name;
  const reg = getTimelineController().timelineForComp(comp);
  if (!reg) return;
  const { timeline } = reg;
  timeline.history.silently(() => {
    if (fields.fps !== undefined && timeline.getFrameRate().fps !== fields.fps) timeline.setFrameRate(fields.fps, { preserveTiming: true });
    const frames = Math.max(1, Math.round(next.durationSeconds * next.fps));
    if (timeline.duration !== frames) timeline.setDuration(frames);
    const loop = timeline.getRanges().loop;
    if (loop) timeline.setRange('loop', timeline.getRanges().workArea ?? { start: 0, duration: timeline.duration });
  });
}

function compScope(comp: string, s: Scope = newScope()): Scope {
  s.keys.add(K.comp(comp));
  s.keys.add(K.node(comp));
  scopeTimeline(s, comp);
  return s;
}

/** Deep copy of a composition's layers into `newComp` (fresh ids), incl. animation and bars. Returns old→new ids. */
function copyCompContents(src: string, newComp: string, ctx: HandlerCtx, refMap: Map<string, string>): void {
  const idMap = new Map<string, string>([[src, newComp]]);
  const walk = (parentOld: string, parentNew: string): void => {
    for (const childOld of graph.getChildOrder(parentOld)) {
      const n = graph.getNode(childOld);
      if (!n) continue;
      const id = ctx.mintId('layer_');
      idMap.set(childOld, id);
      const ref = readCompRef(n);
      const row: SceneNode = {
        id, name: n.name, parent: parentNew, children: [],
        transform: JSON.parse(JSON.stringify(n.transform)),
        components: n.components.map((c) => {
          const props = JSON.parse(JSON.stringify(c.props)) as Record<string, unknown>;
          if (ref && props[COMP_REF_PROP] === ref && refMap.has(ref)) props[COMP_REF_PROP] = refMap.get(ref);
          return { id: `${id}_${c.type}`, type: c.type, props };
        }),
        visible: n.visible, locked: n.locked,
        ...(n.solo ? { solo: true } : {}), ...(n.shy ? { shy: true } : {}), ...(n.color ? { color: n.color } : {}),
      };
      graph.addChild(parentNew, row);
      const snap = defaultAnimation.snapshotNode(childOld);
      if (snap) {
        defaultAnimation.restoreNode(id, {
          tracks: structuredClone(snap.tracks),
          expressions: structuredClone(snap.expressions),
          data: Object.fromEntries(Object.entries(snap.data).map(([k, t]) => [k, { ...structuredClone(t), nodeId: id }])),
        });
      }
      remintKeyIds(id, ctx);
      walk(childOld, id);
    }
  };
  walk(src, newComp);
  const controller = getTimelineController();
  controller.syncFromScene(newComp);
  for (const [oldId, newId] of idMap) {
    if (oldId === src) continue;
    const g = geomsOf(oldId, src);
    if (g.length > 0) writeGeoms(newComp, newId, g);
  }
  // Composition markers and work area travel with a duplicate.
  const from = controller.peekTimeline(src);
  const to = controller.peekTimeline(newComp);
  if (from && to) {
    to.timeline.history.silently(() => {
      to.timeline.setRange('workArea', from.timeline.getRanges().workArea);
      for (const m of from.timeline.markers.list()) to.timeline.markers.add(new Marker({ ...m.toJSON(), id: ctx.mintMarkerId() }));
    });
  }
}

/** Comps a comp's layers reference (instances), recursively, excluding itself. */
function nestedComps(comp: string, seen = new Set<string>()): string[] {
  for (const id of layerIdsOfComp(comp)) {
    const ref = readCompRef(graph.getNode(id)!);
    if (ref && !seen.has(ref) && isCompItem(ref)) {
      seen.add(ref);
      nestedComps(ref, seen);
    }
  }
  return [...seen];
}

export const compHandlers: HandlerTable = {
  createComposition: (cmd, ctx) => {
    const fields = patchToStore(cmd.settings);
    if (cmd.folder && !useAssetStore.getState().folders.some((f) => f.id === cmd.folder)) fail('notFound', `no folder '${cmd.folder}'`, { item: cmd.folder });
    const assets = cmd.fromItems.map((id) => {
      const a = useAssetStore.getState().assets.find((x) => x.id === id);
      if (!a) fail('notFound', `no footage item '${id}'`, { item: id });
      return a;
    });
    const first = assets[0];
    if (first) {
      const md = first.metadata ?? {};
      if (fields.width === undefined && md.width) fields.width = Math.round(md.width * (first.interpret?.par ?? 1));
      if (fields.height === undefined && md.height) fields.height = md.height;
      if (fields.fps === undefined && md.fps) fields.fps = md.fps;
      if (fields.durationSeconds === undefined && md.duration) fields.durationSeconds = md.duration;
      if (fields.name === undefined) fields.name = first.name;
    }
    if (cmd.folder) fields.folderId = cmd.folder;
    const id = ctx.mintId('comp_');
    const layerIds = assets.map(() => ctx.mintId('layer_'));
    return {
      scope: documentScope(),
      label: 'New Composition',
      apply: () => {
        createCompRecord(id, fields);
        const settings = useProjectStore.getState().comps[id]!;
        assets.forEach((a, i) => {
          const kind = a.type === 'audio' ? 'audio' : a.type === 'video' ? 'video' : 'image';
          const node = makeLayerNode({ kind, id: layerIds[i]!, comp: settings, asset: a });
          graph.addChild(id, node);
        });
        getTimelineController().syncFromScene(id);
        return { item: id };
      },
    };
  },

  duplicateComposition: (cmd, ctx) => {
    requireComp(cmd.comp);
    const src = useProjectStore.getState().comps[cmd.comp]! as ExtraComp;
    const nested = cmd.deep ? nestedComps(cmd.comp) : [];
    const newId = ctx.mintId('comp_');
    const nestedIds = nested.map(() => ctx.mintId('comp_'));
    return {
      scope: documentScope(),
      label: 'Duplicate Composition',
      apply: () => {
        const refMap = new Map<string, string>(nested.map((c, i) => [c, nestedIds[i]!]));
        // Nested first so their ids exist when the parents' instances are remapped.
        [...nested].reverse().forEach((c) => {
          const s = useProjectStore.getState().comps[c]! as ExtraComp;
          const { id: _i, ...rest } = s;
          createCompRecord(refMap.get(c)!, { ...rest, name: `${s.name} 2` });
          copyCompContents(c, refMap.get(c)!, ctx, refMap);
        });
        const { id: _id, pristine: _p, ...rest } = src;
        createCompRecord(newId, { ...rest, name: `${src.name} 2` });
        copyCompContents(cmd.comp, newId, ctx, refMap);
        return { item: newId };
      },
    };
  },

  setCompositionSettings: (cmd) => {
    requireComp(cmd.comp);
    const fields = patchToStore(cmd.patch);
    const rootWrites = rootPropWrites(cmd.patch);
    if (rootWrites.length > 0 && !graph.getNode(cmd.comp)?.components[0]) fail('invalidArgument', 'the composition has no root to store this on', { item: cmd.comp });
    if (cmd.patch.workArea) {
      checkTime(cmd.patch.workArea.start, 'workArea.start');
      checkTime(cmd.patch.workArea.duration, 'workArea.duration');
    }
    const scope = compScope(cmd.comp);
    if (cmd.patch.motionBlur) scope.keys.add(K.mb);
    ensureTimeline(cmd.comp);
    return {
      scope,
      label: 'Composition Settings',
      apply: () => {
        const clean: Partial<ExtraComp> = { ...fields };
        if (fields.pristine === undefined && useProjectStore.getState().comps[cmd.comp]?.pristine) clean.pristine = undefined;
        applyCompFields(cmd.comp, clean, cmd.patch.startTimecode);
        // Responsive Time and template fields live on the root's meta component
        // (responsiveTimeStore.ts / templateAuthoring.ts read them there); the
        // comp scope captures the root node, so undo restores them exactly.
        for (const [prop, value] of rootWrites) {
          const meta = graph.getNode(cmd.comp)!.components[0]!.id;
          graph.writeProp(cmd.comp, meta, prop, value);
        }
        if (cmd.patch.workArea) setWorkArea(cmd.comp, cmd.patch.workArea.start, cmd.patch.workArea.duration);
        if (cmd.patch.motionBlur) {
          const mb = cmd.patch.motionBlur;
          useMotionBlurStore.getState().restore({ shutterAngle: mb.shutterAngle, shutterPhase: mb.shutterPhase, samples: mb.samplesPerFrame, adaptiveSampleLimit: mb.adaptiveSampleLimit, ...(mb.enabled !== undefined ? { enabled: mb.enabled } : {}) });
        }
        return {};
      },
    };
  },

  setWorkArea: (cmd) => {
    requireComp(cmd.comp);
    checkTime(cmd.range.start, 'start');
    checkTime(cmd.range.duration, 'duration');
    if (cmd.range.duration <= 0 || cmd.range.start < 0) fail('outOfRange', 'the work area must be a positive range inside the composition');
    ensureTimeline(cmd.comp);
    const scope = newScope();
    scopeTimeline(scope, cmd.comp);
    return {
      scope,
      label: 'Work Area',
      apply: () => {
        setWorkArea(cmd.comp, cmd.range.start, cmd.range.duration);
        return {};
      },
    };
  },

  // B3z: Shift+B. "No work area" reads back as the whole comp and follows the
  // duration (AE always has one; see ENGINE_API.md §4.3).
  clearWorkArea: (cmd) => {
    requireComp(cmd.comp);
    ensureTimeline(cmd.comp);
    const scope = newScope();
    scopeTimeline(scope, cmd.comp);
    return {
      scope,
      label: 'Clear Work Area',
      apply: () => {
        const reg = getTimelineController().timelineForComp(cmd.comp);
        if (!reg) return {};
        const { timeline } = reg;
        timeline.history.silently(() => {
          timeline.setRange('workArea', null);
          if (timeline.getRanges().loop) timeline.setRange('loop', { start: 0, duration: timeline.duration });
        });
        return {};
      },
    };
  },

  precompose: (cmd, ctx) => {
    requireComp(cmd.comp);
    const comp = requireLayersInOneComp(cmd.layers);
    if (comp !== cmd.comp) fail('invalidArgument', 'the layers are not in that composition');
    if (cmd.mode === 'leaveAttributes' && cmd.layers.length !== 1) fail('invalidArgument', 'Leave all attributes needs exactly one layer');
    const mint = { compId: ctx.mintId('comp_'), instanceId: ctx.mintId('layer_'), contentId: ctx.mintId('layer_') };
    ensureTimeline(cmd.comp);
    return {
      scope: documentScope(),
      label: 'Pre-compose',
      apply: () => {
        const r = precomposeNow(cmd.layers, {
          name: cmd.name,
          mode: cmd.mode === 'moveAll' ? 'move' : 'leave',
          adjustDuration: cmd.adjustDuration,
          openNew: false,
          hostId: cmd.comp,
          mint,
          quiet: true,
        });
        if (!r) fail('invalidArgument', cmd.mode === 'leaveAttributes' ? 'this layer cannot be pre-composed leaving its attributes' : 'nothing to pre-compose');
        return { comp: r.compId, layer: r.instanceId };
      },
    };
  },

  trimCompToWorkArea: (cmd) => {
    requireComp(cmd.comp);
    ensureTimeline(cmd.comp);
    const reg = getTimelineController().peekTimeline(cmd.comp)!;
    const wa = reg.timeline.getRanges().workArea;
    if (!wa) fail('invalidArgument', 'the composition has no work area');
    return {
      scope: documentScope(),
      label: 'Trim Comp to Work Area',
      apply: () => {
        const fps = compFps(cmd.comp);
        for (const id of layerIdsOfComp(cmd.comp)) {
          const g = geomsOf(id, cmd.comp);
          if (g.length > 0) writeGeoms(cmd.comp, id, g.map((b) => ({ ...b, start: b.start - wa.start })));
        }
        reg.timeline.history.silently(() => {
          for (const m of reg.timeline.markers.list()) m.frame -= wa.start;
          reg.timeline.markers.reindex();
        });
        applyCompFields(cmd.comp, { durationSeconds: wa.duration / fps });
        reg.timeline.history.silently(() => {
          reg.timeline.setRange('workArea', null);
          if (reg.timeline.getRanges().loop) reg.timeline.setRange('loop', { start: 0, duration: reg.timeline.duration });
        });
        return {};
      },
    };
  },

  cropComposition: (cmd) => {
    requireComp(cmd.comp);
    const r = cmd.region;
    if (!(r.width >= 4 && r.height >= 4)) fail('outOfRange', 'the region must be at least 4×4');
    const tops = graph.getChildOrder(cmd.comp);
    const scope = compScope(cmd.comp);
    for (const id of tops) { scope.keys.add(K.node(id)); scope.keys.add(K.anim(id)); }
    return {
      scope,
      label: 'Crop Composition',
      apply: () => {
        applyCompFields(cmd.comp, { width: Math.round(r.width), height: Math.round(r.height) });
        for (const id of tops) {
          for (const [axis, d] of [['x', -r.x], ['y', -r.y]] as const) {
            const v = readStaticPropertyValue(id, axis);
            if (v !== undefined) writeStaticPropertyValue(id, axis, v + d);
            const kfs = defaultAnimation.getTrackKeyframes(id, axis);
            if (kfs) defaultAnimation.setTrackKeyframes(id, axis, kfs.map((k) => ({ ...k, value: k.value + d })));
          }
        }
        return {};
      },
    };
  },

  assembleComposition: (cmd, ctx) => {
    if (cmd.items.length === 0) fail('invalidArgument', 'no items given');
    checkTime(cmd.overlap, 'overlap');
    const assets = cmd.items.map((id) => {
      const a = useAssetStore.getState().assets.find((x) => x.id === id);
      if (!a) fail('notFound', `no footage item '${id}'`, { item: id });
      return a;
    });
    const first = assets[0]!;
    const fps = first.metadata?.fps && first.metadata.fps > 0 ? first.metadata.fps : DEFAULT_COMP_SETTINGS.fps;
    const clipFrames = assets.map((a) => Math.max(1, Math.round((a.metadata?.duration ?? 5) * fps)));
    const overlap = flicksToFrames(cmd.overlap, fps);
    const total = clipFrames.reduce((s, f) => s + f, 0) - overlap * (assets.length - 1);
    const id = ctx.mintId('comp_');
    const layerIds = assets.map(() => ctx.mintId('layer_'));
    return {
      scope: documentScope(),
      label: 'Assemble Composition',
      apply: () => {
        createCompRecord(id, {
          name: cmd.name || first.name,
          width: Math.round((first.metadata?.width ?? 1920) * (first.interpret?.par ?? 1)),
          height: first.metadata?.height ?? 1080,
          fps,
          durationSeconds: Math.max(1, total) / fps,
        });
        const settings = useProjectStore.getState().comps[id]!;
        assets.forEach((a, i) => {
          const kind = a.type === 'audio' ? 'audio' : a.type === 'video' ? 'video' : 'image';
          graph.addChild(id, makeLayerNode({ kind, id: layerIds[i]!, comp: settings, asset: a }));
        });
        getTimelineController().syncFromScene(id);
        let at = 0;
        assets.forEach((_a, i) => {
          const g = geomsOf(layerIds[i]!, id)[0];
          if (g) writeGeoms(id, layerIds[i]!, [{ ...g, start: at, duration: clipFrames[i]!, sourceIn: 0 }]);
          at += clipFrames[i]! - overlap;
        });
        void compDurationFrames;
        return { item: id };
      },
    };
  },
};

function setWorkArea(comp: string, startFlicks: number, durationFlicks: number): void {
  const fps = compFps(comp);
  const reg = getTimelineController().timelineForComp(comp);
  if (!reg) return;
  const { timeline } = reg;
  const start = Math.max(0, flicksToFrames(startFlicks, fps));
  const end = Math.min(timeline.duration, flicksToFrames(startFlicks + durationFlicks, fps));
  if (end <= start) fail('outOfRange', 'the work area must lie inside the composition');
  timeline.history.silently(() => {
    timeline.setRange('workArea', { start, duration: end - start });
    if (timeline.getRanges().loop) timeline.setRange('loop', { start, duration: end - start });
  });
}

export { framesToFlicks, requireLayer };
