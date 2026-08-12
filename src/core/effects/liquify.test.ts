/**
 * Liquify — one brush carrying a push, a twirl and a pinch.
 *
 * ## What these tests are for
 *
 * The push is the part with no equivalent elsewhere in `distort.ts`, and it has
 * a DIRECTION — which is the one property a still frame cannot show. A push
 * applied the wrong way produces an image that is warped by the right amount in
 * the wrong direction and looks entirely plausible; only a test that asks which
 * way content moved can tell. That failure has already happened once in this
 * file's neighbourhood (see `spherizeData`'s note on `asin` vs `sin`).
 *
 * The other property worth pinning is CONTAINMENT. A brush that reaches beyond
 * its radius is not a brush, and stacking several — which is how this effect
 * substitutes for AE's stroke history — depends on each staying local.
 */

import { liquifyData } from './distort';

const W = 80;
const H = 80;
const CX = 40;
const CY = 40;
const R = 24;

/**
 * Where each destination pixel reads from, read back through the REAL kernel by
 * warping an image that encodes its own coordinates.
 */
function mappingOf(
  push: { x: number; y: number } = { x: 0, y: 0 },
  twirl = 0,
  pinch = 0,
  radius = R,
) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = Math.round((x / (W - 1)) * 255);
      data[i + 1] = Math.round((y / (H - 1)) * 255);
      data[i + 3] = 255;
    }
  }
  const out = liquifyData(data, W, H, CX, CY, radius, push.x, push.y, twirl, pinch);
  return (dx: number, dy: number) => {
    const i = (dy * W + dx) * 4;
    return {
      x: (out[i]! / 255) * (W - 1),
      y: (out[i + 1]! / 255) * (H - 1),
      valid: out[i + 3] === 255,
    };
  };
}

describe('every control at rest is exactly the identity', () => {
  it('returns the SAME buffer when nothing is set', () => {
    const data = new Uint8ClampedArray(W * H * 4).fill(128);
    expect(liquifyData(data, W, H, CX, CY, R, 0, 0, 0, 0)).toBe(data);
  });

  it('returns the SAME buffer when the brush has no size', () => {
    const data = new Uint8ClampedArray(W * H * 4).fill(128);
    expect(liquifyData(data, W, H, CX, CY, 0, 50, 50, 90, 50)).toBe(data);
  });
});

describe('the push has a direction', () => {
  it('reads from BEHIND the push, so the image moves WITH it', () => {
    // The direction check. `remap` asks where a destination reads from, so a
    // rightward push must sample to the LEFT — get this backwards and the image
    // slides the wrong way while looking perfectly plausible.
    const m = mappingOf({ x: 10, y: 0 });
    const p = m(CX, CY);
    expect(p.valid).toBe(true);
    expect(p.x).toBeCloseTo(CX - 10, 0);
    expect(p.y).toBeCloseTo(CY, 0);
  });

  it('pushes in Y independently, so the components are not swapped', () => {
    const m = mappingOf({ x: 0, y: 12 });
    const p = m(CX, CY);
    expect(p.x).toBeCloseTo(CX, 0);
    expect(p.y).toBeCloseTo(CY - 12, 0);
  });

  it('is STRONGEST at the centre and fades to nothing at the rim', () => {
    const m = mappingOf({ x: 12, y: 0 });
    const atCentre = CX - m(CX, CY).x;
    const halfway = CX + Math.round(R / 2) - m(CX + Math.round(R / 2), CY).x;
    const atRim = CX + R - m(CX + R, CY).x;
    expect(atCentre).toBeGreaterThan(halfway);
    expect(halfway).toBeGreaterThan(atRim);
    expect(Math.abs(atRim)).toBeLessThan(0.6);
  });
});

describe('the brush is CONTAINED', () => {
  it('leaves everything outside the radius untouched', () => {
    // What makes stacking several brushes a substitute for a stroke history: if
    // one leaked, two would not compose.
    const m = mappingOf({ x: 15, y: -15 }, 180, 60);
    for (const [x, y] of [[2, 2], [W - 3, 3], [3, H - 3], [W - 3, H - 3], [CX, CY - R - 6]]) {
      const p = m(x!, y!);
      expect(p.valid).toBe(true);
      expect(p.x).toBeCloseTo(x!, 0);
      expect(p.y).toBeCloseTo(y!, 0);
    }
  });
});

describe('twirl and pinch', () => {
  it('twirl rotates about the brush centre', () => {
    // A point directly right of the centre must acquire a Y component; a pure
    // scale or push could not produce one.
    const m = mappingOf({ x: 0, y: 0 }, 90);
    const probeX = CX + Math.round(R / 2);
    const p = m(probeX, CY);
    expect(p.valid).toBe(true);
    expect(Math.abs(p.y - CY)).toBeGreaterThan(2);
    // …and the radius is preserved, which is what makes it a rotation.
    const r0 = probeX - CX;
    const r1 = Math.hypot(p.x - CX, p.y - CY);
    expect(r1).toBeCloseTo(r0, 0);
  });

  it('twirl reverses with the sign of the angle', () => {
    const probeX = CX + Math.round(R / 2);
    const cw = mappingOf({ x: 0, y: 0 }, 90)(probeX, CY);
    const ccw = mappingOf({ x: 0, y: 0 }, -90)(probeX, CY);
    expect(Math.sign(cw.y - CY)).toBe(-Math.sign(ccw.y - CY));
  });

  it('pinch reads FURTHER out, and a negative value bloats', () => {
    const probeX = CX + Math.round(R / 2);
    const r0 = probeX - CX;
    const pinched = mappingOf({ x: 0, y: 0 }, 0, 60)(probeX, CY);
    const bloated = mappingOf({ x: 0, y: 0 }, 0, -60)(probeX, CY);
    expect(pinched.x - CX).toBeGreaterThan(r0);
    expect(bloated.x - CX).toBeLessThan(r0);
  });
});

describe('several brushes stack, which is how this stands in for strokes', () => {
  it('two pushes at different centres each keep their own neighbourhood', () => {
    // Applied in sequence, as the effect stack would.
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        data[i] = Math.round((x / (W - 1)) * 255);
        data[i + 3] = 255;
      }
    }
    const once = liquifyData(data, W, H, 24, 40, 14, 8, 0, 0, 0);
    const twice = liquifyData(once, W, H, 56, 40, 14, -8, 0, 0, 0);
    const readX = (buf: Uint8ClampedArray, x: number, y: number): number =>
      (buf[(y * W + x) * 4]! / 255) * (W - 1);
    // Each centre moved, in its own direction…
    expect(readX(twice, 24, 40)).toBeLessThan(24);
    expect(readX(twice, 56, 40)).toBeGreaterThan(56);
    // …and the midpoint between them, outside both radii, did not.
    expect(readX(twice, 40, 40)).toBeCloseTo(40, 0);
  });
});
