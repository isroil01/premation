/**
 * Choosing which file an analysis walk decodes — and refusing to when it
 * cannot say what the answer means.
 *
 * ## The trap this exists to close
 *
 * Every analysis walk measures in the DECODED grid and reports in the source's
 * DISPLAY grid, converting by `decoded ÷ display`. Decoding a 960px stand-in of
 * a 3840px source is therefore free of precision cost — the conversion absorbs
 * it, and precision is a property of the matcher rather than of the file.
 *
 * That holds only while `display` is known INDEPENDENTLY of what was decoded.
 * Both walks derived it as `sourceDisplaySize(nodeId) ?? decoded size`, and
 * that fallback was harmless for exactly as long as the decoded file WAS the
 * source. Point a walk at a proxy and the fallback quietly becomes the proxy's
 * own size, the ratio collapses to 1, and every measurement comes back in
 * proxy pixels — a track offset by a constant factor of four, or a stabilizer
 * correcting a quarter of the camera motion. No error, no warning, and nothing
 * in the numbers that looks wrong on its own.
 *
 * So the rule here has the same polarity as the rest of the proxy code: if the
 * original's grid cannot be established without asking the decoder, DO NOT use
 * a stand-in. Slower than it could be beats wrong, and `proxyManager`'s header
 * says the same thing about every other proxy failure path.
 */

import { resolveMediaSrc, servedProxy, type ProxyResolvable, type ProxyTier } from '@core/assets/proxy';
import { sourceDisplaySize } from './trackerSource';

/** The subset of an imported asset this decision needs. */
export interface AnalysisAsset extends ProxyResolvable {
  metadata?: { width?: number; height?: number } | undefined;
}

export interface AnalysisPlan {
  /** The file to decode. */
  src: string;
  /** Which tier that turned out to be — diagnostics and tests. */
  tier: ProxyTier;
  /**
   * The ORIGINAL's display grid, or null when it could not be established
   * without the decoder. Null forces `tier: 'original'`, so a caller that
   * falls back to the decoded size cannot be wrong about it.
   */
  display: { width: number; height: number } | null;
}

/**
 * The source's display grid, from facts that do not depend on the decode.
 *
 * `sourceDisplaySize` first — it is the one answer to "what pixel grid is a
 * track point in?" and applies PAR. The asset's own metadata second: it
 * describes the ORIGINAL and never the proxy (`@core/assets/proxy` is explicit
 * that a proxy substitutes pixels and nothing else), so it stays valid however
 * far down the tier ladder the decode lands.
 */
export function originalDisplaySize(
  nodeId: string,
  asset: AnalysisAsset,
): { width: number; height: number } | null {
  const fromSource = sourceDisplaySize(nodeId);
  if (fromSource) return fromSource;
  const w = asset.metadata?.width;
  const h = asset.metadata?.height;
  if (w && h && w > 0 && h > 0) return { width: w, height: h };
  return null;
}

/**
 * Which file this walk should decode, and the grid to report in.
 *
 * Requests the analysis tier BY NAME — no render path can, and the export
 * invariant is untouched. Falls back analysis → viewport → original inside
 * `resolveMediaSrc`, because an analysis walk cares about decode cost alone and
 * a 1920px stand-in beats a 3840px one when no 960px one exists.
 */
export function planAnalysisDecode(nodeId: string, asset: AnalysisAsset): AnalysisPlan {
  const display = originalDisplaySize(nodeId, asset);
  if (!display) {
    // Nothing to scale back to. Decode the source, report in its own grid.
    return { src: asset.src ?? '', tier: 'original', display: null };
  }
  const served = servedProxy(asset, 'analysis');
  const tier: ProxyTier = !served
    ? 'original'
    : served === asset.analysisProxy
      ? 'analysis'
      : 'viewport';
  return { src: resolveMediaSrc(asset, 'analysis') ?? asset.src ?? '', tier, display };
}
