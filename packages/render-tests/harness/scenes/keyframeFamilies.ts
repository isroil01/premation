/**
 * "A keyframe on this property changes the PIXELS."
 *
 * One scene per keyframeable property family, each rendering two frames with
 * two clearly different keyframed values. The gate (`animates` in run.mjs)
 * asserts the two frames differ. Nothing here asserts what the value is or that
 * a track exists — those pass in every version of this bug. Only the pixels can
 * tell you the chain held all the way to the compositor.
 *
 * The bug that motivated it was reported as "keyframes on style properties do
 * not animate". The prop paths, the sampler and the emit gate were all fine —
 * every step anyone would have checked passed — and this gate still found two
 * real breaks on its first run: fill-colour keyframes resolved into `layer.fill`
 * and were then discarded by the GPU path (`representativeColor` re-read the
 * stored `fillPaint`), and every animated effect/layer-style colour rendered
 * near-black because the reader used 0..255 for tracks written in 0..1. Neither
 * is visible from anywhere except the pixels.
 *
 * Each of these families breaks somewhere different when it breaks:
 *
 *   effect numeric / colour   `resolveEffectParams` reading `effect.<id>.<key>`
 *   layer style (spatial)     the compiled style keeping a STABLE effect id, and
 *                             the emit gate accepting an animated style whose
 *                             stored value looks inert
 *   layer style (baked)       the same, plus the raster cache key including the
 *                             resolved effect stack — a key that omitted it
 *                             would serve frame 0's texture forever
 *   fill / stroke / text      the decomposed `fill_r`… channel tracks and the
 *                             measured-text path
 *
 * Sampled at t=0 and t=1 (frame 0 and frame 30 at 30fps).
 */

import { defineScene, node, type Scene } from '../sceneKit';

const COMP = { width: 320, height: 220, background: '#0c0c12' };
const SIZE = { w: 320, h: 220 };
const FRAMES = [0, 30];

type Build = Scene['build'];
type Graph = Parameters<Build>[0];

/** The subject: a centred rect, large enough that a shadow or a glow around it
 *  is many pixels rather than a rounding difference. */
function subject(graph: Graph, style: Record<string, unknown> = {}, fx?: Record<string, unknown>): void {
  graph.addNode(node('s', {
    kind: 'shape',
    position: { x: 160, y: 110 },
    transform: { width: 120, height: 90, shapeType: 'rect' },
    style: { fill: '#3080ff', ...style },
    ...(fx ? { components: [{ id: 's_fx', type: 'fx', props: fx }] } : {}),
  }));
}

function scene(id: string, description: string, build: Build): Scene {
  return defineScene({
    id, description, size: SIZE, comp: COMP, fps: 30, frames: FRAMES,
    build,
    // No blessed reference: the claim is "frame 0 ≠ frame 30", which is checked
    // against the scene's own output. A golden PNG would only add "and it still
    // looks like it did on the day someone approved it", at the cost of 18 more
    // committed images nobody has a reason to eyeball.
    fidelityOnly: true,
    animates: true,
  });
}

export const keyframeFamilyScenes: Scene[] = [
  scene('kf-transform', 'CONTROL — position keyframed; if this frame-pair matches, the harness itself is broken.', (graph, anim) => {
    subject(graph);
    anim.setKeyframe('s', 'x', 0, 80);
    anim.setKeyframe('s', 'x', 1, 240);
  }),

  scene('kf-effect-number', 'Effect numeric param: blur amount 0 → 24.', (graph, anim) => {
    subject(graph);
    graph.setEffects('s', [{ id: 'fx1', type: 'blur', params: { amount: 0 } }]);
    anim.setKeyframe('s', 'effect.fx1.amount', 0, 0);
    anim.setKeyframe('s', 'effect.fx1.amount', 1, 24);
  }),

  // Channel tracks are 0..1 — the scale `Color.fromHex` writes and every reader
  // now agrees on. Authored with the real values on purpose: written in 0..255
  // these scenes still passed, because both readers clamp and 255 lands on full
  // — which is exactly how the units drifted apart unnoticed in the first place.
  scene('kf-effect-color', 'Effect colour param: Fill colour red → green, through the _r/_g channel tracks.', (graph, anim) => {
    subject(graph);
    graph.setEffects('s', [{ id: 'fx1', type: 'fill', params: { color: '#ff0000', opacity: 100 } }]);
    anim.setKeyframe('s', 'effect.fx1.color_r', 0, 1);
    anim.setKeyframe('s', 'effect.fx1.color_r', 1, 0);
    anim.setKeyframe('s', 'effect.fx1.color_g', 0, 0);
    anim.setKeyframe('s', 'effect.fx1.color_g', 1, 1);
  }),

  scene('kf-style-number', 'Layer style numeric: drop-shadow distance 0 → 60 (compiles to a GPU spatial pass).', (graph, anim) => {
    subject(graph, {}, {
      layerStyles: {
        dropShadow: {
          enabled: true, color: '#000000', opacity: 0.9,
          distance: 0, angle: 45, blur: 6, useGlobalLight: false,
        },
      },
    });
    anim.setKeyframe('s', 'effect.layerstyle:dropShadow.distance', 0, 0);
    anim.setKeyframe('s', 'effect.layerstyle:dropShadow.distance', 1, 60);
  }),

  scene('kf-style-color', 'Layer style colour: drop-shadow colour black → orange.', (graph, anim) => {
    subject(graph, {}, {
      layerStyles: {
        dropShadow: {
          enabled: true, color: '#000000', opacity: 0.9,
          distance: 40, angle: 45, blur: 4, useGlobalLight: false,
        },
      },
    });
    for (const [ch, a, b] of [['r', 0, 1], ['g', 0, 0.63], ['b', 0, 0]] as const) {
      anim.setKeyframe('s', `effect.layerstyle:dropShadow.color_${ch}`, 0, a);
      anim.setKeyframe('s', `effect.layerstyle:dropShadow.color_${ch}`, 1, b);
    }
    anim.setKeyframe('s', 'effect.layerstyle:dropShadow.color_a', 0, 1);
    anim.setKeyframe('s', 'effect.layerstyle:dropShadow.color_a', 1, 1);
  }),

  scene('kf-style-baked', 'Layer style that BAKES rather than drawing on the GPU: inner-glow size 1 → 40. Also gates the raster cache key.', (graph, anim) => {
    subject(graph, {}, {
      layerStyles: {
        innerGlow: { enabled: true, color: '#ffe08a', opacity: 1, size: 1 },
      },
    });
    anim.setKeyframe('s', 'effect.layerstyle:innerGlow.size', 0, 1);
    anim.setKeyframe('s', 'effect.layerstyle:innerGlow.size', 1, 40);
  }),

  scene('kf-fill-color', 'Fill colour: blue → yellow through the decomposed fill_r/g/b tracks.', (graph, anim) => {
    subject(graph);
    anim.setKeyframe('s', 'fill_r', 0, 0.19);
    anim.setKeyframe('s', 'fill_r', 1, 1);
    anim.setKeyframe('s', 'fill_g', 0, 0.50);
    anim.setKeyframe('s', 'fill_g', 1, 0.86);
    anim.setKeyframe('s', 'fill_b', 0, 1);
    anim.setKeyframe('s', 'fill_b', 1, 0.16);
  }),

  // Stroke COLOUR, not stroke width: width has no keyframe path and correctly
  // offers no stopwatch (see stopwatchExposure.test.ts), so a scene animating it
  // would be asserting a feature that does not exist.
  scene('kf-stroke-color', 'Stroke colour white → red through the stroke_r/g/b tracks.', (graph, anim) => {
    subject(graph);
    graph.setStroke('s', { color: '#ffffff', width: 12, align: 'center' });
    anim.setKeyframe('s', 'stroke_r', 0, 1);
    anim.setKeyframe('s', 'stroke_r', 1, 1);
    anim.setKeyframe('s', 'stroke_g', 0, 1);
    anim.setKeyframe('s', 'stroke_g', 1, 0);
    anim.setKeyframe('s', 'stroke_b', 0, 1);
    anim.setKeyframe('s', 'stroke_b', 1, 0);
  }),

  scene('kf-text-size', 'Text style: font size 18 → 54 (the measured-text path, not a scale).', (graph, anim) => {
    graph.addNode(node('t', {
      kind: 'text',
      position: { x: 160, y: 110 },
      components: [{
        id: 't_c',
        type: 'Text',
        props: { content: 'Motion', fontSize: 18, opacity: 100, fontFamily: 'Arial', align: 'center', fill: '#ffe08a' },
      }],
    }));
    anim.setKeyframe('t', 'fontSize', 0, 18);
    anim.setKeyframe('t', 'fontSize', 1, 54);
  }),
];
