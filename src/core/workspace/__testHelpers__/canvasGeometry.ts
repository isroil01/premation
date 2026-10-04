/**
 * Tests of the viewport's ports: the canvas geometry (the main viewport's
 * overlay subscription naming every layer of the active composition) is what
 * the scene port and the tool writes read. In the app the viewport's
 * Workspace holds it for its lifetime; a test holds it here.
 */

import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { useGuidesStore } from '@stores/guidesStore';
import { createSceneGraphPort, retainCanvasGeometry } from '../geometryPort';
import { useSelectionStore } from '@stores/selectionStore';
import { MAIN_VIEWPORT, overlayLayer } from '@stores/overlayGeometry';

let release: (() => void) | null = null;

/** Let the engine settle: the mirror sees the edit, the canvas subscription follows it, the engine takes it. */
export async function settleGeometry(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await engineIdle();
    await documentMirror().whenIdle();
    await Promise.resolve();
  }
}

/**
 * Hold the canvas geometry (idempotent) and wait until the engine has the
 * subscription — and, for `ids` (default: the selection), until a frame has
 * carried their records (the tool writes read them; a loaded run may take a while).
 */
export async function holdCanvasGeometry(ids?: readonly string[]): Promise<void> {
  await settleGeometry();
  release ??= retainCanvasGeometry(useGuidesStore.getState().camera3dMode);
  await settleGeometry();
  // An animated outline is the mirror's batched value at the playhead: the
  // first read asks for it (the viewport re-reads every frame; a test reads once).
  const port = createSceneGraphPort();
  const want = ids ?? useSelectionStore.getState().ids;
  for (const id of want) port.getNode(id as never);
  await settleGeometry();
  const deadline = Date.now() + 3000;
  while (want.some((id) => !overlayLayer(MAIN_VIEWPORT, id, 0)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    await settleGeometry();
  }
}

/** Drop the hold (afterEach). */
export function releaseCanvasGeometry(): void {
  release?.();
  release = null;
}
