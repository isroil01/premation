/**
 * The render-path component memo must never disagree with the live getter.
 *
 * `AppNodeView.renderComponents()` caches the reconstructed `Component[]` until
 * the scene's mutation epoch changes, and `buildSnapshot` renders from it. If a
 * mutation path failed to bump the epoch, the canvas would keep drawing the
 * pre-edit state — a stale render with no error anywhere, which is exactly the
 * failure this optimization has to be gated against.
 *
 * So rather than assert that a hand-written list of mutations bumps the epoch —
 * a list that would silently rot as setters are added — every case below
 * compares the memo against `node.components`, the getter that rebuilds from the
 * engine unconditionally and is therefore ground truth by construction. Any
 * write that the epoch misses shows up here as a divergence.
 *
 * `setFx` is the case that motivated bumping the epoch inside `DataComponent.set`
 * rather than in `SceneNode.touch()`: it backs ~30 setters (effects, fill,
 * stroke, mask, blend mode, repeater, trim path…) and does NOT call `touch`.
 */

import SceneGraph, { renderComponentsOf, renderTransformOf } from './SceneGraph';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import type { SceneNode, Component } from '../types';

function mkNode(id: string, extra: Component[] = []): SceneNode {
  return {
    id,
    name: id,
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 10, y: 20 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 10, y: 20, rotation: 0 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
      ...extra,
    ],
  } as unknown as SceneNode;
}

describe('render-path memo agrees with the live getter', () => {
  let graph: SceneGraph;
  let node: SceneNode;

  beforeEach(() => {
    graph = new SceneGraph();
    graph.addNode(mkNode('n1'));
    node = graph.getNode('n1')!;
  });

  /** Ground-truth check: the memo must equal a fresh rebuild, always. */
  const expectAgrees = (): void => {
    expect(renderComponentsOf(node)).toEqual(node.components);
    expect(renderTransformOf(node)).toEqual(node.transform);
  };

  it('agrees before any mutation', () => {
    expectAgrees();
  });

  it('agrees after writeProp', () => {
    renderComponentsOf(node); // prime the memo
    graph.writeProp('n1', 'n1_s', 'fill', '#ff0000');
    expectAgrees();
    expect(renderComponentsOf(node).find((c) => c.type === 'Style')?.props.fill).toBe('#ff0000');
  });

  it('agrees after a transform write (setLocalTransform does not call touch)', () => {
    renderComponentsOf(node);
    renderTransformOf(node);
    graph.setLocalTransform('n1', { x: 111, y: 222, rotation: 33 });
    expectAgrees();
    expect(renderTransformOf(node).position).toEqual({ x: 111, y: 222 });
  });

  it('agrees after setSeparateDimensions (also does not call touch)', () => {
    renderComponentsOf(node);
    graph.setSeparateDimensions('n1', true);
    expectAgrees();
  });

  it('agrees after addComponent', () => {
    renderComponentsOf(node);
    graph.addComponent('n1', { id: 'n1_g', type: 'Geometry', props: { width: 5, height: 6 } });
    expectAgrees();
    expect(renderComponentsOf(node).some((c) => c.type === 'Geometry')).toBe(true);
  });

  // The setFx family — none of these route through `SceneNode.touch()`.
  const fxCases: Array<[string, () => void]> = [
    ['setEffects', () => graph.setEffects('n1', [{ type: 'glow', radius: 4 }])],
    ['setBlendMode', () => graph.setBlendMode('n1', 'multiply')],
    ['setFill', () => graph.setFill('n1', { color: '#00ff00' })],
    ['setStroke', () => graph.setStroke('n1', { color: '#0000ff', width: 3 })],
    ['setMask', () => graph.setMask('n1', { mode: 'alpha' })],
    ['setRepeater', () => graph.setRepeater('n1', { copies: 3 })],
    ['setTrimPath', () => graph.setTrimPath('n1', { start: 0, end: 0.5 })],
    ['setLayerStyles', () => graph.setLayerStyles('n1', { shadow: true })],
    ['setMatte', () => graph.setMatte('n1', 'alpha')],
    ['setPrecomp', () => graph.setPrecomp('n1', true)],
  ];
  for (const [name, mutate] of fxCases) {
    it(`agrees after ${name}`, () => {
      renderComponentsOf(node); // prime, so a missed epoch bump would serve stale
      mutate();
      expectAgrees();
    });
  }

  it('agrees after a second, same-tick mutation', () => {
    // Date.now()-based invalidation would fail this: both writes land inside one
    // millisecond, so a timestamp key would look unchanged for the second.
    renderComponentsOf(node);
    graph.writeProp('n1', 'n1_s', 'fill', '#111111');
    const first = renderComponentsOf(node).find((c) => c.type === 'Style')?.props.fill;
    graph.writeProp('n1', 'n1_s', 'fill', '#222222');
    expectAgrees();
    expect(first).toBe('#111111');
    expect(renderComponentsOf(node).find((c) => c.type === 'Style')?.props.fill).toBe('#222222');
  });

  it('agrees for a second node when a DIFFERENT node is mutated', () => {
    graph.addNode(mkNode('n2'));
    const n2 = graph.getNode('n2')!;
    renderComponentsOf(node);
    renderComponentsOf(n2);
    graph.writeProp('n2', 'n2_s', 'fill', '#abcdef');
    expectAgrees();
    expect(renderComponentsOf(n2)).toEqual(n2.components);
    expect(renderComponentsOf(n2).find((c) => c.type === 'Style')?.props.fill).toBe('#abcdef');
  });

  it('falls back to plain .components for non-view nodes', () => {
    // buildSnapshot's materialized nodes and various test fixtures are plain
    // objects, not AppNodeViews — they must pass through unchanged.
    const plain = mkNode('plain');
    expect(renderComponentsOf(plain)).toBe(plain.components);
    expect(renderTransformOf(plain)).toBe(plain.transform);
  });
});
