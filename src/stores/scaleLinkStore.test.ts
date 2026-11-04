import { isScaleLinked, useScaleLinkStore } from './scaleLinkStore';

describe('scaleLinkStore', () => {
  it('links by default and toggles per layer', () => {
    expect(isScaleLinked('a')).toBe(true);
    useScaleLinkStore.getState().toggle('a');
    expect(isScaleLinked('a')).toBe(false);
    expect(isScaleLinked('b')).toBe(true);
    useScaleLinkStore.getState().toggle('a');
    expect(isScaleLinked('a')).toBe(true);
  });

  it('takes another project\'s list whole, so ids cannot carry over', () => {
    useScaleLinkStore.getState().toggle('layer_1');
    useScaleLinkStore.getState().replace(['layer_2']);
    expect(isScaleLinked('layer_1')).toBe(true);
    expect(isScaleLinked('layer_2')).toBe(false);
    useScaleLinkStore.getState().replace([]);
  });
});
