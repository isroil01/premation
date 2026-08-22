import {
  estimateRollingShutterShear,
  fitSubspaceWarp,
  applyRollingShutterRepair,
  sampleSubspace,
} from './subspaceWarp';
import type { FlowField } from '@core/rendering/pixelMotionFlow';
import { IDENTITY_SIM, type Sim } from './globalMotion';

function fieldFrom(
  cols: number,
  rows: number,
  step: number,
  dxOf: (gx: number, gy: number) => number,
  dyOf: (gx: number, gy: number) => number,
): FlowField {
  const n = cols * rows;
  const dx = new Float32Array(n);
  const dy = new Float32Array(n);
  const valid = new Uint8Array(n);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const i = gy * cols + gx;
      dx[i] = dxOf(gx, gy);
      dy[i] = dyOf(gx, gy);
      valid[i] = 1;
    }
  }
  return { cols, rows, step, dx, dy, valid };
}

describe('subspaceWarp', () => {
  it('fits a near-identity grid on uniform translation flow', () => {
    const f = fieldFrom(9, 9, 10, () => 4, () => -2);
    const cells = fitSubspaceWarp(f, 3, 3);
    expect(cells).toHaveLength(9);
    for (const c of cells) {
      expect(c.sim.tx).toBeCloseTo(4, 0);
      expect(c.sim.ty).toBeCloseTo(-2, 0);
    }
  });

  it('estimates rolling-shutter shear from row-varying dx', () => {
    // dx = 0.05 * (y - cy) with cy at mid row.
    const f = fieldFrom(8, 16, 8, (_gx, gy) => {
      const y = (gy + 0.5) * 8;
      const cy = 8 * 8; // mid of 16 rows * step 8 → 64
      return 0.05 * (y - cy);
    }, () => 0);
    const k = estimateRollingShutterShear(f);
    expect(k).toBeCloseTo(0.05, 2);
    const [rx] = applyRollingShutterRepair(100, 80, 64, k);
    expect(rx).toBeCloseTo(100 - k * (80 - 64), 5);
  });

  it('samples subspace by blending cell sims', () => {
    const a: Sim = { ...IDENTITY_SIM, tx: 0 };
    const b: Sim = { ...IDENTITY_SIM, tx: 10 };
    const cells = [
      { cx: 0, cy: 0, sim: a }, { cx: 1, cy: 0, sim: b },
      { cx: 0, cy: 1, sim: a }, { cx: 1, cy: 1, sim: b },
    ];
    const [x] = sampleSubspace(cells, 2, 2, 50, 50, 100, 100);
    expect(x).toBeCloseTo(55, 0); // mid blend → +5
  });
});
