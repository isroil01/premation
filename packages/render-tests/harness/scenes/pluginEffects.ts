/**
 * Does a plugin effect actually draw, and does it draw the RIGHT thing?
 *
 * ── Why this scene exists ────────────────────────────────────────────────────
 *
 * The plugin effect surface shipped inert three times over, and every time the
 * unit tests were green. They were green because each side of the pipeline was
 * correct about its own half of a conversation the two halves were not having:
 * effects registered and composed; the composition pass drew what the scene
 * handed it; and in between, nothing put the shaders in the renderer's registry
 * and nothing compiled them, so `snapshotToFrameScene` — which emits only
 * `ready` effects — emitted nothing at all.
 *
 * No test could see that, because no test rendered a plugin effect. This one
 * does, through the production pipeline, and reads the pixels.
 *
 * ── The subject: one square, three times ────────────────────────────────────
 *
 * `plugin-control` draws the square with NO effect. `plugin-identity` draws the
 * same square with a plugin effect whose shader is an exact identity, and
 * `plugin-visible` with one that removes the red channel.
 *
 * The assertion is a comparison against the control, not a golden. A golden
 * blessed while the feature was inert would have recorded "the effect changes
 * nothing" as correct — which is the bug. The control is rendered in the same
 * run, on the same backend, from the same subject, so it cannot go stale.
 *
 *   identity vs control   must MATCH   — catches a plugin effect that damages
 *                                        the layer (it disappeared entirely)
 *   visible  vs control   must DIFFER  — catches a plugin effect that is
 *                                        skipped, which "matches" perfectly
 *
 * Neither alone is worth much: "unchanged" is what both a working identity and
 * a dead pipeline produce. The pair pins the effect to running AND to running
 * correctly.
 *
 * One node per scene rather than two side by side in one frame. That was the
 * first design and it measured nothing: the second root never rendered, with a
 * BUILT-IN effect too, so the "the effect erased my layer" reading it produced
 * was the scene's own defect and not the renderer's. Single-node scenes are the
 * shape every other effect scene here uses, and they demonstrably work.
 */

import { defineScene, node, type Scene } from '../sceneKit';
import { registerEffects } from '@core/plugins/pluginEffects';
import type { EffectContribution } from '@core/plugins/effectSchema';

const COMP = { width: 320, height: 180, background: '#0c0c12' };
const SIZE = { w: 320, h: 180 };

/** Where the square sits, in comp pixels. The verifier reads these numbers. */
export const PLUGIN_SUBJECT = { size: 120, centre: { x: 160, y: 90 } };

const PLUGIN_ID = 'studio.rendertest.fx';

/** Exact identity: sampling the input and scaling it by a parameter of 1. */
const IDENTITY = '@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> '
  + '{ return textureSample(src, samp, uv) * params.amount; }';

/**
 * Drops red, keeps green/blue/alpha.
 *
 * Chosen over a brightness change because it cannot be confused with anything
 * else in the pipeline: no blend mode, opacity, or alpha misreading removes one
 * colour channel and leaves the other two. And it stays valid premultiplied
 * output — scaling channels DOWN can never make colour exceed alpha.
 */
const KILL_RED = '@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> '
  + '{ let c = textureSample(src, samp, uv); return vec4<f32>(0.0, c.g, c.b, c.a); }';

function contribution(id: string, shader: string): EffectContribution {
  return {
    id,
    label: id,
    params: { amount: { type: 'number', label: 'Amount', default: 1, min: 0, max: 1 } },
    shader,
  } as unknown as EffectContribution;
}

/*
  Registered at MODULE LOAD, not inside `build`.

  The renderer bridge compiles what is registered when it attaches, and it
  attaches while the backend initialises — which the harness does after the
  scene is built but before it renders. Registering here means the effect is
  already declared by then, so the harness's readiness wait has something to
  wait for. Registering inside `build` would also work today, but it ties
  correctness to an ordering the harness is free to change.

  Idempotent: `registerEffects` is a keyed map write, and both scenes below
  share this one call.
*/
registerEffects(PLUGIN_ID, 'Render Test', [
  contribution('identity', IDENTITY),
  contribution('killred', KILL_RED),
]);

function pluginScene(id: string, effectId: string | null, description: string): Scene {
  return defineScene({
    id,
    description,
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    /*
      GPU is the oracle, and there is no Canvas2D comparison to make.

      A plugin effect is WGSL. The Canvas2D reference engine cannot run one and
      would render the subject unaffected — precisely the failure these scenes
      exist to catch, so comparing against it would gate the bug in as correct.
    */
    oracle: 'gpu' as const,
    gpuParity: 'expect-pass' as const,
    build(graph) {
      graph.addNode(node('subj', {
        kind: 'shape',
        position: { x: PLUGIN_SUBJECT.centre.x, y: PLUGIN_SUBJECT.centre.y },
        transform: { width: PLUGIN_SUBJECT.size, height: PLUGIN_SUBJECT.size, shapeType: 'rect' },
        // All three channels present, so `killred` has something to remove and
        // something to leave behind.
        style: { fill: '#c86464' },
      }));
      if (effectId) {
        graph.setEffects('subj', [
          { id: 'fx', type: `${PLUGIN_ID}.${effectId}`, params: { amount: 1 } },
        ]);
      }
    },
  });
}

export const pluginEffectScenes: Scene[] = [
  pluginScene('plugin-control', null, 'The subject with no effect. The live control the other two are measured against.'),
  pluginScene('plugin-identity', 'identity', 'An exact-identity plugin effect. Must match the control.'),
  pluginScene('plugin-visible', 'killred', 'A plugin effect that removes red. Must differ from the control in red only.'),
];
