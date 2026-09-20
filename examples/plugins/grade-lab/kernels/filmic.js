/**
 * Grade Lab's CPU twin.
 *
 * The GPU shader is what runs normally. This exists so the effect survives a
 * BAKE — a mask-scoped effect beside it, fill opacity, a path-following style
 * — which drops the layer's GPU effect list wholesale. Without a twin the
 * grade would silently vanish from that layer only.
 *
 * ── What it demonstrates ────────────────────────────────────────────────────
 *
 * The lookup table is the point. Building it is the expensive part and it
 * depends on `quality` and nothing else, so it is built ONCE and kept — which
 * is what the manifest's `invalidateOn: ["quality"]` tells the host.
 *
 * In the sandboxed tier that cache is just a module-level variable, as below.
 * A NATIVE addon does the same thing through the host's sequence data: return
 * the table as `state`, get it back next frame, and let the host throw it away
 * when `quality` changes. Same idea, one across a process boundary.
 */

/** The table, and what it was built for. Rebuilt only when that changes. */
let table = null;
let builtFor = -1;

function buildTable(quality) {
  // Steps scale with quality: the cheap setting quantises the curve harder.
  const steps = 32 * Math.max(1, Math.round(quality));
  const out = new Float32Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const x = i / steps;
    // A soft shoulder — the shape is not the point, the caching is.
    out[i] = x <= 0 ? 0 : Math.pow(x, 1 / 1.18);
  }
  return out;
}

exports.render = function render(input, output, params) {
  const quality = Number(params.quality ?? 2);
  if (!table || builtFor !== quality) {
    table = buildTable(quality);
    builtFor = quality;
  }

  const strength = Number(params.strength ?? 1);
  const lift = Number(params.lift ?? 0);
  const gain = Number(params.gain ?? 1);
  const last = table.length - 1;

  for (let i = 0; i + 3 < input.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = input[i + c] / 255;
      const shaped = table[Math.round(v * last)];
      const graded = (shaped + lift * (1 - shaped)) * gain;
      output[i + c] = Math.max(0, Math.min(255, (v + (graded - v) * strength) * 255));
    }
    output[i + 3] = input[i + 3];
  }
};
