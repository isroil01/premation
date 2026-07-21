/**
 * Audio level math for the VU meter — pure so it's unit-testable without Web
 * Audio. `rmsPeak` reduces a block of time-domain samples (AnalyserNode's
 * `getFloatTimeDomainData`, values in [-1,1]) to RMS + absolute peak; `toDb`
 * converts a linear amplitude to dBFS; `meterFraction` maps dBFS onto a 0..1
 * bar over a fixed floor (AE's meter runs roughly -48..0 dB).
 */

export interface Levels {
  /** Root-mean-square amplitude, linear 0..1 (perceived loudness). */
  rms: number;
  /** Absolute peak amplitude, linear 0..1 (clip detection). */
  peak: number;
}

export function rmsPeak(samples: Float32Array): Levels {
  if (samples.length === 0) return { rms: 0, peak: 0 };
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    sumSq += s * s;
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
  }
  return { rms: Math.sqrt(sumSq / samples.length), peak };
}

/** Linear amplitude (0..1) → dBFS. 0 amplitude clamps to `floorDb`. */
export function toDb(amp: number, floorDb = -60): number {
  if (amp <= 0) return floorDb;
  const db = 20 * Math.log10(amp);
  return db < floorDb ? floorDb : db;
}

/** dBFS → a 0..1 meter fill over `[floorDb, 0]` (values above 0 clamp to 1). */
export function meterFraction(db: number, floorDb = -48): number {
  if (db >= 0) return 1;
  if (db <= floorDb) return 0;
  return 1 - db / floorDb;
}
