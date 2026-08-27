/**
 * Shape family: primitive kinds (rect/ellipse/bezier path), rounded corners,
 * and geometry operators (trim path, repeater, path-op). Usually one feature
 * per scene; stacked-operator scenes exist where order is the feature (Trim ↔
 * Zig-Zag, Trim → Repeater, Repeater → Wiggle Transform).
 */

import { defineScene, node, shapeNode, type Scene } from '../sceneKit';

const COMP = { width: 360, height: 280, background: '#101014' };
const SIZE = { w: 360, h: 280 };
const CENTER = { x: 180, y: 140 };

function scene(
  id: string,
  description: string,
  build: Scene['build'],
  gpuParity: Scene['gpuParity'] = 'expect-pass',
  divergence?: Scene['divergence'],
): Scene {
  return defineScene({ id, description, size: SIZE, comp: COMP, fps: 30, frames: [0], gpuParity, divergence, build });
}

export const shapeScenes: Scene[] = [
  scene('shape-rect', 'Axis-aligned rectangle primitive.', (graph) => {
    graph.addNode(node('r', { kind: 'shape', position: CENTER, transform: { width: 200, height: 140, shapeType: 'rect' }, style: { fill: '#3a7bd5' } }));
  }),

  scene('shape-ellipse', 'Ellipse primitive.', (graph) => {
    graph.addNode(node('e', { kind: 'shape', position: CENTER, transform: { width: 200, height: 160, shapeType: 'ellipse' }, style: { fill: '#e0518a' } }));
  }),

  scene('shape-rounded-rect', 'Rounded rectangle (cornerRadius).', (graph) => {
    graph.addNode(node('rr', { kind: 'shape', position: CENTER, transform: { width: 200, height: 150, shapeType: 'rect', cornerRadius: 36 }, style: { fill: '#33c1a6' } }));
  }),

  scene('shape-bezier-path', 'Closed custom bezier path (triangle-ish).', (graph) => {
    graph.addNode(
      node('p', {
        kind: 'shape',
        position: CENTER,
        style: { fill: '#f0a030' },
        components: [
          {
            id: 'p_g',
            type: 'Geometry',
            props: {
              points: [
                { x: 0, y: -90, inX: 0, inY: -90, outX: 0, outY: -90 },
                { x: 100, y: 80, inX: 100, inY: 80, outX: 100, outY: 80 },
                { x: -100, y: 80, inX: -100, inY: 80, outX: -100, outY: 80 },
              ],
            },
          },
        ],
      }),
    );
  }),

  scene('shape-trim-path', 'Stroked rect with trim path revealing 0→65% of the outline.', (graph) => {
    graph.addNode(shapeNode('s', { x: 180, y: 140, rotation: 0, fill: '#1f2f47' }));
    graph.setStroke('s', { enabled: true, color: '#66e0ff', width: 14, opacity: 1, align: 'center', dash: [], cap: 'round', join: 'round' });
    graph.setTrimPath('s', { start: 0, end: 65, offset: 0 });
  }),

  // The F14 gate. A trim with NO stroke at all: every inked pixel in this frame
  // is fill, so it can only be right if the trim cut the geometry the fill is
  // traced from. Before the fix this rendered a solid rectangle — `layer.trim`
  // was read inside the stroke loop and the fill ignored it.
  scene('shape-trim-fill', 'FILL follows the trim (no stroke) — the path is cut, not annotated.', (graph) => {
    graph.addNode(shapeNode('f', { x: 180, y: 140, rotation: 0, fill: '#f0a030' }));
    graph.setTrimPath('f', { start: 0, end: 50, offset: 0 });
  }),

  // Two runs from one path — the case a single `pathPoints` polyline could not
  // express, and therefore the reason trim could not cut geometry at all.
  scene('shape-trim-wrap', 'Trim window wrapped past the end of the path: TWO subpaths, filled + stroked.', (graph) => {
    graph.addNode(shapeNode('w', { x: 180, y: 140, rotation: 0, fill: '#1f2f47' }));
    graph.setStroke('w', { enabled: true, color: '#66e0ff', width: 10, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter' });
    graph.setTrimPath('w', { start: 0, end: 40, offset: 80 });
  }),

  // The Phase-3a gate, in PIXELS. Same two operators, opposite order — if these
  // two references were identical the reorder arrows on a Trim card would be
  // inert, and shipping inert controls is worse than shipping none.
  scene('shape-trim-then-zigzag', 'Trim BEFORE Zig-Zag: the arc is cut first, then ruffled.', (graph) => {
    graph.addNode(shapeNode('a', { x: 180, y: 140, rotation: 0, fill: '#22344f' }));
    graph.setStroke('a', { enabled: true, color: '#ffd166', width: 8, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter' });
    graph.setPathOps('a', [
      { id: 'a_t', type: 'trim', amount: 0, detail: 0, start: 0, end: 37, offset: 0 },
      { id: 'a_z', type: 'zigzag', amount: 16, detail: 5 },
    ]);
  }),

  scene('shape-zigzag-then-trim', 'Zig-Zag BEFORE Trim: the ruffled outline is cut by arc length.', (graph) => {
    graph.addNode(shapeNode('b', { x: 180, y: 140, rotation: 0, fill: '#22344f' }));
    graph.setStroke('b', { enabled: true, color: '#ffd166', width: 8, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter' });
    graph.setPathOps('b', [
      { id: 'b_z', type: 'zigzag', amount: 16, detail: 5 },
      { id: 'b_t', type: 'trim', amount: 0, detail: 0, start: 0, end: 37, offset: 0 },
    ]);
  }),

  scene('shape-repeater', 'Repeater: 4 copies with x/rotation/scale offset.', (graph) => {
    graph.addNode(node('rc', { kind: 'shape', position: { x: 90, y: 140 }, transform: { width: 70, height: 70, shapeType: 'rect' }, style: { fill: '#8a7bff' } }));
    graph.setRepeater('rc', { copies: 4, offsetX: 60, offsetY: 0, offsetRotation: 12, offsetScale: 0.85, offsetOpacity: 0.85 });
  }),

  // ── The two scenes that make the repeater's SPACE visible ──────────────
  //
  // `shape-repeater` above uses an untransformed layer, where comp-space and
  // layer-local copy placement agree exactly. That blindness is the whole
  // reason these exist (F19): the repeater fold-in moves copies from comp
  // space into layer-local geometry, and without a transformed layer in the
  // suite the pixel gate would have passed the change in silence.
  //
  // Both are deliberately translate-only — `offsetRotation: 0`,
  // `offsetScale: 1` — so the ONLY thing a re-bless can be showing is the
  // direction/length of the copy ladder. A per-copy rotation or scale would
  // render the same in either model and would just muddy the diff.

  scene('shape-repeater-rotated-layer', 'Repeater on a layer rotated 35 degrees — copy ladder direction is model-dependent.', (graph) => {
    // Comp-space (pre-fold): copies march along comp +X, 70px apart, and the
    // arrangement stays axis-aligned no matter how the layer is turned.
    //   (100,90) (170,90) (240,90) (310,90)
    // Layer-local (post-fold): the ladder is baked into geometry, so the
    // layer's 35 degrees turns it too — 70·(cos35, sin35) = (57.3, 40.2).
    //   (100,90) (157,130) (215,170) (272,211)
    // Both stay inside the 360×280 frame, so the change shows as movement
    // rather than as copies falling off the edge.
    graph.addNode(node('rr', { kind: 'shape', position: { x: 100, y: 90 }, rotation: 35, transform: { width: 70, height: 70, shapeType: 'rect' }, style: { fill: '#ff9f43' } }));
    graph.setRepeater('rr', { copies: 4, offsetX: 70, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 0.8 });
  }),

  scene('shape-repeater-scaled-layer', 'Repeater on a layer scaled 1.5× — copy SPACING is model-dependent.', (graph) => {
    // The same blindness on the other axis of the layer transform, and it is
    // not implied by the rotated scene: rotation changes the ladder's
    // DIRECTION, scale changes its LENGTH.
    //   comp-space (pre-fold):   80px apart      -> x = 60, 140, 220
    //   layer-local (post-fold): 80·1.5 = 120px  -> x = 60, 180, 300
    // The shape's own drawn size is 40·1.5 = 60 wide either way — layer scale
    // has always multiplied into the copy's scale — so only the gaps move.
    //
    // The bar is deliberately NARROWER than the pre-fold spacing (60 < 80).
    // Sized the obvious way the copies overlap into one featureless block in
    // the pre-fold model, and a golden that cannot show the ladder cannot show
    // the ladder MOVING either. `offsetOpacity` fades each copy for the same
    // reason: so a reader can tell which rung is which.
    graph.addNode(node('rs', { kind: 'shape', position: { x: 60, y: 140 }, transform: { width: 40, height: 80, shapeType: 'rect', scaleX: 1.5, scaleY: 1.5 }, style: { fill: '#4ecdc4' } }));
    graph.setRepeater('rs', { copies: 3, offsetX: 80, offsetY: 0, offsetRotation: 0, offsetScale: 1, offsetOpacity: 0.75 });
  }),

  scene('shape-path-op-zigzag', 'Zigzag path operator on a stroked rect.', (graph) => {
    graph.addNode(shapeNode('z', { x: 180, y: 140, rotation: 0, fill: '#22344f' }));
    graph.setStroke('z', { enabled: true, color: '#ffd166', width: 8, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter' });
    graph.setPathOps('z', [{ id: 'z1', type: 'zigzag', amount: 16, detail: 5 }]);
  }),

  /*
    Wiggle Paths, because zigzag was the only path operator with pixels.

    The whole family renders through one route, so one scene proves the ROUTE
    works — but not that each operator's GEOMETRY does. That gap was measured
    rather than assumed: the displacement was changed from normal-only to a real
    2D one, moving every vertex of an outline like this, and the gate stayed
    green because nothing rendered a wiggle.

    A stroked rect for the same reason zigzag uses one: the operator moves the
    OUTLINE, and a stroke is what makes an outline visible. A filled shape hides
    most of the displacement inside itself.

    `wigglesPerSecond` is left at 0 deliberately. The temporal half cross-fades
    between noise fields, so a frame of an animating wiggle depends on the exact
    phase — a golden of one would pin the time axis as much as the geometry, and
    `pathOps.test.ts` already asserts the animation as an invariant rather than
    as a picture.
  */
  scene('shape-path-op-wiggle', 'Wiggle Paths (roughen) on a stroked rect — 2D vertex displacement.', (graph) => {
    graph.addNode(shapeNode('w', { x: 180, y: 140, rotation: 0, fill: '#22344f' }));
    graph.setStroke('w', { enabled: true, color: '#ff00cc', width: 6, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter' });
    // Correlation 40 — mid-range, where neighbours are neither independent nor
    // locked together. At 0 the outline shreds into noise no reader could sanity
    // check; at 100 every point moves alike, and the picture would survive the
    // displacement collapsing back to one dimension.
    graph.setPathOps('w', [{ id: 'w1', type: 'roughen', amount: 14, detail: 4, seed: 7, correlation: 40 }]);
  }),

  // ── Stacked AE motion-design chains (Phase A shapes → 100%) ────────────
  //
  // Single-op scenes prove each operator's geometry. These prove ORDER hits
  // pixels: trim-then-repeater is draw-on → swarm; repeater-then-wiggle is the
  // swarm-with-independent-copies case unit tests already assert. Without
  // stacked goldens a reorder regression stays green.

  scene('shape-trim-then-repeater', 'Trim BEFORE Repeater: cut outline, then swarm the arc.', (graph) => {
    graph.addNode(shapeNode('tr', { x: 100, y: 140, size: 0, fill: '#1a2438' }));
    graph.setStroke('tr', {
      enabled: true, color: '#66e0ff', width: 10, opacity: 1,
      align: 'center', dash: [], cap: 'round', join: 'round',
    });
    graph.setPathOps('tr', [
      { id: 'tr_t', type: 'trim', amount: 0, detail: 0, start: 0, end: 45, offset: 0 },
      {
        id: 'tr_r', type: 'repeater', amount: 0, detail: 0,
        copies: 4, offsetX: 55, offsetY: 8, offsetRotation: 8,
        offsetScale: 0.92, offsetOpacity: 0.85, offset: 0,
        anchorX: 0, anchorY: 0, composite: 'above',
      },
    ]);
  }),

  scene('shape-repeater-then-wiggle-transform', 'Repeater BEFORE Wiggle Transform: each copy gets its own offset.', (graph) => {
    graph.addNode(node('rw', {
      kind: 'shape',
      position: { x: 90, y: 140 },
      transform: { width: 56, height: 56, shapeType: 'rect' },
      style: { fill: '#8a7bff' },
    }));
    // wigglesPerSecond: 0 — same determinism rule as shape-path-op-wiggle.
    // Correlation 0 so copies diverge (the swarm story); seed fixed for goldens.
    graph.setPathOps('rw', [
      {
        id: 'rw_r', type: 'repeater', amount: 0, detail: 0,
        copies: 4, offsetX: 58, offsetY: 0, offsetRotation: 0,
        offsetScale: 1, offsetOpacity: 0.9, offset: 0,
        anchorX: 0, anchorY: 0, composite: 'above',
      },
      {
        id: 'rw_w', type: 'wiggleTransform', amount: 14, detail: 0,
        wigglesPerSecond: 0, seed: 11, correlation: 0,
        wiggleRotation: 0, wiggleScale: 0, anchorX: 0, anchorY: 0,
      },
    ]);
  }),
];
