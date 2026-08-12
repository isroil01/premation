/**
 * Bend's inverse map, ported to TS so its ALGEBRA can be executed.
 *
 * Three faults were reported together — a negative Amount did nothing, Style
 * appeared inert, and Past Base appeared inert — and they turned out to be one
 * bug with three faces:
 *
 *   R = L / theta goes NEGATIVE for a negative bend, so `dy = R - b` follows it
 *   and `atan2(a, dy) / theta` comes out negative across the whole band. Every
 *   pixel then took the "before Top" branch, which is the identity. Nothing
 *   bent; nothing ever reached the past-Base region either, so Carry and Hold
 *   were indistinguishable and the Style profile was never evaluated.
 *
 * The fix mirrors the frame for a negative angle and solves the positive
 * problem. These assertions are what the GPU cannot tell us here: the render
 * gate needs Electron, so the maths is executed on the CPU instead. This is a
 * PORT — it proves the algorithm, not the WGSL transcription of it, which is
 * what the render scenes gate.
 */

/** Exactly the profiles in the shader. */
function profileInv(w: number, style: number): number {
  if (style < 0.5) return 0.5 - Math.sin(Math.asin(Math.min(1, Math.max(-1, 1 - 2 * w))) / 3);
  if (style < 1.5) return w;
  return Math.asin(Math.min(1, Math.max(0, w))) * (2 / Math.PI);
}

interface Args {
  theta: number; style?: number; hold?: boolean;
  top?: [number, number]; base?: [number, number];
}

/** The shader's fragment maths for one point, in aspect-corrected units. */
function bendInverse(q: [number, number], a0: Args): [number, number] {
  const { theta, style = 1, hold = false } = a0;
  const top = a0.top ?? [0.5, 0];
  const base = a0.base ?? [0.5, 1];
  const axis: [number, number] = [base[0] - top[0], base[1] - top[1]];
  const L = Math.hypot(axis[0], axis[1]);
  if (Math.abs(theta) <= 0.0001 || L <= 0.0001) return q;

  const d: [number, number] = [axis[0] / L, axis[1] / L];
  const n: [number, number] = [-d[1], d[0]];
  const rel: [number, number] = [q[0] - top[0], q[1] - top[1]];
  const a = rel[0] * d[0] + rel[1] * d[1];

  const sgn = theta >= 0 ? 1 : -1;
  const th = Math.abs(theta);
  const b = (rel[0] * n[0] + rel[1] * n[1]) * sgn;
  const R = L / th;
  const dy = R - b;
  const r = Math.hypot(a, dy);
  const w = Math.atan2(a, dy) / th;

  let sa = a;
  let sb = b;
  if (w > 1 && !hold) {
    const ce = Math.cos(th); const se = Math.sin(th);
    const ex = R * se; const ey = R - R * ce;
    const rx = a - ex; const ry = b - ey;
    sa = L + (rx * ce + ry * se);
    sb = -rx * se + ry * ce;
  } else if (w > 1) {
    // Hold: untouched.
  } else if (w >= 0) {
    sa = profileInv(w, style) * L;
    sb = R - r;
  }
  const sbSigned = sb * sgn;
  return [top[0] + d[0] * sa + n[0] * sbSigned, top[1] + d[1] * sa + n[1] * sbSigned];
}

const MID: [number, number] = [0.5, 0.5];
const near = (a: number, b: number, p = 6): void => expect(a).toBeCloseTo(b, p);

describe('a negative Amount bends', () => {
  it('★ moves the pixel at all — the reported fault was that it did not', () => {
    const out = bendInverse(MID, { theta: -Math.PI / 4 });
    // Identity would return MID exactly. Any real bend displaces it.
    expect(Math.hypot(out[0] - MID[0], out[1] - MID[1])).toBeGreaterThan(0.01);
  });

  it('★ mirrors the positive bend across the bend line', () => {
    // The bend line is vertical at x = 0.5, so mirroring negates the x offset
    // and leaves y alone. Exact symmetry is the point of solving one direction.
    const pos = bendInverse(MID, { theta: Math.PI / 4 });
    const neg = bendInverse(MID, { theta: -Math.PI / 4 });
    near(neg[0] - 0.5, -(pos[0] - 0.5));
    near(neg[1], pos[1]);
  });

  it('is the identity at exactly zero, with no divide by zero', () => {
    const out = bendInverse(MID, { theta: 0 });
    expect(out).toEqual(MID);
  });
});

describe('Style actually selects a profile', () => {
  it('★ the three styles give three different mappings', () => {
    const at = (style: number): number => bendInverse([0.5, 0.3], { theta: Math.PI / 3, style })[1];
    const [marilyn, sharp, circular] = [at(0), at(1), at(2)];
    // Sharp is the linear ramp; the other two curve away from it in opposite
    // senses, so all three must be distinct.
    expect(Math.abs(marilyn - sharp)).toBeGreaterThan(1e-4);
    expect(Math.abs(circular - sharp)).toBeGreaterThan(1e-4);
    expect(Math.abs(marilyn - circular)).toBeGreaterThan(1e-4);
  });

  it('every profile is still an exact inverse at its endpoints', () => {
    for (const style of [0, 1, 2]) {
      near(profileInv(0, style), 0);
      near(profileInv(1, style), 1, 5);
    }
  });
});

describe('Past Base', () => {
  /**
   * A point beyond Base along the bend axis.
   *
   * "Past Base" is w > 1, and w is `atan2(a, dy) / theta` — NOT linear in
   * distance. At theta = 60° the boundary sits near a = 1.65, well beyond
   * Base's a = 1, so a point at 1.6 is still inside the arc. Chosen from the
   * algebra rather than by eye, because a fixture that lands on the wrong side
   * makes both Hold and Carry assertions vacuous.
   */
  const PAST: [number, number] = [0.5, 2.5];

  it('★ Hold leaves the remainder exactly where it was', () => {
    const out = bendInverse(PAST, { theta: Math.PI / 3, hold: true });
    near(out[0], PAST[0]);
    near(out[1], PAST[1]);
  });

  it('★ Carry moves it, so the two modes are genuinely different', () => {
    const carried = bendInverse(PAST, { theta: Math.PI / 3, hold: false });
    expect(Math.hypot(carried[0] - PAST[0], carried[1] - PAST[1])).toBeGreaterThan(0.05);
  });

  it('both modes agree INSIDE the band — the control only affects past Base', () => {
    const a = bendInverse(MID, { theta: Math.PI / 3, hold: true });
    const b = bendInverse(MID, { theta: Math.PI / 3, hold: false });
    near(a[0], b[0]);
    near(a[1], b[1]);
  });
});

describe('the bend line is where the points put it', () => {
  it('a horizontal Top→Base bends across the other axis', () => {
    // Freedom the old angle+extent form could not express: the line runs left
    // to right here, so the displacement is vertical.
    const out = bendInverse([0.5, 0.5], {
      theta: Math.PI / 4, top: [0, 0.5], base: [1, 0.5],
    });
    expect(Math.abs(out[1] - 0.5)).toBeGreaterThan(0.01);
  });

  it('is the identity when Top and Base coincide, rather than NaN', () => {
    const out = bendInverse(MID, { theta: Math.PI / 4, top: [0.5, 0.5], base: [0.5, 0.5] });
    expect(Number.isFinite(out[0])).toBe(true);
    expect(out).toEqual(MID);
  });
});
