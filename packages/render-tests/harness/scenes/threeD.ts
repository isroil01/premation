/**
 * 3D family: perspective layers, camera, light types, depth of field.
 * A layer becomes 3D when it carries z / rotationX / rotationY on its Transform.
 */

import { defineScene, node, type Scene } from '../sceneKit';

const COMP = { width: 480, height: 360, background: '#0c0c12' };
const SIZE = { w: 480, h: 360 };
const CENTER = { x: 240, y: 180 };

function scene(
  id: string,
  description: string,
  build: Scene['build'],
  gpuParity: Scene['gpuParity'] = 'expect-pass',
  divergence?: Scene['divergence'],
): Scene {
  return defineScene({ id, description, size: SIZE, comp: COMP, fps: 30, frames: [0], gpuParity, divergence, build });
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
function styleOn3dPair(id: string, description: string, styles: Record<string, unknown>, fill = '#4a7fd0'): Scene[] {
  // Off-centre and modest, so every side has background for the style to reach
  // and no edge of the frame can clip the thing being measured.
  const place = { position: { x: 200, y: 155 }, size: { width: 170, height: 120 } };
  const build = (withStyles: boolean): Scene['build'] => (graph) => {
    graph.addNode(node('p', {
      kind: 'shape',
      position: place.position,
      transform: { ...place.size, shapeType: 'rect', z: 0, rotationX: 12, rotationY: 24 },
      style: { fill },
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

/**
 * Shadow catcher — does `Accepts Shadows` actually catch anything?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * "Shadow catcher" sat on a backlog as something still to build, on the
 * strength of a comment in `scene/material.ts` saying `acceptsShadows` was
 * "read/persisted for AE-parity but unconsumed". That was true when cast
 * shadows were a CSS drop-shadow on the CASTER — which never landed on another
 * layer — and it stopped being true when real projected shadows arrived. The
 * comment survived the change that falsified it, and nothing in the suite could
 * contradict it, because no scene rendered a shadow onto a receiver.
 *
 * So this is not a scene for a new feature. It is the measurement that decides
 * whether an item on a backlog is real, and then keeps that answer true.
 *
 * ── Why a pair, and what the pair isolates ──────────────────────────────────
 *
 * A light also emits a comp-sized ambient WASH, and a lit plane is shaded
 * per-fragment; both are large effects next to one soft shadow, and both would
 * dominate any single-frame check. The two frames here differ in exactly one
 * property — the floor's `acceptsShadows` — so wash, shading, projection and
 * geometry cancel and the DIFFERENCE is the caught shadow and nothing else.
 *
 * The `-off` frame is committed as a reference of its own, so a change to the
 * floor or the light shows up as its own failure instead of silently moving the
 * baseline the pair is measured against.
 *
 * ── The geometry is chosen to satisfy the projection, not by eye ────────────
 *
 * `buildSnapshot` projects a caster onto the NEAREST accepting plane behind it
 * and refuses the degenerate cases: the receiver must be more than 1 unit
 * behind the caster, the caster must not share the light's plane, and the
 * scale factor `t = (receiverZ − lightZ) / (casterZ − lightZ)` must be finite,
 * positive and ≤ 8 (a runaway projection would smear black over the frame).
 * Light at z −400, caster at 0, floor at 400 gives t = 2 — comfortably inside
 * every bound, and a shadow twice the caster's size, which is large enough to
 * measure and small enough to stay in frame.
 *
 * The floor is `castsShadows: false` so it cannot throw a shadow of its own
 * onto anything, and bright, so a dark shadow on it is a large delta rather
 * than a few levels above the near-black comp background.
 */
function shadowCatcherPair(): Scene[] {
  const build = (accepts: boolean): Scene['build'] => (graph) => {
    graph.addNode(node('floor', {
      kind: 'shape',
      position: CENTER,
      transform: {
        width: 440, height: 340, shapeType: 'rect', z: 400,
        castsShadows: false,
        acceptsShadows: accepts,
      },
      style: { fill: '#c8ccd8' },
    }));
    // Off-centre, so the projection moves the shadow away from the caster
    // rather than hiding it directly behind — a shadow that landed exactly
    // under its own caster would be invisible in both frames.
    graph.addNode(node('caster', {
      kind: 'shape',
      position: { x: 200, y: 150 },
      transform: { width: 110, height: 90, shapeType: 'rect', z: 0 },
      style: { fill: '#4ad0a0' },
    }));
    graph.addNode(node('L', {
      kind: 'light',
      position: CENTER,
      transform: { z: -400, intensity: 100, lightType: 'point', castShadows: true, shadowDiffusion: 0 },
      style: { fill: '#ffffff' },
    }));
    graph.addNode(node('cam', { kind: 'camera', position: CENTER, transform: { z: -1000, focalLength: 1000 } }));
  };
  return [
    scene('shadow-catcher', 'A 3D caster throwing a real shadow onto an ACCEPTING plane behind it.', build(true)),
    scene('shadow-catcher-off', 'The same scene with the floor refusing shadows — the control the pair is measured against.', build(false)),
  ];
}

/**
 * Shadow MAP — does the geometric path put a shadow where the projected one
 * cannot?
 *
 * ── What the pair isolates ──────────────────────────────────────────────────
 *
 * Both frames have the same geometry, the same camera, the same spot light and
 * the same Casts / Accepts switches. They differ in ONE property: the light's
 * `shadowMap`. So the difference between them is the difference between a
 * shadow rasterised from the light and a caster copy projected onto the nearest
 * accepting plane — not the presence of a shadow, which both have.
 *
 * That is the honest comparison to make, and it is a harder one than
 * shadow-on / shadow-off. `-off` here is not "no shadow": it is the 2.5D
 * projection this feature is an ALTERNATIVE to, committed as a reference of its
 * own so a change to either path shows up as its own failure.
 *
 * ── Why the geometry is what it is ──────────────────────────────────────────
 *
 * The caster floats at z = 0 with the floor at z = 400 and the light at
 * z = −400, which is the same arrangement `shadowCatcherPair` uses and for the
 * same reason: it satisfies every bound the projected path imposes (t = 2, well
 * inside its ≤ 8 cap), so the control frame genuinely renders a projected
 * shadow rather than silently rendering none.
 *
 * The floor sets `acceptsLights` explicitly. It is OFF by default
 * (`acceptsLightsFlag` requires an explicit true), and a shadow multiplies a
 * LIGHT's contribution — so on an unlit floor the map would be computed,
 * sampled, and multiplied into nothing. A scene that looked identical either
 * way would have certified a feature that does not run.
 *
 * The spot aims at the floor's centre through a Point of Interest rather than
 * through `lightAngle`: the legacy 2D angle can only swing a light within the
 * comp plane, so it could not point a cone down the z axis at all.
 *
 * Shadow Darkness is 70, not the default 100, and that is a measurement
 * decision rather than a taste one. This spot is the comp's ONLY light, so a
 * fully blocking shadow leaves the occluded floor at exactly zero — visually
 * indistinguishable from a hole in the floor, and numerically indistinguishable
 * from the background, which would make the golden unreadable by the human who
 * has to bless it. 70 leaves 30 % of the light through, so the shadow is dark,
 * bounded, and obviously ON the floor. It also exercises the slider on BOTH
 * paths at once: the projected copy scales its opacity by the same number.
 */
function shadowMapSpotPair(): Scene[] {
  const build = (map: boolean): Scene['build'] => (graph) => {
    /*
      The light is added FIRST, and the order is load-bearing.

      A light also emits a comp-sized WASH layer, and the wash keeps its slot in
      the layer stack while the 3D layers sort by depth around it. With the light
      third, dropping the projected shadow layer (which is what turning the map
      on does) shifted the caster from after the wash to before it — so the
      caster came out screen-brightened in one frame of the pair and not the
      other, and the pair no longer isolated the shadow. Adding the light first
      pins the wash to the back in both frames, and the caster is painted last in
      both.
    */
    graph.addNode(node('L', {
      kind: 'light',
      position: CENTER,
      transform: {
        z: -400, intensity: 100, lightType: 'spot', lightCone: 100, radius: 1600,
        poiX: 240, poiY: 180, poiZ: 400,
        castShadows: true, shadowDiffusion: 0, shadowDarkness: 70,
        ...(map ? { shadowMap: true } : {}),
      },
      style: { fill: '#ffffff' },
    }));
    graph.addNode(node('floor', {
      kind: 'shape',
      position: CENTER,
      transform: {
        width: 440, height: 340, shapeType: 'rect', z: 400,
        castsShadows: false,
        acceptsShadows: true,
        acceptsLights: true,
        diffuse: 100,
      },
      style: { fill: '#c8ccd8' },
    }));
    // Off-centre, so the shadow lands beside its caster instead of hiding
    // directly behind it — invisible in both frames is not a measurement.
    graph.addNode(node('caster', {
      kind: 'shape',
      position: { x: 190, y: 145 },
      transform: { width: 110, height: 90, shapeType: 'rect', z: 0, castsShadows: true },
      style: { fill: '#4ad0a0' },
    }));
    graph.addNode(node('cam', { kind: 'camera', position: CENTER, transform: { z: -1000, focalLength: 1000 } }));
  };
  return [
    scene('shadow-map-spot', 'A spot light with Shadow Map on: the caster is rasterised from the light and sampled per fragment.', build(true)),
    scene('shadow-map-spot-off', 'The same scene with Shadow Map off — the 2.5D projected caster copy, the control the pair is measured against.', build(false)),
  ];
}

export const threeDScenes: Scene[] = [
  ...shadowCatcherPair(),
  ...shadowMapSpotPair(),

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
  }, 'known-divergent', {
    why:
      'The reference is frozen output of the DELETED Canvas2D backend, which shaded a lit plane '
      + 'PER QUAD — one flat tint for the whole layer — while the GPU shades per fragment '
      + '(Lambert + Blinn-Phong, see FrameScene.threeD.shade, whose `quadGain` is explicitly the '
      + 'old per-quad value kept as a fallback). A plane that was one flat colour is now a '
      + 'gradient, so the two disagree across the whole lit area rather than at its edges. A light '
      + 'also emits a comp-sized WASH layer (buildSnapshot, `emitLayer` for kind light), and the '
      + 'two engines draw that wash differently too. NOT YET ESTABLISHED, and the reason this '
      + 'entry is not simply re-blessed: whether the ambient wash SHOULD have a radial falloff at '
      + 'all. An ambient light has no position — buildSnapshot pins its wash to the comp centre — '
      + 'so a falloff looks wrong on inspection and may be a real defect rather than an upgrade.',
    wouldMatchWhen:
      'The ambient-wash question is settled and, if the GPU behaviour is confirmed correct, the '
      + 'reference is re-blessed from the GPU engine. Blessing before settling it would certify '
      + 'whatever the wash currently does.',
  }),

  scene('light-point', 'Point light on a 3D panel.', (graph) => {
    panel(graph, 'p', { z: 0, rotationX: 10 }, '#c9c9d6');
    light(graph, 'L', { z: -200, intensity: 90, radius: 320, lightType: 'point' }, '#ffcc55');
  }),

  scene('light-spot', 'Spot light on a 3D panel.', (graph) => {
    panel(graph, 'p', { z: 0 }, '#c9c9d6');
    light(graph, 'L', { z: -300, intensity: 100, radius: 400, lightType: 'spot', lightAngle: 90, lightCone: 32 }, '#88d0ff');
  }, 'known-divergent', {
    why:
      'The reference is frozen output of the DELETED Canvas2D backend, which shaded a lit plane '
      + 'PER QUAD — one flat tint for the whole layer — while the GPU shades per fragment '
      + '(Lambert + Blinn-Phong, see FrameScene.threeD.shade, whose `quadGain` is explicitly the '
      + 'old per-quad value kept as a fallback). A plane that was one flat colour is now a '
      + 'gradient, so the two disagree across the whole lit area rather than at its edges. A light '
      + 'also emits a comp-sized WASH layer (buildSnapshot, `emitLayer` for kind light), and the '
      + 'two engines draw that wash differently too. NOT YET ESTABLISHED, and the reason this '
      + 'entry is not simply re-blessed: whether the ambient wash SHOULD have a radial falloff at '
      + 'all. An ambient light has no position — buildSnapshot pins its wash to the comp centre — '
      + 'so a falloff looks wrong on inspection and may be a real defect rather than an upgrade.',
    wouldMatchWhen:
      'The ambient-wash question is settled and, if the GPU behaviour is confirmed correct, the '
      + 'reference is re-blessed from the GPU engine. Blessing before settling it would certify '
      + 'whatever the wash currently does.',
  }),

  scene('light-ambient', 'Ambient light tint on a 3D panel.', (graph) => {
    panel(graph, 'p', { z: 0, rotationX: 5 }, '#9098b0');
    light(graph, 'L', { intensity: 70, lightType: 'ambient' }, '#ff88aa');
  }, 'known-divergent', {
    why:
      'The reference is frozen output of the DELETED Canvas2D backend, which shaded a lit plane '
      + 'PER QUAD — one flat tint for the whole layer — while the GPU shades per fragment '
      + '(Lambert + Blinn-Phong, see FrameScene.threeD.shade, whose `quadGain` is explicitly the '
      + 'old per-quad value kept as a fallback). A plane that was one flat colour is now a '
      + 'gradient, so the two disagree across the whole lit area rather than at its edges. A light '
      + 'also emits a comp-sized WASH layer (buildSnapshot, `emitLayer` for kind light), and the '
      + 'two engines draw that wash differently too. NOT YET ESTABLISHED, and the reason this '
      + 'entry is not simply re-blessed: whether the ambient wash SHOULD have a radial falloff at '
      + 'all. An ambient light has no position — buildSnapshot pins its wash to the comp centre — '
      + 'so a falloff looks wrong on inspection and may be a real defect rather than an upgrade.',
    wouldMatchWhen:
      'The ambient-wash question is settled and, if the GPU behaviour is confirmed correct, the '
      + 'reference is re-blessed from the GPU engine. Blessing before settling it would certify '
      + 'whatever the wash currently does.',
  }),

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
  }, 'known-divergent', {
    why:
      'The reference is frozen output of the DELETED Canvas2D backend, which shaded a lit plane '
      + 'PER QUAD — one flat tint for the whole layer — while the GPU shades per fragment '
      + '(Lambert + Blinn-Phong, see FrameScene.threeD.shade, whose `quadGain` is explicitly the '
      + 'old per-quad value kept as a fallback). A plane that was one flat colour is now a '
      + 'gradient, so the two disagree across the whole lit area rather than at its edges. A light '
      + 'also emits a comp-sized WASH layer (buildSnapshot, `emitLayer` for kind light), and the '
      + 'two engines draw that wash differently too. NOT YET ESTABLISHED, and the reason this '
      + 'entry is not simply re-blessed: whether the ambient wash SHOULD have a radial falloff at '
      + 'all. An ambient light has no position — buildSnapshot pins its wash to the comp centre — '
      + 'so a falloff looks wrong on inspection and may be a real defect rather than an upgrade.',
    wouldMatchWhen:
      'The ambient-wash question is settled and, if the GPU behaviour is confirmed correct, the '
      + 'reference is re-blessed from the GPU engine. Blessing before settling it would certify '
      + 'whatever the wash currently does.',
  }),

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
  // FIXED — this scene was created failing and now passes; the history is kept
  // because it is the only record of what the check is actually for.
  //
  // On its first run the ring outside the silhouette came out DARKER than the
  // background: the delta ramped 0 → −4 levels toward the panel edge and the
  // composite tracked `bg·(1−a)`, i.e. the glow was drawn BLACK. Geometry was
  // right (~25 px falloff for size 22) and only the colour was wrong. Cause: the
  // composite passed the glow colour as a TINT, and a tint multiplies — see
  // `silhouetteOf` in packages/renderer/src/shaders/builtin.ts. Now a fill.
  //
  // Held by the colour pair below, not by this scene: a WHITE glow cannot
  // distinguish a fill from a tint, because white is the identity of a multiply.
  // This scene proves the glow lightens and spreads evenly; the green-on-blue
  // twin proves it is the glow's colour.
  ...styleOn3dPair(
    'three-d-outer-glow',
    'Outer glow on a 3D layer — a bright ring OUTSIDE the silhouette, on all sides.',
    { outerGlow: { enabled: true, color: '#ffffff', opacity: 1, size: 22 } },
  ),

  // ── the two scenes that pin the style's COLOUR ─────────────────────
  //
  // The defect above was a colour defect with correct geometry, so every check
  // that looks at where a style lands passes straight through it. These two
  // pick colours that make the arithmetic legible:
  //
  //   glow   pure GREEN on a pure BLUE layer. Multiplying the two gives black
  //          (no channel overlaps), so the broken path renders a dark halo and
  //          the correct path renders a green one. Nothing in between is
  //          reachable, which makes the check immune to tolerance choices.
  //   shadow pure RED on a pure BLUE layer. This is the control that proves the
  //          shadow shares the bug: it passes today ONLY because the default
  //          shadow colour is black, and black is the absorbing element of a
  //          multiply. Give it a non-black colour and the same defect appears.
  //
  // Asserted on HUE (which channel dominates), not on brightness — a wrong-hue
  // glow can be exactly as bright as a right one.
  ...styleOn3dPair(
    'three-d-outer-glow-green-on-blue',
    'Green outer glow on a blue layer — the halo must be GREEN, not the layer’s colour.',
    { outerGlow: { enabled: true, color: '#00ff00', opacity: 1, size: 22 } },
    '#0000ff',
  ),
  ...styleOn3dPair(
    'three-d-drop-shadow-red-on-blue',
    'Red drop shadow on a blue layer — the shadow must be RED, not black.',
    { dropShadow: { enabled: true, color: '#ff0000', opacity: 1, distance: 26, angle: 45, blur: 6, useGlobalLight: false } },
    '#0000ff',
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
