/**
 * Where an imported SVG LANDS, and whether its animation reaches the pixels.
 *
 * `svgImportAnimation.test.ts` proves the keyframes are written; that is one
 * step short of what the user sees. Two defects lived in that gap and both read
 * to the user as "the SVG imported wrong":
 *
 *   1. `insertSvgShapeGroup` set only `node.transform.position`. Every reader —
 *      `readBase` in buildSnapshot, `toWorkspaceNode` in ports — prefers the
 *      Transform COMPONENT's `x`/`y`, so the group stayed at makeNode's
 *      placeholder (160, 120). On a 1920×1080 comp the icon appeared jammed in
 *      the top-left with its parts straddling the canvas edge.
 *   2. buildSnapshot's `localOf` read the uniform `scale` track only, so a
 *      keyframed `scaleX`/`scaleY` — what a CSS `scale` animation imports as,
 *      and what the scale gizmo autokeys — never reached the rendered layer.
 *
 * Both are asserted through `buildSnapshot`, because that is the only place
 * that proves it renders rather than merely that it was stored.
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from './DefaultSceneGraph';
import { insertSvgShapeGroup } from './sceneInsert';
import { seedDefaultScene } from './seedDefaultScene';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import type { RenderLayer } from '@core/rendering/RenderBackend';

const COMP = { rootId: '', width: 1920, height: 1080 };

const wrap = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${inner}</svg>`;

function layersAt(rootId: string, t: number): readonly RenderLayer[] {
  return buildSnapshot(defaultSceneGraph, defaultAnimation, t, undefined, undefined, undefined, undefined, {
    ...COMP,
    rootId,
  } as never).layers;
}

/** Insert and hand back the group node plus its composition root. */
function insert(markup: string, name: string): { groupId: string; rootId: string } {
  const groupId = insertSvgShapeGroup(markup, name);
  if (!groupId) throw new Error('insert produced no group');
  const rootId = defaultSceneGraph.getNode(groupId)?.parent;
  if (!rootId) throw new Error('group has no composition root');
  return { groupId, rootId };
}

beforeAll(() => {
  seedDefaultScene();
});

describe('an imported SVG lands where the user dropped it', () => {
  it('writes the position onto the Transform component, not just the node field', () => {
    const { groupId } = insert(wrap('<rect x="10" y="10" width="20" height="20" fill="#333"/>'), 'static.svg');
    const t = defaultSceneGraph.getNode(groupId)!.components.find((c) => c.type === 'Transform')!;
    // The comp centre — NOT makeNode's (160, 120) placeholder.
    expect([t.props.x, t.props.y]).toEqual([960, 540]);
  });

  it('sizes the group to its content rather than the 280×280 default', () => {
    const { groupId } = insert(wrap('<rect x="0" y="0" width="100" height="50" fill="#333"/>'), 'wide.svg');
    const t = defaultSceneGraph.getNode(groupId)!.components.find((c) => c.type === 'Transform')!;
    expect(Number(t.props.width)).toBeGreaterThan(Number(t.props.height));
  });

  it('renders every part clustered around the comp centre', () => {
    const { rootId } = insert(wrap(`
      <rect x="10" y="10" width="20" height="20" fill="#f00"/>
      <circle cx="70" cy="70" r="15" fill="#0f0"/>
      <rect x="45" y="45" width="10" height="10" fill="#00f"/>`), 'multi.svg');
    const parts = layersAt(rootId, 0);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    for (const p of parts) {
      // Inside the canvas, and on the centre side of it — the failure being
      // guarded is parts landing at or past the top-left edge.
      expect(p.x).toBeGreaterThan(COMP.width * 0.25);
      expect(p.y).toBeGreaterThan(COMP.height * 0.25);
      expect(p.x).toBeLessThan(COMP.width * 0.75);
      expect(p.y).toBeLessThan(COMP.height * 0.75);
    }
  });
});

describe('an imported animation reaches the rendered layer', () => {
  it('renders a CSS scale() animation as a growing layer', () => {
    const { rootId } = insert(wrap(`
      <style>
        @keyframes pulse { from { transform: scale(1) } to { transform: scale(1.6) } }
        .c { animation: pulse 1s linear infinite alternate; transform-box: fill-box; transform-origin: center }
      </style>
      <circle class="c" cx="50" cy="50" r="20" fill="#0f0"/>`), 'pulse.svg');

    const at = (t: number): RenderLayer => layersAt(rootId, t).at(-1)!;
    expect(at(0).scaleX).toBeCloseTo(1, 2);
    expect(at(0.5).scaleX).toBeCloseTo(1.3, 2);
    expect(at(1).scaleX).toBeCloseTo(1.6, 2);
    // `alternate` runs the second iteration backwards.
    expect(at(1.5).scaleX).toBeCloseTo(1.3, 2);
  });

  it('renders a SMIL rotation', () => {
    const { rootId } = insert(wrap(`
      <rect x="40" y="40" width="20" height="20" fill="#f00">
        <animateTransform attributeName="transform" type="rotate"
          from="0 50 50" to="360 50 50" dur="2s" repeatCount="indefinite"/>
      </rect>`), 'spin.svg');
    const at = (t: number): RenderLayer => layersAt(rootId, t).at(-1)!;
    expect(at(0).rotation).toBeCloseTo(0, 1);
    expect(Math.abs(at(0.5).rotation)).toBeGreaterThan(45);
  });
});
