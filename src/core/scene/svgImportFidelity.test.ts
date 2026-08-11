/**
 * What an imported SVG's parts actually RENDER as.
 *
 * `svgFidelity.test.ts` stops at the parsed shape, which is one step short of
 * the complaint: "parts of my animated SVG are missing". Two of the causes only
 * exist past that line — a paint the parser reported correctly and the insert
 * path then stored in a form Canvas2D silently refuses, and multi-run geometry
 * the parser split and the layer then flattened again.
 *
 * Asserted through `buildSnapshot` because that is the only place that proves
 * it reaches the renderer rather than merely that it was stored.
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from './DefaultSceneGraph';
import { insertSvgShapeGroup } from './sceneInsert';
import { seedDefaultScene } from './seedDefaultScene';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import type { RenderLayer } from '@core/rendering/RenderBackend';
import type { SceneNode } from '@core/types';

const COMP = { rootId: '', width: 1920, height: 1080 };

const wrap = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${inner}</svg>`;

function insert(markup: string, name: string): { groupId: string; rootId: string } {
  const groupId = insertSvgShapeGroup(markup, name);
  if (!groupId) throw new Error('insert produced no group');
  const rootId = defaultSceneGraph.getNode(groupId)?.parent;
  if (!rootId) throw new Error('group has no composition root');
  return { groupId, rootId };
}

function partsOf(groupId: string): SceneNode[] {
  return (defaultSceneGraph.getNode(groupId)?.children ?? [])
    .map((id) => defaultSceneGraph.getNode(id))
    .filter((n): n is SceneNode => !!n);
}

function propsOf(node: SceneNode, type: string): Record<string, unknown> {
  return (node.components.find((c) => c.type === type)?.props ?? {}) as Record<string, unknown>;
}

/**
 * The rendered layer for one imported part.
 *
 * By node id, not by position: every test in this file inserts into the same
 * composition root, so the last shape layer in the snapshot is whichever one
 * z-order put there — not necessarily the one just added.
 */
function layerFor(rootId: string, nodeId: string): RenderLayer {
  const snap = buildSnapshot(defaultSceneGraph, defaultAnimation, 0, undefined, undefined, undefined, undefined, {
    ...COMP,
    rootId,
  } as never);
  const layer = snap.layers.find((l) => l.id === nodeId);
  if (!layer) throw new Error(`no layer rendered for ${nodeId}`);
  return layer;
}

/** The single part of a one-shape import, rendered. */
function onlyLayer(groupId: string, rootId: string): RenderLayer {
  const parts = partsOf(groupId);
  if (parts.length !== 1) throw new Error(`expected 1 part, got ${parts.length}`);
  return layerFor(rootId, parts[0]!.id);
}

beforeAll(() => {
  seedDefaultScene();
});

describe('fill="none" does not become a black blob', () => {
  const OUTLINE = wrap(`
    <path d="M20 50 L80 50" fill="none" stroke="#ff3366" stroke-width="6">
      <animate attributeName="opacity" values="1;0.2;1" dur="1s" repeatCount="indefinite"/>
    </path>`);

  it('stores a paintable colour rather than the literal "none"', () => {
    // `ctx.fillStyle = 'none'` is not an error — the spec says an invalid
    // assignment is IGNORED, so the context kept its previous colour (black on
    // a fresh one) and every stroke-only outline icon was filled in solid.
    const { groupId } = insert(OUTLINE, 'outline.svg');
    const style = propsOf(partsOf(groupId)[0]!, 'Style');
    expect(style.fill).toBe('transparent');
  });

  it('reaches the renderer as transparent', () => {
    const { groupId, rootId } = insert(OUTLINE, 'outline2.svg');
    const layer = onlyLayer(groupId, rootId);
    expect(layer.fill).toBe('transparent');
  });

  it('renders the stroke at all', () => {
    // The stroke was written onto the `Style` component, and the renderer's
    // only reader (`readNodeStroke`) looks at `fx.props.stroke` — so nothing
    // read it. Combined with the fill above, an outline icon rendered as
    // nothing whatsoever.
    const { groupId, rootId } = insert(OUTLINE, 'outline3.svg');
    const layer = onlyLayer(groupId, rootId);
    expect(layer.stroke?.color).toBe('#ff3366');
    // Scaled with the geometry, like everything else the group holds.
    expect(layer.stroke!.width).toBeGreaterThan(6);
  });
});

describe('opacity reaches the layer', () => {
  it('writes element and group opacity onto the Style component', () => {
    const { groupId } = insert(wrap(`
      <g opacity="0.5">
        <rect x="10" y="10" width="20" height="20" fill="#f00" opacity="0.5">
          <animate attributeName="x" values="10;20;10" dur="1s" repeatCount="indefinite"/>
        </rect>
      </g>`), 'faded.svg');
    expect(propsOf(partsOf(groupId)[0]!, 'Style').opacity).toBe(25);
  });

  it('folds fill-opacity into the fill colour', () => {
    const { groupId } = insert(wrap(`
      <rect x="10" y="10" width="20" height="20" fill="#ff0000" fill-opacity="0.5">
        <animate attributeName="opacity" values="1;0.2;1" dur="1s" repeatCount="indefinite"/>
      </rect>`), 'wash.svg');
    // 8-digit hex: the alpha has to live in the colour, since the Style
    // component's own opacity is the LAYER's and a stroke must not inherit it.
    expect(String(propsOf(partsOf(groupId)[0]!, 'Style').fill)).toMatch(/^#ff0000[0-9a-f]{2}$/i);
  });
});

describe('imported text keeps its typeface', () => {
  it('carries font family, weight and style onto the Text component', () => {
    // These were dropped, so every imported label rendered in the app's default
    // face — the most visible way a text layer can be wrong while every number
    // around it is right.
    const { groupId } = insert(wrap(`
      <g font-family="Georgia" font-weight="700" font-style="italic">
        <text x="20" y="50" font-size="24" fill="#111">Hello
          <animate attributeName="opacity" values="1;0.2;1" dur="1s" repeatCount="indefinite"/>
        </text>
      </g>`), 'label.svg');
    const text = propsOf(partsOf(groupId)[0]!, 'Text');
    expect(text.fontFamily).toBe('Georgia');
    expect(text.fontWeight).toBe('700');
    expect(text.fontStyle).toBe('italic');
    expect(text.content).toBe('Hello');
  });
});

describe('a path with a hole renders as two runs', () => {
  const DONUT = wrap(`
    <path d="M10 10 H90 V90 H10 Z M30 30 H70 V70 H30 Z" fill="#ffffff">
      <animate attributeName="opacity" values="1;0.2;1" dur="1s" repeatCount="indefinite"/>
    </path>`);

  it('stores runs on the Geometry component, not one flat point list', () => {
    const { groupId } = insert(DONUT, 'donut.svg');
    const geom = propsOf(partsOf(groupId)[0]!, 'Geometry');
    expect(Array.isArray(geom.subpaths)).toBe(true);
    expect((geom.subpaths as unknown[]).length).toBe(2);
    // The two geometry fields are mutually exclusive (raster/subpaths.ts).
    expect(geom.points).toBeUndefined();
  });

  it('renders as a layer carrying both runs and no flat shorthand', () => {
    const { groupId, rootId } = insert(DONUT, 'donut2.svg');
    const layer = onlyLayer(groupId, rootId);
    expect(layer.subpaths?.length).toBe(2);
    expect(layer.pathPoints).toBeUndefined();
    expect(layer.primitive).toBe('path');
    // The inner run really is inside the outer one — this is the hole.
    const span = (pts: ReadonlyArray<{ x: number; y: number }>): number =>
      Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
    expect(span(layer.subpaths![1]!.points)).toBeLessThan(span(layer.subpaths![0]!.points));
  });

  it('still uses the flat shorthand for an ordinary single-run path', () => {
    const { groupId, rootId } = insert(wrap(`
      <path d="M10 10 H90 V90 Z" fill="#ffffff">
        <animate attributeName="opacity" values="1;0.2;1" dur="1s" repeatCount="indefinite"/>
      </path>`), 'plain.svg');
    const layer = onlyLayer(groupId, rootId);
    expect(layer.subpaths).toBeUndefined();
    expect(layer.pathPoints?.length).toBeGreaterThan(1);
  });
});
