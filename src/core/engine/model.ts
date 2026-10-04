/**
 * Read model: build the API's records (LayerInfo, CompSettings, ItemInfo,
 * Marker, PropertyInfo, KeyframeSet, DocumentSnapshot) from today's stores.
 * Pure reads — nothing here writes the document.
 */

import type {
  LayerInfo,
  TrackMatte,
  ItemInfo,
  Transition,
  Color,
  Interpretation,
  MotionBlurSettings,
  ColorManagementSettings,
} from '@motion/engine-api';
import type {  Layer as TimelineBar } from '@motion/timeline';
import {  type ImportedAsset, type AssetFolder } from '@stores/assetStore';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { useColorManagementStore } from '@stores/colorManagementStore';
import type { TransitionRecord, TransitionKind, TransitionAlignment } from '@core/timeline/transitionModel';
import { readNodeMatte } from '@core/effects/matte';
import { LABEL_COLORS } from '@core/scene/labelColor';
import { parseColorChannels } from '@core/effects/effects';
import type { SceneNode } from '@core/types';
import { compFps, framesToFlicks, fpsToRational, secondsToFlicks } from './time';

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

export function layerMatte(node: SceneNode): TrackMatte {
  const m = readNodeMatte(node);
  if (!m) return { mode: 'none' };
  const mode = m.mode === 'luma' ? (m.inverted ? 'lumaInverted' : 'luma') : m.inverted ? 'alphaInverted' : 'alpha';
  return { mode, ...(m.sourceId ? { layer: m.sourceId } : {}) };
}

/** B4: what the layer holds of an SVG document — its `svg` component's sanitized markup (an SVG layer) or only the retained source (a converted group). */
export function svgRoleOf(node: SceneNode): LayerInfo['svg'] {
  const p = node.components.find((c) => c.type === 'svg')?.props as Record<string, unknown> | undefined;
  if (!p) return 'none';
  if (typeof p.sanitizedMarkup === 'string' && p.sanitizedMarkup !== '') return 'layer';
  if (typeof p.sourceMarkup === 'string' && p.sourceMarkup !== '') return 'converted';
  return 'none';
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
    mediaType: a.type === 'image' || a.type === 'video' || a.type === 'audio' ? a.type : 'none',
    alphaProbed: typeof md.hasAlpha === 'boolean',
    audioProbed: typeof md.hasAudioTrack === 'boolean',
    // B4 round 5: the stored source reference the page's media loaders take (object URL, local-file:, motion-blob:).
    ...(typeof a.src === 'string' && a.src !== '' ? { mediaUrl: a.src } : {}),
  };
}

export function folderInfo(f: AssetFolder): ItemInfo {
  return {
    id: f.id, kind: 'folder', name: f.name, ...(f.parentId ? { parent: f.parentId } : {}),
    label: 0, comment: '', path: '', missing: false, width: 0, height: 0, duration: 0,
    hasVideo: false, hasAudio: false, hasAlpha: false, proxyPath: '', proxyEnabled: false,
    tags: [], codec: '', audioChannels: 0, audioSampleRate: 0, colorProfile: '', fileBytes: 0,
    mediaType: 'none', alphaProbed: false, audioProbed: false,
  };
}

/** F2: the project's motion-blur record (motionBlurStore) as CompSettings / DocumentSnapshot report it. */
export function motionBlurInfo(): MotionBlurSettings {
  const mb = useMotionBlurStore.getState().settings();
  return {
    shutterAngle: mb.shutterAngle,
    shutterPhase: mb.shutterPhase,
    samplesPerFrame: mb.samples,
    adaptiveSampleLimit: mb.adaptiveSampleLimit,
    enabled: mb.enabled,
  };
}

/** F2: colorManagementStore.settings() as the API reports it. */
export function colorManagementInfo(): ColorManagementSettings {
  const cm = useColorManagementStore.getState().settings();
  return {
    workingSpace: cm.workingSpace === 'aces-cg' ? 'acesCg' : 'srgbLinear',
    displayTransform: cm.displayTransform,
    bitDepth: cm.bitDepth === 32 ? 32 : 16,
  };
}
