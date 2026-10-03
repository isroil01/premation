/**
 * Fixture layers pasted through the engine — what suites once wrote straight
 * into the TypeScript scene graph.
 */

import type { SceneNode } from '@core/types';
import { insertFragment } from '@/engine-client/insertFragment';
import { documentMirror } from '@stores/documentMirror';
import { settleEdits } from './appEngine';

export interface DrawnPoint { x: number; y: number; inX: number; inY: number; outX: number; outY: number }

/**
 * A drawn path layer as the Pen leaves it: a shape whose Geometry stores its
 * points (the engine's `layer/path.points`), at `x`, `y`. Resolves to its id,
 * its property tree loaded.
 */
export async function pasteDrawnShape(
  comp: string,
  points: readonly DrawnPoint[],
  opts: { name?: string; x?: number; y?: number; open?: boolean } = {},
): Promise<string> {
  const { name = 'Drawn', x = 0, y = 0, open = false } = opts;
  const ids = await insertFragment('Fixture', (b) => b.addChild(comp, {
    id: 'drawn', name, parent: comp, children: [], visible: true, locked: false,
    transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: 'drawn_t', type: 'Transform', props: { __kind: 'shape', x, y, rotation: 0, shapeType: 'path' } },
      { id: 'drawn_g', type: 'Geometry', props: { points: [...points], ...(open ? { open: true } : {}) } },
    ],
  } as unknown as SceneNode), { comp, noSelect: true });
  const id = ids![0]!;
  await settleEdits();
  await documentMirror().loadTree(id);
  return id;
}
