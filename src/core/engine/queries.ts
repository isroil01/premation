/**
 * Queries (ENGINE_API.md §7): read without changing anything, at the revision
 * in the response. What the TypeScript engine cannot answer from document data
 * alone (rendered pixels, waveforms, thumbnails, GPU facts) says so with
 * `unsupported` rather than inventing a value; those move into the engine
 * process with the renderer (phase D/E).
 */

import type { Query, QueryResult, HistoryState, JobInfo, LogRecord, PropertyValue, EffectInfo, LayerKind, Keyframe } from '@motion/engine-api';
import { defaultAnimation } from '@motion/animation';
import { EFFECT_DEFS, effectDefFor, getNodeEffects } from '@core/effects/effects';
import { captureEffect } from '@core/effects/effectClipboard';
import { getCryptomatteForAsset } from '@core/media/cryptomatte';
import { listPresets, capturePresetBody } from '@core/animation/animationPresets';
import { presetContextFor } from '@core/animation/presetContext';
import { world2DAt, world3DAt } from '@core/scene/layerSpace';
import { compSizeOf } from '@core/composition/compSizes';
import { readCompRef } from '@core/scene/compInstance';
import { getFontWeights } from '@core/text/fontCatalog';
import { captureDocument } from '@core/api/cloudDocument';
import { fail } from './errors';
import { graph, requireComp, requireLayer, compOfLayer, layerIdsOfComp, compItemIds, layerKindOf, isCompItem, resolveItem, isLayer } from './doc';
import {
  documentSnapshot,
  compInfo,
  layerInfo,
  propertyTree,
  keyframeSets,
  compMarkers,
  layerMarkers,
  itemInfo,
  svgRoleOf,
} from './model';
import { catalogFor, requireBinding, readStatic, readKeys, keyAtToApi, isAnimated, flicksToKeyTime, keyTimeToFlicks, toApiNums, apiUnitFactor } from './props';
import { valueAt } from './handlers/properties';
import { textLayoutAnswer } from './textLayoutQuery';
import { sourceTextPreview } from './sourceTextPreview';
import { installSourceTextProvider } from '@core/textExpr/sourceTextProvider';
import { layerBoundsAnswer } from './layerBoundsQuery';
import { rigPoseAnswer } from './rigOverlay';
import { memberTracksAnswer } from './memberKeysQuery';
import { documentColorsAnswer, captionCuesAnswer, mapLayerTimeAnswer, sourceSizesAnswer, precomposeCheckAnswer, timelineRowsAnswer } from './itemFactsQueries';
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
  /** Engine jobs, the last 64 (jobs/runner.ts). */
  jobs?: () => JobInfo[];
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
    case 'exportDocument': {
      const document = new TextEncoder().encode(JSON.stringify(captureDocument()));
      return { type: q.type, document };
    }
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
          const nums = toApiNums(b, b.members.map((m) => defaultAnimation.sample(p.layer, m, t) ?? 0));
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
        // API units: samples are stored units (scaled per member); the static fallback already is API.
        const nums = b.members.map((m, i) => {
          const s = defaultAnimation.sample(q.prop.layer, m, t);
          return s !== undefined ? s * (b.colorBase ? 1 : apiUnitFactor(m)) : (numbersOf(readStatic(q.prop.layer, b))[i] ?? 0);
        });
        times.push(tf);
        values.push(...nums);
        if (q.speed) {
          const dt = 1 / 240;
          const n2 = toApiNums(b, b.members.map((m) => defaultAnimation.sample(q.prop.layer, m, t + dt) ?? 0));
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
    case 'copyKeyframes': {
      // B4: whole keys in API form, per property, in the order the ids first name them.
      const layerSets = new Map<string, ReturnType<typeof keyframeSets>>();
      const picked = new Map<string, { prop: { layer: string; path: string }; ids: Set<string>; keys: Keyframe[] }>();
      for (const id of q.keys) {
        const loc = ctx.keyIndex.resolve(id);
        if (!loc) continue;
        let sets = layerSets.get(loc.layer);
        if (!sets) {
          sets = keyframeSets(loc.layer);
          layerSets.set(loc.layer, sets);
        }
        for (const set of sets) {
          const k = set.keyframes.find((x) => x.id === id);
          if (!k) continue;
          const key = `${set.prop.layer}\u0000${set.prop.path}`;
          const entry = picked.get(key) ?? { prop: set.prop, ids: new Set<string>(), keys: [] };
          if (!entry.ids.has(k.id)) {
            entry.ids.add(k.id);
            entry.keys.push(k);
          }
          picked.set(key, entry);
          break;
        }
      }
      return { type: q.type, sets: [...picked.values()].map((e) => ({ prop: e.prop, keyframes: [...e.keys].sort((a, b) => a.time - b.time) })) };
    }
    case 'getMemberKeyframes':
      // B4: the stored member tracks the keyframe assistants transform (memberKeysQuery.ts).
      return { type: q.type, tracks: memberTracksAnswer(q) };
    case 'copyEffects': {
      // B4: the effect clipboard's capture (effectClipboard.ts captureEffect), stack order.
      requireLayer(q.layer);
      const wanted = new Set(q.effects.flatMap((p) => {
        const seg = p.split('/');
        return seg.length === 2 && seg[0] === 'effects' && seg[1] ? [seg[1]] : [];
      }));
      const stack = getNodeEffects(q.layer);
      const picked = q.effects.length === 0 ? stack : stack.filter((e) => wanted.has(e.id));
      return { type: q.type, effects: JSON.stringify(picked.map((e) => captureEffect(q.layer, e))), paths: picked.map((e) => `effects/${e.id}`) };
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
    case 'getSvgDocument': {
      // B4: the `svg` component as stored (svgLayer.ts readSvgLayer / readRetainedSvgSource).
      const node = requireLayer(q.layer);
      const role = svgRoleOf(node);
      const p = (node.components.find((c) => c.type === 'svg')?.props ?? {}) as Record<string, unknown>;
      const str = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '');
      const num = (k: string, d: number): number => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : d);
      const vb = Array.isArray(p.viewBox) && p.viewBox.length === 4 && p.viewBox.every((v) => typeof v === 'number') ? (p.viewBox as number[]) : null;
      if (role === 'none') {
        return { type: q.type, role, fileName: '', intrinsicWidth: 0, intrinsicHeight: 0, capabilities: '{}', livePlayback: false, sourceMarkup: '', sanitizedMarkup: '', sanitizePolicy: 0 };
      }
      return {
        type: q.type,
        role,
        fileName: str('fileName') || 'untitled.svg',
        intrinsicWidth: num('intrinsicWidth', 512),
        intrinsicHeight: num('intrinsicHeight', 512),
        ...(vb ? { viewBox: { x: vb[0]!, y: vb[1]!, width: vb[2]!, height: vb[3]! } } : {}),
        capabilities: JSON.stringify(p.capabilities && typeof p.capabilities === 'object' ? p.capabilities : {}),
        livePlayback: p.livePlayback === true,
        sourceMarkup: str('sourceMarkup') || str('sanitizedMarkup'),
        sanitizedMarkup: str('sanitizedMarkup'),
        sanitizePolicy: Math.max(0, Math.round(num('sanitizePolicy', 0))),
      };
    }
    case 'getCryptomatte': {
      // B4: the EXR's decoded manifest — the page decodes EXR in this engine (media/floatExr.ts).
      if (!resolveItem(q.item)) fail('notFound', `no item '${q.item}'`, { item: q.item });
      const set = getCryptomatteForAsset(q.item);
      return { type: q.type, layers: (set?.layers ?? []).map((l) => ({ name: l.name, objects: l.objects.map((o) => o.name) })) };
    }
    case 'getThumbnail':
    case 'renderDocumentStill':
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
    case 'capturePreset': {
      // B4: Save as Preset — the preset body resolved against the layer's OWN composition.
      requireLayer(q.layer);
      const body = capturePresetBody(q.layer, presetContextFor(q.layer, compOfLayer(q.layer) ?? undefined));
      return { type: q.type, preset: body ? JSON.stringify(body) : '{}', empty: body === null };
    }
    case 'listPlugins':
      // Native SDK plugins live in the C++ engine process (G1); this engine hosts none.
      return { type: q.type, plugins: [] };
    case 'getEffectUi': {
      requireLayer(q.layer);
      const seg = q.effect.split('/');
      const fx = seg.length === 2 && seg[0] === 'effects' ? getNodeEffects(q.layer).find((e) => e.id === seg[1]) : undefined;
      if (!fx) fail('notFound', `no effect '${q.effect}'`, { layer: q.layer, path: q.effect });
      const def = effectDefFor(fx.type);
      // A builtin effect: every param enabled and visible under its catalog name.
      const params = (def?.params ?? []).filter((p) => p.type !== 'resolved').map((p) => ({ key: p.key, name: p.label, enabled: true, hidden: false }));
      return { type: q.type, params };
    }
    case 'getCapabilities':
      return {
        type: q.type,
        gpuAdapter: '', gpuBackend: 'webgpu', vramBytes: 0, maxTextureSize: 0, hardwareDecode: [],
        exportFormats: ['mp4-h264', 'mov-prores', 'webm-vp9', 'png-seq', 'gif'],
        colorManagement: true, float32: false, pluginApis: [], expressionEngines: ['premation'],
        cpuThreads: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 1 : 1,
      };
    case 'getTextLayout':
      // B4: measured with the page's canvas metrics, as the painter lays the text out (textLayoutQuery.ts).
      checkTime(q.time);
      return { type: q.type, ...textLayoutAnswer(q) };
    case 'getLayerBounds':
      // B4: readGeometry's box at the time (layerBoundsQuery.ts).
      return { type: q.type, bounds: layerBoundsAnswer(q) };
    case 'getRigPose':
      // B4 round 5: the rig at the time, pointer points through the pose (rigOverlay.ts).
      return { type: q.type, ...rigPoseAnswer(q) };
    case 'hitTest':
    case 'readPixels':
      return fail('unsupported', `'${q.type}' needs the renderer's geometry/pixels; the TypeScript engine answers it in the editor until D2`);
    case 'getLayerTransforms': {
      checkTime(q.time);
      const transforms = q.layers.map((id) => {
        requireLayer(id);
        const seconds = flicksToSeconds(q.time);
        // A 3D layer (or a camera / light): its world 4×4, as toWorld reads it —
        // a device through the active camera's eye, at the layer's comp size.
        const comp = compOfLayer(id);
        const size = (comp ? compSizeOf(comp) : undefined) ?? { width: 1920, height: 1080 };
        const m3 = world3DAt(id, seconds, { width: size.width, height: size.height });
        if (m3) return { layer: id, matrix: Array.from(m3), anchor: { x: 0, y: 0, z: 0 } };
        const m = world2DAt(id, seconds);
        return { layer: id, matrix: [m.a, m.b, 0, 0, m.c, m.d, 0, 0, 0, 0, 1, 0, m.e, m.f, 0, 1], anchor: { x: 0, y: 0, z: 0 } };
      });
      return { type: q.type, transforms };
    }
    case 'evaluateExpression': {
      requireLayer(q.prop.layer);
      const b = requireBinding(catalogFor(q.prop.layer), q.prop.path);
      checkTime(q.time);
      if (b.path === 'text/sourceText') {
        // A draft Source Text expression: text + style overrides (B4, the editor preview).
        installSourceTextProvider();
        const r = defaultAnimation.previewSourceTextExpression(q.prop.layer, q.source, flicksToKeyTime(q.prop.layer, b, q.time));
        return {
          type: q.type,
          ...(r.result ? { text: sourceTextPreview(r.result) } : {}),
          diagnostics: r.error ? [{ message: r.error, line: 0, column: 0 }] : [],
        };
      }
      if (b.members.length === 0) fail('unsupported', `'${b.path}' is not numeric`, { path: b.path });
      const member = q.member ?? 0;
      if (member >= b.members.length) fail('outOfRange', `'${b.path}' has ${b.members.length} member(s)`, { path: b.path });
      const r = defaultAnimation.previewExpression(q.prop.layer, b.members[member]!, q.source, flicksToKeyTime(q.prop.layer, b, q.time));
      const val = r.value;
      const value = val === null ? undefined : Array.isArray(val)
        ? (val.length === 2 ? { kind: 'vec2' as const, value: { x: val[0]!, y: val[1]! } } : { kind: 'vec3' as const, value: { x: val[0]!, y: val[1] ?? 0, z: val[2] ?? 0 } })
        : { kind: 'scalar' as const, value: val as number };
      return { type: q.type, ...(value ? { value } : {}), diagnostics: r.error ? [{ message: r.error, line: 0, column: 0 }] : [] };
    }
    case 'getSearchFacts': {
      const ids = q.layers.length > 0 ? q.layers.filter((id) => isLayer(id)) : compItemIds().flatMap((c) => layerIdsOfComp(c));
      const exprs = new Map<string, string[]>();
      for (const e of defaultAnimation.allExpressions()) {
        const list = exprs.get(e.nodeId);
        if (list) list.push(e.src);
        else exprs.set(e.nodeId, [e.src]);
      }
      return {
        type: q.type,
        layers: ids.map((id) => ({
          layer: id,
          effects: getNodeEffects(id).map((e) => e.type),
          expressions: exprs.get(id) ?? [],
        })),
      };
    }
    // B4 round 5 (itemFactsQueries.ts).
    case 'getDocumentColors':
      return { type: q.type, colors: documentColorsAnswer(q) };
    case 'getCaptionCues':
      return { type: q.type, cues: captionCuesAnswer(q) };
    case 'mapLayerTime':
      return { type: q.type, ...mapLayerTimeAnswer(q) };
    case 'getTimelineRows':
      return { type: q.type, sets: timelineRowsAnswer(q.layers) };
    case 'getSourceSize':
      return { type: q.type, sizes: sourceSizesAnswer(q) };
    case 'checkPrecompose':
      return { type: q.type, leaveAttributesReason: precomposeCheckAnswer(q) };
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
      return { type: q.type, jobs: ctx.jobs?.() ?? [] };
    case 'getRenderQueue':
      return { type: q.type, items: documentSnapshot(ctx.revision, '', false, false, false).renderQueue };
    case 'getCommandLog':
      return { type: q.type, records: ctx.log(q.fromRevision) };
    default:
      return fail('unsupported', `unknown query '${(q as { type: string }).type}'`);
  }
}

export { compOfLayer, keyTimeToFlicks, keyframeSets };
