/**
 * An SVG layer's stored document, asked of the engine (`getSvgDocument`), in
 * the shape the SVG helpers take (core/svg/svgLayer `SvgLayerData`). Shared by
 * the Inspector's conversions and the AI's.
 */

import type { SvgDocument } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import type { SvgLayerData } from './svgLayer';
import type { SvgCapabilities } from './svgCapabilities';

/** An SVG layer's stored document as the SVG helpers take it (the engine's `getSvgDocument`), or null for any other layer. */
export function svgLayerDataOf(doc: SvgDocument | null | undefined): SvgLayerData | null {
  if (!doc || doc.role !== 'layer' || !doc.sanitizedMarkup) return null;
  let capabilities = {} as SvgCapabilities;
  try {
    capabilities = JSON.parse(doc.capabilities) as SvgCapabilities;
  } catch {
    /* an unreadable scan reads as none */
  }
  return {
    sourceMarkup: doc.sourceMarkup,
    sanitizedMarkup: doc.sanitizedMarkup,
    intrinsicWidth: doc.intrinsicWidth,
    intrinsicHeight: doc.intrinsicHeight,
    viewBox: doc.viewBox ? [doc.viewBox.x, doc.viewBox.y, doc.viewBox.width, doc.viewBox.height] : null,
    capabilities,
    fileName: doc.fileName,
    livePlayback: doc.livePlayback,
  };
}

/** The layer's SVG document, asked of the engine (null when it is not an SVG layer). */
export async function fetchSvgLayerData(nodeId: string): Promise<SvgLayerData | null> {
  const res = await engine().query({ type: 'getSvgDocument', layer: nodeId });
  return res.ok ? svgLayerDataOf(res.value) : null;
}

