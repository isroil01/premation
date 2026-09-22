import type { Keyframe, PropertyTrack } from '@motion/animation';
import { sampleTrack } from '@motion/animation';

import { NATIVE_ABI_VERSION_PACKED, PACKED_DOUBLES } from './abi';
import {
  getNativeModule,
  isNativeActive,
  loadNative,
  nativeSampleScalar,
  nativeSampleScalarBatch,
  setNativeModule,
} from './bridge';
import type { NativeEvalModule } from './bridge';
import { loadGoldenTable } from './golden.test-util';
import { packKeyframes, packedFor } from './packed';

/** The golden track, exactly as native/tests/gen_golden.ts defines it. */
const goldenKeyframes: Keyframe[] = [
  { t: 0, value: 0, easing: 'bezier', bezier: [0.42, 0, 0.58, 1] },
  { t: 1, value: 100, easing: 'bezier', bezier: [0.17, 0.67, 0.83, 0.67], so: 30 },
  { t: 2.5, value: -40, si: -12.5 },
];
const goldenTrack: PropertyTrack = { nodeId: 'golden', prop: 'x', keyframes: goldenKeyframes };

const golden = loadGoldenTable();

afterEach(() => setNativeModule(null));

describe('golden table', () => {
  it('is the table the generator describes (3 keyframes, ≥ 20 samples)', () => {
    expect(golden.keyframes).toHaveLength(3);
    expect(golden.samples.length).toBeGreaterThanOrEqual(20);
    for (const k of golden.keyframes) expect(k).toHaveLength(PACKED_DOUBLES);
  });

  it('packs the golden track to exactly the KF lines in the .inc', () => {
    // This pins gen_golden.ts's hand-copied easing/flag numbers to abi.ts.
    expect(Array.from(packKeyframes(goldenKeyframes))).toEqual(golden.keyframes.flat());
  });

  it('the TypeScript sampler still produces the table (regenerate if this fails)', () => {
    for (const { t, expected } of golden.samples) {
      expect(sampleTrack(goldenTrack, t)).toBe(expected);
    }
  });
});

describe('fallback path (no native module)', () => {
  it('loadNative reports unavailable with a reason', async () => {
    const r = await loadNative();
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toMatch(/N0|N1/);
    expect(isNativeActive()).toBe(false);
    expect(getNativeModule()).toBeNull();
  });

  it('nativeSampleScalar matches @motion/animation on every golden sample, bit for bit', () => {
    for (const { t, expected } of golden.samples) {
      expect(nativeSampleScalar(goldenTrack, t)).toBe(expected);
    }
  });

  it('nativeSampleScalarBatch equals per-sample', () => {
    const times = new Float64Array(golden.samples.map((s) => s.t));
    const out = nativeSampleScalarBatch(goldenTrack, times)!;
    expect(out).toBeInstanceOf(Float64Array);
    golden.samples.forEach((s, i) => expect(out[i]).toBe(s.expected));
  });

  it('empty track → undefined, like sampleTrack', () => {
    const empty: PropertyTrack = { nodeId: 'n', prop: 'x', keyframes: [] };
    expect(nativeSampleScalar(empty, 0)).toBeUndefined();
    expect(nativeSampleScalarBatch(empty, new Float64Array([0]))).toBeUndefined();
  });
});

describe('packing', () => {
  it('writes presence flags and the spatial mode', () => {
    const kfs: Keyframe[] = [
      { t: 0, value: 1 },
      { t: 1, value: 2, easing: 'hold', si: 3, so: 4, spatialInterp: 'auto' },
      { t: 2, value: 5, easing: 'step', spatialInterp: 'linear' },
    ];
    const p = packKeyframes(kfs);
    expect(p.length).toBe(3 * PACKED_DOUBLES);
    expect(Array.from(p.subarray(0, PACKED_DOUBLES))).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    // hold=1, flags = HAS_SI|HAS_SO | auto(4)<<4 = 2|4|64 = 70
    expect(Array.from(p.subarray(PACKED_DOUBLES, 2 * PACKED_DOUBLES))).toEqual([1, 2, 1, 70, 0, 0, 0, 0, 3, 4]);
    // step=9, flags = linear(1)<<4 = 16
    expect(Array.from(p.subarray(2 * PACKED_DOUBLES))).toEqual([2, 5, 9, 16, 0, 0, 0, 0, 0, 0]);
  });

  it('caches per keyframe array identity', () => {
    const kfs: Keyframe[] = [{ t: 0, value: 0 }];
    expect(packedFor(kfs)).toBe(packedFor(kfs));
    expect(packedFor([...kfs])).not.toBe(packedFor(kfs));
  });
});

describe('with a native module installed', () => {
  const calls: Array<[Float64Array, number]> = [];
  const fake: NativeEvalModule = {
    abiVersion: () => NATIVE_ABI_VERSION_PACKED,
    sampleScalar(packed, t) {
      calls.push([packed, t]);
      return -1; // a marker: proves the call was routed, not sampled in TypeScript
    },
    sampleScalarBatch(packed, times) {
      return new Float64Array(times.length).fill(packed.length);
    },
  };

  it('routes sampling to the module with the packed track', () => {
    setNativeModule(fake, 'wasm');
    expect(isNativeActive()).toBe(true);
    expect(nativeSampleScalar(goldenTrack, 0.5)).toBe(-1);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(packedFor(goldenKeyframes));
    expect(calls[0]![1]).toBe(0.5);
    expect(Array.from(nativeSampleScalarBatch(goldenTrack, new Float64Array(2))!)).toEqual([30, 30]);
  });

  it('refuses a module with a different ABI version', () => {
    const wrong: NativeEvalModule = { ...fake, abiVersion: () => (1 << 16) | 0 };
    expect(() => setNativeModule(wrong)).toThrow(/ABI 1\.0/);
    expect(isNativeActive()).toBe(false);
  });

  it('setNativeModule(null) restores the fallback', () => {
    setNativeModule(fake);
    setNativeModule(null);
    expect(nativeSampleScalar(goldenTrack, 0.5)).toBe(50);
  });
});
