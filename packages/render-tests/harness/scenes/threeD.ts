/**
 * 3D family: perspective layers, camera, light types, depth of field.
 * A layer becomes 3D when it carries z / rotationX / rotationY on its Transform.
 */

import { defineScene, node, type Scene } from '../sceneKit';

const COMP = { width: 480, height: 360, background: '#0c0c12' };
const SIZE = { w: 480, h: 360 };
const CENTER = { x: 240, y: 180 };

function scene(id: string, description: string, build: Scene['build'], gpuParity: Scene['gpuParity'] = 'expect-pass'): Scene {
  return defineScene({ id, description, size: SIZE, comp: COMP, fps: 30, frames: [0], gpuParity, build });
}

/** A large flat panel used as a 3D surface. */
function panel(graph: Parameters<Scene['build']>[0], id: string, extraTransform: Record<string, unknown>, fill = '#4a7fd0') {
  graph.addNode(node(id, { kind: 'shape', position: CENTER, transform: { width: 240, height: 180, shapeType: 'rect', ...extraTransform }, style: { fill } }));
}

function light(graph: Parameters<Scene['build']>[0], id: string, props: Record<string, unknown>, color: string) {
  graph.addNode(node(id, { kind: 'light', position: CENTER, transform: props, style: { fill: color } }));
}

/**
 * A 3D panel plus its style-off control, as a matched pair.
 *
 * Same geometry, same camera, same everything but the layer style — so
 * subtracting one frame from the other isolates exactly the style's
 * contribution, with no model of the perspective projection needed in the
 * verifier. The control carries `-off` and is not itself interesting; it is
 * committed as a reference so a change to the PANEL shows up as its own
 * failure rather than silently moving the baseline the pair is measured against.
 */
function styleOn3dPair(id: string, description: string, styles: Record<string, unknown>): Scene[] {
  // Off-centre and modest, so every side has background for the style to reach
  // and no edge of the frame can clip the thing being measured.
  const place = { position: { x: 200, y: 155 }, size: { width: 170, height: 120 } };
  const build = (withStyles: boolean): Scene['build'] => (graph) => {
    graph.addNode(node('p', {
      kind: 'shape',
      position: place.position,
      transform: { ...place.size, shapeType: 'rect', z: 0, rotationX: 12, rotationY: 24 },
      style: { fill: '#4a7fd0' },
    }));
    graph.addNode(node('cam', { kind: 'camera', position: CENTER, transform: { z: -1000, focalLength: 1000 } }));
    if (withStyles) graph.setLayerStyles('p', styles);
  };
  return [
    scene(id, description, build(true)),
    scene(`${id}-off`, `${description.split('—')[0].trim()} — control, style disabled.`, build(false)),
  ];
}

/**
 * A far panel with a hard edge, with and without depth of field.
 *
 * The panel is deliberately NOT centred on the focus distance: the camera
 * focuses at z = 0 and the panel sits at z = 700, so it is far out of focus and
 * the blur is at its widest — a small radius error is a large relative error in
 * the measured band, which is the point.
 */
function dofExtentPair(): Scene[] {
  const CAM = { z: -1000, focalLength: 1000 };
  const DOF = { dofStrength: 24, focusDistance: 1000, dofAperture: 40 };
  const build = (dof: boolean): Scene['build'] => (graph) => {
    graph.addNode(node('far', {
      kind: 'shape',
      // Centred so both vertical edges are well inside the frame with clean
      // background either side — the verifier scans a row through the middle.
      position: CENTER,
      transform: { width: 200, height: 200, shapeType: 'rect', z: 700 },
      style: { fill: '#d05a7f' },
    }));
    graph.addNode(node('cam', { kind: 'camera', position: CENTER, transform: { ...CAM, ...(dof ? DOF : {}) } }));
  };
  return [
    scene('three-d-dof-extent', 'Depth of field on a far 3D panel — measured by blur EXTENT, not presence.', build(true)),
    scene('three-d-dof-extent-off', 'Same panel and camera with depth of field disabled — the sharp control.', build(false)),
  ];
}

export const threeDScenes: Scene[] = [
  scene('three-d-rotated', 'Layer rotated in 3D (rotationY) — perspective foreshortening.', (graph) => {
    panel(graph, 'p', { z: 0, rotationY: 45 });
  }),

  scene('three-d-camera', 'Camera with focal length viewing a rotated 3D layer.', (graph) => {
    panel(graph, 'p', { z: 120, rotationY: 35, rotationX: 15 });
    graph.addNode(node('cam', { kind: 'camera', position: CENTER, transform: { z: -1000, focalLength: 1000 } }));
  }),

  scene('three-d-dof', 'Depth of field: near panel sharp, far panel blurred.', (graph) => {
    panel(graph, 'far', { z: 600 }, '#d05a7f');
    panel(graph, 'near', { z: 0 }, '#4ad0a0');
    graph.addNode(node('cam', { kind: 'camera', position: CENTER, transform: { z: -1000, focalLength: 1000, dofStrength: 24, focusDistance: 1000, dofAperture: 40 } }));
  }),

  // The original three-d-dof's far panel is fully occluded by the near one
  // (perspective shrinks it behind the sharp panel), so its blur never reaches
  // a visible pixel. Here the far panel is offset so its blurred edges show.
  // No committed reference yet — bless with `--update three-d-dof-visible`
  // after a human confirms the far panel is actually blurred.
  scene('three-d-dof-visible', 'Depth of field with the far (blurred) panel visibly offset.', (graph) => {
    graph.addNode(node('far', { kind: 'shape', position: { x: 120, y: 100 }, transform: { width: 240, height: 180, shapeType: 'rect', z: 600 }, style: { fill: '#d05a7f' } }));
    graph.addNode(node('near', { kind: 'shape', position: { x: 330, y: 250 }, transform: { width: 180, height: 130, shapeType: 'rect', z: 0 }, style: { fill: '#4ad0a0' } }));
    graph.addNode(node('cam', { kind: 'camera', position: CENTER, transform: { z: -1000, focalLength: 1000, dofStrength: 24, focusDistance: 1000, dofAperture: 40 } }));
  }, 'known-divergent'),

  scene('light-point', 'Point light on a 3D panel.', (graph) => {
    panel(graph, 'p', { z: 0, rotationX: 10 }, '#c9c9d6');
    light(graph, 'L', { z: -200, intensity: 90, radius: 320, lightType: 'point' }, '#ffcc55');
  }),

  scene('light-spot', 'Spot light on a 3D panel.', (graph) => {
    panel(graph, 'p', { z: 0 }, '#c9c9d6');
    light(graph, 'L', { z: -300, intensity: 100, radius: 400, lightType: 'spot', lightAngle: 90, lightCone: 32 }, '#88d0ff');
  }, 'known-divergent'),

  scene('light-ambient', 'Ambient light tint on a 3D panel.', (graph) => {
    panel(graph, 'p', { z: 0, rotationX: 5 }, '#9098b0');
    light(graph, 'L', { intensity: 70, lightType: 'ambient' }, '#ff88aa');
  }, 'known-divergent'),

  // 2.5D light-cast shadow: a shadow-casting point light above-left of a small
  // panel throws a soft drop-shadow down-right (away from the light). No
  // committed reference yet — bless with `--update light-cast-shadow` after a
  // human eyeballs the shadow. Exercises buildSnapshot's cast-shadow → GPU
  // drop-shadow effect path (previously CSS-filter-only, i.e. rendered nothing).
  scene('light-cast-shadow', 'Point light with castShadows throws a drop-shadow off a panel.', (graph) => {
    // Bright backdrop (castsShadows: false) so the 45%-black shadow is plainly
    // visible — over the default near-black comp bg it vanished under the glow.
    graph.addNode(node('bg', { kind: 'shape', position: CENTER, transform: { width: 480, height: 360, shapeType: 'rect', castsShadows: false }, style: { fill: '#c8ccd8' } }));
    graph.addNode(node('p', { kind: 'shape', position: { x: 260, y: 200 }, transform: { width: 140, height: 100, shapeType: 'rect' }, style: { fill: '#4ad0a0' } }));
    light(graph, 'L', { z: -200, intensity: 100, radius: 320, lightType: 'point', castShadows: true }, '#ffcc55');
  }, 'known-divergent'),

  // ── layer styles ON 3D LAYERS ──────────────────────────────────────
  //
  // These three exist because the paths they cover rendered NOTHING before
  // 1a32ab6 ("make layer styles work on 3D and extruded layers"). A scene that
  // merely proves pixels appeared would have passed the moment the fix landed
  // and then never said anything again — and would have passed just as happily
  // on a shadow at the wrong offset or a glow one pixel wide.
  //
  // So each one is built to be measured by DIRECTION or by EXTENT, and each
  // ships with a control twin rendering the same geometry with the style off.
  // The style's contribution is then the DIFFERENCE between the pair, which is
  // what verify-3d-styles.mjs measures. A pair also removes the need to model
  // 3D projection in the verifier: whatever perspective does to the panel, it
  // does to both frames identically.
  //
  // The subject sits off-centre and small, so there is background on every side
  // for the style to spread into and an occluded direction cannot hide a defect.
  ...styleOn3dPair(
    'three-d-drop-shadow',
    'Drop shadow on a 3D layer — offset DOWN-RIGHT of the panel, nowhere else.',
    { dropShadow: { enabled: true, color: '#000000', opacity: 0.9, distance: 26, angle: 45, blur: 6, useGlobalLight: false } },
  ),
  // DELIBERATELY UNBLESSED — this one FAILS, and the failure is the point.
  //
  // Measured on its first run: the ring outside the silhouette comes out
  // DARKER than the background, not brighter. Along y=155 the delta ramps
  // 0 → −4 levels approaching the panel edge and the composite tracks
  // `bg·(1−a)` — i.e. the glow is being drawn BLACK. Its geometry is right
  // (the falloff extends ~25 px, matching size 22) and only its colour is
  // wrong, on all four sides equally.
  //
  // Not confined to 3D. On the 2D `layer-styles` scene a #78b4ff glow over an
  // #ff8a3d layer brightens toward ORANGE (14,13,19 → 32,28,27 approaching the
  // edge) rather than toward blue: outer glow spreads the layer's own COLOUR
  // instead of filling the blurred alpha with the glow colour. On a light layer
  // that passes for a glow; on a saturated one it is visibly the wrong hue, and
  // on the near-black 3D comp it collapses to a dark halo.
  //
  // Why it survived: the only other coverage is `layer-styles`, which enables a
  // drop shadow AND an outer glow on one layer — so the two contributions
  // cannot be separated — and is marked known-divergent, so it is not gated.
  //
  // No reference is committed, so this fails as "missing reference" until the
  // glow is fixed. Blessing it would make the suite green while certifying the
  // defect, which is the same trap the bevel-profile goldens set.
  ...styleOn3dPair(
    'three-d-outer-glow',
    'Outer glow on a 3D layer — a bright ring OUTSIDE the silhouette, on all sides.',
    { outerGlow: { enabled: true, color: '#ffffff', opacity: 1, size: 22 } },
  ),

  // ── depth of field, measured by EXTENT ─────────────────────────────
  //
  // The defect this is built against is a WRONG RADIUS, not a missing blur: the
  // DOF radii were once ~14× too small in layer space, which a presence check
  // ("is the far panel different from sharp?") passes without complaint. A 14×
  // error is only visible if you measure HOW FAR the edge spreads.
  //
  // The subject is a single far panel with a hard vertical edge crossing clean
  // background, so the blur's extent is readable as the WIDTH of the transition
  // band along one scanline — one variable, no occlusion, no second panel whose
  // own edges could be mistaken for the first one's falloff. (The existing
  // three-d-dof hid its far panel entirely behind the near one, which is how a
  // blur that never reached a visible pixel went unnoticed.)
  //
  // Paired with a DOF-off control at identical geometry: the sharp frame's
  // transition width is the projection's own edge softness, so the difference
  // between the two is the blur and nothing else.
  ...dofExtentPair(),
];
