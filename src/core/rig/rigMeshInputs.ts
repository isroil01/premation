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
 * Resolution, plus the one ASSEMBLY that composes it (`nodeRestMesh`). No
 * solving. The coverage mask is cached by asset identity inside
 * `imageAlphaCoverage` and the mesh by node identity inside `getCachedRestMesh`;
 * neither cache is owned here.
 *
 * `lookupAsset` stays INJECTED throughout, so this module never reaches for a
 * store: each caller keeps its own cache strategy while the resolution ORDER
 * cannot diverge.
 */

import type { SceneNode } from '@core/types';
import type { SceneKind } from '@core/scene/seedDefaultScene';
import { assetUrl } from '@core/api/client';
import { readNodeSequence, sequenceSrcAt } from '@core/scene/imageSequence';
import { svgLayerSrc } from '@core/svg/svgLayer';
import { getImageCoverageMask } from '@core/rendering/imageAlphaCoverage';
import { resolveMediaSrc, type ProxyRecord, type ProxyTier } from '@core/assets/proxy';
import { readNodeKind } from '@core/scene/sceneDerive';
import { rasterPadding } from '@core/rendering/raster/vectorDraw';
import { readNodePuppet, getCachedRestMesh, silhouetteFromPathPoints, resolvePuppetSilhouette } from './puppet';
import { readNodeSkeleton } from './skeletonCommands';
import type { PuppetCoverageMask, PuppetRig, PuppetSilhouette } from './puppet';

/**
 * The mesh settings `buildRestMesh` falls back to when a rig stores none.
 *
 * They live here, beside the other shared mesh inputs, because a PANEL that
 * shows a default is making the same claim the mesher acts on. The bone rig's
 * Skinning Mesh card had drifted to 15 / 8 while the mesher used 22 / 0 — so it
 * described a mesh nobody was building, and its expansion default in particular
 * named the value that switches on the one-cell dilation that wraps a PNG
 * character in a ring of empty pixels.
 *
 * `buildRestMesh` still spells its own fallbacks inline (it is the puppet half's
 * file); these must stay equal to those two literals.
 */
export const MESH_DENSITY_DEFAULT = 22;
export const MESH_EXPANSION_DEFAULT = 0;

/** The media reference scanned off a node's components (mirrors readBase). */
export interface RigMediaRef {
  src?: string;
  assetId?: string;
}

/** Minimal asset shape the src resolver needs. `proxy` rides along so the ONE
 *  place an asset id becomes a decodable URL is also the one place a proxy can
 *  be substituted — see `@core/assets/proxy`. */
export interface RigAssetRef {
  src?: string;
  proxy?: ProxyRecord;
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
 *
 * `tier` opts this call in to a low-res stand-in. It defaults to `'original'`,
 * and that polarity is the safety property: export, the offline renderer and
 * the render-test harness never pass it, so they cannot use a proxy by
 * forgetting to opt out. Only the interactive viewport sets it, and only ever
 * to `'viewport'` — the analysis tier is not displayable and no render path can
 * name it. See `@core/assets/proxy`.
 */
export function resolveRigImageSrc(
  node: SceneNode,
  kind: SceneKind,
  media: RigMediaRef,
  sourceTime: number,
  lookupAsset: (id: string) => RigAssetRef | undefined,
  tier: ProxyTier = 'original',
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
    // The single substitution point. `resolveMediaSrc` falls back to the
    // original for every proxy state that is not ready-with-a-src.
    if (asset) {
      const resolved = resolveMediaSrc(asset, tier);
      if (resolved) return resolved;
    }
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

/**
 * The REST MESH for a node's rig, assembled from the inputs above.
 *
 * This assembly used to live inline in `BoneOverlay`, ~30 lines of node
 * scanning. The moment a second reader needed it — the numeric weight editor in
 * the Rigging panel — copying it would have recreated exactly the drift this
 * module was written to stop: two derivations of one mesh, agreeing until one of
 * them is edited. §2·0.
 *
 * Vertex INDICES are the reason this matters more than the usual duplication
 * argument. A weight override is stored against an index, so two callers that
 * build meshes of different density are not slightly inconsistent — they are
 * addressing different vertices, and the editor would write weights onto parts
 * of the artwork the user never touched.
 *
 * The puppet mesh WINS when the layer has pins: the two rigs compose, the puppet
 * refines the mesh first, and the skeleton pose carries it. A skeleton-only
 * layer falls back to its own density/expansion settings.
 */
export function nodeRestMesh(
  node: SceneNode,
  geom: { width: number; height: number; ellipse: boolean },
  lookupAsset: (id: string) => RigAssetRef | undefined,
  /**
   * The puppet overlay shows a mesh before any pin exists. Hug the artwork
   * (silhouette, expansion 0) so the first pin does not retopologize a bbox
   * grid into a body mesh. Bone overlay and the renderer leave this off.
   */
  authoringPreview = false,
): ReturnType<typeof getCachedRestMesh> {
  const skel = readNodeSkeleton(node);
  const puppetRig = readNodePuppet(node);
  const hasPins = (puppetRig?.pins?.length ?? 0) > 0;
  const kind = readNodeKind(node);
  // Pinless preview: mirror the mesh mode `addPuppetPin` will WRITE on the first
  // pin (`defaultMeshMode` in puppetCommands), so the lattice the user aims at
  // is the lattice they get. An image layer means the alpha outline mesh.
  const previewMeshMode: PuppetRig['meshMode'] =
    kind === 'image' || kind === 'svg' ? 'silhouette' : 'grid';
  const meshRig = hasPins
    ? puppetRig!
    : authoringPreview || puppetRig
      ? {
          pins: [] as PuppetRig['pins'],
          meshDensity: puppetRig?.meshDensity ?? skel?.meshDensity,
          meshExpansion: puppetRig?.meshExpansion ?? 0,
          meshMode: puppetRig?.meshMode ?? previewMeshMode,
          solver: puppetRig?.solver,
          maxRotationDeg: puppetRig?.maxRotationDeg,
        }
      : {
          pins: [],
          meshDensity: skel?.meshDensity,
          meshExpansion: skel?.meshExpansion,
          // Forwarded so a BONE-only layer can reach the alpha-outline mesh too.
          // Only density and expansion used to cross this boundary, so a skeleton
          // was pinned to the bbox grid no matter what the rig asked for, and a
          // thin arm had no triangles of its own for a bone to bend.
          meshMode: skel?.meshMode,
        };

  const geometryComponent = node.components.find((c) => c.type === 'Geometry');
  const pathSilhouette = silhouetteFromPathPoints(
    geometryComponent?.props.points as Array<{ x: number; y: number }> | undefined,
    geometryComponent?.props.open === true,
  );
  const media = readNodeMediaRef(node);
  const coverage = rigCoverageMask(
    rigLayerKind(kind),
    resolveRigImageSrc(node, kind, media, 0, lookupAsset),
    media.assetId,
    pathSilhouette,
  );
  const silhouette = resolvePuppetSilhouette(
    pathSilhouette,
    coverage,
    geom.width,
    geom.height,
    meshRig.meshMode,
  );
  // `rasterPadding` reads the paint/stroke shape the rasterizer pads for, so the
  // mesh covers the drawn pixels rather than the geometric box.
  const pad = rasterPadding({
    kind: geom.ellipse ? 'shape' : 'rect',
    stroke: node.components.find((c) => c.type === 'Stroke')?.props.stroke,
    strokes: node.components.find((c) => c.type === 'Strokes')?.props.strokes,
    paint: node.components.find((c) => c.type === 'Paint')?.props.paint,
  } as never);

  return getCachedRestMesh(node.id, geom.width, geom.height, pad, meshRig, silhouette, coverage);
}
