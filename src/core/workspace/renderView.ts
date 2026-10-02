/**
 * View transform (comp → canvas, in CSS pixels) supplied by the workspace
 * camera. canvasPx = compPx * scale + offset.
 */

export interface RenderView {
  scale: number;
  offsetX: number;
  offsetY: number;
}
