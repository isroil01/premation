/**
 * Colour temperature — Kelvin ⇄ sRGB for light colours.
 *
 * Lighting is chosen in Kelvin everywhere but here: tungsten practicals are
 * 2700 K, an overcast sky is 7000 K, and "make this warmer" is a number a
 * gaffer says out loud. The inspector's raw hex picker cannot express that, so
 * a light's colour was always eyeballed.
 *
 * `kelvinToHex` is the standard Tanner Helland piecewise fit to the Planckian
 * locus (accurate to a few units over 1000–40000 K). The fit is already
 * brightness-normalised — red pins at 255 below 6600 K and blue pins at 255
 * above it — which is what a light colour wants: the ENERGY is the layer's
 * Intensity, so warming a light must change its hue without dimming it.
 *
 * `nearestKelvin` is the inverse the UI needs: the control has to show the
 * temperature of whatever colour the light currently has (a hex written by the
 * picker, a preset, or an older project), and no closed-form inverse of the
 * fit exists. It searches the curve instead — coarse, then refined — which is
 * exact for colours the forward function produced and sensible for the rest.
 */

/** The range the UI offers, and the range `nearestKelvin` searches. */
export const KELVIN_MIN = 1500;
export const KELVIN_MAX = 15000;

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Blackbody colour at `kelvin`, as 0–255 sRGB channels. */
export function kelvinToRgb(kelvin: number): [number, number, number] {
  // The fit is defined from 1000 K up; below that it is extrapolation, not data.
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100;

  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);

  const g = t <= 66
    ? 99.4708025861 * Math.log(t) - 161.1195681661
    : 288.1221695283 * Math.pow(t - 60, -0.0755148492);

  const b = t >= 66
    ? 255
    : t <= 19
      ? 0
      : 138.5177312231 * Math.log(t - 10) - 305.0447927307;

  return [clamp255(r), clamp255(g), clamp255(b)];
}

/** Blackbody colour at `kelvin` as `#rrggbb`. */
export function kelvinToHex(kelvin: number): string {
  const [r, g, b] = kelvinToRgb(kelvin);
  const h = (v: number): string => v.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Parse `#rgb` / `#rrggbb` (with or without the hash). Null when unparseable. */
function parseHex(hex: string): [number, number, number] | null {
  const s = hex.trim().replace(/^#/, '');
  if (s.length === 3) {
    const [a, b, c] = [s[0], s[1], s[2]];
    if (a === undefined || b === undefined || c === undefined) return null;
    const n = Number.parseInt(`${a}${a}${b}${b}${c}${c}`, 16);
    if (!Number.isFinite(n)) return null;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  if (s.length < 6) return null;
  const n = Number.parseInt(s.slice(0, 6), 16);
  if (!Number.isFinite(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The temperature whose blackbody colour is closest to `hex`, in Kelvin,
 * clamped to [KELVIN_MIN, KELVIN_MAX]. Compares HUE only (each colour scaled so
 * its brightest channel is full), so a dimmed warm white still reads as warm
 * rather than collapsing toward the nearest dark point on the curve.
 */
export function nearestKelvin(hex: string, fallback = 6500): number {
  const rgb = parseHex(hex);
  if (!rgb) return fallback;
  const norm = (c: [number, number, number]): [number, number, number] => {
    const m = Math.max(c[0], c[1], c[2]);
    return m <= 0 ? [0, 0, 0] : [(c[0] / m) * 255, (c[1] / m) * 255, (c[2] / m) * 255];
  };
  const target = norm(rgb);
  const dist = (k: number): number => {
    const c = norm(kelvinToRgb(k));
    const dr = c[0] - target[0], dg = c[1] - target[1], db = c[2] - target[2];
    return dr * dr + dg * dg + db * db;
  };
  let best = KELVIN_MIN;
  let bestD = Infinity;
  for (let k = KELVIN_MIN; k <= KELVIN_MAX; k += 100) {
    const d = dist(k);
    if (d < bestD) { bestD = d; best = k; }
  }
  for (let k = Math.max(KELVIN_MIN, best - 100); k <= Math.min(KELVIN_MAX, best + 100); k += 10) {
    const d = dist(k);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}
