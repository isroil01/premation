/**
 * Canvas drag-and-drop payloads (AE-style "drag a thing onto the scene").
 *
 * Left-panel library items (shapes, text, assets, components) and the effect /
 * motion-preset browsers set a typed payload on the native drag event; the
 * viewport (see Workspace.tsx) reads it on drop and inserts/applies at the
 * cursor. A discrete MIME key is used because `dragover` can inspect
 * `dataTransfer.types` but browsers forbid reading the DATA until `drop` — so
 * the viewport gates the drop on the key alone and only parses on drop.
 */

import type { ShapeKind } from '@core/scene/sceneInsert';
import type { EffectType } from '@core/effects/effects';

export const CANVAS_DRAG_MIME = 'application/x-motion-drag';

export type CanvasDragPayload =
  | { kind: 'shape'; primitive: ShapeKind; label: string }
  | { kind: 'text'; label: string; fontSize: number; weight: number; extra?: Record<string, unknown> }
  | { kind: 'asset'; assetId: string }
  | { kind: 'component'; componentId: string }
  | { kind: 'component-preset'; presetId: string; label: string }
  | { kind: 'effect'; effectType: EffectType }
  | { kind: 'motionPreset'; name: string }
  | { kind: 'animPreset'; presetId: string }
  | { kind: 'cursor'; cursorId: string; name: string }
  | { kind: 'uikit'; componentId: string; name: string }
  | { kind: 'mograph'; mographId: string; name: string }
  | { kind: 'transition'; transId: string; name: string }
  | { kind: 'sfx'; sfxId: string; name: string }
  | { kind: 'lottie'; lottieId: string; name: string };


/** Attach a typed payload to a drag event (call from a panel item's onDragStart). */
export function setCanvasDrag(e: { dataTransfer: DataTransfer | null }, payload: CanvasDragPayload): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(CANVAS_DRAG_MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = 'copy';
}

/** True if this drag carries a canvas payload (safe to call during dragover). */
export function hasCanvasDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(CANVAS_DRAG_MIME);
}

/** Read the payload on drop. Returns null if absent or malformed. */
export function readCanvasDrag(e: { dataTransfer: DataTransfer | null }): CanvasDragPayload | null {
  if (!e.dataTransfer) return null;
  const raw = e.dataTransfer.getData(CANVAS_DRAG_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CanvasDragPayload;
  } catch {
    return null;
  }
}
