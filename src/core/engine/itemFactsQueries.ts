/**
 * B4 round 5 queries (ENGINE_API.md §15.14) — the TypeScript engine's answers
 * to the item / layer facts the UI read around the API: the document's paint
 * colours, a composition's caption cues, a time through a layer's own time,
 * the intrinsic size Fit uses, and a precompose dry run. The C++ twins are in
 * native/engine/src/core/item_facts.cpp.
 */

import type {
  GetDocumentColors,
  GetCaptionCues,
  CaptionCue,
  MapLayerTime,
  GetSourceSize,
  LayerSourceSize,
  CheckPrecompose,
  TimelineRowSet,
} from '@motion/engine-api';
import { buildStaticPropertyTree } from '@core/timeline/propertyTree';
import { defaultAnimation } from '@motion/animation';
import { compToKeyframeTime, keyframeToCompTime } from '@core/timeline/TimelineController';
import { readCompRef } from '@core/scene/compInstance';
import { intrinsicSizeOf } from '@core/source/fitCommands';
import { leaveAttributesUnavailableReason } from '@core/composition/precompose';
import { collectDocumentColors } from '@core/paint/documentColors';
import type { SceneNode } from '@core/types';
import { graph, requireComp, requireLayer, compItemIds, layerIdsOfComp, isLayer } from './doc';
import { barsOf } from './model';
import { checkTime, compFps, flicksToSeconds, secondsToFlicks, framesToFlicks } from './time';

// ── getDocumentColors ──────────────────────────────────────────────────

/** Every layer of every composition, `findLayers` order. */
function everyLayerNode(): SceneNode[] {
  const out: SceneNode[] = [];
  for (const comp of compItemIds()) {
    for (const id of layerIdsOfComp(comp)) {
      const n = graph.getNode(id);
      if (n) out.push(n);
    }
  }
  return out;
}

export function documentColorsAnswer(q: GetDocumentColors): string[] {
  return collectDocumentColors(everyLayerNode(), q.limit > 0 ? q.limit : Number.POSITIVE_INFINITY);
}

// ── getCaptionCues ─────────────────────────────────────────────────────

function isCaption(node: SceneNode): boolean {
  return node.components.some((c) => (c.props as Record<string, unknown>).__caption === true);
}

/** The text a caption shows: the first component's string `content` (captionLayers.ts `captionText`). */
function captionText(node: SceneNode): string {
  for (const c of node.components) {
    const content = (c.props as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
  }
  return '';
}

export function captionCuesAnswer(q: GetCaptionCues): CaptionCue[] {
  requireComp(q.comp);
  const fps = compFps(q.comp);
  const cues: CaptionCue[] = [];
  for (const node of graph.getChildren(q.comp)) {
    if (!isCaption(node)) continue;
    const bar = barsOf(node.id, q.comp)[0];
    if (!bar) continue;
    const text = captionText(node).trim();
    if (text === '') continue;
    cues.push({ layer: node.id, start: framesToFlicks(bar.start, fps), end: framesToFlicks(bar.start + bar.duration, fps), text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

// ── mapLayerTime ───────────────────────────────────────────────────────

function isRemapped(layerId: string): boolean {
  return defaultAnimation.isAnimated(layerId, 'timeRemap') || defaultAnimation.isAnimated(layerId, 'precompTime');
}

/**
 * Composition time → the time inside what `layerId` shows (seconds): the
 * renderer's `precompSourceTime` — the layer's own time remap when keyframed,
 * then its clip retime / stretch (`compToKeyframeTime`). One to one for a layer
 * that shows no composition.
 */
export function innerTimeOf(layerId: string, parentTime: number): number {
  const node = graph.getNode(layerId);
  if (!node || !readCompRef(node)) return parentTime;
  const remapped = defaultAnimation.sample(layerId, 'timeRemap', parentTime)
    ?? defaultAnimation.sample(layerId, 'precompTime', parentTime);
  const t = typeof remapped === 'number' ? remapped : parentTime;
  return compToKeyframeTime(layerId, t);
}

/**
 * Nested time → the composition time that shows it, or null when that has no
 * single answer (a keyframed time remap can show one inner frame at many
 * times, or at none).
 */
export function outerTimeOf(layerId: string, innerTime: number): number | null {
  const node = graph.getNode(layerId);
  if (!node) return null;
  if (!readCompRef(node)) return innerTime;
  if (isRemapped(layerId)) return null;
  return keyframeToCompTime(layerId, innerTime);
}

export function mapLayerTimeAnswer(q: MapLayerTime): { time?: number } {
  requireLayer(q.layer);
  checkTime(q.time);
  const t = flicksToSeconds(q.time);
  const r = q.outward ? outerTimeOf(q.layer, t) : innerTimeOf(q.layer, t);
  return r === null || !Number.isFinite(r) ? {} : { time: secondsToFlicks(r) };
}

// ── getSourceSize ──────────────────────────────────────────────────────

export function sourceSizesAnswer(q: GetSourceSize): LayerSourceSize[] {
  const out: LayerSourceSize[] = [];
  for (const id of q.layers) {
    if (!isLayer(id)) continue;
    const node = graph.getNode(id);
    const size = node ? intrinsicSizeOf(node) : null;
    if (size) out.push({ layer: id, width: size.width, height: size.height });
  }
  return out;
}

// ── checkPrecompose ────────────────────────────────────────────────────

export function precomposeCheckAnswer(q: CheckPrecompose): string {
  requireComp(q.comp);
  return leaveAttributesUnavailableReason(q.layers, q.comp) ?? '';
}

// ── getTimelineRows ────────────────────────────────────────────────────

/** The timeline's AE row projection of each layer (`buildStaticPropertyTree`); unknown ids are skipped. */
export function timelineRowsAnswer(layers: readonly string[]): TimelineRowSet[] {
  const out: TimelineRowSet[] = [];
  for (const layer of layers) {
    if (!isLayer(layer)) continue;
    out.push({
      layer,
      rows: buildStaticPropertyTree(layer).map((r) => ({
        prop: r.prop,
        label: r.label,
        group: r.group,
        members: [...r.members],
        ...(r.merged ? { merged: r.merged } : {}),
        valueProps: [...r.valueProps],
        ...(r.valueUnit ? { valueUnit: r.valueUnit } : {}),
        maskTrack: r.maskTrack === true,
      })),
    });
  }
  return out;
}
