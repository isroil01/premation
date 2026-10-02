/**
 * The comp-space geometry of the active composition's layers, for the
 * Quality = Wireframe boxes a surface paints over the engine's frame
 * (layout/Workspace/wireframeOverlay.ts) where it has no workspace port of its
 * own — presentation mode. Read through the Active Camera view.
 */

import { createSceneGraphPort } from '@core/workspace/ports';

let wireframePort: ReturnType<typeof createSceneGraphPort> | null = null;

export function activeViewWireframeNodes(): Iterable<{
  id: string;
  worldBounds: { x: number; y: number; width: number; height: number };
  worldCorners?: ReadonlyArray<{ x: number; y: number }>;
} | null | undefined> {
  wireframePort ??= createSceneGraphPort();
  return wireframePort.getNodes();
}
