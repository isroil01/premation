/**
 * A DRAWN vector layer gets the same Continuous Rasterization default an
 * INSERTED one does.
 *
 * ── The bug this exists for ────────────────────────────────────────────
 * `enableContinuousRasterByDefault` was a private helper inside `sceneInsert`,
 * and its four call sites are every menu and library insert — and nothing else.
 * Layers the user DRAWS are built by `makeNodeAt` here in `ports`, which could
 * not reach it, so the pen, the pencil, the brush, the curvature pen and the
 * shape tools all silently opted out of a default the codebase states as on.
 *
 * The cost is the one `AppTextureProvider.tierFor` calls "the single
 * most-reported quality complaint": with CR off, a vector's raster tier is
 * clamped at 4x, so past 400% — by its own Scale, by a parent null, by viewport
 * zoom, or by a camera moving in — it goes soft and STAYS soft. Two layers of
 * identical geometry rasterized differently depending on which gesture made
 * them, and the drawn one was the soft one.
 *
 * The parity is the point, so it is asserted as parity rather than as a literal.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { insertShape } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';
import { commands } from '@motion/workspace';
import { readContinuousRaster, supportsContinuousRaster } from '@core/scene/continuousRaster';
import { createCommandPort } from './ports';
import type { SceneNode } from '@core/types';

/** The id the last create selected — both paths select what they made. */
function lastCreated(): SceneNode {
  const ids = useSelectionStore.getState().ids;
  const id = ids[ids.length - 1];
  if (!id) throw new Error('nothing was selected by the create');
  const node = defaultSceneGraph.getNode(id as never);
  if (!node) throw new Error(`no node ${id}`);
  return node;
}

/** An open outline, the shape the pen commits. */
const OUTLINE = [
  { x: -50, y: 40, inX: -50, inY: 40, outX: -50, outY: 40 },
  { x: 0, y: -40, inX: 0, inY: -40, outX: 0, outY: -40 },
  { x: 50, y: 40, inX: 50, inY: 40, outX: 50, outY: 40 },
];

/** Draw a path the way the pen tool's `finish` does — through the command port. */
function drawPath(): SceneNode {
  createCommandPort().execute(
    commands.createNode('Path', { x: 0, y: 0, width: 100, height: 80 }, OUTLINE as never),
  );
  return lastCreated();
}

beforeAll(() => {
  seedDefaultScene();
});

describe('Continuous Rasterization is on by default however the layer was made', () => {
  it('a DRAWN path gets it — the case that was missing', () => {
    const node = drawPath();
    // Guard: if the layer stopped qualifying, the assertion below would pass
    // for the wrong reason.
    expect(supportsContinuousRaster(node)).toBe(true);
    expect(readContinuousRaster(node)).toBe(true);
  });

  it('matches what an INSERTED vector layer gets', () => {
    const drawn = readContinuousRaster(drawPath());
    // `insertShape` is the Layer-menu path — one of the four that always
    // applied the default, and the baseline the drawn one had to match.
    insertShape('ellipse', 'Ellipse');
    const inserted = readContinuousRaster(lastCreated());
    expect(inserted).toBe(true);
    expect(drawn).toBe(inserted);
  });

  it('leaves a kind that cannot benefit alone', () => {
    // A flat solid rect has no vector edge to re-rasterize; turning the switch
    // on there would cost memory and change nothing, so `makeNodeAt` must not
    // blanket-set it.
    createCommandPort().execute(
      commands.createNode('Rectangle', { x: 0, y: 0, width: 100, height: 100 }),
    );
    const node = lastCreated();
    expect(supportsContinuousRaster(node)).toBe(false);
    expect(readContinuousRaster(node)).toBe(false);
  });
});
