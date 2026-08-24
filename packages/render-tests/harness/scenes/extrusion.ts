/**
 * Extrusion family: does an effect reach the faces the extrusion synthesized?
 *
 * ── Why these are pairs measured by a verifier, not goldens ─────────────────
 *
 * The defect these are built against is REACH, not presence. `buildSnapshot`
 * synthesized a back cap and side walls with `effects: undefined`, so a layer's
 * whole effect stack landed on the front face alone — thirteen of fourteen
 * renderables dropped it. Every symptom of that passes a presence check:
 *
 *   invert   the object visibly changes colour, because the front face is most
 *            of what you see head-on. A golden blessed with the bug in place
 *            certifies "the front face inverted" forever.
 *   DOF      the far object visibly blurs, for the same reason. The frames the
 *            diagnostic compared (DOF on vs off) were byte-identical only
 *            because that scene's subject showed no front face at all — with
 *            one in view, "something blurred" is true and useless.
 *
 * So each scene has a twin differing in exactly one property, and the assertion
 * is about WHICH pixels of the object moved, not whether any did:
 *
 *   ext-fx-invert      what FRACTION of the object's own pixels the effect
 *                      changed. Front-face-only lands near half; every face
 *                      lands near all of them.
 *   ext-dof-wall       how far the blur spreads at the WALL's outer silhouette
 *                      edge — a scanline chosen to miss the front face entirely,
 *                      so a front-face-only blur cannot register at all.
 *
 * Pairing also keeps the perspective projection out of the verifier: whatever
 * the camera does to the solid it does identically to both frames, so the
 * difference is the effect and nothing else.
 */

import { defineScene, node, type Scene } from '../sceneKit';

const COMP = { width: 480, height: 360, background: '#0c0c12' };
const SIZE = { w: 480, h: 360 };
const CENTER = { x: 240, y: 180 };

/** Camera shared by every scene here, matching the rest of the 3D family. */
const CAM = { z: -1000, focalLength: 1000 };

function scene(id: string, description: string, build: Scene['build'], tolerance?: number): Scene {
  return defineScene({
    id,
    description,
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    gpuParity: 'expect-pass',
    // No Canvas2D backend exists to act as an oracle for these (see
    // EffectDef.gpuOnly's note), and the subject is a depth-tested 3D solid
    // — the one thing the deleted backend never drew. GPU is the reference.
    oracle: 'gpu',
    ...(tolerance !== undefined ? { tolerance } : {}),
    build,
  });
}

/**
 * The subject: a rect extruded into a real solid, yawed and pitched so that a
 * side wall, the front face and (at this yaw) nothing else are all in view with
 * clean background on every side.
 *
 * The yaw is what makes the scenes measurable. Head-on, the walls project to
 * zero width and no check can tell a front-face-only effect from a per-face
 * one. At 35° the right-hand wall is several tens of px wide, which is wider
 * than any blur kernel here and wide enough to hold a scanline of its own.
 */
function solid(graph: Parameters<Scene['build']>[0], extra: Record<string, unknown> = {}) {
  graph.addNode(node('solid', {
    kind: 'shape',
    position: CENTER,
    transform: {
      width: 160,
      height: 120,
      shapeType: 'rect',
      extrusionDepth: 120,
      rotationY: 35,
      rotationX: -18,
      z: 0,
      ...extra,
    },
    style: { fill: '#4a7fd0' },
  }));
}

/**
 * Colour reach: `invert` is the cleanest possible probe.
 *
 * It is a colour-matrix effect, so it costs nothing per face and cannot be
 * confused with a spatial one; it moves every channel of every covered pixel by
 * a large, unambiguous amount; and it is idempotent-free, so no face can look
 * unchanged by coincidence. The brief's acceptance wording — "invert turns the
 * whole solid navy, not just the front" — is this scene.
 */
function invertPair(): Scene[] {
  const build = (on: boolean): Scene['build'] => (graph) => {
    solid(graph);
    graph.addNode(node('cam', { kind: 'camera', position: CENTER, transform: CAM }));
    if (on) graph.setEffects('solid', [{ id: 'fx', type: 'invert', params: { amount: 100 } }]);
  };
  return [
    scene('ext-fx-invert', 'Invert on an extruded solid — every face must invert, not just the front.', build(true)),
    scene('ext-fx-invert-off', 'The same solid with no effect — the control the reach is measured against.', build(false)),
  ];
}

/**
 * Depth-of-field reach, measured at the WALL.
 *
 * The subject sits far behind the focus plane, so DOF is a large blur. The
 * front face and the walls carry different depths, so per-face DOF gives each
 * its own radius — which is the whole reason an extruded object reads as
 * spanning depth rather than as a postcard.
 *
 * `dofStrength`/`focusDistance`/`dofAperture` are the same numbers
 * `three-d-dof-extent` uses, so the two scenes' extents are directly
 * comparable and a regression in the DOF model itself moves both.
 */
function dofWallPair(): Scene[] {
  const DOF = { dofStrength: 24, focusDistance: 1000, dofAperture: 40 };
  const build = (dof: boolean): Scene['build'] => (graph) => {
    // Deeper and yawed harder than the invert subject, with no pitch: the wall
    // projects ~140 px wide and its outer edge is vertical, so the verifier can
    // sample wall pixels far enough from the front face that a front-face-only
    // blur cannot bleed into them. At the invert subject's 35°/−18° the wall is
    // ~70 px and the whole of it sits within one blur radius of the front face,
    // which would make "the wall changed" true for the wrong reason.
    solid(graph, { z: 700, width: 140, height: 200, extrusionDepth: 200, rotationY: 45, rotationX: 0 });
    graph.addNode(node('cam', {
      kind: 'camera',
      position: CENTER,
      transform: { ...CAM, ...(dof ? DOF : {}) },
    }));
  };
  return [
    scene('ext-dof-wall', 'Depth of field on an extruded solid — the WALL must blur, not only the front face.', build(true)),
    scene('ext-dof-wall-off', 'The same solid and camera with depth of field off — the sharp control.', build(false)),
  ];
}

/**
 * A rounded card with a bevel — the shape whose front face floated.
 *
 * The rounded-outline branch of `extrusionFaces` returns before the bevel path,
 * so it emits no chamfer ring; `buildSnapshot` nonetheless shrank the front face
 * by `clampBevel(...)` for any rect. The front face therefore met a ring that
 * did not exist, and the darker back cap showed through the ring-shaped gap
 * around it.
 *
 * Single scene, no twin: the failure is not a difference between two renders,
 * it is a hole in one of them. A yaw and a pitch put the gap in view on two
 * sides at once, and the fill is light against a dark comp so the back cap —
 * the thing visible THROUGH the gap, at `EXTRUSION_BACK_GAIN` — reads as an
 * obvious dark band rather than as a shading nuance.
 */
function roundedBevelScene(): Scene {
  return scene(
    'ext-rounded-bevel',
    'A rounded card with a bevel — the front face must fill its own outline, with no ring-shaped gap.',
    (graph) => {
      graph.addNode(node('card', {
        kind: 'shape',
        position: CENTER,
        transform: {
          width: 220,
          height: 150,
          shapeType: 'rect',
          cornerRadius: 28,
          extrusionDepth: 60,
          bevelDepth: 14,
          rotationY: 28,
          rotationX: -16,
          z: 0,
        },
        style: { fill: '#7fb2f0' },
      }));
      graph.addNode(node('cam', { kind: 'camera', position: CENTER, transform: CAM }));
    },
  );
}

/**
 * Deep extruded TEXT — the slice stack must stay solid, not comb.
 *
 * Text and complex shapes extrude as a stack of thin plates sliced along the
 * depth axis, and the stack always spanned the full depth (`sliceStep =
 * extrusionDepth / sliceCount`). What did not scale was the SPACING: the slice
 * count was capped at 45, so past 45 × 1.5 = 67.5 px of depth the plates simply
 * moved further apart — 6.7 px at depth 300, against 1.5 px at depth 40. Yawed,
 * those gaps open into visible stair-stepping along the trailing edge.
 *
 * Both depths are rendered because the shallow one is the control that shows the
 * stack was never broken, only under-sampled — and because a single deep scene
 * would need someone to know what "correct" looks like, whereas the pair makes
 * the claim comparative: at the same yaw, the deep body must be as solid as the
 * shallow one.
 */
function sliceDensityScenes(): Scene[] {
  const build = (depth: number): Scene['build'] => (graph) => {
    graph.addNode(node('t', {
      kind: 'text',
      position: CENTER,
      transform: {
        width: 300, height: 90, text: 'DEPTH', fontSize: 64,
        extrusionDepth: depth,
        // Yawed hard: the gaps between plates project to `step · sin(yaw)`, so
        // a face-on subject cannot show this defect at any spacing.
        rotationY: 40, rotationX: -12, z: 0,
      },
      style: { fill: '#7fb2f0' },
    }));
    graph.addNode(node('cam', { kind: 'camera', position: CENTER, transform: CAM }));
  };
  // Raised tolerance: many thin slice plates × depth-tested AA puts ~1–2% of pixels
  // on glyph fringe rows, and those rows wobble between SwiftShader builds/OSes.
  const sliceTol = 0.025;
  return [
    scene('ext-text-depth-40', 'Extruded text at depth 40 — the shallow control, always solid.', build(40), sliceTol),
    scene('ext-text-depth-300', 'Extruded text at depth 300 — must be as solid as the shallow control, not combed.', build(300), sliceTol),
  ];
}

/**
 * One-sided shading, isolated by mirroring the light's AIM and nothing else.
 *
 * ── Four designs that did not work, and the property that does ──────────────
 *
 * A light emits a comp-sized wash, and it is larger than anything the shading
 * model does. Moving the light between frames changes the wash everywhere
 * (that design reported an identical 2.43x ratio for one-sided and two-sided
 * builds); two boxes in one frame sit under different parts of the gradient;
 * mirroring the box's YAW leaves a mirrored silhouette, so the frames differ by
 * the geometry rather than by the shading.
 *
 * Two properties of the light model make it isolable:
 *
 *   1. The wash renderable is stretched to the light's `2 x radius` box
 *      (`AppTextureProvider`, LIGHT_TEX_SIZE), while a PARALLEL light's shading
 *      ignores radius entirely — the `d >= radius` cutoff is in the point/spot
 *      branch of `shadeLayer`, not the parallel one. A small-radius parallel
 *      light placed off-frame therefore shades at full strength with its wash
 *      outside the viewport.
 *   2. A light's AIM comes from its Point of Interest, and the wash does not
 *      read the POI at all. So mirroring the POI turns the light around while
 *      leaving its position, radius, intensity and wash untouched.
 *
 * So between these two frames the geometry is byte-identical, the light is in
 * the same place, and the wash is the same wash. The ONLY difference is which
 * way the light faces, which flips the visible wall's `dot(N, L)` from +0.77 to
 * −0.77 — exact negatives, which `abs()` cannot tell apart.
 *
 *   TWO-SIDED  the wall is lit the same either way, so the two frames are
 *              IDENTICAL. That is the defect, expressed as an equality.
 *   ONE-SIDED  the wall keeps its gain in one frame and goes to zero in the
 *              other.
 *
 * The FRONT face is the control, and it is inside the scene rather than beside
 * it: it stays two-sided by design, so its gain is 0.401 in both frames. A
 * change that dimmed the whole object — a light that moved, or got weaker —
 * would move the front face too, and this pair would show it.
 */
function oneSidedLightPair(): Scene[] {
  const build = (poiX: number): Scene['build'] => (graph) => {
    graph.addNode(node('box', {
      kind: 'shape',
      position: CENTER,
      transform: {
        width: 120, height: 170, shapeType: 'rect',
        extrusionDepth: 130, rotationY: 40, rotationX: 0, z: 0,
        // Per-fragment shading only runs for a layer that accepts lights.
        acceptsLights: true,
      },
      style: { fill: '#9fb4c8' },
    }));
    graph.addNode(node('L', {
      kind: 'light',
      // Off-frame and small, so the wash cannot reach the subject. Identical in
      // both frames — only the POI below differs.
      position: { x: -400, y: 180 },
      transform: { lightType: 'parallel', intensity: 100, radius: 60, z: 0, poiX, poiY: 180, poiZ: 0 },
      style: { fill: '#ffffff' },
    }));
    graph.addNode(node('cam', { kind: 'camera', position: CENTER, transform: CAM }));
  };
  return [
    scene('ext-lit-toward', 'Extruded box under a parallel light aimed +x — the visible wall faces the light.', build(480)),
    scene('ext-lit-away', 'The same frame with the light AIMED THE OTHER WAY — the wall must go dark, the front face must not.', build(-1280)),
  ];
}

/**
 * Mesh-path subjects — what the quad synthesis could not draw at all.
 *
 * The extrusion body is now ONE mesh with per-vertex normals
 * (core/geometry/extrudeMesh.ts). These scenes exist because the older
 * geometry had no equivalent: a cylinder's wall was twenty flat strips, each
 * lit as its own facet, with a seam at every join; text had no walls, only a
 * stack of plates. Lit from one side, the wall of a cylinder must now shade
 * as a CONTINUOUS gradient around the body, and the walls and chamfer of a
 * glyph must read as surfaces in their own right.
 */
function meshPathScenes(): Scene[] {
  const light = (graph: Parameters<Scene['build']>[0]): void => {
    graph.addNode(node('L', {
      kind: 'light',
      position: { x: -400, y: 120 },
      // A FRONTAL key: the aim is mostly −z (out of the screen) with a little
      // +x/+y rake, so the one-sided fronts and bevels catch it and the walls
      // still grade off — the classic key light an AE scene would carry.
      transform: { lightType: 'parallel', intensity: 100, radius: 60, z: 400, poiX: 340, poiY: 240, poiZ: -500 },
      style: { fill: '#ffffff' },
    }));
    graph.addNode(node('cam', { kind: 'camera', position: CENTER, transform: CAM }));
  };
  return [
    scene('ext-mesh-cylinder', 'A lit extruded ELLIPSE — the wall shades continuously around the body, no facets, no seams.', (graph) => {
      graph.addNode(node('disc', {
        kind: 'shape',
        position: CENTER,
        transform: { width: 180, height: 180, shapeType: 'ellipse', extrusionDepth: 120, rotationY: 55, rotationX: -20, z: 0, acceptsLights: true },
        style: { fill: '#9fb4c8' },
      }));
      light(graph);
    }),
    scene('ext-mesh-text-bevel', 'Lit extruded TEXT with a convex bevel — real side walls and a rounded chamfer per glyph.', (graph) => {
      // A REAL text node (Text component), so the outline reader finds its
      // content and the mesh path traces it — a bare transform `text` prop
      // renders the placeholder string through the plate-stack fallback.
      graph.addNode(node('t', {
        kind: 'text',
        position: CENTER,
        transform: {
          extrusionDepth: 50, bevelDepth: 6, bevelStyle: 'convex',
          rotationY: 30, rotationX: -14, z: 0, acceptsLights: true,
        },
        components: [{
          id: 't_text',
          type: 'Text',
          props: { content: 'MESH', fontSize: 84, fontWeight: 700, opacity: 100, fontFamily: 'Arial', align: 'center', fill: '#7fb2f0' },
        }],
      }));
      light(graph);
    }, 0.04), // Arial outlines + bevel AA drift ~3.5% across OS/SwiftShader; 2.5% is too tight.
    scene('ext-mesh-rounded-concave', 'A lit rounded card with a CONCAVE bevel — the cove catches the light along the rim.', (graph) => {
      graph.addNode(node('card', {
        kind: 'shape',
        position: CENTER,
        transform: { width: 220, height: 150, shapeType: 'rect', cornerRadius: 30, extrusionDepth: 60, bevelDepth: 12, bevelStyle: 'concave', rotationY: 28, rotationX: -16, z: 0, acceptsLights: true },
        style: { fill: '#7fb2f0' },
      }));
      light(graph);
    }),
  ];
}

export const extrusionScenes: Scene[] = [
  ...invertPair(),
  ...dofWallPair(),
  roundedBevelScene(),
  ...sliceDensityScenes(),
  ...oneSidedLightPair(),
  ...meshPathScenes(),
];
