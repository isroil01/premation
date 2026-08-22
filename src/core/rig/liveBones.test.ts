import { resolveLiveBones } from './liveBones';

describe('resolveLiveBones', () => {
  const bone = {
    id: 'arm',
    parentId: null,
    length: 100,
    x: 10,
    y: 20,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
  };

  it('samples every pose channel, including scale, from one shared path policy', () => {
    const values: Record<string, number> = {
      'bone.arm.rotation': 0.5,
      'bone.arm.x': 30,
      'bone.arm.y': 40,
      'bone.arm.scaleX': 1.5,
      'bone.arm.scaleY': 0.75,
    };
    const [live] = resolveLiveBones([bone], 'layer', 2, {
      sample: (_nodeId, path) => values[path],
    });
    expect(live).toMatchObject({
      rotation: 0.5,
      x: 30,
      y: 40,
      scaleX: 1.5,
      scaleY: 0.75,
    });
  });

  it('falls back per channel when a sample is missing or invalid', () => {
    const [live] = resolveLiveBones([bone], 'layer', 0, {
      sample: (_nodeId, path) => path.endsWith('scaleX') ? Number.NaN : undefined,
    });
    expect(live).toEqual(bone);
  });
});
