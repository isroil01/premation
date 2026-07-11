import { readNodeAdjustment } from './adjustment';
import type { SceneNode } from '@core/types';

function nodeWithFx(props?: Record<string, unknown>): SceneNode {
  return { components: props ? [{ type: 'fx', props }] : [] } as unknown as SceneNode;
}

describe('readNodeAdjustment', () => {
  test('false when no fx / flag absent / falsy', () => {
    expect(readNodeAdjustment(nodeWithFx())).toBe(false);
    expect(readNodeAdjustment(nodeWithFx({ effects: [] }))).toBe(false);
    expect(readNodeAdjustment(nodeWithFx({ isAdjustment: false }))).toBe(false);
  });

  test('true only when the flag is exactly true', () => {
    expect(readNodeAdjustment(nodeWithFx({ isAdjustment: true }))).toBe(true);
    // Guard against truthy-but-not-true values leaking through.
    expect(readNodeAdjustment(nodeWithFx({ isAdjustment: 1 as unknown as boolean }))).toBe(false);
  });
});
