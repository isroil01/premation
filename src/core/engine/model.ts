/**
 * Read model: build the API's records (LayerInfo, CompSettings, ItemInfo,
 * Marker, PropertyInfo, KeyframeSet, DocumentSnapshot) from today's stores.
 * Pure reads — nothing here writes the document.
 */

import type {
  LayerInfo,
  LayerSwitches,
  LayerTiming,
  TrackMatte,
  BlendMode,
  CompSettings,
  ItemInfo,
  Marker,
  MarkerOwner,
  PropertyInfo,
  MemberExpression,
  KeyframeSet,
  CompInfo,
  Transition,
  DocumentSnapshot,
  Color,
  LayerQuality,
  FrameBlend,
  AutoOrient,
  RetimeMode,
  Interpretation,
} from '@motion/engine-api';
import type { MarkerData, Layer as TimelineBar } from '@motion/timeline';
import { defaultAnimation } from '@motion/animation';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useProjectStore, DEFAULT_GLOBAL_LIGHT, type CompositionSettings } from '@stores/projectStore';
import { useAssetStore, type ImportedAsset, type AssetFolder } from '@stores/assetStore';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { useTransitionStore } from '@stores/transitionStore';
import type { TransitionRecord, TransitionKind, TransitionAlignment } from '@core/timeline/transitionModel';
import { readLayerFlag } from '@core/scene/layerFlags';
import { readNodeQuality } from '@core/effects/layerQuality';
import { getNodeLayerTime } from '@core/scene/layerTime';
import { readAutoOrientMode } from '@core/scene/autoOrient';
import { readNodeBlend } from '@core/effects/blendMode';
import { readNodeMatte } from '@core/effects/matte';
import { readNodeMaskAnim } from '@core/effects/mask';
import { isLayerAudioMuted } from '@core/audio/audioLayerSwitches';
import { LABEL_COLORS } from '@core/scene/labelColor';
import { parseColorChannels, readNodeEffects } from '@core/effects/effects';
import { readRetimeMode } from '@core/animation/retime';
import { readNodeKind } from '@core/scene/sceneDerive';
import { splitKind } from '@core/plugins/layerKindSchema';
import { BLEND_MODES as API_BLEND_MODES } from './enums';
import type { SceneNode } from '@core/types';
import {
  graph,
  compItemIds,
  compOfLayer,
  layerIdsOfComp,
  layerKindOf,
  layerSourceOf,
  apiParentOf,
} from './doc';
import { compFps, framesToFlicks, fpsToRational, secondsToFlicks } from './time';
import { catalogFor, readStatic, readKeys, keyAtToApi, isAnimated, type Catalog, type PropBinding } from './props';
import { getProjectSettings, getRenderQueue } from '@core/project/documentExtras';

// ── Colours and labels ───────────────────────────────────────────────

export function hexToColor(hex: string | undefined, fallback: Color = { r: 0, g: 0, b: 0, a: 1 }): Color {
  if (typeof hex !== 'string' || !/^#?[0-9a-fA-F]{3,8}$/.test(hex.trim())) return fallback;
  const [r, g, b, a] = parseColorChannels(hex);
  return { r, g, b, a };
}

/**
 * Label colour hex — or a palette id (`slate`: the Project panel stores footage
 * labels that way) → AE label index (1-based into LABEL_COLORS, 0 = none/custom).
 */
export function labelIndexOf(color: string | null | undefined): number {
  if (!color) return 0;
  const want = color.toLowerCase();
  const i = LABEL_COLORS.findIndex((c) => c.color.toLowerCase() === want || c.id === color);
  return i < 0 ? 0 : i + 1;
}

export function labelColorOf(index: number): string | undefined {
  return index > 0 ? LABEL_COLORS[index - 1]?.color : undefined;
}

/** The palette entry's id for a label index (`setItemLabel` stores footage labels by id). */
export function labelIdOf(index: number): string | undefined {
  return index > 0 ? LABEL_COLORS[index - 1]?.id : undefined;
}

/** A custom label colour: `#rgb`, `#rrggbb` or `#rrggbbaa` (setLayerSwitches `labelColor`). */
export const LABEL_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// ── Timing ───────────────────────────────────────────────────────────

/**
 * While a whole-document read runs (`withBarIndex`), each composition's bars
 * are grouped by layer ONCE: `barsOf` per layer was a filter over every bar of
 * the comp, so a 2,000-layer `getDocument` (the B4 mirror's load and every
 * refetch) was quadratic — 360 ms for the headers alone.
 */
let barIndex: Map<string, Map<string, TimelineBar[]>> | null = null;

/** Run `fn` with the per-composition bar index (reads only; nothing may edit inside). */
export function withBarIndex<T>(fn: () => T): T {
  if (barIndex) return fn();
  barIndex = new Map();
  try {
    return fn();
  } finally {
    barIndex = null;
  }
}

function indexedBars(comp: string): Map<string, TimelineBar[]> | null {
  if (!barIndex) return null;
  let m = barIndex.get(comp);
  if (!m) {
    m = new Map();
    const reg = getTimelineController().peekTimeline(comp);
    const track = reg?.timeline.getTrack(reg.trackId);
    for (const l of track?.layers ?? []) {
      if (l.sourceId === null) continue;
      const list = m.get(l.sourceId);
      if (list) list.push(l);
      else m.set(l.sourceId, [l]);
    }
    for (const list of m.values()) list.sort((a, b) => a.start - b.start);
    barIndex.set(comp, m);
  }
  return m;
}

/** A layer's bars in its OWN composition's timeline, in start order. */
export function barsOf(layerId: string, comp = compOfLayer(layerId)): TimelineBar[] {
  if (!comp) return [];
  const idx = indexedBars(comp);
  if (idx) return [...(idx.get(layerId) ?? [])];
  const reg = getTimelineController().peekTimeline(comp);
  const track = reg?.timeline.getTrack(reg.trackId);
  if (!track) return [];
  return track.layers.filter((l) => l.sourceId === layerId).sort((a, b) => a.start - b.start);
}

export function compDurationFrames(comp: string): number {
  const reg = getTimelineController().peekTimeline(comp);
  if (reg) return reg.timeline.duration;
  const c = useProjectStore.getState().comps[comp];
  return Math.max(1, Math.round((c?.durationSeconds ?? 10) * (c?.fps ?? 30)));
}

export function layerTiming(layerId: string): LayerTiming {
  const comp = compOfLayer(layerId) ?? '';
  const fps = compFps(comp);
  const bars = barsOf(layerId, comp);
  const cfg = getNodeLayerTime(layerId);
  const stretch = (cfg.stretch / 100) * (cfg.reverse ? -1 : 1);
  const retime: RetimeMode = readRetimeMode(defaultAnimation, layerId);
  const timeRemapEnabled = defaultAnimation.isAnimated(layerId, 'timeRemap');
  if (bars.length === 0) {
    return { inPoint: 0, outPoint: framesToFlicks(compDurationFrames(comp), fps), startTime: 0, stretch, timeRemapEnabled, retime };
  }
  const first = bars[0]!;
  const last = bars[bars.length - 1]!;
  // B4: the bar's source bound (Clip.sourceDuration, comp frames) — null = unbounded.
  const srcDur = first.clip.sourceDuration;
  return {
    inPoint: framesToFlicks(first.start, fps),
    outPoint: framesToFlicks(last.start + last.duration, fps),
    startTime: framesToFlicks(first.start - first.clip.sourceIn, fps),
    stretch,
    timeRemapEnabled,
    retime,
    ...(srcDur !== null && Number.isFinite(srcDur) ? { sourceDuration: framesToFlicks(srcDur, fps) } : {}),
  };
}

// ── Layers ───────────────────────────────────────────────────────────

const QUALITY: Record<string, LayerQuality> = { best: 'best', draft: 'draft', wireframe: 'wireframe' };
const FRAME_BLEND: Record<string, FrameBlend> = { none: 'off', mix: 'frameMix', pixelMotion: 'pixelMotion' };
const AUTO_ORIENT: Record<string, AutoOrient> = { off: 'off', path: 'alongPath', camera: 'towardsCamera' };

function fxOf(node: SceneNode): Record<string, unknown> {
  return (node.components.find((c) => c.type === 'fx')?.props ?? {}) as Record<string, unknown>;
}

export function layerSwitches(node: SceneNode): LayerSwitches {
  return {
    visible: node.visible !== false,
    audioEnabled: !isLayerAudioMuted(node.id),
    solo: node.solo === true,
    locked: node.locked === true,
    shy: node.shy === true,
    collapse: readLayerFlag(node, 'collapse'),
    quality: QUALITY[readNodeQuality(node)] ?? 'best',
    effectsEnabled: readLayerFlag(node, 'fxEnabled'),
    motionBlur: readLayerFlag(node, 'motionBlur'),
    adjustment: readLayerFlag(node, 'adjustment'),
    threeD: readLayerFlag(node, 'threeD'),
    guide: readLayerFlag(node, 'guide'),
    frameBlend: FRAME_BLEND[getNodeLayerTime(node.id).frameBlend] ?? 'off',
    autoOrient: AUTO_ORIENT[readAutoOrientMode(node)] ?? 'off',
    preserveTransparency: readLayerFlag(node, 'preserveTransparency'),
    label: labelIndexOf(node.color),
    // B3z: a colour outside the palette is reported as itself.
    ...(node.color && labelIndexOf(node.color) === 0 ? { labelColor: node.color } : {}),
  };
}

export function layerMatte(node: SceneNode): TrackMatte {
  const m = readNodeMatte(node);
  if (!m) return { mode: 'none' };
  const mode = m.mode === 'luma' ? (m.inverted ? 'lumaInverted' : 'luma') : m.inverted ? 'alphaInverted' : 'alpha';
  return { mode, ...(m.sourceId ? { layer: m.sourceId } : {}) };
}

export function layerBlend(node: SceneNode): BlendMode {
  const b = readNodeBlend(node) as string;
  return (API_BLEND_MODES as readonly string[]).includes(b) ? (b as BlendMode) : 'normal';
}

function markerFromData(m: MarkerData, owner: MarkerOwner, fps: number): Marker {
  return {
    id: m.id,
    owner,
    time: framesToFlicks(m.frame, fps),
    duration: framesToFlicks(m.duration, fps),
    name: m.name,
    comment: m.comment,
    label: labelIndexOf(m.color),
    chapter: m.chapter ?? '',
    url: m.url ?? '',
    cuePoint: m.cuePoint ?? '',
    protectedRegion: m.protectedRegion === true,
    color: m.color ?? '',
  };
}

export function layerMarkers(layerId: string): Marker[] {
  const comp = compOfLayer(layerId);
  if (!comp) return [];
  const fps = compFps(comp);
  const out: Marker[] = [];
  for (const bar of barsOf(layerId, comp)) {
    for (const m of bar.markers.list()) out.push(markerFromData(m.toJSON(), { comp, layer: layerId }, fps));
  }
  return out;
}

export function compMarkers(comp: string): Marker[] {
  const reg = getTimelineController().peekTimeline(comp);
  if (!reg) return [];
  const fps = compFps(comp);
  return reg.timeline.markers.list().map((m) => markerFromData(m.toJSON(), { comp }, fps));
}

export function layerInfo(layerId: string): LayerInfo {
  const node = graph.getNode(layerId);
  if (!node) throw new Error(`no layer ${layerId}`);
  const comp = compOfLayer(layerId) ?? '';
  const kind = layerKindOf(node);
  const parent = apiParentOf(layerId);
  const source = layerSourceOf(node);
  const comment = fxOf(node).comment;
  return {
    id: layerId,
    comp,
    kind,
    name: node.name ?? layerId,
    ...(parent ? { parent } : {}),
    ...(source ? { source } : {}),
    switches: layerSwitches(node),
    timing: layerTiming(layerId),
    blendMode: layerBlend(node),
    matte: layerMatte(node),
    children: kind === 'group' ? [...graph.getChildOrder(layerId)].reverse() : [],
    hasVideo: !['audio', 'null', 'camera', 'light'].includes(kind),
    hasAudio: kind === 'audio' || (kind === 'video' && node.components.some((c) => (c.props as Record<string, unknown>).hasAudioTrack !== false)),
    markers: layerMarkers(layerId),
    comment: typeof comment === 'string' ? comment : '',
    generator: kind === 'generator' ? pluginKindOf(node) : '',
    pinned: pinnedOf(node),
    effectCount: readNodeEffects(node).length,
  };
}

/** B4: the layer's pinned properties — `__pinnedProps` on the first component carrying the list (pinnedProps.ts `readPinnedProps`). */
function pinnedOf(node: SceneNode): string[] {
  for (const c of node.components) {
    const bag = (c.props as Record<string, unknown>).__pinnedProps;
    if (Array.isArray(bag)) return bag.filter((k): k is string => typeof k === 'string');
  }
  return [];
}

/** B4: a plugin layer kind's id (`<pluginId>.<kindId>`, layerKindSchema `splitKind`), '' for any other kind. */
function pluginKindOf(node: SceneNode): string {
  const k = readNodeKind(node) as string;
  return splitKind(k) !== null ? k : '';
}

// ── Compositions ─────────────────────────────────────────────────────

type ExtraComp = CompositionSettings & {
  folderId?: string;
  comment?: string;
  label?: number;
  renderer3d?: CompSettings['renderer3d'];
  dropFrame?: boolean;
  preserveFrameRate?: boolean;
  preserveResolution?: boolean;
};

export function compSettings(compId: string): CompSettings {
  const c = (useProjectStore.getState().comps[compId] ?? {}) as ExtraComp;
  const fps = c.fps ?? 30;
  const reg = getTimelineController().peekTimeline(compId);
  const wa = reg?.timeline.getRanges().workArea;
  const durFrames = compDurationFrames(compId);
  const mb = useMotionBlurStore.getState().settings();
  const world: Record<string, unknown> = {};
  if (c.defaultEnvPreset !== undefined) world.defaultEnvPreset = c.defaultEnvPreset;
  if (c.groundLevel !== undefined) world.groundLevel = c.groundLevel;
  if (c.showSkyBackdrop !== undefined) world.showSkyBackdrop = c.showSkyBackdrop;
  if (c.ssao !== undefined) world.ssao = c.ssao;
  return {
    name: c.name ?? compId,
    width: c.width ?? 1920,
    height: c.height ?? 1080,
    pixelAspect: c.pixelAspect ?? 1,
    frameRate: fpsToRational(fps),
    duration: framesToFlicks(durFrames, fps),
    startTimecode: framesToFlicks(c.startFrame ?? 0, fps),
    background: hexToColor(c.background, { r: 0, g: 0, b: 0, a: 1 }),
    transparent: c.transparent === true,
    workArea: wa
      ? { start: framesToFlicks(wa.start, fps), duration: framesToFlicks(wa.duration, fps) }
      : { start: 0, duration: framesToFlicks(durFrames, fps) },
    motionBlur: {
      shutterAngle: mb.shutterAngle,
      shutterPhase: mb.shutterPhase,
      samplesPerFrame: mb.samples,
      adaptiveSampleLimit: mb.adaptiveSampleLimit,
      enabled: mb.enabled,
    },
    renderer3d: c.renderer3d ?? 'classic',
    globalLightAngle: c.globalLightAngle ?? DEFAULT_GLOBAL_LIGHT.angle,
    globalLightAltitude: c.globalLightAltitude ?? DEFAULT_GLOBAL_LIGHT.altitude,
    dropFrame: c.dropFrame === true,
    preserveFrameRate: c.preserveFrameRate === true,
    preserveResolution: c.preserveResolution === true,
    ...(Object.keys(world).length > 0 ? { world: JSON.stringify(world) } : {}),
    ...rootJson(compId, '__responsiveTime', 'responsiveTime'),
    ...rootJson(compId, '__templateFields', 'templateFields'),
    ...(c.backgroundPaint ? { backgroundPaint: JSON.stringify(c.backgroundPaint) } : {}),
  };
}

/** A composition-root prop as a CompSettings JSON field (absent when unset). */
function rootJson<K extends 'responsiveTime' | 'templateFields'>(compId: string, prop: string, key: K): Partial<Record<K, string>> {
  for (const c of graph.getNode(compId)?.components ?? []) {
    const v = (c.props as Record<string, unknown>)[prop];
    if (v !== undefined && v !== null) return { [key]: JSON.stringify(v) } as Partial<Record<K, string>>;
  }
  return {};
}

export function compInfo(compId: string): CompInfo {
  return { id: compId, settings: compSettings(compId), layers: layerIdsOfComp(compId), markers: compMarkers(compId), transitions: transitionsOf(compId) };
}

// ── Transitions (B3z) ────────────────────────────────────────────────

const TRANSITION_KINDS: readonly TransitionKind[] = ['crossDissolve', 'dipToBlack', 'dipToWhite', 'wipe'];
const TRANSITION_ALIGNMENTS: readonly TransitionAlignment[] = ['centred', 'startAtCut', 'endAtCut'];

/** A stored record as the API reports it (malformed legacy records read with defaults). */
export function transitionInfo(comp: string, rec: TransitionRecord): Transition {
  const r = rec as unknown as Record<string, unknown>;
  const kind = TRANSITION_KINDS.includes(r.kind as TransitionKind) ? (r.kind as Transition['kind']) : 'crossDissolve';
  const alignment = TRANSITION_ALIGNMENTS.includes(r.alignment as TransitionAlignment) ? (r.alignment as Transition['alignment']) : 'centred';
  const frames = typeof r.durationFrames === 'number' && Number.isFinite(r.durationFrames) ? Math.round(r.durationFrames) : 0;
  return {
    id: typeof r.id === 'string' ? r.id : '',
    comp,
    left: typeof r.leftNodeId === 'string' ? r.leftNodeId : '',
    right: typeof r.rightNodeId === 'string' ? r.rightNodeId : '',
    kind,
    duration: framesToFlicks(frames, compFps(comp)),
    alignment,
  };
}

/** Every transition of a composition, in the order added. */
export function transitionsOf(comp: string): Transition[] {
  return (useTransitionStore.getState().byComp[comp] ?? []).map((rec) => transitionInfo(comp, rec));
}

// ── Items ────────────────────────────────────────────────────────────

function interpretationOf(a: ImportedAsset): Interpretation {
  const i = a.interpret ?? {};
  return {
    alpha: i.alpha === 'premultiplied' ? 'premultiplied' : i.alpha === 'straight' ? 'straight' : 'auto',
    ...(i.conformFps ? { conformFrameRate: fpsToRational(i.conformFps) } : {}),
    pixelAspect: i.par ?? 1,
    fieldOrder: i.fields === 'upper' ? 'upperFirst' : i.fields === 'lower' ? 'lowerFirst' : 'progressive',
    loops: i.loopCount ?? 1,
    colorProfile: 'auto',
    invertAlpha: false,
    // B3z: Remove Pulldown — sourceInfo.ts `interpretationOf`'s validation (an integer phase 0..4).
    ...(typeof i.pulldownPhase === 'number' && Number.isInteger(i.pulldownPhase) && i.pulldownPhase >= 0 && i.pulldownPhase <= 4
      ? { removePulldown: i.pulldownPhase } : {}),
  };
}

export function footageInfo(a: ImportedAsset): ItemInfo {
  const md = a.metadata ?? {};
  return {
    id: a.id,
    kind: 'footage',
    name: a.name,
    ...(a.folderId ? { parent: a.folderId } : {}),
    label: labelIndexOf(a.label),
    comment: a.comment ?? '',
    path: a.path ?? '',
    missing: a.src === '',
    width: Math.max(0, Math.round(md.width ?? 0)),
    height: Math.max(0, Math.round(md.height ?? 0)),
    duration: secondsToFlicks(md.duration ?? 0),
    ...(md.fps ? { frameRate: fpsToRational(md.fps) } : {}),
    hasVideo: a.type !== 'audio',
    hasAudio: a.type === 'audio' || md.hasAudioTrack === true,
    hasAlpha: md.hasAlpha === true,
    interpretation: interpretationOf(a),
    proxyPath: a.proxy?.src ?? '',
    proxyEnabled: a.proxy?.status === 'ready',
    tags: [...(a.tags ?? [])],
    codec: md.codec ?? '',
    audioChannels: Math.max(0, Math.round(md.audioChannels ?? 0)),
    audioSampleRate: 0,
    colorProfile: '',
    fileBytes: Math.max(0, Math.round(a.size ?? 0)),
  };
}

export function folderInfo(f: AssetFolder): ItemInfo {
  return {
    id: f.id, kind: 'folder', name: f.name, ...(f.parentId ? { parent: f.parentId } : {}),
    label: 0, comment: '', path: '', missing: false, width: 0, height: 0, duration: 0,
    hasVideo: false, hasAudio: false, hasAlpha: false, proxyPath: '', proxyEnabled: false,
    tags: [], codec: '', audioChannels: 0, audioSampleRate: 0, colorProfile: '', fileBytes: 0,
  };
}

export function compItemInfo(compId: string): ItemInfo {
  const c = (useProjectStore.getState().comps[compId] ?? {}) as ExtraComp;
  const s = compSettings(compId);
  return {
    id: compId, kind: 'composition', name: s.name, ...(c.folderId ? { parent: c.folderId } : {}),
    label: c.label ?? 0, comment: c.comment ?? '', path: '', missing: false,
    width: s.width, height: s.height, duration: s.duration, frameRate: s.frameRate,
    hasVideo: true, hasAudio: false, hasAlpha: s.transparent, proxyPath: '', proxyEnabled: false,
    tags: [], codec: '', audioChannels: 0, audioSampleRate: 0, colorProfile: '', fileBytes: 0,
  };
}

export function itemInfo(id: string): ItemInfo | null {
  if (compItemIds().includes(id)) return compItemInfo(id);
  const s = useAssetStore.getState();
  const a = s.assets.find((x) => x.id === id);
  if (a) return footageInfo(a);
  const f = s.folders.find((x) => x.id === id);
  return f ? folderInfo(f) : null;
}

export function allItemInfos(): ItemInfo[] {
  const s = useAssetStore.getState();
  return [
    ...s.folders.map(folderInfo),
    ...compItemIds().map(compItemInfo),
    ...s.assets.map(footageInfo),
  ];
}

// ── Properties ───────────────────────────────────────────────────────

export function propertyInfo(layerId: string, cat: Catalog, b: PropBinding): PropertyInfo {
  const animated = isAnimated(layerId, b);
  const lead = b.members[0] ?? b.dataTrack;
  const expr = lead ? defaultAnimation.getExpressionSrc(layerId, lead) : undefined;
  const exprErr = lead ? defaultAnimation.getExpressionError(layerId, lead) : null;
  const keyCount = animated ? readKeys(layerId, b).length : 0;
  void cat;
  return {
    path: b.path,
    name: b.name,
    matchName: b.matchName,
    kind: 'property',
    valueType: b.valueType,
    animatable: b.animatable,
    animated,
    dimensions: Math.max(1, b.members.length),
    separated: b.separated === true,
    enabled: true,
    value: readStatic(layerId, b),
    ...(b.defaultValue ? { defaultValue: b.defaultValue } : {}),
    ...(b.min !== undefined ? { min: b.min } : {}),
    ...(b.max !== undefined ? { max: b.max } : {}),
    choices: b.choices ? [...b.choices] : [],
    unit: b.unit,
    expression: expr ?? '',
    expressionEnabled: lead ? defaultAnimation.isExpressionEnabled(layerId, lead) : false,
    expressionError: exprErr ?? '',
    keyframeCount: keyCount,
    children: b.separated ? [...cat.byPath.keys()].filter((p) => p.startsWith(`${b.path}/`)) : [],
    hidden: b.hidden === true,
    memberExpressions: memberExpressionsOf(layerId, b),
  };
}

/**
 * B4: per-dimension expressions of an UNSEPARATED multi-member property
 * (setExpression `member`) — every member carrying one, when the members do not
 * all carry the same (source, enabled). Empty for one shared expression or none.
 */
function memberExpressionsOf(layerId: string, b: PropBinding): MemberExpression[] {
  if (b.separated || b.members.length < 2) return [];
  const per = b.members.map((m) => ({
    source: defaultAnimation.getExpressionSrc(layerId, m) ?? '',
    enabled: defaultAnimation.isExpressionEnabled(layerId, m),
  }));
  const first = per[0]!;
  if (per.every((p) => p.source === first.source && (p.source === '' || p.enabled === first.enabled))) return [];
  const out: MemberExpression[] = [];
  per.forEach((p, i) => {
    if (p.source === '') return;
    out.push({ member: i, source: p.source, enabled: p.enabled, error: defaultAnimation.getExpressionError(layerId, b.members[i]!) ?? '' });
  });
  return out;
}

export function groupInfo(cat: Catalog, path: string): PropertyInfo {
  const g = cat.groups.get(path)!;
  return {
    path, name: g.name, matchName: g.matchName, kind: g.kind, valueType: 'none', animatable: false,
    animated: false, dimensions: 0, separated: false, enabled: g.enabled, choices: [], unit: '',
    expression: '', expressionEnabled: false, expressionError: '', keyframeCount: 0,
    children: [...g.children], hidden: false, memberExpressions: [],
  };
}

/** Every node of a layer's property tree (groups and properties), in tree order. */
export function propertyTree(layerId: string, cat = catalogFor(layerId), root = '', depth = 0): PropertyInfo[] {
  const out: PropertyInfo[] = [];
  const visit = (path: string, level: number): void => {
    if (depth > 0 && level > depth) return;
    if (cat.groups.has(path)) {
      out.push(groupInfo(cat, path));
      for (const c of cat.groups.get(path)!.children) visit(c, level + 1);
      return;
    }
    const b = cat.byPath.get(path);
    if (!b) return;
    out.push(propertyInfo(layerId, cat, b));
    if (b.separated) for (const c of cat.byPath.keys()) if (c.startsWith(`${path}/`)) visit(c, level + 1);
  };
  if (root === '') for (const r of cat.roots) visit(r, 1);
  else visit(root, 1);
  return out;
}

/** False only when the layer certainly has no keyframes (no animation track, data track or mask key). */
export function mayHaveKeys(layerId: string): boolean {
  if (defaultAnimation.animatedProps(layerId).length > 0) return true;
  if (defaultAnimation.dataTracksFor(layerId).length > 0) return true;
  const node = graph.getNode(layerId);
  return node ? readNodeMaskAnim(node).length > 0 : false;
}

export function keyframeSets(layerId: string, cat = catalogFor(layerId)): KeyframeSet[] {
  const out: KeyframeSet[] = [];
  for (const b of cat.props) {
    if (!isAnimated(layerId, b)) continue;
    out.push({ prop: { layer: layerId, path: b.path }, keyframes: readKeys(layerId, b).map((k) => keyAtToApi(layerId, b, k)) });
  }
  return out;
}

// ── Document ─────────────────────────────────────────────────────────

export function documentSnapshot(
  revision: number,
  projectPath: string,
  dirty: boolean,
  includeProperties: boolean,
  includeKeyframes: boolean,
): DocumentSnapshot {
  return withBarIndex(() => documentSnapshotIndexed(revision, projectPath, dirty, includeProperties, includeKeyframes));
}

function documentSnapshotIndexed(
  revision: number,
  projectPath: string,
  dirty: boolean,
  includeProperties: boolean,
  includeKeyframes: boolean,
): DocumentSnapshot {
  const comps = compItemIds();
  const layers: LayerInfo[] = [];
  for (const c of comps) for (const id of layerIdsOfComp(c)) layers.push(layerInfo(id));
  const propertyTrees = includeProperties ? layers.map((l) => ({ layer: l.id, nodes: propertyTree(l.id) })) : [];
  // A layer with no track, data track or mask keyframe has no keyframe set:
  // skip its catalog build (the bulk of a 2,000-layer snapshot otherwise).
  const keyframes = includeKeyframes ? layers.flatMap((l) => (mayHaveKeys(l.id) ? keyframeSets(l.id) : [])) : [];
  return {
    revision,
    projectPath,
    dirty,
    settings: getProjectSettings(),
    items: allItemInfos(),
    comps: comps.map(compInfo),
    layers,
    propertyTrees,
    keyframes,
    renderQueue: getRenderQueue(),
  };
}
