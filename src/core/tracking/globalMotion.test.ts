/**
 * Dense stabilization's math, on synthetic motion — known similarity in,
 * recovered similarity out, and the smoothing contract that separates this
 * from lock-to-a-point: deliberate moves survive, jitter dies.
 */

import {
  applySim, composeSim, fitSimilarity, invertSim, simFrom, simRotation, simScale,
  stabilizingCorrections, flowSamplePoints, IDENTITY_SIM,
  type MotionSamplePoint, type Sim,
} from './globalMotion';
import { downsampleLuma } from './smoothStabilize';
import type { FlowField } from '@core/rendering/pixelMotionFlow';

/** Observations of a known similarity over a grid. */
function observationsOf(s: Sim, jitter: (i: number) => [number, number] = () => [0, 0]): MotionSamplePoint[] {
  const out: MotionSamplePoint[] = [];
  let i = 0;
  for (let y = 40; y <= 400; y += 60) {
    for (let x = 40; x <= 600; x += 60) {
      const [tx, ty] = applySim(s, x, y);
      const [jx, jy] = jitter(i++);
      out.push({ x, y, dx: tx - x + jx, dy: ty - y + jy });
    }
  }
  return out;
}

describe('similarity algebra', () => {
  const s = simFrom(0.3, 1.2, 15, -8);

  it('compose ∘ invert is identity', () => {
    const id = composeSim(s, invertSim(s));
    expect(id.a).toBeCloseTo(1, 9);
    expect(id.b).toBeCloseTo(0, 9);
    expect(id.tx).toBeCloseTo(0, 9);
    expect(id.ty).toBeCloseTo(0, 9);
  });

  it('decomposition returns what simFrom was given', () => {
    expect(simRotation(s)).toBeCloseTo(0.3, 9);
    expect(simScale(s)).toBeCloseTo(1.2, 9);
  });
});

describe('fitSimilarity', () => {
  it('recovers an exact similarity exactly', () => {
    const truth = simFrom(0.05, 1.03, 7.5, -3.2);
    const fit = fitSimilarity(observationsOf(truth))!;
    expect(fit.a).toBeCloseTo(truth.a, 6);
    expect(fit.b).toBeCloseTo(truth.b, 6);
    expect(fit.tx).toBeCloseTo(truth.tx, 5);
    expect(fit.ty).toBeCloseTo(truth.ty, 5);
  });

  it('trims a coherent outlier cluster (the moving foreground subject)', () => {
    const truth = simFrom(0, 1, 5, 0);
    // A fifth of the observations report a wildly different motion.
    const obs = observationsOf(truth, (i) => (i % 5 === 0 ? [40, 25] : [0, 0]));
    const fit = fitSimilarity(obs)!;
    expect(fit.tx).toBeCloseTo(5, 1);
    expect(fit.ty).toBeCloseTo(0, 1);
  });

  it('refuses to fit fewer than 3 points', () => {
    expect(fitSimilarity([{ x: 0, y: 0, dx: 1, dy: 1 }])).toBeNull();
  });

  it('is deterministic', () => {
    const obs = observationsOf(simFrom(0.02, 0.99, -3, 4), (i) => [((i * 7) % 5) - 2, ((i * 3) % 5) - 2]);
    expect(fitSimilarity(obs)).toEqual(fitSimilarity(obs));
  });
});

describe('flowSamplePoints', () => {
  it('excludes abstaining blocks — flat wall must not vote "still"', () => {
    const f: FlowField = {
      cols: 2, rows: 1, step: 8,
      dx: new Float32Array([3, 0]),
      dy: new Float32Array([1, 0]),
      valid: new Uint8Array([1, 0]),
    };
    const pts = flowSamplePoints(f, 2, 2);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toEqual({ x: 8, y: 8, dx: 6, dy: 2 }); // scaled ×2
  });
});

describe('stabilizingCorrections', () => {
  /** Apply each correction to the cumulative path — the "stabilized camera". */
  const stabilizedPath = (pairs: Array<Sim | null>, sigma: number): Sim[] => {
    const corr = stabilizingCorrections(pairs, sigma);
    const path: Sim[] = [{ ...IDENTITY_SIM }];
    for (let i = 0; i < pairs.length; i++) path.push(composeSim(pairs[i] ?? IDENTITY_SIM, path[i]!));
    return path.map((p, i) => composeSim(corr[i]!, p));
  };

  it('pure alternating jitter cancels to a near-still camera', () => {
    // ±2px alternating shake, no net motion.
    const pairs: Sim[] = [];
    for (let i = 0; i < 40; i++) pairs.push(simFrom(0, 1, i % 2 === 0 ? 2 : -2, 0));
    const stab = stabilizedPath(pairs, 6);
    for (const s of stab) {
      expect(Math.abs(s.tx)).toBeLessThan(1.1);
      expect(Math.abs(s.ty)).toBeLessThan(0.5);
    }
  });

  it('a deliberate constant pan SURVIVES smoothing', () => {
    // 3px/frame steady pan — the smoother must not fight it.
    const pairs: Sim[] = Array.from({ length: 60 }, () => simFrom(0, 1, 3, 0));
    const stab = stabilizedPath(pairs, 8);
    // Away from the edges, the stabilized camera still travels ~3px/frame.
    const v = stab[40]!.tx - stab[39]!.tx;
    expect(v).toBeGreaterThan(2.5);
    expect(v).toBeLessThan(3.5);
    // And ends far from where it started — the pan happened.
    expect(stab[59]!.tx).toBeGreaterThan(120);
  });

  it('pan + jitter keeps the pan and sheds the jitter', () => {
    const pairs: Sim[] = Array.from({ length: 60 }, (_, i) => simFrom(0, 1, 3 + (i % 2 === 0 ? 2 : -2), 0));
    const stab = stabilizedPath(pairs, 6);
    // Frame-to-frame velocity variance collapses versus the raw path.
    let rawVar = 0;
    let stabVar = 0;
    for (let i = 20; i < 40; i++) {
      const rawV = 3 + (i % 2 === 0 ? 2 : -2);
      const stabV = stab[i + 1]!.tx - stab[i]!.tx;
      rawVar += (rawV - 3) * (rawV - 3);
      stabVar += (stabV - 3) * (stabV - 3);
    }
    expect(stabVar).toBeLessThan(rawVar / 10);
  });

  it('a failed pair (null) degrades to identity motion, not a spike', () => {
    const pairs: Array<Sim | null> = Array.from({ length: 20 }, () => simFrom(0, 1, 2, 0));
    pairs[10] = null;
    const corr = stabilizingCorrections(pairs, 4);
    // Corrections stay bounded through the gap.
    for (const c of corr) expect(Math.abs(c.tx)).toBeLessThan(30);
  });

  it('rotation shake smooths in unwrapped space', () => {
    const pairs: Sim[] = Array.from({ length: 30 }, (_, i) => simFrom(i % 2 === 0 ? 0.02 : -0.02, 1, 0, 0));
    const stab = stabilizedPath(pairs, 6);
    for (const s of stab) expect(Math.abs(simRotation(s))).toBeLessThan(0.012);
  });
});

describe('downsampleLuma', () => {
  it('box-averages exact blocks and is deterministic', () => {
    const data = new Float32Array([1, 3, 5, 7, 2, 4, 6, 8]); // 4×2
    const d = downsampleLuma(data, 4, 2, 2);
    expect(d.w).toBe(2);
    expect(d.h).toBe(1);
    expect(Array.from(d.data)).toEqual([2.5, 6.5]);
  });

  it('factor 1 is a pass-through', () => {
    const data = new Float32Array([9, 9]);
    expect(downsampleLuma(data, 2, 1, 1).data).toBe(data);
  });
});
