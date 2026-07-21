/**
 * The boundary test for rich text runs: scene graph -> RenderLayer.
 *
 * The pure layout/normalizer tests in core/text prove the arithmetic. They do
 * not prove the model reaches the renderer — which is exactly the defect class
 * this codebase keeps hitting (a switch that lights up and changes no pixels).
 * This suite crosses the boundary the unit tests don't: it stores `__runs` the
 * way the inspector stores it and asserts what the backend is handed.
 *
 * The last hop (RenderLayer -> pixels) needs a real 2D context, which jsdom
 * does not have; that half is verified in-browser.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import type { RichRun } from '@core/text/textLayout';

function textNode(id: string, content: string, runs?: unknown): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 100, y: 100 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: 100, y: 100, rotation: 0 } },
      {
        id: `${id}_c`,
        type: 'Text',
        props: { content, fontSize: 40, opacity: 100, ...(runs !== undefined ? { __runs: runs } : {}) },
      },
    ],
  } as unknown as SceneNode;
}

const layerFor = (node: SceneNode) => {
  const graph = new SceneGraph();
  graph.addNode(node);
  return buildSnapshot(graph, new AnimationEngine(), 0).layers.find((l) => l.id === node.id);
};

describe('rich runs reach the renderer', () => {
  it('carries stored runs onto the text layer', () => {
    const runs: RichRun[] = [{ start: 0, end: 3, style: { fill: '#ff0000' } }];
    expect(layerFor(textNode('r1', 'Hello', runs))!.runs).toEqual(runs);
  });

  it('omits runs entirely when the layer has none', () => {
    // Presence is what costs a layer the cheap whole-string draw, so an
    // unstyled layer must not carry an empty array.
    expect(layerFor(textNode('r2', 'Hello'))!.runs).toBeUndefined();
    expect(layerFor(textNode('r3', 'Hello', []))!.runs).toBeUndefined();
  });

  it('normalizes runs on the way out', () => {
    // Overlapping spans are split and merged field-wise before any backend
    // sees them, so the two backends cannot disagree about an overlap.
    const runs: RichRun[] = [
      { start: 0, end: 4, style: { fill: '#ff0000' } },
      { start: 2, end: 4, style: { fontWeight: '700' } },
    ];
    expect(layerFor(textNode('r4', 'Hello', runs))!.runs).toEqual([
      { start: 0, end: 2, style: { fill: '#ff0000' } },
      { start: 2, end: 4, style: { fill: '#ff0000', fontWeight: '700' } },
    ]);
  });

  it('clamps a run that outlives the text it was written against', () => {
    // Delete characters without re-indexing and the stored run overhangs; the
    // renderer must not be handed an index past the end of the string.
    const runs: RichRun[] = [{ start: 0, end: 99, style: { fill: '#ff0000' } }];
    expect(layerFor(textNode('r5', 'Hi', runs))!.runs).toEqual([
      { start: 0, end: 2, style: { fill: '#ff0000' } },
    ]);
  });

  it('drops malformed runs from an untrusted document', () => {
    const runs = [
      { start: 'nope', end: 3, style: { fill: '#ff0000' } },
      null,
      { start: 0, end: 2, style: { fill: '#00ff00' } },
    ];
    expect(layerFor(textNode('r6', 'Hello', runs))!.runs).toEqual([
      { start: 0, end: 2, style: { fill: '#00ff00' } },
    ]);
  });

  it('ignores a non-array __runs without throwing', () => {
    expect(layerFor(textNode('r7', 'Hello', 'garbage'))!.runs).toBeUndefined();
  });

  it('indexes runs in code points, matching the animator index space', () => {
    // '𝐀' is a surrogate pair. If runs were indexed by UTF-16 unit, a run over
    // the character after it would land one slot off.
    const runs: RichRun[] = [{ start: 1, end: 2, style: { fill: '#ff0000' } }];
    expect(layerFor(textNode('r8', '𝐀b', runs))!.runs).toEqual(runs);
  });

  it('emits paragraphSpacing onto the layer', () => {
    const node = textNode('r9', 'a\nb');
    (node.components[1] as { props: Record<string, unknown> }).props.paragraphSpacing = 12;
    expect(layerFor(node)!.paragraphSpacing).toBe(12);
  });
});

describe('text on a path reaches the renderer', () => {
  const corner = (x: number, y: number) => ({ x, y, inX: x, inY: y, outX: x, outY: y });
  const maskFx = (paths: unknown) => ({ id: 'fx1', type: 'fx', props: { mask: { paths } } });
  const line = (id = 'm1') => ({
    id, mode: 'add', closed: false,
    points: [corner(0, 0), corner(100, 0)],
    feather: 0, opacity: 1, expansion: 0, inverted: false,
  });

  const withFx = (id: string, fx: unknown, textPath: unknown) => {
    const node = textNode(id, 'abc') as unknown as { components: unknown[] };
    node.components.push(fx);
    (node.components[2] as { props: Record<string, unknown> }).props.textPath = textPath;
    return layerFor(node as unknown as SceneNode);
  };

  it('flattens the chosen mask onto the layer', () => {
    const l = withFx('p1', maskFx([line()]), { pathId: 'm1', firstMargin: 0, reversed: false, perpendicular: true });
    expect(l!.textPath).toBeDefined();
    expect(l!.textPath!.points.length).toBeGreaterThanOrEqual(2);
    expect(l!.textPath!.closed).toBe(false);
    expect(l!.textPath!.perpendicular).toBe(true);
  });

  it('defaults to the first mask when no pathId is set', () => {
    const l = withFx('p2', maskFx([line('mA'), line('mB')]), { pathId: '', firstMargin: 0, reversed: false, perpendicular: true });
    expect(l!.textPath).toBeDefined();
  });

  it('omits textPath when the layer has no textPath config', () => {
    const l = withFx('p3', maskFx([line()]), undefined);
    expect(l!.textPath).toBeUndefined();
  });

  it('omits textPath when the config points at a mask that does not exist', () => {
    // A path can be deleted after the text was pointed at it; the renderer must
    // fall back to ordinary text rather than be handed empty geometry.
    const l = withFx('p4', maskFx([line('mA')]), { pathId: 'gone', firstMargin: 0, reversed: false, perpendicular: true });
    expect(l!.textPath).toBeUndefined();
  });

  it('omits textPath when the layer has no masks at all', () => {
    const l = withFx('p5', { id: 'fx1', type: 'fx', props: {} }, { pathId: '', firstMargin: 0, reversed: false, perpendicular: true });
    expect(l!.textPath).toBeUndefined();
  });

  it('carries firstMargin through so it can be keyframed', () => {
    const l = withFx('p6', maskFx([line()]), { pathId: 'm1', firstMargin: 25, reversed: true, perpendicular: false });
    expect(l!.textPath!.firstMargin).toBe(25);
    expect(l!.textPath!.reversed).toBe(true);
    expect(l!.textPath!.perpendicular).toBe(false);
  });
});
