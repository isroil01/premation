/**
 * HDR transfer functions for encode (ST.2084 PQ + ARIB STD-B67 HLG).
 *
 * Scene/display-linear RGB (approx BT.2020-ish, relative) → nonlinear signal
 * in 0..1 for 10-bit staging. Matches the preview curves in colorPipeline.ts
 * so Comp Settings “PQ / HLG” and HDR export speak the same language.
 */

export type HdrTransfer = 'pq' | 'hlg';

/** ST.2084 PQ OETF. `L` is relative luminance 0..1 mapped so 1 ≈ 100 nits peak
 *  of the working buffer (preview convention). For true mastering scale callers
 *  should pre-multiply by peakNits/10000. */
export function pqOetfChannel(L: number): number {
  const Y = Math.max(0, L);
  const m1 = 2610 / 16384;
  const m2 = 2523 / 4096 * 128;
  const c1 = 3424 / 4096;
  const c2 = 2413 / 4096 * 32;
  const c3 = 2392 / 4096 * 32;
  const Ym = Y ** m1;
  return ((c1 + c2 * Ym) / (1 + c3 * Ym)) ** m2;
}

/** HLG OETF (ARIB STD-B67), scene-referred relative. */
export function hlgOetfChannel(E: number): number {
  const a = 0.17883277;
  const b = 0.28466892;
  const c = 0.55991073;
  const e = Math.max(0, E);
  return e <= 1 / 12 ? Math.sqrt(3 * e) : a * Math.log(12 * e - b) + c;
}

export function applyHdrTransferRgb(
  r: number,
  g: number,
  b: number,
  transfer: HdrTransfer,
): [number, number, number] {
  if (transfer === 'pq') {
    return [
      Math.min(1, Math.max(0, pqOetfChannel(r))),
      Math.min(1, Math.max(0, pqOetfChannel(g))),
      Math.min(1, Math.max(0, pqOetfChannel(b))),
    ];
  }
  return [
    Math.min(1, Math.max(0, hlgOetfChannel(r))),
    Math.min(1, Math.max(0, hlgOetfChannel(g))),
    Math.min(1, Math.max(0, hlgOetfChannel(b))),
  ];
}

/**
 * Bake HDR transfer into an 8-bit canvas ImageData in place (from sRGB-ish
 * display buffer → undo approx sRGB → apply PQ/HLG). Good enough for staged
 * PNG → ffmpeg HDR encode when float RT readback is unavailable.
 */
export function bakeHdrTransferIntoRgba8(
  data: Uint8ClampedArray,
  transfer: HdrTransfer,
): void {
  const toLinear = (u: number): number => {
    const c = u / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = applyHdrTransferRgb(
      toLinear(data[i]!),
      toLinear(data[i + 1]!),
      toLinear(data[i + 2]!),
      transfer,
    );
    data[i] = Math.round(r * 255);
    data[i + 1] = Math.round(g * 255);
    data[i + 2] = Math.round(b * 255);
  }
}

/** Apply transfer to a canvas; returns a new canvas (does not mutate source). */
export function canvasWithHdrTransfer(
  source: HTMLCanvasElement,
  transfer: HdrTransfer,
): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  if (!ctx) return source;
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  bakeHdrTransferIntoRgba8(img.data, transfer);
  ctx.putImageData(img, 0, 0);
  return out;
}

/**
 * HDR10 mastering metadata (CEA-861.3 / ST.2086 foothold).
 * MaxCLL / MaxFALL in nits; peak luminance of the mastering display.
 */
export interface HdrMasteringStats {
  /** Max Content Light Level (nits), integer. */
  maxCll: number;
  /** Max Frame-Average Light Level (nits), integer. */
  maxFall: number;
  /** Mastering display peak (nits). Default 1000. */
  displayMaxNits: number;
  /** Mastering display min (nits). Default 0.005. */
  displayMinNits: number;
}

export function createHdrMasteringAccumulator(displayMaxNits = 1000): {
  accumulateLinearFrame: (rgba: Float32Array | Uint8ClampedArray, linear?: boolean) => void;
  finish: () => HdrMasteringStats;
} {
  let maxCll = 0;
  let maxFallSum = 0;
  let frames = 0;
  const toLin = (u: number): number => {
    const c = u / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return {
    accumulateLinearFrame(rgba, alreadyLinear = false) {
      const n = Math.floor(rgba.length / 4);
      if (n <= 0) return;
      let frameMax = 0;
      let frameSum = 0;
      for (let i = 0; i < n; i++) {
        let r: number;
        let g: number;
        let b: number;
        if (alreadyLinear || rgba instanceof Float32Array) {
          r = rgba[i * 4]!;
          g = rgba[i * 4 + 1]!;
          b = rgba[i * 4 + 2]!;
        } else {
          r = toLin(rgba[i * 4]!);
          g = toLin(rgba[i * 4 + 1]!);
          b = toLin(rgba[i * 4 + 2]!);
        }
        // Rec.2020-ish luma; scale relative 1.0 → displayMaxNits.
        const Y = (0.2627 * r + 0.6780 * g + 0.0593 * b) * displayMaxNits;
        if (Y > frameMax) frameMax = Y;
        frameSum += Y;
      }
      if (frameMax > maxCll) maxCll = frameMax;
      maxFallSum += frameSum / n;
      frames++;
    },
    finish(): HdrMasteringStats {
      return {
        maxCll: Math.max(1, Math.round(maxCll)),
        maxFall: Math.max(1, Math.round(frames > 0 ? maxFallSum / frames : 0)),
        displayMaxNits,
        displayMinNits: 0.005,
      };
    },
  };
}

/** Rec.2020 / D65 mastering-display string for x265 `master-display=` (0.00002 units). */
export function x265MasterDisplay(stats: HdrMasteringStats): string {
  const Lmax = Math.round(stats.displayMaxNits * 10000);
  const Lmin = Math.round(stats.displayMinNits * 10000);
  return `G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(${Lmax},${Lmin})`;
}

/** Full x265-params fragment for PQ or HLG with MaxCLL/MaxFALL. */
export function x265HdrParams(transfer: HdrTransfer, stats: HdrMasteringStats): string {
  const trc = transfer === 'pq' ? 'smpte2084' : 'arib-std-b67';
  const md = x265MasterDisplay(stats);
  return (
    `hdr-opt=1:repeat-headers=1:colorprim=bt2020:transfer=${trc}:colormatrix=bt2020nc` +
    `:master-display=${md}:max-cll=${stats.maxCll},${stats.maxFall}`
  );
}
