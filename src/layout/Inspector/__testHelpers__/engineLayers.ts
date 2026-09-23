/**
 * Test helpers for inspector suites whose writes go through the engine API
 * (B3). The engine addresses LAYERS — nodes inside a composition — so a
 * fixture node added at the top level (parent null) is a composition root to
 * it, and the inspector keeps its legacy path for it. `addLayer` parents the
 * fixture under a shared test composition root instead; `idle` waits for the
 * asynchronous engine commands a click or a typed value sent.
 */

import { act } from '@testing-library/react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { engineIdle } from '@core/engine/engineInstance';
import type { SceneNode } from '@core/types';

export const TEST_COMP_ROOT = 'inspector_test_comp_root';

/** Add `node` as a layer of the shared test composition (creating the root once). */
export function addLayer(node: SceneNode): void {
  if (!defaultSceneGraph.getNode(TEST_COMP_ROOT)) {
    defaultSceneGraph.addNode({
      id: TEST_COMP_ROOT, name: 'Test Comp', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [],
    } as unknown as SceneNode);
  }
  defaultSceneGraph.addChild(TEST_COMP_ROOT, node);
}

/** Wait for every queued engine request (and re-render). */
export async function idle(): Promise<void> {
  await act(async () => { await engineIdle(); });
}
