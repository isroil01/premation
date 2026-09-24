/**
 * The Knife cuts the outline the renderer is actually drawing — radii included.
 *
 * A primitive that has never been converted to a path has no stored points, so
 * `readCutRuns` seeds the cut from `shapeOutline`. That call passed no corner
 * radii, so a rounded rect was cut as if it were sharp: the halves came back
 * with square corners the screen had never shown. Same class of bug as the
 * path-op chain's seed (`cornerRadiusPathOps.test.ts`) and the boolean's
 * operand seed (`mergePaths.test.ts`), and the same observable: the outline's
 * closest approach to the sharp corner it replaced is the arc's true r(√2−1).
 *
 * Driven through `createCommandPort` — the way the tool itself commits — so
 * the whole write path is covered: seed, world→local line mapping, subpath
 * write, shapeType flip.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { commands } from '@motion/workspace';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode, ID } from '@core/types';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import { createCommandPort } from './ports';
import { settleToolEdits } from './viewportGesture';

const W = 160;
const H = 120;
const R = 40;
/** The rounded outline's closest approach to the sharp corner it replaced. */
const STAND_OFF = R * (Math.SQRT2 - 1); // ≈ 16.57
const CX = 200;
const CY = 150;

function shapeNode(id: string, radiusProps: Record<string, number>): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: CX, y: CY }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`, type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape', shapeType: 'rect',
          x: CX, y: CY, rotation: 0, width: W, height: H,
          ...radiusProps,
        },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#1f4f8f' } },
    ],
  } as unknown as SceneNode;
}

/** Cut the layer with a vertical world line through its centre; return every
 *  written anchor in LOCAL space (how the runs are stored). */
async function cutVertically(id: string): Promise<Array<{ x: number; y: number }>> {
  createCommandPort().execute(
    commands.cutPaths([id], { x: CX, y: CY - 400 }, { x: CX, y: CY + 400 }),
  );
  // The cut is one engine edit (`setShapeOutline`).
  await settleToolEdits();
  await engineIdle();
  const node = defaultSceneGraph.getNode(id as ID)!;
  const geom = node.components.find((c) => c.type === 'Geometry');
  const subs = geom?.props.subpaths as
    | Array<{ points: Array<{ x: number; y: number }>; open?: boolean }>
    | undefined;
  // The line crossed the ring, so the cut committed: two closed halves, and
  // the primitive is gone. Without this guard the stand-off assertions below
  // could pass against geometry the knife never wrote.
  expect(Array.isArray(subs)).toBe(true);
  expect(subs!.length).toBe(2);
  expect((node.components.find((c) => c.type === 'Transform')?.props as Record<string, unknown>).shapeType).toBe('path');
  return subs!.flatMap((r) => r.points.map((p) => ({ x: p.x, y: p.y })));
}

// The runs are LOCAL, centred on the layer's origin.
const CORNERS = [
  { x: -W / 2, y: -H / 2 }, // TL
  { x: W / 2, y: -H / 2 },  // TR
  { x: W / 2, y: H / 2 },   // BR
  { x: -W / 2, y: H / 2 },  // BL
];

const minDistTo = (
  pts: ReadonlyArray<{ x: number; y: number }>,
  c: { x: number; y: number },
): number => Math.min(...pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y)));

let h: Harness;
beforeEach(async () => {
  h = await setupAppEngine();
});
afterEach(async () => {
  await h.dispose();
});

/** A layer of the composition, seeded directly (the engine resyncs before the cut). */
function addNode(node: SceneNode): void {
  defaultSceneGraph.addNode(node);
  defaultSceneGraph.addChild('comp_root' as ID, node);
}

describe('Knife on a rounded-rect primitive', () => {
  it('SHARP CONTROL: without radii the halves keep a vertex AT each corner', async () => {
    addNode(shapeNode('knife_sharp', {}));
    const pts = await cutVertically('knife_sharp');
    for (const c of CORNERS) expect(minDistTo(pts, c)).toBeLessThan(0.75);
  });

  it('a uniform radius survives the cut: every corner stood off by r(√2−1)', async () => {
    addNode(shapeNode('knife_round', { cornerRadius: R }));
    const pts = await cutVertically('knife_round');
    for (const c of CORNERS) {
      const d = minDistTo(pts, c);
      expect(d).toBeGreaterThan(STAND_OFF - 1.5);
      expect(d).toBeLessThan(STAND_OFF + 1.5);
    }
  });

  it('per-corner radii survive: only the corner that asked is rounded', async () => {
    addNode(shapeNode('knife_tl', { cornerRadiusTL: R }));
    const pts = await cutVertically('knife_tl');
    const dTL = minDistTo(pts, CORNERS[0]!);
    expect(dTL).toBeGreaterThan(STAND_OFF - 1.5);
    expect(dTL).toBeLessThan(STAND_OFF + 1.5);
    // TR stays the sharp vertex it authored.
    expect(minDistTo(pts, CORNERS[1]!)).toBeLessThan(0.75);
  });
});
