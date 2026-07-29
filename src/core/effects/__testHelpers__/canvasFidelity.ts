/**
 * Is the test environment's Canvas2D faithful enough to assert compositing on?
 *
 * jsdom has no rasterizer, so jest.setup.ts backs <canvas> with @napi-rs/canvas
 * (Skia). That is enough for text metrics and for plain source-over drawing, but
 * NOT for the alpha algebra the layer-style chain is built from. Measured:
 *
 *            op            spec   Skia   node-canvas
 *   source-in              128     64        128
 *   destination-in         128     64        128
 *   destination-out        127    191        127
 *
 * Skia applies `globalAlpha` twice on those three ops. Interior styles (inner
 * shadow/glow, satin, bevel) and fill opacity are made of exactly those ops, so
 * under Skia they produce wrong pixels that still satisfy loose relational
 * assertions — a green test that certifies nothing. node-canvas gets the algebra
 * right but silently no-ops `ctx.filter`, which is what every interior blur is
 * built on, so it is no better.
 *
 * Rather than hard-code "skip in jest", these probes measure the property the
 * tests actually depend on. They skip on an unfaithful backend and light up on
 * their own if one becomes faithful. End-to-end fidelity against the real
 * Chromium compositor is the golden-frame suite's job — packages/render-tests.
 */

/** A 2D context, or null where the environment provides no rasterizer at all. */
function probeCtx(w: number, h: number): CanvasRenderingContext2D | null {
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c.getContext('2d');
  } catch {
    return null;
  }
}

/** Pixels come back at all — the floor every pixel assertion needs. */
export const hasCanvas: boolean = (() => {
  const c = probeCtx(4, 4);
  if (!c) return false;
  try {
    c.fillRect(0, 0, 2, 2);
    return c.getImageData(0, 0, 4, 4).data.some((v) => v !== 0);
  } catch {
    return false;
  }
})();

/**
 * `globalAlpha` composes correctly under the alpha-algebra operators.
 *
 * Opaque-over-opaque with globalAlpha 0.5: source-in and destination-in must
 * leave alpha ≈128 (As × Ad), destination-out ≈128 (Ad × (1 − As)). A backend
 * that squares the alpha lands on 64 / 191 and fails here.
 */
export const hasFaithfulCompositing: boolean = (() => {
  if (!hasCanvas) return false;
  try {
    for (const [op, expected] of [
      ['source-in', 128],
      ['destination-in', 128],
      ['destination-out', 128],
    ] as const) {
      const dst = probeCtx(8, 8);
      const src = probeCtx(8, 8);
      if (!dst || !src) return false;
      dst.fillStyle = '#ffffff';
      dst.fillRect(0, 0, 8, 8);
      src.fillStyle = '#ffffff';
      src.fillRect(0, 0, 8, 8);
      dst.globalCompositeOperation = op;
      dst.globalAlpha = 0.5;
      dst.drawImage(src.canvas, 0, 0);
      // ±2 absorbs rounding; the failure mode being caught is off by ~64.
      if (Math.abs(dst.getImageData(4, 4, 1, 1).data[3]! - expected) > 2) return false;
    }
    return true;
  } catch {
    return false;
  }
})();

/** `ctx.filter = 'blur(Npx)'` actually blurs, rather than being accepted and ignored. */
export const hasFaithfulFilter: boolean = (() => {
  if (!hasCanvas) return false;
  try {
    const c = probeCtx(60, 60);
    if (!c) return false;
    c.filter = 'blur(8px)';
    c.fillStyle = '#ffffff';
    c.fillRect(20, 20, 20, 20);
    // 6px outside the hard edge: zero unless the blur ran.
    return c.getImageData(14, 30, 1, 1).data[3]! > 0;
  } catch {
    return false;
  }
})();

/** Everything the CPU layer-style chain depends on. */
export const canAssertLayerStylePixels: boolean =
  hasCanvas && hasFaithfulCompositing && hasFaithfulFilter;
