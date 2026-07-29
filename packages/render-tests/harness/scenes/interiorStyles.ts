/**
 * Interior layer styles + fill opacity.
 *
 * These exist because the equivalent unit tests CANNOT run anywhere else. They
 * assert alpha algebra (source-in / destination-in / destination-out at a
 * fractional globalAlpha) over a blurred silhouette, and both headless
 * rasterizers get one half of that wrong — @napi-rs/canvas doubles globalAlpha
 * on those three operators, node-canvas accepts `ctx.filter` and silently
 * ignores it. Either produces wrong pixels that still satisfy a relational
 * assertion, so the jest copies are guarded off (see
 * src/core/effects/__testHelpers__/canvasFidelity.ts) and the real compositor
 * here is the only faithful host.
 *
 * Subject is a centred opaque rounded rect on a dark comp — an alpha edge for
 * the interior work and a large flat middle for the "leaves the centre alone"
 * case. All styles pin `useGlobalLight: false` so the render does not depend on
 * the comp's global light, which is animatable and would make these
 * non-deterministic.
 *
 * The two "is a no-op" assertions are expressed as `fidelityTwin` pairs against
 * an unstyled twin rather than as blessed pixels: a golden PNG can only say
 * "unchanged since blessing", whereas the twin says "identical to the layer
 * without the style", which is the actual claim.
 */

import { defineScene, node, type Scene } from '../sceneKit';

const COMP = { width: 320, height: 220, background: '#0c0c12' };
const SIZE = { w: 320, h: 220 };

type Build = Scene['build'];
type Graph = Parameters<Build>[0];

/** The subject under test: centred opaque rounded rect. */
function subject(graph: Graph, opts: { fillOpacity?: number } = {}): void {
  graph.addNode(node('s', {
    kind: 'shape',
    position: { x: 160, y: 110 },
    transform: { width: 170, height: 130, shapeType: 'rect', cornerRadius: 16 },
    style: {
      fill: '#3080ff',
      ...(opts.fillOpacity !== undefined ? { fillOpacity: opts.fillOpacity } : {}),
    },
  }));
}

/**
 * A small unstyled marker in the corner, present in every fill-opacity scene.
 * Without it, "fill opacity 0 erases the contents" blesses an empty frame — and
 * an empty frame is also what a total render failure produces. The marker makes
 * the reference distinguish "the subject was erased" from "nothing drew".
 */
function marker(graph: Graph): void {
  graph.addNode(node('mk', {
    kind: 'shape',
    position: { x: 40, y: 40 },
    transform: { width: 28, height: 28, shapeType: 'rect' },
    style: { fill: '#ffd070' },
  }));
}

function scene(
  id: string,
  description: string,
  build: Build,
  extra: Partial<Scene> = {},
): Scene {
  return defineScene({ id, description, size: SIZE, comp: COMP, fps: 30, frames: [0], build, ...extra });
}

export const interiorStyleScenes: Scene[] = [
  // ── Twin oracles ─────────────────────────────────────────────────
  scene('interior-unstyled', 'Bare subject — the twin oracle for the no-op cases.', (graph) => {
    subject(graph);
  }, { fidelityOnly: true }),

  scene('fill-opacity-unstyled', 'Bare subject + marker — twin oracle for fill opacity 1.', (graph) => {
    subject(graph);
    marker(graph);
  }, { fidelityOnly: true }),

  // ── Interior styles ──────────────────────────────────────────────
  //
  // Covers three unit assertions at once: nothing is added outside the
  // silhouette (the corners stay comp background), the inside edge darkens, and
  // the centre of a large shape is essentially untouched.
  scene('interior-inner-shadow', 'Inner shadow — darkens the inside edge, adds nothing outside it.', (graph) => {
    subject(graph);
    graph.setLayerStyles('s', {
      innerShadow: {
        enabled: true, color: '#000000', opacity: 1,
        distance: 6, angle: 135, size: 10, useGlobalLight: false,
      },
    });
  }),

  scene('interior-inner-glow', 'Inner glow — LIGHTENS the inside edge rather than darkening it.', (graph) => {
    subject(graph);
    graph.setLayerStyles('s', {
      innerGlow: { enabled: true, color: '#ffffff', opacity: 1, size: 12 },
    });
  }),

  scene('interior-satin', 'Satin — interior sheen from the offset set algebra.', (graph) => {
    subject(graph);
    graph.setLayerStyles('s', {
      satin: {
        enabled: true, color: '#00204a', opacity: 0.8,
        distance: 14, angle: 135, size: 16, invert: false,
      },
    });
  }),

  // The only style that SHADES rather than composites, and the one the audit
  // measures at 101 ms/frame at 1080p. Pinning it here is what lets the pending
  // performance work (working-buffer cap, or a shader port) be verified against
  // something instead of by eye — the downscale attempt was reverted precisely
  // because there was no gate for it.
  scene('interior-bevel', 'Bevel & emboss — alpha height field lit at a fixed angle/altitude.', (graph) => {
    subject(graph);
    graph.setLayerStyles('s', {
      bevel: {
        enabled: true, size: 12, depth: 100, direction: 'up',
        angle: 135, altitude: 45,
        highlightColor: '#ffffff', highlightOpacity: 0.75,
        shadowColor: '#000000', shadowOpacity: 0.75,
        useGlobalLight: false,
      },
    });
  }),

  scene('interior-inner-shadow-zero-opacity', 'Inner shadow at opacity 0 is a no-op.', (graph) => {
    subject(graph);
    graph.setLayerStyles('s', {
      innerShadow: {
        enabled: true, color: '#000000', opacity: 0,
        distance: 6, angle: 135, size: 10, useGlobalLight: false,
      },
    });
  }, { fidelityTwin: 'interior-unstyled', fidelityTolerance: 0 }),

  // ── Fill opacity ─────────────────────────────────────────────────
  scene('fill-opacity-full', 'Fill opacity 100 changes nothing — must equal the unstyled layer.', (graph) => {
    subject(graph, { fillOpacity: 100 });
    marker(graph);
  }, { fidelityTwin: 'fill-opacity-unstyled', fidelityTolerance: 0 }),

  scene('fill-opacity-half', 'Fill opacity 50 fades the layer’s own pixels.', (graph) => {
    subject(graph, { fillOpacity: 50 });
    marker(graph);
  }),

  scene('fill-opacity-zero', 'Fill opacity 0 erases the contents; the unstyled marker proves the frame drew.', (graph) => {
    subject(graph, { fillOpacity: 0 });
    marker(graph);
  }),

  // Photoshop's rule: fill opacity fades the layer's own fill and leaves its
  // EFFECTS at full strength. Interior styles used to fade with the contents,
  // because the old implementation ran the chain at full alpha and subtracted the
  // contents back out — which took the interior styles with it. At fill 0 this
  // scene is the whole claim in one frame: the fill is gone, the inner shadow is
  // still there at full strength, floating on nothing.
  scene('fill-opacity-zero-inner-shadow', 'Fill opacity 0 + inner shadow — the style survives the fade.', (graph) => {
    subject(graph, { fillOpacity: 0 });
    marker(graph);
    graph.setLayerStyles('s', {
      innerShadow: {
        // Deliberately large and bright: the claim is 'the style is still here at
        // full strength', and a subtle band over a dark comp cannot carry it.
        enabled: true, color: '#ff2d55', opacity: 1,
        distance: 0, angle: 135, size: 40, useGlobalLight: false,
      },
    });
  }),

  // ── Bevel working-buffer parity ──────────────────────────────────
  //
  // The bevel computes its shading on a buffer capped at 640px on the long side,
  // which makes its cost constant instead of resolution-proportional. One of
  // these scenes sits below that cap and the other above it, so between them they
  // hold a committed reference for both code paths.
  //
  // THEY ARE NOT A PROFILE COMPARISON, and must not be read as one. The bevel
  // takes its normal from a per-pixel slope, so doubling the geometry AND the
  // bevel size together genuinely halves the shading: the 2× scene is a weaker
  // bevel by construction, not by defect. Measured — amplitude tracks depth/size,
  // linearly in depth until the highlight clamps — which is the same model
  // Photoshop uses, where a larger Size at constant Depth is a softer bevel.
  // Comparing these two profiles therefore measures the algorithm's legitimate
  // scale-dependence, not the working buffer, and "the large one is flatter" is
  // the CORRECT result.
  //
  // An earlier version of this comment claimed verify-interior.mjs compares the
  // two profiles at relative coordinates. It does not, and deliberately does not
  // — see the note above the both-resolutions checks in that file. The claim cost
  // a false defect report and a needless revert of these very references, so it
  // is corrected rather than softened.
  //
  // THE CAP'S ACTUAL GATE IS src/core/effects/bevelWorkingBuffer.test.ts, which
  // runs the SAME input through both paths and asserts the capped profile tracks
  // the full-resolution one. That is the test that would catch the flat-shading
  // regression the previous attempt shipped; these scenes would not.
  scene('bevel-below-cap', 'Bevel below the working-buffer cap — computed at full resolution.', (graph) => {
    graph.addNode(node('s', {
      kind: 'shape',
      position: { x: 320, y: 240 },
      transform: { width: 600, height: 440, shapeType: 'rect' },
      style: { fill: '#3080ff' },
    }));
    graph.setLayerStyles('s', {
      bevel: {
        enabled: true, size: 30, depth: 100, direction: 'up',
        angle: 135, altitude: 45,
        highlightColor: '#ffffff', highlightOpacity: 0.75,
        shadowColor: '#000000', shadowOpacity: 0.75,
        useGlobalLight: false,
      },
    });
  }, { size: { w: 640, h: 480 }, comp: { width: 640, height: 480, background: '#0c0c12' } }),

  scene('bevel-above-cap', 'Same bevel at 2× — computed on the capped buffer and upsampled.', (graph) => {
    graph.addNode(node('s', {
      kind: 'shape',
      position: { x: 640, y: 480 },
      transform: { width: 1200, height: 880, shapeType: 'rect' },
      style: { fill: '#3080ff' },
    }));
    graph.setLayerStyles('s', {
      bevel: {
        enabled: true, size: 60, depth: 100, direction: 'up',
        angle: 135, altitude: 45,
        highlightColor: '#ffffff', highlightOpacity: 0.75,
        shadowColor: '#000000', shadowOpacity: 0.75,
        useGlobalLight: false,
      },
    });
  }, { size: { w: 1280, h: 960 }, comp: { width: 1280, height: 960, background: '#0c0c12' } }),

  // The floating-shadow case: the stroke is generated from the FULL-alpha
  // silhouette and sits outside it, so subtracting the contents leaves the ring
  // behind. If the subtraction ever took the styles with it, this goes empty.
  scene('fill-opacity-zero-stroke', 'Fill opacity 0 with a stroke style — contents gone, ring survives.', (graph) => {
    subject(graph, { fillOpacity: 0 });
    marker(graph);
    graph.setLayerStyles('s', {
      stroke: { enabled: true, color: '#ff2d55', opacity: 1, size: 6 },
    });
  }),
];
