/**
 * Alpha interpretation, and the 3D layer-style paths that shipped ungated.
 *
 * ## Why these exist
 *
 * Premultiplied-alpha interpretation shipped across two sessions without anyone
 * looking at its output. Unit tests proved the flag reaches the FrameScene and
 * that the shader variants are derived correctly, but "the right shader was
 * selected" is not "the pixels are right" — and there was no working path to
 * look. These scenes are that path: they render through the production
 * pipeline, write openable PNGs, and are measured by
 * scripts/verify-alpha.mjs, which asserts the invariants below rather than
 * diffing a blessed image. That script gates every run against the WebGPU
 * actuals (see SEMANTIC_GATE_BACKEND in scripts/run.mjs) — when this comment
 * was first written it named a file that did not exist yet.
 *
 * ## The subject, and why it is a LINEAR ramp
 *
 * Every alpha scene draws the same thing: a white square whose alpha ramps
 * linearly left (0) to right (1), stored PREMULTIPLIED — so its RGB equals its
 * alpha. Alpha varies only along x, which means a verifier can average whole
 * columns to beat 8-bit quantisation, and one variable moves at a time.
 *
 * That geometry turns the correctness question into a shape, not a threshold:
 *
 *   interpreted correctly  out = 255·a + bg·(1−a)   — LINEAR in alpha
 *   interpreted as straight out = 255·a² + bg·(1−a) — QUADRATIC in alpha
 *
 * The wrong reading multiplies by alpha a second time, so its curve sags below
 * the straight line everywhere between the endpoints, and meets it exactly at
 * a = 0 and a = 1. That sag IS the dark fringe. Fitting the curve is a far
 * stronger check than comparing a reference pixel, and it says WHICH way it is
 * wrong when it fails.
 *
 * Proven by: scripts/verify-alpha.mjs (`premultiplied is linear in alpha`,
 * `straight is measurably quadratic`). Shader derivation is proven separately
 * by packages/renderer/src/__tests__/premultipliedAlpha.test.ts, and the
 * flag's route through the snapshot by src/core/rendering/alphaInterpretation.test.ts.
 */

import { defineScene, node, type Scene } from '../sceneKit';
import { useAssetStore } from '@stores/assetStore';

/** Backgrounds chosen so a dark fringe is obvious against them. */
const LIGHT = '#e8e8e8';
const MID = '#808080';
const DARK = '#101014';

const SUB = 240; // subject edge length, px
const W = 320;
const H = 240;

/**
 * A white square, alpha ramping linearly across x, stored PREMULTIPLIED.
 *
 * Built here rather than committed as a binary so the exact pixel values are
 * visible in source and cannot drift: at every column, r = g = b = a.
 *
 * The ramp deliberately reaches BOTH endpoints. a = 0 exercises the shader's
 * sub-quantum threshold (below one 8-bit alpha step the divide would otherwise
 * multiply noise by 255), and a = 1 is the control where both interpretations
 * must agree exactly.
 */
function premultipliedRampDataUrl(size = SUB): string {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const a = Math.round((x / (size - 1)) * 255);
      // Premultiplied white: colour (255,255,255) × alpha ⇒ every channel = a.
      img.data[i] = a;
      img.data[i + 1] = a;
      img.data[i + 2] = a;
      img.data[i + 3] = a;
    }
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/**
 * Register the ramp as an asset under `assetId` with the given interpretation.
 *
 * Interpretation lives on the ASSET (it is a statement about the file), so a
 * scene sets it by registering its own asset rather than by touching the layer.
 * Each scene uses its own id so scenes cannot leak state into one another —
 * they share one global store and run in sequence.
 */
function registerRamp(assetId: string, alpha: 'straight' | 'premultiplied', src: string): void {
  const prev = useAssetStore.getState().assets.filter((a) => a.id !== assetId);
  useAssetStore.setState({
    assets: [
      ...prev,
      {
        id: assetId,
        type: 'image',
        src,
        metadata: { width: SUB, height: SUB, hasAlpha: true },
        interpret: { alpha },
      },
    ] as never,
  });
}

/** One alpha scene: the ramp over `bg`, read as `alpha`, with optional 3D/extrusion. */
function alphaScene(
  id: string,
  description: string,
  alpha: 'straight' | 'premultiplied',
  bg: string,
  extra: Record<string, unknown> = {},
): Scene {
  return defineScene({
    id,
    description,
    size: { w: W, h: H },
    comp: { width: W, height: H, background: bg },
    fps: 30,
    frames: [0],
    // GPU-native: the premultiplied variants are shader-side, so Canvas2D is not
    // a meaningful oracle for them.
    oracle: 'gpu',
    build: (graph) => {
      const src = premultipliedRampDataUrl();
      const assetId = `${id}-asset`;
      registerRamp(assetId, alpha, src);
      graph.addNode(
        node('subject', {
          kind: 'image',
          position: { x: W / 2, y: H / 2 },
          transform: { width: SUB, height: SUB, src, assetId, __assetId: assetId, ...extra },
          style: { opacity: 100 },
        }),
      );
    },
  });
}

/**
 * A STRAIGHT-alpha ramp: constant white RGB, alpha ramping across x.
 *
 * The premultiplied ramp cannot distinguish "the file is premultiplied" from
 * "the upload premultiplied it", because rgb == alpha either way. Here rgb is
 * constant 255 while alpha ramps, so the two hypotheses predict different
 * curves and one render separates them.
 */
function straightRampDataUrl(size = SUB): string {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const a = Math.round((x / (size - 1)) * 255);
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = a;
    }
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/**
 * A tiny hard-edged source, drawn MAGNIFIED so bilinear filtering dominates.
 *
 * This is the scene that measures what the straight-alpha invariant costs, and
 * the ramp scenes cannot do it: their source is constant white, so averaging a
 * transparent texel with an opaque one in straight space averages white with
 * white and no artifact can appear. Here the opaque half is saturated RED and
 * the transparent half is (0,0,0,0) — the state every canvas-rasterized source
 * has, because a 2D canvas stores premultiplied and zeroes RGB at zero alpha.
 *
 * Magnified 30×, one texel spans ~30 screen px, so the interpolated band is
 * wide enough to sample away from both endpoints.
 *
 *   filtered in PREMULTIPLIED space  edge stays red, fades to the background
 *   filtered in STRAIGHT space       RGB averages red→BLACK while alpha fades,
 *                                    so the shader's out = rgb·a darkens twice
 *                                    over — the classic dark halo
 *
 * Both readings agree at the two endpoints and differ only in between, so this
 * is the same "correctness as a shape" test as the ramp, on the axis the ramp
 * is blind to.
 */
function hardEdgeDataUrl(): string {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 8;
  const g = c.getContext('2d')!;
  // Left half opaque red, right half untouched — i.e. (0,0,0,0).
  g.fillStyle = '#ff0000';
  g.fillRect(0, 0, 4, 8);
  return c.toDataURL('image/png');
}

/**
 * The magnified hard edge over a light background.
 *
 * Registered as STRAIGHT (the default and the invariant), because the question
 * is what the SHIPPING configuration costs — not what an opt-in setting can
 * recover.
 */
function softEdgeFilterScene(): Scene {
  return defineScene({
    id: 'alpha-filter-hard-edge',
    description: 'Magnified hard alpha edge — measures the filtering cost of the straight invariant.',
    size: { w: W, h: H },
    comp: { width: W, height: H, background: LIGHT },
    fps: 30, frames: [0], oracle: 'gpu',
    build: (graph) => {
      const src = hardEdgeDataUrl();
      const assetId = 'alpha-filter-hard-edge-asset';
      const prev = useAssetStore.getState().assets.filter((a) => a.id !== assetId);
      useAssetStore.setState({
        assets: [...prev, {
          id: assetId, type: 'image', src,
          metadata: { width: 8, height: 8, hasAlpha: true },
          interpret: { alpha: 'straight' },
        }] as never,
      });
      graph.addNode(node('subject', {
        kind: 'image',
        position: { x: W / 2, y: H / 2 },
        transform: { width: 240, height: 240, src, assetId, __assetId: assetId },
        style: { opacity: 100 },
      }));
    },
  });
}

/** 3D marker props — a numeric z/rotationX/rotationY is what is3DEnabled tests. */
const THREE_D = { z: 0, rotationX: 0, rotationY: 0 };

/** The straight-source control (see straightRampDataUrl). */
function straightControlScene(id: string, description: string, alpha: 'straight' | 'premultiplied'): Scene {
  return defineScene({
    id, description,
    size: { w: W, h: H },
    comp: { width: W, height: H, background: LIGHT },
    fps: 30, frames: [0], oracle: 'gpu',
    build: (graph) => {
      const src = straightRampDataUrl();
      const assetId = `${id}-asset`;
      registerRamp(assetId, alpha, src);
      graph.addNode(node('subject', {
        kind: 'image',
        position: { x: W / 2, y: H / 2 },
        transform: { width: SUB, height: SUB, src, assetId, __assetId: assetId },
        style: { opacity: 100 },
      }));
    },
  });
}

export const alphaInterpScenes: Scene[] = [
  // 6 — what the invariant COSTS. See softEdgeFilterScene: the ramp scenes are
  //     structurally blind to filtering artifacts, so this is the only scene
  //     that can price the straight-vs-premultiplied choice.
  softEdgeFilterScene(),

  // 0 — the control that tells us what the UPLOAD does. A genuinely straight
  //     source read as straight must composite LINEARLY in alpha. If it comes
  //     out quadratic, the texture was premultiplied before the shader saw it
  //     and every straight-alpha asset is being multiplied twice.
  straightControlScene('alpha-control-straight-src', 'Straight-alpha source read as straight — must be linear.', 'straight'),
  straightControlScene('alpha-control-straight-src-premul', 'Straight-alpha source misread as premultiplied.', 'premultiplied'),

  // 1 — the headline case. A dark fringe on a light background is the symptom
  //     the whole feature exists to remove.
  alphaScene('alpha-light-premul', 'Premultiplied ramp read correctly, light background.', 'premultiplied', LIGHT),
  alphaScene('alpha-light-straight', 'Same ramp misread as straight — the double multiply.', 'straight', LIGHT),

  // 2 — mid-grey. The sag is smaller here but still one-directional, which
  //     rules out "it only works against white".
  alphaScene('alpha-grey-premul', 'Premultiplied ramp read correctly, mid-grey background.', 'premultiplied', MID),
  alphaScene('alpha-grey-straight', 'Same ramp misread as straight, mid-grey background.', 'straight', MID),

  // 3 — the low-alpha end over a DARK background, where the divide is most
  //     dangerous: at a = 1/255 an unguarded un-premultiply multiplies
  //     quantisation noise by 255. Dark makes specks obvious rather than
  //     washed out.
  alphaScene('alpha-softedge-premul', 'Near-zero alpha over dark — threshold and clamp territory.', 'premultiplied', DARK),
  alphaScene('alpha-softedge-straight', 'Near-zero alpha over dark, read as straight.', 'straight', DARK),

  // 4 — a 3D layer. Textured3D is one of the six families that double-multiply,
  //     so the flag has to survive the depth-tested path.
  alphaScene('alpha-3d-premul', 'Premultiplied ramp on a 3D layer.', 'premultiplied', LIGHT, THREE_D),
  alphaScene('alpha-3d-straight', 'Ramp on a 3D layer, read as straight.', 'straight', LIGHT, THREE_D),

  // 5 — extruded. The side walls are flat-filled geometry with no texture, but
  //     the front face AND the back cap both sample the image. The back cap
  //     silently losing the flag would fringe the back of an object only, which
  //     reads as a lighting artefact rather than an alpha bug.
  alphaScene('alpha-extruded-premul', 'Premultiplied ramp on an extruded layer (front + back cap).', 'premultiplied', LIGHT, {
    ...THREE_D,
    rotationY: 28,
    extrusionDepth: 40,
  }),
  alphaScene('alpha-extruded-straight', 'Extruded layer read as straight.', 'straight', LIGHT, {
    ...THREE_D,
    rotationY: 28,
    extrusionDepth: 40,
  }),
];
