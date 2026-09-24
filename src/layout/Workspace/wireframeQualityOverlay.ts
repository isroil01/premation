/**
 * Per-layer Quality = WIREFRAME, drawn as viewport chrome.
 *
 * `buildSnapshot` hides a wireframe-quality layer's pixels whenever its host
 * passes `wireframeLayers: true` — the main viewport AND the secondary surfaces
 * (the 2-up / 4-up panes, Presentation Mode). Only the main viewport drew the
 * layer's box in their place, so in a pane the layer simply vanished, which is
 * the one thing AE's Wireframe switch never does.
 *
 * So the painter lives here, and every host calls it with its OWN view:
 * geometry arrives in comp space (the oriented `worldCorners` the selection
 * outline uses — already projected through that host's camera, so Top/Front
 * and camera views come out right), and `toScreen` is the host's comp → canvas
 * map. The geometry half is pure and tested; the canvas half is two strokes.
 */

import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import { flattenCompLayers } from '@core/mirror/compLayers';

export interface WirePt {
  x: number;
  y: number;
}

export type WireQuad = readonly [WirePt, WirePt, WirePt, WirePt];

/** The slice of a workspace node the painter reads. */
export interface WireframeNodeGeometry {
  readonly id: string;
  readonly worldBounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly worldCorners?: ReadonlyArray<WirePt>;
}

/**
 * Whether the active comp has ANY wireframe-quality layer, memoised per
 * document revision (and composition). The painter used to ask the workspace
 * port for every node's resolved world geometry on every frame just to find
 * out there was nothing to draw — on a 300-layer comp that resolve (with its
 * per-node keyframe-time fold) was the single largest allocation of a playback
 * frame. Read from the mirror's layer headers (B4): during playback the
 * revision does not move, so a frame pays two comparisons and no allocation.
 */
let anyWireframeRev = -1;
let anyWireframeGen = -1;
let anyWireframeComp: string | undefined;
let anyWireframe = false;
export function compHasWireframeQualityLayer(): boolean {
  const m = documentMirror();
  const comp = activeCompIdNow();
  if (m.revision !== anyWireframeRev || m.generation !== anyWireframeGen || comp !== anyWireframeComp) {
    anyWireframeRev = m.revision;
    anyWireframeGen = m.generation;
    anyWireframeComp = comp;
    anyWireframe = flattenCompLayers(m, comp).some((id) => isWireframeQualityLayer(id));
  }
  return anyWireframe;
}

/** Hidden (eye off) layers draw nothing, as in AE. */
export function isWireframeQualityLayer(nodeId: string): boolean {
  const layer = documentMirror().layer(nodeId);
  return !!layer && layer.switches.visible && layer.switches.quality === 'wireframe';
}

/**
 * The screen quads to stroke: one per visible wireframe-quality node, from its
 * oriented corners (the AABB when an adapter supplied none). A node whose
 * projection is not finite — behind the camera, degenerate — is skipped rather
 * than drawn as a line to infinity.
 */
export function wireframeQuads(
  nodes: Iterable<WireframeNodeGeometry | null | undefined>,
  toScreen: (p: WirePt) => WirePt,
  isWireframe: (nodeId: string) => boolean = isWireframeQualityLayer,
): WireQuad[] {
  const out: WireQuad[] = [];
  for (const node of nodes) {
    if (!node || !isWireframe(node.id)) continue;
    const b = node.worldBounds;
    const corners: ReadonlyArray<WirePt> =
      node.worldCorners && node.worldCorners.length >= 4
        ? node.worldCorners
        : [
            { x: b.x, y: b.y },
            { x: b.x + b.width, y: b.y },
            { x: b.x + b.width, y: b.y + b.height },
            { x: b.x, y: b.y + b.height },
          ];
    const [p0, p1, p2, p3] = corners.slice(0, 4).map((c) => toScreen({ x: c.x, y: c.y }));
    if (!p0 || !p1 || !p2 || !p3) continue;
    if ([p0, p1, p2, p3].some((q) => !Number.isFinite(q.x) || !Number.isFinite(q.y))) continue;
    out.push([p0, p1, p2, p3]);
  }
  return out;
}

/** Dark halo under the hairline — readable over any artwork. */
const HALO = 'rgba(0,0,0,0.45)';

/** The hairline colour: the ruler text token, as the main viewport has always used. */
export function wireframeLineColor(): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--color-ruler-text').trim();
    return v || 'rgb(204,204,204)';
  } catch {
    return 'rgb(204,204,204)';
  }
}

function strokeQuad(ctx: CanvasRenderingContext2D, q: WireQuad): void {
  ctx.beginPath();
  ctx.moveTo(q[0].x + 0.5, q[0].y + 0.5);
  for (let i = 1; i < 4; i++) ctx.lineTo(q[i]!.x + 0.5, q[i]!.y + 0.5);
  ctx.closePath();
  ctx.stroke();
}

export function strokeWireframeQuads(
  ctx: CanvasRenderingContext2D,
  quads: ReadonlyArray<WireQuad>,
  lineColor: string = wireframeLineColor(),
): void {
  if (quads.length === 0) return;
  ctx.save();
  for (const q of quads) {
    ctx.strokeStyle = HALO;
    ctx.lineWidth = 3;
    strokeQuad(ctx, q);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    strokeQuad(ctx, q);
  }
  ctx.restore();
}

/** Both halves, for a host that already has a 2D context in canvas CSS px. Returns the quad count. */
export function paintWireframeQualityLayers(
  ctx: CanvasRenderingContext2D,
  nodes: Iterable<WireframeNodeGeometry | null | undefined>,
  toScreen: (p: WirePt) => WirePt,
  lineColor?: string,
): number {
  const quads = wireframeQuads(nodes, toScreen);
  strokeWireframeQuads(ctx, quads, lineColor);
  return quads.length;
}

/** A comp → canvas map from a `{ scale, offsetX, offsetY }` view (a pane's RenderView). */
export function viewToScreen(view: { scale: number; offsetX: number; offsetY: number }): (p: WirePt) => WirePt {
  return (p) => ({ x: p.x * view.scale + view.offsetX, y: p.y * view.scale + view.offsetY });
}
