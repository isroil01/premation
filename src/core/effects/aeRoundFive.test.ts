/**
 * Round five — twenty effects, asserted on BEHAVIOUR.
 *
 * Same charter as aeRoundFour.test.ts: the registry/dispatch/dead-control
 * guards prove wiring exists, never that pixels move, so each test below
 * states one claim a plausible-but-wrong implementation would fail. Distorts
 * assert WHERE content landed (inverse-map direction, see
 * gotcha_motion_inverse_map_direction); particle effects assert DETERMINISM
 * (same params → bit-identical frame) because that is the property that makes
 * scrubbing stable; transitions assert the completion contract (0 = untouched,
 * 100 = gone).
 */

import {
  starBurstData, snowfallData, rainfallData, writeOnData, lightBurstData,
} from './generateRoundFive';
import {
  glassData, texturizeData, threadsData, chromaticAberrationData, hexTileData, vectorBlurData,
} from './aeStylizeRoundFive';
import {
  floMotionData, lensData, griddlerData, ballActionData, drizzleData,
} from './aeDistortRoundFive';
import {
  jawsData, pixelPollyData, twisterData, cardDanceData,
} from './aeTransitionsRoundFive';

// ── helpers ─────────────────────────────────────────────────────────

function image(
  w: number,
  h: number,
  fn: (x: number, y: number) => [number, number, number, number],
): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const o = (y * w + x) * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
    }
  }
  return d;
}

const solid = (w: number, h: number, r: number, g: number, b: number, a = 255): Uint8ClampedArray =>
  image(w, h, () => [r, g, b, a]);

const px = (d: Uint8ClampedArray, w: number, x: number, y: number): [number, number, number, number] => {
  const o = (y * w + x) * 4;
  return [d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!];
};

const alphaAt = (d: Uint8ClampedArray, w: number, x: number, y: number): number =>
  d[(y * w + x) * 4 + 3]!;

const identical = (a: Uint8ClampedArray, b: Uint8ClampedArray): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const visibleCount = (d: Uint8ClampedArray): number => {
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]! > 8) n++;
  return n;
};

const sumDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s;
};

// ── Generate ────────────────────────────────────────────────────────

describe('Star Burst', () => {
  const src = solid(64, 64, 40, 90, 200);
  it('blend 100 returns the untouched layer', () => {
    const out = starBurstData(src, 64, 64, 500, 60, 2, [255, 255, 255], 100, 1);
    expect(identical(out, src)).toBe(true);
  });
  it('blend 0 replaces the layer with a sparse starfield', () => {
    const out = starBurstData(src, 64, 64, 500, 60, 2, [255, 255, 255], 0, 1);
    const vis = visibleCount(out);
    expect(vis).toBeGreaterThan(0);
    expect(vis).toBeLessThan(64 * 64 * 0.5); // sparse, not a repaint
  });
  it('stars are glints with cross spikes, not discs', () => {
    // At equal distance from a star's core, a point on the axis sits on a
    // diffraction spike and a diagonal point does not — a round disc would
    // light both equally. Measured at the brightest star of a sparse field.
    const out = starBurstData(solid(120, 120, 0, 0, 0, 0), 120, 120, 700, 15, 3, [255, 255, 255], 0, 2);
    // Outer field only: stars near the flight origin clump and pollute the
    // measurement; an outer star is isolated and fully grown.
    let bx = 0;
    let by = 0;
    let bright = -1;
    for (let y = 8; y < 112; y++) {
      for (let x = 8; x < 112; x++) {
        if (Math.hypot(x - 60, y - 60) < 35) continue;
        const v = px(out, 120, x, y)[0];
        if (v > bright) { bright = v; bx = x; by = y; }
      }
    }
    expect(bright).toBeGreaterThan(100);
    // The hot core saturates several pixels and argmax tie-breaks to its
    // top-left corner — recentre on the centroid of the near-max blob.
    let sx = 0;
    let sy = 0;
    let cnt = 0;
    for (let y = Math.max(0, by - 3); y <= Math.min(119, by + 3); y++) {
      for (let x = Math.max(0, bx - 3); x <= Math.min(119, bx + 3); x++) {
        if (px(out, 120, x, y)[0] >= bright - 8) { sx += x; sy += y; cnt++; }
      }
    }
    bx = Math.round(sx / cnt);
    by = Math.round(sy / cnt);
    const axis =
      (px(out, 120, bx + 4, by)[0] + px(out, 120, bx - 4, by)[0] +
        px(out, 120, bx, by + 4)[0] + px(out, 120, bx, by - 4)[0]) / 4;
    const diag =
      (px(out, 120, bx + 3, by + 3)[0] + px(out, 120, bx - 3, by - 3)[0] +
        px(out, 120, bx + 3, by - 3)[0] + px(out, 120, bx - 3, by + 3)[0]) / 4;
    expect(axis).toBeGreaterThan(diag * 1.5);
  });
  it('is deterministic and phase moves the field', () => {
    const a = starBurstData(src, 64, 64, 500, 60, 2, [255, 255, 255], 0, 1);
    const b = starBurstData(src, 64, 64, 500, 60, 2, [255, 255, 255], 0, 1);
    const c = starBurstData(src, 64, 64, 900, 60, 2, [255, 255, 255], 0, 1);
    expect(identical(a, b)).toBe(true);
    expect(identical(a, c)).toBe(false);
  });
});

describe('Snowfall', () => {
  const dark = solid(64, 64, 10, 10, 30);
  it('lays bright flakes over the layer and evolution moves them', () => {
    const a = snowfallData(dark, 64, 64, 60, 3, 0, 10, 90, [255, 255, 255], 1);
    const b = snowfallData(dark, 64, 64, 60, 3, 120, 10, 90, [255, 255, 255], 1);
    expect(sumDiff(a, dark)).toBeGreaterThan(0);
    expect(identical(a, b)).toBe(false);
    // Same frame twice → bit-identical (scrub-stable).
    const a2 = snowfallData(dark, 64, 64, 60, 3, 0, 10, 90, [255, 255, 255], 1);
    expect(identical(a, a2)).toBe(true);
  });
  it('amount 0 draws nothing', () => {
    const out = snowfallData(dark, 64, 64, 0, 3, 50, 10, 90, [255, 255, 255], 1);
    expect(identical(out, dark)).toBe(true);
  });
});

describe('Rainfall', () => {
  const dark = solid(80, 80, 8, 8, 16);
  it('draws streaks whose coverage grows with length', () => {
    const short = rainfallData(dark, 80, 80, 40, 8, 10, 30, 80, [220, 235, 255], 1);
    const long = rainfallData(dark, 80, 80, 40, 40, 10, 30, 80, [220, 235, 255], 1);
    expect(sumDiff(short, dark)).toBeGreaterThan(0);
    expect(sumDiff(long, dark)).toBeGreaterThan(sumDiff(short, dark));
  });
});

describe('Write-on', () => {
  const clear = solid(100, 60, 0, 0, 0, 0);
  it('completion 0 draws nothing; 50 covers the start half only', () => {
    const none = writeOnData(clear, 100, 60, -40, 0, 40, 0, 0, 6, [255, 0, 0], 0, 0);
    expect(visibleCount(none)).toBe(0);
    const half = writeOnData(clear, 100, 60, -40, 0, 40, 0, 50, 6, [255, 0, 0], 0, 0);
    // Near the start (x ≈ 10) painted, near the end (x ≈ 90) not.
    expect(alphaAt(half, 100, 12, 30)).toBeGreaterThan(0);
    expect(alphaAt(half, 100, 88, 30)).toBe(0);
    const full = writeOnData(clear, 100, 60, -40, 0, 40, 0, 100, 6, [255, 0, 0], 0, 0);
    expect(alphaAt(full, 100, 88, 30)).toBeGreaterThan(0);
  });
});

describe('Light Burst', () => {
  it('intensity 0 is the identity', () => {
    const src = image(60, 60, (x, y) => (x === 20 && y === 30 ? [255, 255, 255, 255] : [20, 20, 20, 255]));
    const out = lightBurstData(src, 60, 60, 0, 0, 0, 30);
    expect(identical(out, src)).toBe(true);
  });
  it('streaks bright content OUTWARD along the ray from the centre', () => {
    // Bright block left of centre: pixels further left (outward) look back
    // toward the centre THROUGH the block and pick it up; the perpendicular
    // neighbour at the same distance does not.
    const src = image(61, 61, (x, y) =>
      x >= 17 && x <= 23 && y >= 27 && y <= 33 ? [255, 255, 255, 255] : [10, 10, 10, 255]);
    const out = lightBurstData(src, 61, 61, 0, 0, 300, 60);
    const outward = px(out, 61, 11, 30)[0]; // further from centre, on the ray
    const perp = px(out, 61, 20, 18)[0]; // off the ray, clear of the block
    expect(outward).toBeGreaterThan(perp + 10);
  });
});

// ── Stylize ─────────────────────────────────────────────────────────

describe('Glass', () => {
  it('a featureless layer has no relief and passes through', () => {
    const flat = solid(40, 40, 120, 120, 120);
    const out = glassData(flat, 40, 40, 2, 40, 12, 135, 60, 40);
    expect(sumDiff(out, flat)).toBe(0);
  });
  it('a luminance edge refracts and lights the neighbourhood', () => {
    const edge = image(40, 40, (x) => (x < 20 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const out = glassData(edge, 40, 40, 2, 40, 12, 135, 60, 40);
    expect(sumDiff(out, edge)).toBeGreaterThan(0);
  });
});

describe('Texturize', () => {
  it('contrast 0 is the identity; texture breaks a flat field', () => {
    const flat = solid(40, 40, 128, 128, 128);
    expect(identical(texturizeData(flat, 40, 40, 0, 0, 100, 135), flat)).toBe(true);
    const out = texturizeData(flat, 40, 40, 0, 80, 100, 135);
    expect(sumDiff(out, flat)).toBeGreaterThan(0);
  });
});

describe('Threads', () => {
  it('spacing opens transparent gaps; zero spacing covers fully', () => {
    const src = solid(48, 48, 200, 120, 60);
    const gapped = threadsData(src, 48, 48, 8, 4, 40);
    // A pixel in the gap: x % 12 and y % 12 both ≥ 8.
    expect(alphaAt(gapped, 48, 10, 10)).toBe(0);
    expect(alphaAt(gapped, 48, 2, 2)).toBe(255);
    const woven = threadsData(src, 48, 48, 8, 0, 40);
    expect(visibleCount(woven)).toBe(48 * 48);
  });
});

describe('Chromatic Aberration', () => {
  it('linear mode fringes red on one edge and blue on the other', () => {
    // White bar on black, shift along +x: red samples from the left (bar
    // shifted right in red), blue from the right (shifted left in blue).
    const src = image(60, 20, (x) => (x >= 25 && x < 35 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = chromaticAberrationData(src, 60, 20, 4, 1, 0, 0, 0, 0);
    const right = px(out, 60, 37, 10); // just outside the bar's right edge
    const left = px(out, 60, 23, 10); // just outside the left edge
    expect(right[0]).toBeGreaterThan(right[2] + 40); // red fringe
    expect(left[2]).toBeGreaterThan(left[0] + 40); // blue fringe
  });
  it('amount 0 is the identity', () => {
    const src = solid(30, 30, 90, 140, 200);
    expect(identical(chromaticAberrationData(src, 30, 30, 0, 0, 0, 50, 0, 0), src)).toBe(true);
  });
});

describe('Hex Tile', () => {
  it('flattens each hex to its centre colour', () => {
    const grad = image(60, 60, (x, y) => [x * 4, y * 4, 0, 255]);
    const out = hexTileData(grad, 60, 60, 12, 0);
    // Neighbouring pixels inside one cell agree; distant cells differ.
    expect(px(out, 60, 30, 30)).toEqual(px(out, 60, 31, 30));
    expect(px(out, 60, 6, 6)).not.toEqual(px(out, 60, 54, 54));
  });
  it('border darkens the seams', () => {
    const flat = solid(60, 60, 200, 200, 200);
    const plain = hexTileData(flat, 60, 60, 12, 0);
    const seamed = hexTileData(flat, 60, 60, 12, 80);
    let sPlain = 0;
    let sSeam = 0;
    for (let i = 0; i < plain.length; i += 4) {
      sPlain += plain[i]!;
      sSeam += seamed[i]!;
    }
    expect(sSeam).toBeLessThan(sPlain);
  });
});

describe('Vector Blur', () => {
  it('blurs along the edge by default, across it with a 90° offset', () => {
    const edge = image(40, 40, (x) => (x < 20 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const along = vectorBlurData(edge, 40, 40, 8, 0, 1);
    const across = vectorBlurData(edge, 40, 40, 8, 90, 1);
    // Flow along a vertical edge is vertical — the edge survives; rotated 90°
    // the smear crosses the edge and melts it.
    expect(sumDiff(across, edge)).toBeGreaterThan(sumDiff(along, edge) * 2);
  });
});

// ── Distort ─────────────────────────────────────────────────────────

describe('Flo Motion', () => {
  it('a positive knot magnifies — content moves AWAY from the knot', () => {
    // Knot at the centre; bright dot 8px to its right. Magnification must
    // push the dot further right, not pull it in (the inverse-map direction).
    const src = image(80, 80, (x, y) => (x === 48 && y === 40 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = floMotionData(src, 80, 80, 0, 0, 60, 1000, 1000, 0, 40);
    let bx = -1;
    let bright = -1;
    for (let x = 0; x < 80; x++) {
      const v = px(out, 80, x, 40)[0];
      if (v > bright) { bright = v; bx = x; }
    }
    expect(bright).toBeGreaterThan(60);
    expect(bx).toBeGreaterThan(48);
  });
});

describe('Lens', () => {
  const src = image(80, 80, (x, y) => {
    const corner = (x < 8 || x >= 72) && (y < 8 || y >= 72);
    return corner ? [255, 0, 0, 255] : [0, 0, 255, 255];
  });
  it('outside the ball is transparent', () => {
    const out = lensData(src, 80, 80, 0, 0, 60, 50);
    expect(alphaAt(out, 80, 2, 40)).toBe(0); // left of the ball on its axis
    expect(alphaAt(out, 80, 40, 40)).toBe(255);
  });
  it('full convergence folds the corners into the ball', () => {
    const out = lensData(src, 80, 80, 0, 0, 60, 100);
    // Somewhere inside the ball the red corner pixels must now appear.
    let redInside = 0;
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 80; x++) {
        const [r, , b, a] = px(out, 80, x, y);
        if (a > 0 && r > 128 && b < 64) redInside++;
      }
    }
    expect(redInside).toBeGreaterThan(0);
  });
});

describe('Griddler', () => {
  it('sub-100% tile scale opens transparent seams, tile centres survive', () => {
    const src = solid(64, 64, 90, 200, 90);
    const out = griddlerData(src, 64, 64, 16, 50, 50, 0);
    expect(alphaAt(out, 64, 15, 15)).toBe(0); // tile corner — in the gap
    expect(alphaAt(out, 64, 8, 8)).toBe(255); // tile centre
  });
});

describe('Ball Action', () => {
  it('renders shaded balls with transparent surrounds', () => {
    const src = solid(64, 64, 180, 180, 180);
    const out = ballActionData(src, 64, 64, 16, 70, 0, 1);
    // Cell corner lies outside every ball.
    expect(alphaAt(out, 64, 0, 0)).toBe(0);
    // Ball centre is opaque, and its top-left is brighter than its
    // bottom-right — the shading that sells the sphere.
    expect(alphaAt(out, 64, 8, 8)).toBe(255);
    const tl = px(out, 64, 5, 5)[0];
    const br = px(out, 64, 11, 11)[0];
    expect(tl).toBeGreaterThan(br);
  });
});

describe('Drizzle', () => {
  it('drip rate 0 is the identity; rings displace deterministically', () => {
    const grad = image(64, 64, (x, y) => [x * 3, y * 3, 100, 255]);
    expect(identical(drizzleData(grad, 64, 64, 0, 10, 100, 50, 1), grad)).toBe(true);
    const a = drizzleData(grad, 64, 64, 80, 14, 80, 55, 1);
    const b = drizzleData(grad, 64, 64, 80, 14, 80, 55, 1);
    expect(identical(a, b)).toBe(true);
    expect(sumDiff(a, grad)).toBeGreaterThan(0);
  });
});

// ── Transitions ─────────────────────────────────────────────────────

describe('Jaws', () => {
  const src = solid(60, 60, 120, 160, 200);
  it('honours the completion contract: 0 untouched, 100 gone', () => {
    expect(identical(jawsData(src, 60, 60, 0, 0, 10, 20), src)).toBe(true);
    expect(visibleCount(jawsData(src, 60, 60, 100, 0, 10, 20))).toBe(0);
  });
  it('opens a transparent bite along the seam that widens with completion', () => {
    const some = jawsData(src, 60, 60, 30, 0, 10, 20);
    const more = jawsData(src, 60, 60, 60, 0, 10, 20);
    const visSome = visibleCount(some);
    const visMore = visibleCount(more);
    expect(visSome).toBeLessThan(60 * 60);
    expect(visMore).toBeLessThan(visSome);
    // The gap is centred on the seam.
    expect(alphaAt(some, 60, 30, 30)).toBe(0);
  });
});

describe('Pixel Polly', () => {
  const src = solid(60, 60, 200, 120, 80);
  it('0 is the identity, shards scatter and coverage falls, 100 is empty', () => {
    expect(identical(pixelPollyData(src, 60, 60, 0, 12, 50, 180, 0, 0, 1), src)).toBe(true);
    const mid = pixelPollyData(src, 60, 60, 55, 12, 50, 180, 0, 0, 1);
    const vis = visibleCount(mid);
    expect(vis).toBeGreaterThan(0);
    expect(vis).toBeLessThan(60 * 60);
    expect(visibleCount(pixelPollyData(src, 60, 60, 100, 12, 50, 180, 0, 0, 1))).toBe(0);
    // Deterministic — a transition may be scrubbed backwards.
    const mid2 = pixelPollyData(src, 60, 60, 55, 12, 50, 180, 0, 0, 1);
    expect(identical(mid, mid2)).toBe(true);
  });
});

describe('Twister', () => {
  const src = solid(60, 60, 90, 90, 220);
  it('compresses rows toward the axis and vanishes at 100', () => {
    expect(identical(twisterData(src, 60, 60, 0, 0, 120), src)).toBe(true);
    const mid = twisterData(src, 60, 60, 60, 0, 120);
    // Far from the axis the sheet has foreshortened out of frame…
    expect(alphaAt(mid, 60, 30, 1)).toBe(0);
    // …while the axis row is still there.
    expect(alphaAt(mid, 60, 30, 30)).toBe(255);
    expect(visibleCount(twisterData(src, 60, 60, 100, 0, 120))).toBe(0);
  });
});

describe('Card Dance', () => {
  it('amount 0 is bit-exactly the untouched frame; cards move with amount', () => {
    const grad = image(64, 64, (_x, y) => [0, y * 4, 200, 255]);
    expect(identical(cardDanceData(grad, 64, 64, 8, 8, 0, 20, 0), grad)).toBe(true);
    const out = cardDanceData(grad, 64, 64, 8, 8, 40, 20, 25);
    expect(sumDiff(out, grad)).toBeGreaterThan(0);
    const out2 = cardDanceData(grad, 64, 64, 8, 8, 40, 20, 25);
    expect(identical(out, out2)).toBe(true);
  });
});
