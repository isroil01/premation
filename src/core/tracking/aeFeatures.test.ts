import { floodMatte, matteToPath, morphClose, morphOpen, refineRotoMatte } from './rotoMatte';
import { warpMatte } from './rotoBrush';
import { computeFlow, lumaOf } from '@core/rendering/pixelMotionFlow';
import { inpaintPatchMatch, propagateFillFrame } from '@core/effects/contentAwareFill';
import { solveSfmCameraPath } from './sfmCamera';
import { bundleAdjust, yprToR } from './bundleAdjust';
import { projectPoint } from './triangulate';
import { grabCutMatte } from './grabCut';
import { pqOetfChannel, hlgOetfChannel, applyHdrTransferRgb } from '@core/export/hdrTransfer';
import { decodePackBits, decodePsd } from '@core/media/psd';
import { exrToFloatRgba } from '@core/media/floatExr';
import { encodeExr, decodeExr } from '@core/media/exr';

describe('rotoMatte + warp', () => {
  it('warps a filled matte with identity-ish flow', () => {
    const w = 16;
    const h = 16;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 200;
      rgba[i * 4 + 3] = 255;
    }
    const mask = floodMatte(rgba, w, h, [{ x: 8, y: 8, tolerance: 50 }]);
    expect(mask.some((v) => v === 255)).toBe(true);
    const luma = lumaOf(rgba, w, h);
    const flow = computeFlow(luma, luma, w, h, { step: 4 });
    const warped = warpMatte(mask, w, h, flow, 1, 1);
    expect(warped.filter((v) => v === 255).length).toBeGreaterThan(0);
    expect(matteToPath(mask, w, h).length).toBeGreaterThan(3);
  });

  it('refines edge with morph open/close and soft feather', () => {
    const w = 24;
    const h = 24;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const inside = x >= 6 && x <= 17 && y >= 6 && y <= 17;
        rgba[i * 4] = inside ? 220 : 40;
        rgba[i * 4 + 1] = inside ? 40 : 180;
        rgba[i * 4 + 2] = inside ? 40 : 40;
        rgba[i * 4 + 3] = 255;
        if (inside) mask[i] = 255;
      }
    }
    // Speckle outside
    mask[2 * w + 2] = 255;
    const opened = morphOpen(mask, w, h, 1);
    expect(opened[2 * w + 2]).toBe(0);
    const closed = morphClose(opened, w, h, 1);
    expect(closed.filter((v) => v === 255).length).toBeGreaterThan(20);
    const refined = refineRotoMatte(rgba, mask, w, h, { morphRadius: 1, featherPx: 2 });
    expect(refined.mask.some((v) => v === 255)).toBe(true);
    expect(refined.feather).toBe(2);
  });
});

describe('contentAwareFill', () => {
  it('fills a hole from surrounding colour', () => {
    const w = 32;
    const h = 32;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const hole = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        rgba[i * 4] = 40;
        rgba[i * 4 + 1] = 80;
        rgba[i * 4 + 2] = 120;
        rgba[i * 4 + 3] = 255;
        if (x >= 12 && x < 20 && y >= 12 && y < 20) {
          hole[i] = 255;
          rgba[i * 4] = 0;
          rgba[i * 4 + 1] = 0;
          rgba[i * 4 + 2] = 0;
        }
      }
    }
    const n = inpaintPatchMatch(rgba, w, h, hole, { patchHalf: 3, iterations: 3 });
    expect(n).toBe(64);
    // Centre of hole should no longer be pure black.
    const c = ((16 * w + 16) * 4);
    expect(rgba[c]! + rgba[c + 1]! + rgba[c + 2]!).toBeGreaterThan(0);
  });

  it('propagates fill to the next frame', () => {
    const w = 24;
    const h = 24;
    const a = new Uint8ClampedArray(w * h * 4);
    const b = new Uint8ClampedArray(w * h * 4);
    const hole = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      a[i * 4] = b[i * 4] = 90;
      a[i * 4 + 1] = b[i * 4 + 1] = 90;
      a[i * 4 + 2] = b[i * 4 + 2] = 90;
      a[i * 4 + 3] = b[i * 4 + 3] = 255;
    }
    for (let y = 8; y < 16; y++) {
      for (let x = 8; x < 16; x++) {
        hole[y * w + x] = 255;
        b[(y * w + x) * 4] = 0;
      }
    }
    // Fill a first
    inpaintPatchMatch(a, w, h, hole.slice(), { patchHalf: 2, iterations: 2 });
    const left = hole.slice();
    propagateFillFrame(a, b, w, h, left, { patchHalf: 2, iterations: 2 });
    expect(b[(12 * w + 12) * 4]!).toBeGreaterThan(0);
  });
});

describe('sfmCamera', () => {
  it('returns a planar camera path for a translating quad', () => {
    const frames = [];
    for (let i = 0; i < 5; i++) {
      const d = i * 2;
      frames.push({
        points: [
          { x: 10 + d, y: 10 },
          { x: 200 + d, y: 10 },
          { x: 200 + d, y: 150 },
          { x: 10 + d, y: 150 },
        ],
      });
    }
    const path = solveSfmCameraPath(frames, { focalLength: 50, width: 210, height: 160 });
    expect(path.length).toBe(5);
    expect(path.every((p) => Number.isFinite(p.x + p.y + p.z))).toBe(true);
  });
});

describe('bundleAdjust', () => {
  it('reduces or holds reprojection cost on a synthetic two-view scene', () => {
    const f = 100;
    const cx = 50;
    const cy = 40;
    const cams = [
      { C: { x: 0, y: 0, z: -100 }, yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
      { C: { x: 10, y: 0, z: -100 }, yawDeg: 5, pitchDeg: 0, rollDeg: 0 },
    ];
    const pts = [
      { x: -20, y: -10, z: 0 },
      { x: 20, y: -10, z: 0 },
      { x: 20, y: 10, z: 0 },
      { x: -20, y: 10, z: 0 },
      { x: 0, y: 0, z: 5 },
    ];
    const obs = [];
    for (let fi = 0; fi < cams.length; fi++) {
      const R = yprToR(cams[fi]!.yawDeg, cams[fi]!.pitchDeg, cams[fi]!.rollDeg);
      for (let pi = 0; pi < pts.length; pi++) {
        const p = projectPoint(R, cams[fi]!.C, pts[pi]!, f, cx, cy);
        if (!p) continue;
        obs.push({ frame: fi, pointId: pi, x: p.u + 0.3, y: p.v - 0.2 });
      }
    }
    const noisyPts = pts.map((p) => ({ x: p.x + 1, y: p.y - 1, z: p.z + 0.5 }));
    const before = bundleAdjust(obs, cams, noisyPts, { focal: f, cx, cy, maxIters: 0 });
    const after = bundleAdjust(obs, cams, noisyPts, { focal: f, cx, cy, maxIters: 8 });
    expect(after.rmsPx).toBeLessThanOrEqual(before.rmsPx + 1e-6);
    expect(after.cameras.length).toBe(2);
  });
});

describe('grabCut', () => {
  it('segments a coloured blob from the background', () => {
    const w = 32;
    const h = 32;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const inside = x >= 10 && x <= 22 && y >= 10 && y <= 22;
        rgba[i] = inside ? 220 : 30;
        rgba[i + 1] = inside ? 40 : 30;
        rgba[i + 2] = inside ? 40 : 160;
        rgba[i + 3] = 255;
      }
    }
    const mask = grabCutMatte(rgba, w, h, [{ x: 16, y: 16, tolerance: 50 }], {
      unknownRadius: 4,
      iterations: 4,
    });
    expect(mask[16 * w + 16]).toBe(255);
    expect(mask[2 * w + 2]).toBe(0);
  });
});

describe('hdrTransfer', () => {
  it('maps mid grey through PQ and HLG into 0..1', () => {
    expect(pqOetfChannel(0)).toBeCloseTo(0, 5);
    expect(pqOetfChannel(1)).toBeGreaterThan(0.5);
    expect(hlgOetfChannel(0)).toBeCloseTo(0, 5);
    expect(hlgOetfChannel(1)).toBeCloseTo(1, 2);
    const [r] = applyHdrTransferRgb(0.18, 0.18, 0.18, 'pq');
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });

  it('accumulates MaxCLL / MaxFALL and formats x265 master-display', async () => {
    const {
      createHdrMasteringAccumulator,
      x265HdrParams,
      x265MasterDisplay,
    } = await import('@core/export/hdrTransfer');
    const acc = createHdrMasteringAccumulator(1000);
    const rgba = new Float32Array(4 * 4);
    for (let i = 0; i < 4; i++) {
      rgba[i * 4] = 1;
      rgba[i * 4 + 1] = 1;
      rgba[i * 4 + 2] = 1;
      rgba[i * 4 + 3] = 1;
    }
    acc.accumulateLinearFrame(rgba, true);
    const stats = acc.finish();
    expect(stats.maxCll).toBeGreaterThanOrEqual(900);
    expect(x265MasterDisplay(stats)).toContain('L(10000000,');
    expect(x265HdrParams('pq', stats)).toContain('max-cll=');
    expect(x265HdrParams('pq', stats)).toContain('master-display=');
  });
});

describe('psd packbits', () => {
  it('decodes a literal run', () => {
    const src = new Uint8Array([2, 10, 20, 30]); // n=2 → 3 literal bytes
    expect([...decodePackBits(src, 3)]).toEqual([10, 20, 30]);
  });
});

describe('floatExr', () => {
  it('round-trips linear float through encode/decode', async () => {
    const w = 2;
    const h = 2;
    const r = new Float32Array([0.5, 1, 0, 0.25]);
    const g = new Float32Array([0, 0.5, 1, 0.25]);
    const b = new Float32Array([0, 0, 0.5, 1]);
    const buf = encodeExr({
      width: w,
      height: h,
      channels: [
        { name: 'R', data: r },
        { name: 'G', data: g },
        { name: 'B', data: b },
      ],
    });
    const img = await decodeExr(buf);
    const f = exrToFloatRgba(img);
    expect(f.width).toBe(2);
    expect(f.rgba[0]).toBeCloseTo(0.5, 2);
  });
});

describe('decodePsd header reject', () => {
  it('rejects non-PSD', () => {
    const buf = new Uint8Array(32);
    buf[0] = 1; buf[1] = 2; buf[2] = 3; buf[3] = 4;
    expect(() => decodePsd(buf.buffer)).toThrow(/8BPS|not an/);
  });
});

describe('samSegment classical', () => {
  it('segments a centre blob from a click prompt', async () => {
    const { segmentSamSync } = await import('./samSegment');
    const w = 32;
    const h = 32;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const inside = Math.hypot(x - 16, y - 16) < 8;
        rgba[i] = inside ? 220 : 30;
        rgba[i + 1] = inside ? 40 : 30;
        rgba[i + 2] = inside ? 40 : 90;
        rgba[i + 3] = 255;
      }
    }
    const r = segmentSamSync({ rgba, width: w, height: h, points: [{ x: 16, y: 16, label: 1 }] });
    expect(r.engine).toBe('classical');
    expect(r.mask.some((v) => v === 255)).toBe(true);
    expect(r.soft.length).toBe(w * h);
  });
});

describe('samOnnxLoader', () => {
  it('reports unavailable when onnxruntime-web is missing', async () => {
    const { tryRegisterSamOnnxFromUrl, unregisterSamOnnx } = await import('./samOnnxLoader');
    unregisterSamOnnx();
    const r = await tryRegisterSamOnnxFromUrl('https://example.com/sam.onnx');
    expect(r.status === 'unavailable' || r.status === 'failed').toBe(true);
  });
});

describe('propagateFillBidirectional', () => {
  it('fills a hole across two frames', async () => {
    const { propagateFillBidirectional } = await import('@core/effects/contentAwareFill');
    const w = 16;
    const h = 16;
    const mk = (holeX: number): { rgba: Uint8ClampedArray; hole: Uint8Array } => {
      const rgba = new Uint8ClampedArray(w * h * 4);
      const hole = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          rgba[i * 4] = 100;
          rgba[i * 4 + 1] = 120;
          rgba[i * 4 + 2] = 140;
          rgba[i * 4 + 3] = 255;
          if (x === holeX && y === 8) {
            hole[i] = 255;
            rgba[i * 4] = 0;
            rgba[i * 4 + 1] = 0;
            rgba[i * 4 + 2] = 0;
          }
        }
      }
      return { rgba, hole };
    };
    const a = mk(4);
    const b = mk(5);
    const n = propagateFillBidirectional([a.rgba, b.rgba], w, h, [a.hole, b.hole], {
      patchHalf: 2,
      iterations: 2,
    });
    expect(n).toBeGreaterThan(0);
  });
});

describe('textFontVariationSettings', () => {
  it('emits wdth and slnt axes', async () => {
    const { textFontVariationSettings } = await import('@core/rendering/AppTextureProvider');
    expect(textFontVariationSettings({ fontWidth: 125, fontSlant: -10 })).toContain("'wdth' 125");
    expect(textFontVariationSettings({ fontWidth: 125, fontSlant: -10 })).toContain("'slnt' -10");
  });
});
