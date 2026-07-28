/**
 * SVGLayer — the scene-object model for an imported SVG.
 *
 * The hybrid import architecture treats an SVG the way it treats video, image
 * and Lottie: the asset is stored INTACT and stays intact until the user
 * explicitly asks for it to become editable geometry. Import is therefore a
 * capability scan plus a sanitize pass — the geometry parser never runs — which
 * is what makes a 300-path illustration import as one layer instead of 300.
 *
 * Storage lives on an `svg` component:
 *   sourceMarkup     verbatim, pre-sanitization — kept so the sanitization
 *                    policy is re-appliable and revert is lossless (§13)
 *   sanitizedMarkup  what actually renders (script-free, id-scoped)
 *   intrinsicWidth/Height, viewBox
 *   capabilities     the import-time scan, serialized
 *   fileName
 *
 * The renderer wants a `src` it can rasterize. That is derived, not stored: a
 * base64 data URL of `sanitizedMarkup` is three copies of the file if stored
 * alongside it, and rebuilding it per frame would base64 a megabyte 60×/sec. So
 * it is memoized here, keyed by node id, and returned as the SAME string
 * reference every frame — which is exactly what AppTextureProvider.setImage's
 * idempotence check needs to avoid re-decoding.
 */

import type { SceneNode } from '../types';
import { SCENE_KIND_PROP } from '../scene/seedDefaultScene';
import { svgToDataUrl, type SvgIntrinsicSize } from './svgSanitize';
import type { SvgCapabilities } from './svgCapabilities';

/** The component type carrying an SVG layer's document. */
export const SVG_COMPONENT = 'svg';

export interface SvgLayerData {
  sourceMarkup: string;
  sanitizedMarkup: string;
  intrinsicWidth: number;
  intrinsicHeight: number;
  viewBox: [number, number, number, number] | null;
  capabilities: SvgCapabilities;
  fileName: string;
}

/** The `svg` component on a node, or undefined when it isn't an SVG layer. */
function svgComponent(node: SceneNode): { props: Record<string, unknown> } | undefined {
  return node.components.find((c) => c.type === SVG_COMPONENT) as
    | { props: Record<string, unknown> }
    | undefined;
}

/** Read an SVG layer's stored document. Null for any other kind of node. */
export function readSvgLayer(node: SceneNode): SvgLayerData | null {
  const c = svgComponent(node);
  if (!c) return null;
  const p = c.props;
  const sanitized = typeof p.sanitizedMarkup === 'string' ? p.sanitizedMarkup : '';
  if (!sanitized) return null;
  return {
    sourceMarkup: typeof p.sourceMarkup === 'string' ? p.sourceMarkup : sanitized,
    sanitizedMarkup: sanitized,
    intrinsicWidth: typeof p.intrinsicWidth === 'number' ? p.intrinsicWidth : 512,
    intrinsicHeight: typeof p.intrinsicHeight === 'number' ? p.intrinsicHeight : 512,
    viewBox: Array.isArray(p.viewBox) && p.viewBox.length === 4
      ? (p.viewBox as [number, number, number, number])
      : null,
    capabilities: (p.capabilities ?? {}) as SvgCapabilities,
    fileName: typeof p.fileName === 'string' ? p.fileName : 'untitled.svg',
  };
}

/** True when this node is an SVG layer (as opposed to a converted shape group). */
export function isSvgLayer(node: SceneNode | undefined | null): boolean {
  return !!node && readSvgLayer(node) !== null;
}

/**
 * The original markup retained on a node, whether it is still an SVG layer or a
 * group that was converted from one. This is what "Revert to Original SVG"
 * reads, so it must survive conversion (§13).
 */
export function readRetainedSvgSource(node: SceneNode): { markup: string; fileName: string } | null {
  const c = svgComponent(node);
  if (!c) return null;
  const markup = typeof c.props.sourceMarkup === 'string' ? c.props.sourceMarkup : '';
  if (!markup) return null;
  return {
    markup,
    fileName: typeof c.props.fileName === 'string' ? c.props.fileName : 'untitled.svg',
  };
}

// ── Derived render source ────────────────────────────────────────────────────

/** nodeId → { markup it was built from, the data URL }. */
const dataUrlCache = new Map<string, { markup: string; url: string }>();

/**
 * Cache ceiling. Entries hold a base64 copy of a whole document, so a deleted
 * layer's entry is megabytes worth keeping only until it ages out — and no real
 * composition has anywhere near this many SVG layers live at once.
 */
const DATA_URL_CACHE_MAX = 64;

/**
 * The `data:` URL the texture pipeline rasterizes for this layer.
 *
 * Memoized on the node id and invalidated by markup identity, so editing the
 * layer's document (or reverting it) produces a new URL — and everything else
 * gets a stable reference that costs nothing to re-read each frame.
 */
export function svgLayerSrc(node: SceneNode): string | undefined {
  const data = readSvgLayer(node);
  if (!data) return undefined;
  const hit = dataUrlCache.get(node.id);
  if (hit && hit.markup === data.sanitizedMarkup) return hit.url;
  const url = svgToDataUrl(data.sanitizedMarkup);
  // Re-inserting moves the key to the end, so eviction is least-recently-written.
  dataUrlCache.delete(node.id);
  dataUrlCache.set(node.id, { markup: data.sanitizedMarkup, url });
  if (dataUrlCache.size > DATA_URL_CACHE_MAX) {
    const oldest = dataUrlCache.keys().next();
    if (!oldest.done) dataUrlCache.delete(oldest.value);
  }
  return url;
}

/** Drop a node's cached data URL (call when the layer is deleted). */
export function forgetSvgLayerSrc(nodeId: string): void {
  dataUrlCache.delete(nodeId);
}

// ── Component construction ───────────────────────────────────────────────────

/**
 * Build the `svg` component for a new layer.
 *
 * `SCENE_KIND_PROP` is duplicated here as well as on Transform because
 * `readNodeKind` scans components in order and stops at the first one carrying
 * it — a converted group keeps this component for its retained source, and must
 * NOT read back as kind 'svg' afterwards, so conversion drops the kind prop
 * rather than the whole component (see `stripSvgKind`).
 */
export function makeSvgComponent(
  id: string,
  data: {
    sourceMarkup: string;
    sanitizedMarkup: string;
    size: SvgIntrinsicSize;
    capabilities: SvgCapabilities;
    fileName: string;
  },
): { id: string; type: string; props: Record<string, unknown> } {
  return {
    id,
    type: SVG_COMPONENT,
    props: {
      sourceMarkup: data.sourceMarkup,
      sanitizedMarkup: data.sanitizedMarkup,
      intrinsicWidth: data.size.width,
      intrinsicHeight: data.size.height,
      viewBox: data.size.viewBox,
      capabilities: data.capabilities,
      fileName: data.fileName,
    },
  };
}

/**
 * Turn an SVG layer's component into a retained-source-only record.
 *
 * Conversion replaces the layer with real shape layers, so the rendered
 * document must go — but the ORIGINAL stays, because that is what makes
 * conversion non-destructive and re-runnable against a better parser later.
 */
export function stripToRetainedSource(props: Record<string, unknown>): Record<string, unknown> {
  const { sanitizedMarkup: _drop, ...rest } = props;
  delete (rest as Record<string, unknown>)[SCENE_KIND_PROP];
  return rest;
}
