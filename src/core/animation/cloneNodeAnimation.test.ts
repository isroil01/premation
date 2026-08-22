import { defaultAnimation } from '@motion/animation';
import { copyNodeAnimation } from './cloneNodeAnimation';

describe('copyNodeAnimation', () => {
  beforeEach(() => {
    for (const id of ['src', 'dst']) {
      for (const t of defaultAnimation.tracksFor(id)) {
        defaultAnimation.removeTrack(id, t.prop);
      }
      for (const t of defaultAnimation.dataTracksFor(id)) {
        defaultAnimation.setDataTrack(id, t.prop, null);
      }
      for (const e of defaultAnimation.allExpressions().filter((x) => x.nodeId === id)) {
        defaultAnimation.removeExpression(id, e.prop);
      }
    }
  });

  it('copies property keyframes, data tracks, and expressions', () => {
    defaultAnimation.setKeyframe('src', 'x', 0, 10);
    defaultAnimation.setKeyframe('src', 'x', 1, 90);
    defaultAnimation.setDataKeyframe('src', 'text.source', 'text', 0, 'Hello');
    defaultAnimation.setExpression('src', 'opacity', 'value * 0.5');

    copyNodeAnimation('src', 'dst');

    expect(defaultAnimation.getTrackKeyframes('dst', 'x')?.map((k) => k.value)).toEqual([10, 90]);
    expect(defaultAnimation.sampleData('dst', 'text.source', 0)).toBe('Hello');
    expect(defaultAnimation.getExpressionSrc('dst', 'opacity')).toBe('value * 0.5');
  });
});
