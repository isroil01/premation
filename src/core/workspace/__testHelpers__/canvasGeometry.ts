/**
 * Tests of the viewport's ports: the canvas geometry (the main viewport's
 * overlay subscription naming every layer of the active composition) is what
 * the scene port and the tool writes read. In the app the viewport's
 * Workspace holds it for its lifetime; a test holds it here.
 */

import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { useGuidesStore } from '@stores/guidesStore';
import { retainCanvasGeometry } from '../geometryPort';

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
 * subscription. The mirror is re-read first: fixtures built straight on the
 * TypeScript engine's graph reach it only as an unattributed resync.
 */
export async function holdCanvasGeometry(): Promise<void> {
  await settleGeometry();
  documentMirror().reload();
  await settleGeometry();
  release ??= retainCanvasGeometry(useGuidesStore.getState().camera3dMode);
  await settleGeometry();
}

/** Drop the hold (afterEach). */
export function releaseCanvasGeometry(): void {
  release?.();
  release = null;
}
