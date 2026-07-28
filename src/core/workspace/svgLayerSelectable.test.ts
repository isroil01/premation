/**
 * A statically-imported SVG must be grabbable on canvas.
 *
 * The bug this guards: `isDrawableKind` — the allow-list `readGeometry` consults
 * before anything else — listed every layer kind EXCEPT `svg`. A null geometry
 * makes `toWorkspaceNode` bail, and a node the port never emits has no
 * worldBounds for the broad phase, no `hitTestLocal` for the click and no
 * corners for the marquee. So the icon rendered (buildSnapshot maps `svg` onto
 * the image path and rasterizes it), it could be picked in the Scene tree, and
 * yet it was completely inert in the viewport: unselectable and undraggable.
 *
 * Animated SVGs never showed the symptom because that import branch converts to
 * real keyframed SHAPE layers, which were always in the list. That asymmetry is
 * what made the report read as "only some SVGs break", so the animated route is
 * asserted here too — it is the half that must keep working untouched.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { insertSvgLayer, insertSvgShapeGroup } from '@core/scene/sceneInsert';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { readNodeKind } from '@core/scene/sceneDerive';
import { createSceneGraphPort } from './ports';
import { isDrawableKind, readGeometry } from './geometry';

/** 240×120 so a default-square fallback (100×100) cannot pass by accident. */
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" width="240" height="120">' +
  '<rect width="240" height="120" fill="#0af"/></svg>';

const ANIMATED =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
  '<rect x="40" y="40" width="20" height="20" fill="#f00">' +
  '<animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50"' +
  ' dur="2s" repeatCount="indefinite"/></rect></svg>';

beforeAll(() => {
  seedDefaultScene();
});

describe('a static SVG layer is a first-class canvas object', () => {
  it('is a drawable kind', () => {
    expect(isDrawableKind('svg')).toBe(true);
  });

  it('reports geometry instead of null', () => {
    const id = insertSvgLayer(ICON, 'icon.svg')!;
    const g = readGeometry(defaultSceneGraph.getNode(id)!);
    expect(g).not.toBeNull();
    // Its OWN intrinsic size — not the 100×100 floor and not the image default.
    expect(g!.width).toBeCloseTo(240, 0);
    expect(g!.height).toBeCloseTo(120, 0);
  });

  it('is emitted by the scene-graph port, so the viewport can see it at all', () => {
    const id = insertSvgLayer(ICON, 'icon.svg')!;
    const port = createSceneGraphPort();
    expect(port.getNode(id as never)).toBeDefined();
    expect([...port.getNodes()].some((n) => n.id === id)).toBe(true);
  });

  it('hit-tests inside its box and rejects points outside it', () => {
    const id = insertSvgLayer(ICON, 'icon.svg')!;
    const wn = createSceneGraphPort().getNode(id as never)!;
    // hitTestLocal works in the layer's own space, centred on its origin.
    expect(wn.hitTestLocal?.({ x: 0, y: 0 })).toBe(true);
    expect(wn.hitTestLocal?.({ x: 110, y: 50 })).toBe(true);
    expect(wn.hitTestLocal?.({ x: 400, y: 0 })).toBe(false);
    expect(wn.hitTestLocal?.({ x: 0, y: 400 })).toBe(false);
  });

  it('has a selection box the size of the artwork', () => {
    const id = insertSvgLayer(ICON, 'icon.svg')!;
    const wn = createSceneGraphPort().getNode(id as never)!;
    expect(wn.worldBounds.width).toBeCloseTo(240, 0);
    expect(wn.worldBounds.height).toBeCloseTo(120, 0);
    expect(wn.worldCorners).toHaveLength(4);
  });
});

describe('the animated import route is unchanged', () => {
  it('still converts to shape layers, which stay selectable', () => {
    const groupId = insertSvgShapeGroup(ANIMATED, 'spin.svg')!;
    expect(groupId).not.toBeNull();
    // The converted result is NOT an svg-kind layer — it is real geometry, and
    // the parts under it carry the shapes.
    expect(readNodeKind(defaultSceneGraph.getNode(groupId)!)).not.toBe('svg');
    const port = createSceneGraphPort();
    expect(port.getNode(groupId as never)).toBeDefined();
    for (const child of defaultSceneGraph.getChildren(groupId)) {
      expect(readGeometry(defaultSceneGraph.getNode(child.id)!)).not.toBeNull();
    }
  });
});
