import { MULTICAM_ANGLE_PROP } from './multicam';

describe('multicam tags', () => {
  it('exports a stable metadata key for angle tagging', () => {
    expect(MULTICAM_ANGLE_PROP).toBe('__multicamAngle');
  });
});
