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

/**
 * Bake PQ/HLG straight from FLOAT linear light into a staging canvas.
 *
 * The 8-bit path above quantises the picture TWICE — once into the display's
 * sRGB bytes, again after the OETF — and sRGB byte spacing is exactly wrong
 * for PQ's shadow-heavy code allocation, which is where HDR10 exports banded.
 * Going float→PQ→byte quantises once, on the perceptually-uniform side.
 * Returns null when the 2D context is unavailable; callers fall back to the
 * 8-bit path.
 */
export function hdrCanvasFromLinearRgba(
  linear: Float32Array,
  width: number,
  height: number,
  transfer: HdrTransfer,
): HTMLCanvasElement | null {
  if (linear.length < width * height * 4) return null;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(width, height);
  const d = img.data;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const [r, g, b] = applyHdrTransferRgb(
      linear[i * 4]!,
      linear[i * 4 + 1]!,
      linear[i * 4 + 2]!,
      transfer,
    );
    d[i * 4] = Math.round(r * 255);
    d[i * 4 + 1] = Math.round(g * 255);
    d[i * 4 + 2] = Math.round(b * 255);
    // HDR delivery is an opaque mp4 — alpha never survives the encode.
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
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

/**
 * Pre-export copy for HDR10/HLG: what the host ffmpeg can actually deliver.
 * `libx265 === null` means the probe is still in flight (or unavailable in web).
 */
export function formatHdrCapabilityNote(libx265: boolean | null): string {
  if (libx265 === null) {
    return 'Checking host ffmpeg for HEVC (libx265)…';
  }
  if (libx265) {
    return 'Will encode HEVC 10-bit (libx265) with MaxCLL / MaxFALL mastering metadata.';
  }
  return (
    'Host ffmpeg has no libx265. Will encode H.264 High 10 with BT.2020 colour tags — '
    + 'MaxCLL / MaxFALL SEI requires HEVC. Install an ffmpeg build with libx265 for full HDR10.'
  );
}

/** Post-export toast fragment: codec + measured light levels when present. */
export function formatHdrExportDoneNote(
  videoCodec: string | undefined,
  mastering?: Pick<HdrMasteringStats, 'maxCll' | 'maxFall'> | null,
): string {
  const codec =
    videoCodec === 'libx265' ? 'HEVC / libx265'
      : videoCodec === 'libx264' ? 'H.264 10-bit (no libx265)'
        : videoCodec ?? '';
  const levels = mastering
    ? ` · MaxCLL ${mastering.maxCll} · MaxFALL ${mastering.maxFall}`
    : '';
  if (!codec && !levels) return '';
  return codec ? ` (${codec}${levels})` : ` (${levels.trim()})`;
}

/**
 * HDR10/HLG export bakes PQ/HLG in {@link canvasWithHdrTransfer}. The viewport
 * ODT must not already be PQ/HLG or the signal is double-encoded. Callers wrap
 * the offline render in this helper so Comp Settings preview ODT stays for
 * interactive work only.
 */
export async function withNeutralDisplayForHdrEncode<T>(
  run: () => Promise<T>,
  setDisplay: (v: 'srgb' | 'aces' | 'pq' | 'hlg') => void,
  getDisplay: () => 'srgb' | 'aces' | 'pq' | 'hlg',
): Promise<T> {
  const prev = getDisplay();
  if (prev !== 'pq' && prev !== 'hlg') return run();
  setDisplay('srgb');
  try {
    return await run();
  } finally {
    setDisplay(prev);
  }
}
