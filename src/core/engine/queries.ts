/**
 * Queries (ENGINE_API.md §7): read without changing anything, at the revision
 * in the response. What the TypeScript engine cannot answer from document data
 * alone (rendered pixels, waveforms, thumbnails, GPU facts) says so with
 * `unsupported` rather than inventing a value; those move into the engine
 * process with the renderer (phase D/E).
 */

import type { Query, QueryResult, HistoryState, LogRecord, PropertyValue, EffectInfo, LayerKind } from '@motion/engine-api';
import { defaultAnimation } from '@motion/animation';
import { EFFECT_DEFS, effectDefFor } from '@core/effects/effects';
import { listPresets } from '@core/animation/animationPresets';
import { world2DAt } from '@core/scene/layerSpace';
import { readCompRef } from '@core/scene/compInstance';
import { getFontWeights } from '@core/text/fontCatalog';
import { fail } from './errors';
import { graph, requireComp, requireLayer, compOfLayer, layerIdsOfComp, compItemIds, layerKindOf, isCompItem, resolveItem } from './doc';
import {
  documentSnapshot,
  compInfo,
  layerInfo,
  propertyTree,
  keyframeSets,
  compMarkers,
  layerMarkers,
  itemInfo,
} from './model';
import { catalogFor, requireBinding, readStatic, readKeys, keyAtToApi, isAnimated, flicksToKeyTime, keyTimeToFlicks } from './props';
import { valueAt } from './handlers/properties';
import { encodeFragment } from './handlers/layers';
import { GROUP_TYPES } from './handlers/groups';
import { checkTime, flicksToSeconds } from './time';
import type { Transport } from './transport';
import type { KeyIndex } from './keyIndex';

export interface QueryCtx {
  revision: number;
  projectPath: string;
  dirty: boolean;
  history(): HistoryState;
  log(fromRevision: number): LogRecord[];
  transport: Transport;
  keyIndex: KeyIndex;
}

function numbersOf(v: PropertyValue['value']): number[] {
  switch (v.kind) {
    case 'scalar': case 'int': return [v.value];
    case 'bool': return [v.value ? 1 : 0];
    case 'vec2': return [v.value.x, v.value.y];
    case 'vec3': return [v.value.x, v.value.y, v.value.z];
    case 'vec4': return [v.value.x, v.value.y, v.value.z, v.value.w];
    case 'color': return [v.value.r, v.value.g, v.value.b, v.value.a];
    default: return [];
  }
}

function effectInfo(type: string): EffectInfo {
  const def = effectDefFor(type)!;
  return {
    matchName: def.type,
    displayName: def.label,
    category: '',
    gpu: def.gpuOnly === true,
    provider: def.type.includes('.') ? def.type.split('.')[0]! : 'builtin',
    params: def.params.filter((p) => p.type !== 'resolved').map((p) => ({
      name: p.label,
      matchName: p.key,
      valueType: p.type === 'number' ? 'scalar' : p.type === 'color' ? 'color' : p.type === 'checkbox' ? 'bool' : p.type === 'enum' ? 'choice' : p.type === 'layer' ? 'layer' : p.type === 'maskPath' ? 'string' : 'json',
      animatable: p.type === 'number' || p.type === 'color',
      ...(typeof p.default === 'number' ? { defaultValue: { kind: 'scalar' as const, value: p.default } } : {}),
      ...(p.min !== undefined ? { min: p.min } : {}),
      ...(p.max !== undefined ? { max: p.max } : {}),
      choices: (p.options ?? []).map((o) => o.label),
      unit: p.unit ?? '',
      group: p.group ?? '',
    })),
    supportsFloat: false,
    audio: false,
  };
}

export function runQuery(q: Query, ctx: QueryCtx): QueryResult {
  switch (q.type) {
    case 'getDocument':
      return { type: q.type, ...documentSnapshot(ctx.revision, ctx.projectPath, ctx.dirty, q.includeProperties, q.includeKeyframes) };
    case 'getComposition':
      requireComp(q.comp);
      return { type: q.type, comp: compInfo(q.comp), layers: layerIdsOfComp(q.comp).map(layerInfo) };
    case 'getLayers':
      for (const id of q.layers) requireLayer(id);
      return { type: q.type, layers: q.layers.map(layerInfo) };
    case 'getPropertyTree': {
      requireLayer(q.layer);
      const cat = catalogFor(q.layer);
      if (q.path !== '' && !cat.groups.has(q.path) && !cat.byPath.has(q.path)) fail('notFound', `no property '${q.path}'`, { layer: q.layer, path: q.path });
      const nodes = propertyTree(q.layer, cat, q.path, q.depth);
      if (q.time !== undefined) {
        checkTime(q.time);
        for (const n of nodes) {
          const b = cat.byPath.get(n.path);
          if (b && n.animated) {
            const v = valueAt(q.layer, b, flicksToKeyTime(q.layer, b, q.time));
            if (v) n.value = v;
          }
        }
      }
      return { type: q.type, layer: q.layer, nodes };
    }
    case 'getPropertyValues': {
      checkTime(q.time);
      const values = q.props.map((p) => {
        requireLayer(p.layer);
        const b = requireBinding(catalogFor(p.layer), p.path);
        const t = flicksToKeyTime(p.layer, b, q.time);
        let value = isAnimated(p.layer, b) ? valueAt(p.layer, b, t) ?? readStatic(p.layer, b) : readStatic(p.layer, b);
        if (q.evaluated && b.members.length > 0 && b.members.some((m) => defaultAnimation.isExpressionEnabled(p.layer, m))) {
          const nums = b.members.map((m) => defaultAnimation.sample(p.layer, m, t) ?? 0);
          value = b.valueType === 'scalar' ? { kind: 'scalar', value: nums[0]! } : value.kind === 'vec2' ? { kind: 'vec2', value: { x: nums[0]!, y: nums[1]! } } : value.kind === 'vec3' ? { kind: 'vec3', value: { x: nums[0]!, y: nums[1]!, z: nums[2]! } } : value;
        }
        return { prop: p, value };
      });
      return { type: q.type, values };
    }
    case 'sampleProperty': {
      requireLayer(q.prop.layer);
      const b = requireBinding(catalogFor(q.prop.layer), q.prop.path);
      if (b.members.length === 0) fail('unsupported', `'${b.path}' is not numeric`, { path: b.path });
      if (q.samples < 2 || q.samples > 100000) fail('outOfRange', 'samples must be 2…100000');
      const times: number[] = [];
      const values: number[] = [];
      const speeds: number[] = [];
      for (let i = 0; i < q.samples; i++) {
        const tf = q.range.start + Math.round((q.range.duration * i) / (q.samples - 1));
        const t = flicksToKeyTime(q.prop.layer, b, tf);
        const nums = b.members.map((m) => defaultAnimation.sample(q.prop.layer, m, t) ?? (numbersOf(readStatic(q.prop.layer, b))[b.members.indexOf(m)] ?? 0));
        times.push(tf);
        values.push(...nums);
        if (q.speed) {
          const dt = 1 / 240;
          const n2 = b.members.map((m) => defaultAnimation.sample(q.prop.layer, m, t + dt) ?? 0);
          speeds.push(Math.hypot(...n2.map((v, j) => v - nums[j]!)) / dt);
        }
      }
      return { type: q.type, times, values, dimensions: b.members.length, speeds };
    }
    case 'getMotionPath': {
      requireLayer(q.layer);
      if (q.samples < 2 || q.samples > 100000) fail('outOfRange', 'samples must be 2…100000');
      const times: number[] = [];
      const values: number[] = [];
      for (let i = 0; i < q.samples; i++) {
        const tf = q.range.start + Math.round((q.range.duration * i) / (q.samples - 1));
        const m = world2DAt(q.layer, flicksToSeconds(tf));
        times.push(tf);
        values.push(m.e, m.f);
      }
      return { type: q.type, times, values, dimensions: 2, speeds: [] };
    }
    case 'getKeyframes': {
      const sets = q.props.map((p) => {
        requireLayer(p.layer);
        const b = requireBinding(catalogFor(p.layer), p.path);
        let keys = readKeys(p.layer, b).map((k) => keyAtToApi(p.layer, b, k));
        if (q.range) keys = keys.filter((k) => k.time >= q.range!.start && k.time < q.range!.start + q.range!.duration);
        return { prop: p, keyframes: keys };
      });
      return { type: q.type, sets };
    }
    case 'getMarkers': {
      requireComp(q.owner.comp);
      let markers = q.owner.layer ? (requireLayer(q.owner.layer), layerMarkers(q.owner.layer)) : compMarkers(q.owner.comp);
      if (q.range) markers = markers.filter((m) => m.time >= q.range!.start && m.time < q.range!.start + q.range!.duration);
      return { type: q.type, markers };
    }
    case 'copyLayers':
      for (const id of q.layers) requireLayer(id);
      return { type: q.type, ...encodeFragment(q.layers) };
    case 'getWaveform':
      return fail('unsupported', 'waveform peaks are computed by the editor\'s audio engine until audio moves into the engine (E2)');
    case 'listFonts': {
      const families = new Set<string>();
      if (typeof document !== 'undefined' && document.fonts) {
        document.fonts.forEach((f) => families.add(f.family.replace(/^["']|["']$/g, '')));
      }
      const needle = q.query.toLowerCase();
      const fonts = [...families].filter((f) => f.toLowerCase().includes(needle)).sort().flatMap((family) =>
        getFontWeights(family).map((w) => ({ family, style: String(w), postScriptName: '', weight: w, italic: false, variableAxes: [], scripts: [], path: '' })));
      return { type: q.type, fonts };
    }
    case 'getItems': {
      const items = q.items.map((id) => {
        const info = itemInfo(id);
        if (!info) fail('notFound', `no item '${id}'`, { item: id });
        return info;
      });
      return { type: q.type, items };
    }
    case 'getThumbnail':
      return fail('unsupported', 'thumbnails are rendered by the editor until the engine owns rendering (D2)');
    case 'listEffects': {
      const effects = EFFECT_DEFS.map((d) => effectInfo(d.type)).filter((e) => q.category === '' || e.category === q.category);
      return { type: q.type, effects };
    }
    case 'listGroupTypes': {
      requireLayer(q.layer);
      const node = graph.getNode(q.layer)!;
      const isText = node.components.some((c) => c.type === 'Text');
      const pattern = (p: string): RegExp => new RegExp(`^${p.replace(/\*/g, '[^/]+')}$`);
      const types = GROUP_TYPES.filter((t) => pattern(t.parent).test(q.parent) && (t.category !== 'text' || isText))
        .map((t) => ({ matchName: t.matchName, displayName: t.displayName, category: t.category }));
      if (q.parent === 'effects') for (const d of EFFECT_DEFS) types.push({ matchName: d.type, displayName: d.label, category: 'effects' });
      return { type: q.type, types };
    }
    case 'listPresets': {
      const presets = listPresets()
        .filter((p) => q.category === '' || p.category === q.category || p.folder === q.category)
        .map((p) => ({ id: p.name, name: p.name, category: p.folder ?? p.category ?? '', description: p.description ?? '' }));
      return { type: q.type, presets };
    }
    case 'getCapabilities':
      return {
        type: q.type,
        gpuAdapter: '', gpuBackend: 'webgpu', vramBytes: 0, maxTextureSize: 0, hardwareDecode: [],
        exportFormats: ['mp4-h264', 'mov-prores', 'webm-vp9', 'png-seq', 'gif'],
        colorManagement: true, float32: false, pluginApis: [], expressionEngines: ['premation'],
        cpuThreads: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 1 : 1,
      };
    case 'hitTest':
    case 'getLayerBounds':
    case 'getTextLayout':
    case 'readPixels':
      return fail('unsupported', `'${q.type}' needs the renderer's geometry/pixels; the TypeScript engine answers it in the editor until D2`);
    case 'getLayerTransforms': {
      checkTime(q.time);
      const transforms = q.layers.map((id) => {
        requireLayer(id);
        const m = world2DAt(id, flicksToSeconds(q.time));
        return { layer: id, matrix: [m.a, m.b, 0, 0, m.c, m.d, 0, 0, 0, 0, 1, 0, m.e, m.f, 0, 1], anchor: { x: 0, y: 0, z: 0 } };
      });
      return { type: q.type, transforms };
    }
    case 'evaluateExpression': {
      requireLayer(q.prop.layer);
      const b = requireBinding(catalogFor(q.prop.layer), q.prop.path);
      if (b.members.length === 0) fail('unsupported', `'${b.path}' is not numeric`, { path: b.path });
      checkTime(q.time);
      const r = defaultAnimation.previewExpression(q.prop.layer, b.members[0]!, q.source, flicksToKeyTime(q.prop.layer, b, q.time));
      const val = r.value;
      const value = val === null ? undefined : Array.isArray(val)
        ? (val.length === 2 ? { kind: 'vec2' as const, value: { x: val[0]!, y: val[1]! } } : { kind: 'vec3' as const, value: { x: val[0]!, y: val[1] ?? 0, z: val[2] ?? 0 } })
        : { kind: 'scalar' as const, value: val as number };
      return { type: q.type, ...(value ? { value } : {}), diagnostics: r.error ? [{ message: r.error, line: 0, column: 0 }] : [] };
    }
    case 'findLayers': {
      const comps = q.comp ? [q.comp] : compItemIds();
      if (q.comp) requireComp(q.comp);
      const kinds = new Set<LayerKind>(q.kinds);
      const needle = q.name.toLowerCase();
      const out: string[] = [];
      for (const c of comps) {
        for (const id of layerIdsOfComp(c)) {
          const n = graph.getNode(id)!;
          if (needle && !(n.name ?? '').toLowerCase().includes(needle)) continue;
          if (kinds.size > 0 && !kinds.has(layerKindOf(n))) continue;
          if (q.effect) {
            const fx = n.components.find((x) => x.type === 'fx')?.props.effects;
            if (!Array.isArray(fx) || !fx.some((e) => (e as { type?: string }).type === q.effect)) continue;
          }
          out.push(id);
        }
      }
      return { type: q.type, layers: out };
    }
    case 'getDependencies': {
      if (q.item) {
        if (!resolveItem(q.item)) fail('notFound', `no item '${q.item}'`, { item: q.item });
        const usedBy: string[] = [];
        graph.traverse((n) => { if (n.parent && readCompRef(n) === q.item) usedBy.push(n.id); });
        const items = isCompItem(q.item) ? layerIdsOfComp(q.item).map((id) => readCompRef(graph.getNode(id)!)).filter((x): x is string => !!x) : [];
        return { type: q.type, uses: [], usedBy: usedBy.map((layer) => ({ layer, path: '' })), items };
      }
      if (!q.layer) fail('invalidArgument', 'give a layer or an item');
      requireLayer(q.layer);
      const uses: Array<{ layer: string; path: string }> = [];
      const usedBy: Array<{ layer: string; path: string }> = [];
      for (const e of defaultAnimation.allExpressions()) {
        const refs = [...e.src.matchAll(/layer\(\s*['"]#([^'"]+)['"]/g)].map((m) => m[1]!);
        if (e.nodeId === q.layer) for (const r of refs) uses.push({ layer: r, path: '' });
        if (refs.includes(q.layer)) usedBy.push({ layer: e.nodeId, path: e.prop });
      }
      const ref = readCompRef(graph.getNode(q.layer)!);
      return { type: q.type, uses, usedBy, items: ref ? [ref] : [] };
    }
    case 'getHistory':
      return { type: q.type, ...ctx.history() };
    case 'getRenderStats':
      return { type: q.type, gpuFrameMs: 0, cpuFrameMs: 0, fps: 0, droppedFrames: 0, vramBytes: 0, ramCacheBytes: 0, diskCacheBytes: 0, cacheHitRate: 0, decodeMs: 0 };
    case 'getLayerErrors':
      if (q.comp) requireComp(q.comp);
      // Render errors are recorded on each frame's snapshot by the editor's renderer (§10).
      return { type: q.type, errors: [] };
    case 'getJobs':
      return { type: q.type, jobs: [] };
    case 'getRenderQueue':
      return { type: q.type, items: documentSnapshot(ctx.revision, '', false, false, false).renderQueue };
    case 'getCommandLog':
      return { type: q.type, records: ctx.log(q.fromRevision) };
    default:
      return fail('unsupported', `unknown query '${(q as { type: string }).type}'`);
  }
}

export { compOfLayer, keyTimeToFlicks, keyframeSets };
