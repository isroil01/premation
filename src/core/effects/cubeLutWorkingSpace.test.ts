/**
 * CUBE LUT × project working-space contract.
 *
 * `sampleCubeLut` is space-agnostic math; the live pipeline feeds it working-
 * space RGB (`srgb-linear` or `aces-cg`). These tests pin that identity cubes
 * round-trip in both spaces and that DOMAIN_* still remaps.
 */

import { parseCubeLut, sampleCubeLut } from './cubeLut';
import {
  setActiveColorPipeline,
  getActiveColorPipeline,
  DEFAULT_COLOR_PIPELINE,
  type WorkingSpace,
} from '@motion/renderer';

const IDENTITY_2 = `
TITLE "identity"
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

describe('CUBE LUT × working space', () => {
  afterEach(() => {
    setActiveColorPipeline(DEFAULT_COLOR_PIPELINE);
  });

  it.each(['srgb-linear', 'aces-cg'] as WorkingSpace[])(
    'identity cube round-trips RGB while pipeline is %s',
    (workingSpace) => {
      setActiveColorPipeline({ ...DEFAULT_COLOR_PIPELINE, workingSpace });
      expect(getActiveColorPipeline().workingSpace).toBe(workingSpace);

      const lut = parseCubeLut(IDENTITY_2)!;
      const samples: Array<[number, number, number]> = [
        [0, 0, 0],
        [1, 0, 0],
        [0.5, 0.5, 0.5],
        [1, 1, 1],
      ];
      for (const [r, g, b] of samples) {
        const out = sampleCubeLut(lut, r, g, b);
        expect(out[0]).toBeCloseTo(r, 5);
        expect(out[1]).toBeCloseTo(g, 5);
        expect(out[2]).toBeCloseTo(b, 5);
      }
    },
  );

  it('DOMAIN_MIN/MAX still remap before lookup (working-space independent)', () => {
    setActiveColorPipeline({ ...DEFAULT_COLOR_PIPELINE, workingSpace: 'aces-cg' });
    const lut = parseCubeLut(`
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 2 2 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`)!;
    // Input 1.0 sits at mid-domain → identity mid sample ≈ 0.5
    const out = sampleCubeLut(lut, 1, 1, 1);
    expect(out[0]).toBeCloseTo(0.5, 5);
    expect(out[1]).toBeCloseTo(0.5, 5);
    expect(out[2]).toBeCloseTo(0.5, 5);
  });
});
