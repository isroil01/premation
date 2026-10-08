/**
 * Plugin viewer overlays (plugin SDK 1.1, docs/PLUGIN_SDK.md "Viewer overlays"):
 * what a native plugin effect draws over the viewer (PR_CMD_DRAW_OVERLAY), as
 * the engine pushes it with the frame (overlay kind `plugin`, layer px), and
 * the commands a handle drag sends (`dragEffectOverlay`, PR_CMD_OVERLAY_DRAG).
 *
 * Pure: projection in, SVG data and commands out. The component is
 * src/layout/Workspace/PluginOverlay.tsx. No plugin code runs in the page —
 * the engine asked the plugin; this only draws its list.
 */

import type { Command, OverlayPluginItem } from '@motion/engine-api';

export interface Point {
  x: number;
  y: number;
}

/** A drawable, already in screen px. */
export type OverlayShape =
  | { kind: 'path'; d: string; color: string | null }
  | { kind: 'handle'; effect: string; handle: number; shape: number; at: Point; local: Point; color: string | null };

/** Straight rgba 0..1 → CSS; null = the viewer's handle colour. */
export function cssColor(c: readonly number[]): string | null {
  if (c.length < 4) return null;
  const b = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgba(${b(c[0]!)}, ${b(c[1]!)}, ${b(c[2]!)}, ${Math.min(1, Math.max(0, c[3]!)).toFixed(3)})`;
}

/** The engine's items → screen shapes through `toScreen` (layer px → screen px). */
export function overlayShapes(items: readonly OverlayPluginItem[], toScreen: (x: number, y: number) => Point): OverlayShape[] {
  const out: OverlayShape[] = [];
  for (const i of items) {
    const color = cssColor(i.color);
    if (i.kind === 'handle' && i.points.length >= 2) {
      const local = { x: i.points[0]!, y: i.points[1]! };
      out.push({ kind: 'handle', effect: i.effect, handle: i.handle, shape: i.shape, at: toScreen(local.x, local.y), local, color });
      continue;
    }
    if ((i.kind === 'line' || i.kind === 'path') && i.points.length >= 4) {
      let d = '';
      for (let k = 0; k + 1 < i.points.length; k += 2) {
        const s = toScreen(i.points[k]!, i.points[k + 1]!);
        d += `${k === 0 ? 'M' : 'L'}${s.x.toFixed(2)} ${s.y.toFixed(2)}`;
      }
      if (i.kind === 'path' && i.closed) d += 'Z';
      out.push({ kind: 'path', d, color });
    }
  }
  return out;
}

/** The handle under `p` (screen px) within `radius`, nearest first. */
export function pickHandle(shapes: readonly OverlayShape[], p: Point, radius: number): Extract<OverlayShape, { kind: 'handle' }> | null {
  let best: Extract<OverlayShape, { kind: 'handle' }> | null = null;
  let bestD = radius * radius;
  for (const s of shapes) {
    if (s.kind !== 'handle') continue;
    const d = (s.at.x - p.x) ** 2 + (s.at.y - p.y) ** 2;
    if (d <= bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

export const DRAG_BEGIN = 0;
export const DRAG_MOVE = 1;
export const DRAG_END = 2;

/** One step of a handle drag (layer px). The caller sends a drag's steps inside one gesture. */
export function dragCommand(
  layer: string,
  effect: string,
  handle: number,
  at: Point,
  start: Point,
  phase: typeof DRAG_BEGIN | typeof DRAG_MOVE | typeof DRAG_END,
): Command {
  return {
    type: 'dragEffectOverlay',
    group: { layer, path: effect },
    handle,
    x: at.x,
    y: at.y,
    startX: start.x,
    startY: start.y,
    phase,
  } as Command;
}
