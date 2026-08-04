/**
 * `setMarkerProvider` — the engine half of `marker.*`.
 *
 * ## Why this file exists separately (rule 5·0)
 *
 * `markerExpressions.test.ts` hands `markersAt` straight into `ExprContext`,
 * so it proves the AE semantics and nothing about how markers GET there. Every
 * assertion in that file passes with `setMarkerProvider` deleted — the context
 * is built by the test, not by the engine.
 *
 * This file samples the other layer: `AnimationEngine.exprContext` wiring the
 * provider through to a real expression evaluation. What neither file can see
 * is the host binding in `Providers.tsx`; that is a wiring fact and needs the
 * running app, which is where it was checked.
 */

import { AnimationEngine } from '../AnimationEngine';
import type { ExprMarkerData } from '../expressions';

const LAYER: ExprMarkerData[] = [
  { time: 5, duration: 0, name: 'L', comment: 'layer-note' },
];
const COMP: ExprMarkerData[] = [
  { time: 9, duration: 0, name: 'C', comment: 'comp-note' },
  { time: 1, duration: 0, name: 'C0', comment: '' },
];

function engineWithMarkers() {
  const a = new AnimationEngine();
  const calls: Array<{ nodeId: string; scope: string }> = [];
  a.setMarkerProvider((nodeId, scope) => {
    calls.push({ nodeId, scope });
    return scope === 'comp' ? COMP : LAYER;
  });
  return { a, calls };
}

describe('AnimationEngine.setMarkerProvider', () => {
  it('reaches an expression as marker.*', () => {
    const { a } = engineWithMarkers();
    a.setExpression('n1', 'x', 'marker.key(1).time');
    expect(a.evaluateNode('n1', 0).get('x')).toBeCloseTo(5, 6);
  });

  it('routes thisComp.marker to the comp scope', () => {
    const { a } = engineWithMarkers();
    a.setExpression('n1', 'x', 'thisComp.marker.numKeys');
    expect(a.evaluateNode('n1', 0).get('x')).toBe(2);
  });

  /**
   * The provider is asked about the node being evaluated, not some ambient
   * "current layer". Two nodes with the same expression must each ask for
   * their own markers — otherwise every layer's `marker` would resolve to
   * whichever layer happened to be evaluated first.
   */
  it('asks for the markers of the node under evaluation', () => {
    const { a, calls } = engineWithMarkers();
    a.setExpression('alpha', 'x', 'marker.numKeys');
    a.setExpression('beta', 'x', 'marker.numKeys');
    a.evaluateNode('alpha', 0);
    a.evaluateNode('beta', 0);
    expect(calls.map((c) => c.nodeId)).toEqual(['alpha', 'beta']);
    expect(calls.every((c) => c.scope === 'layer')).toBe(true);
  });

  /**
   * The default. An engine with no provider must answer "no markers" rather
   * than throwing — `marker.*` is reachable from any expression, including in
   * a headless render that never installs one.
   */
  it('defaults to no markers rather than throwing', () => {
    const a = new AnimationEngine();
    a.setExpression('n1', 'x', 'marker.numKeys + marker.nearestKey(3).time');
    const v = a.evaluateNode('n1', 0);
    expect(v.get('x')).toBe(0);
  });
});
