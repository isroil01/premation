/**
 * Quality = Wireframe boxes over an engine surface.
 *
 * The engine draws the pixels (EngineSurface, EnginePaneSurface); a layer whose
 * Quality is Wireframe draws no pixels, so the page paints its box on a 2D
 * canvas laid over the surface, through the same comp → canvas view the
 * surface was asked to render with (the host's live view, else the contain fit).
 */

import type { RenderView } from '@core/workspace/renderView';
import { paneViewTransform } from './useSceneRefGeometry';
import {
  paintWireframeQualityLayers,
  viewToScreen,
  wireframeQuads,
  type WireframeNodeGeometry,
} from './wireframeQualityOverlay';

/** A 2D canvas over the surface, and the nodes whose wireframe boxes it draws. */
export interface WireframeOverlayHost {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Comp-space geometry, projected through THIS surface's view. */
  nodes: () => Iterable<WireframeNodeGeometry | null | undefined>;
}

/**
 * Paint the host's wireframe boxes onto its overlay canvas, aligned to
 * `content` (the surface's box) and mapped through `view`.
 *
 * Touches the 2D context only when there is something to draw or clear, so a
 * surface with no wireframe layers never creates one.
 */
export function paintWireframeOverlay(
  host: WireframeOverlayHost,
  content: HTMLElement | null,
  view: RenderView | undefined,
  comp: { width: number; height: number },
  painted: { current: boolean },
): void {
  const overlay = host.canvasRef.current;
  if (!overlay || !content) return;
  const box = content.getBoundingClientRect();
  if (box.width < 1 || box.height < 1 || comp.width <= 0 || comp.height <= 0) return;
  const toScreen = viewToScreen(view ?? paneViewTransform(box.width, box.height, comp.width, comp.height));
  const nodes = [...host.nodes()];
  if (!painted.current && wireframeQuads(nodes, toScreen).length === 0) return;
  const parent = overlay.offsetParent?.getBoundingClientRect();
  overlay.style.left = `${box.left - (parent?.left ?? box.left)}px`;
  overlay.style.top = `${box.top - (parent?.top ?? box.top)}px`;
  overlay.style.width = `${box.width}px`;
  overlay.style.height = `${box.height}px`;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(box.width * dpr);
  const h = Math.round(box.height * dpr);
  if (overlay.width !== w) overlay.width = w;
  if (overlay.height !== h) overlay.height = h;
  const ctx = overlay.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, box.width, box.height);
  painted.current = paintWireframeQualityLayers(ctx, nodes, toScreen) > 0;
}
