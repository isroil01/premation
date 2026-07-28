/**
 * Shared rest-mesh INPUTS for the puppet / bone rigs.
 *
 * WHY THIS MODULE EXISTS: `buildSnapshot` (what renders) and `PuppetOverlay`
 * (what you see while authoring) must derive the rest mesh from byte-identical
 * inputs, or the preview lies. That invariant was violated once — the overlay
 * omitted the image-alpha coverage mask that buildSnapshot passes, so on an
 * image layer it drew an untrimmed bbox grid over an alpha-culled render:
 * different vertex counts, different weights, a meaningless weight heatmap.
 *
 * Rather than re-deriving the inputs on each side (which is how they drifted),
 * both callers now go through the helpers here. Anything that changes how a
 * mesh input is resolved changes it for both, by construction.
 *
 * Pure resolution only — no solving, no caching of meshes. The coverage mask
 * itself is cached by asset identity inside `imageAlphaCoverage`.
 */

import type { SceneNode } from '@core/types';
import type { SceneKind } from '@core/scene/seedDefaultScene';
import { assetUrl } from '@core/api/client';
import { readNodeSequence, sequenceSrcAt } from '@core/scene/imageSequence';
import { svgLayerSrc } from '@core/svg/svgLayer';
import { getImageCoverageMask } from '@core/rendering/imageAlphaCoverage';
import type { PuppetCoverageMask, PuppetSilhouette } from './puppet';

/** The media reference scanned off a node's components (mirrors readBase). */
export interface RigMediaRef {
  src?: string;
  assetId?: string;
}

/** Minimal asset shape the src resolver needs. */
export interface RigAssetRef {
  src?: string;
}

/**
 * Scan a node's components for its media reference. `readBase` in buildSnapshot
 * does exactly this scan (last writer wins) as part of a much larger read; this
 * is the same rule, isolated so non-snapshot callers get the same answer.
 */
export function readNodeMediaRef(node: SceneNode): RigMediaRef {
  let src: string | undefined;
  let assetId: string | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.src === 'string') src = p.src;
    if (typeof p.assetId === 'string') assetId = p.assetId;
  }
  return { src, assetId };
}

/**
 * The layer kind the rig mesh reasons about. An SVG layer is a stored vector
 * document rasterized to a texture, so it composites — and meshes — exactly
 * like an image. Mirrors buildSnapshot's `layerKind`.
 */
export function rigLayerKind(kind: SceneKind): 'shape' | 'text' | 'image' | 'video' {
  if (kind === 'svg') return 'image';
  if (kind === 'shape' || kind === 'text' || kind === 'image' || kind === 'video') return kind;
  return 'shape';
}

/**
 * Resolve the image source a layer draws from, in buildSnapshot's exact order:
 * SVG document → image-sequence frame at `sourceTime` → asset library entry →
 * healed raw src.
 *
 * `lookupAsset` is injected so each caller keeps its own cache strategy
 * (buildSnapshot memoizes an id→asset Map once per snapshot; the overlay reads
 * the store directly) without the resolution ORDER ever diverging.
 */
export function resolveRigImageSrc(
  node: SceneNode,
  kind: SceneKind,
  media: RigMediaRef,
  sourceTime: number,
  lookupAsset: (id: string) => RigAssetRef | undefined,
): string {
  // SVG layer: the document lives on the node, not in the asset library.
  // `svgLayerSrc` memoizes the data URL per node and hands back the SAME string
  // reference each frame, so setImage's idempotence check short-circuits
  // instead of re-decoding a megabyte of markup 60x/sec.
  if (kind === 'svg') {
    const svgSrc = svgLayerSrc(node);
    if (svgSrc) return svgSrc;
  }
  // Image sequence: pick the frame for this layer's source time (holds the last
  // frame past the end). Deterministic — scrubbing is stable.
  const seq = readNodeSequence(node);
  if (seq) return assetUrl(sequenceSrcAt(seq, sourceTime));
  if (media.assetId) {
    const asset = lookupAsset(media.assetId);
    if (asset && asset.src) return asset.src;
  }
  return assetUrl(media.src);
}

/**
 * The coverage mask a rest mesh should cull against, or undefined for the plain
 * bbox grid.
 *
 * Precedence matches buildSnapshot: a path `silhouette` (closed vector outline)
 * always wins; image layers fall back to an alpha-derived mask; everything else
 * (open strokes, text, video, an image whose bitmap has not decoded yet) keeps
 * the bbox grid. Never blocks and never throws — an undecoded bitmap simply
 * returns undefined for this frame and the tighter mesh appears once the decode
 * lands.
 */
export function rigCoverageMask(
  layerKind: string,
  src: string | undefined,
  assetId: string | undefined,
  silhouette: PuppetSilhouette | undefined,
): PuppetCoverageMask | undefined {
  if (silhouette) return undefined;
  if (layerKind !== 'image' || !src) return undefined;
  return getImageCoverageMask(assetId ?? src, src);
}
