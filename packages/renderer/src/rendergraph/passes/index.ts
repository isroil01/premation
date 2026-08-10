/** Built-in render passes + a default graph wiring for the standard pipeline. */

import { RenderGraph } from '../RenderGraph';
import { ClearPass } from './ClearPass';
import { BackgroundPass } from './BackgroundPass';
import { CompositionPass, PLUGIN_ORIGIN, PLUGIN_HALF1, PLUGIN_HALF2, PLUGIN_QUARTER1, PLUGIN_QUARTER2, LAYER_TARGET, BLUR_TARGET1, BLUR_TARGET2, BLUR_TARGET3, MATTE_TARGET, BACKDROP_HALF1, BACKDROP_HALF2, BACKDROP_DOWNSCALE, PRECOMP_TARGETS } from './CompositionPass';
import { SelectionPass } from './SelectionPass';
import { OverlayPass } from './OverlayPass';
import { MaskPass, MASK_TARGET } from './MaskPass';
import { EffectPass, SCENE_COLOR_TARGET } from './EffectPass';

export { ClearPass } from './ClearPass';
export { BackgroundPass } from './BackgroundPass';
export { CompositionPass, PLUGIN_ORIGIN, PLUGIN_HALF1, PLUGIN_HALF2, PLUGIN_QUARTER1, PLUGIN_QUARTER2, PLUGIN_SCALED_TARGETS, LAYER_TARGET, BLUR_TARGET1, BLUR_TARGET2, BLUR_TARGET3, MATTE_TARGET, BACKDROP_HALF1, BACKDROP_HALF2, BACKDROP_DOWNSCALE, PRECOMP_TARGETS, MAX_PRECOMP_DEPTH } from './CompositionPass';
export { SelectionPass } from './SelectionPass';
export { OverlayPass } from './OverlayPass';
export { MaskPass, MASK_TARGET } from './MaskPass';
export { EffectPass, SCENE_COLOR_TARGET } from './EffectPass';
export * from './passUtils';

/**
 * The standard pipeline: clear → background → composition (shapes/images/text) →
 * selection → overlay. Mask/effect passes are registered (disabled) with their
 * transient targets declared, ready to enable. Pass order is *derived* from each
 * pass's `after`/reads/writes by the graph, not from this insertion order.
 */
/**
 * MSAA samples for the depth-capable 3D targets. 4× is the standard
 * quality/bandwidth trade and is universally supported where MSAA exists at all.
 */
export const MSAA_SAMPLES = 4;

export function buildDefaultGraph(): RenderGraph {
  const graph = new RenderGraph();
  graph
    .addPass(new ClearPass())
    .addPass(new BackgroundPass())
    .addPass(new CompositionPass())
    .addPass(new SelectionPass())
    .addPass(new OverlayPass())
    .addPass(new MaskPass())
    .addPass(new EffectPass());

  graph.declareTarget(MASK_TARGET, (vp) => ({
    label: MASK_TARGET,
    width: vp.pixelSize.width,
    height: vp.pixelSize.height,
    format: 'rgba8unorm',
  }));
  graph.declareTarget(SCENE_COLOR_TARGET, (vp) => ({
    label: SCENE_COLOR_TARGET,
    width: vp.pixelSize.width,
    height: vp.pixelSize.height,
    // rgba16float: the main compositing/scene target. Higher precision means
    // stacked effects don't band and add/screen don't clip to 1.0 between
    // passes; resolveTargets downgrades it to the surface format where float
    // rendering is unsupported (or the HDR kill switch is off).
    format: 'rgba16float',
    // 3D render groups depth-test into the scene target (the adapter routes
    // any frame containing 3D layers through it via hasEffects).
    depth: true,
    // 4× MSAA. Extruded 3D objects draw each face as its own alpha-blended quad
    // with SDF edge AA; where two faces share an edge both contribute partial
    // coverage and the nearer one wins the depth test, so the join showed as a
    // seam. Multisampling resolves that coverage properly. Backends clamp to the
    // device max and fall back to single-sample if the combination is refused.
    samples: MSAA_SAMPLES,
  }));
  graph.declareTarget(LAYER_TARGET, (vp) => ({
    label: LAYER_TARGET,
    width: vp.pixelSize.width,
    height: vp.pixelSize.height,
    format: 'rgba16float',
  }));
  graph.declareTarget(BLUR_TARGET1, (vp) => ({
    label: BLUR_TARGET1,
    width: vp.pixelSize.width,
    height: vp.pixelSize.height,
    format: 'rgba16float',
  }));
  graph.declareTarget(BLUR_TARGET2, (vp) => ({
    label: BLUR_TARGET2,
    width: vp.pixelSize.width,
    height: vp.pixelSize.height,
    format: 'rgba16float',
  }));
  // Third blur slot — optical bloom needs mid + wide lobes without stomping
  // the layer's current effect-chain texture.
  graph.declareTarget(BLUR_TARGET3, (vp) => ({
    label: BLUR_TARGET3,
    width: vp.pixelSize.width,
    height: vp.pixelSize.height,
    format: 'rgba16float',
  }));
  graph.declareTarget(MATTE_TARGET, (vp) => ({
    label: MATTE_TARGET,
    width: vp.pixelSize.width,
    height: vp.pixelSize.height,
    format: 'rgba8unorm',
  }));
  // Half-resolution backdrop-blur chain. A large-radius blur has no
  // high-frequency content left to lose, so blurring at half size costs a
  // quarter as much for an output nobody can distinguish. See CompositionPass.
  for (const name of [BACKDROP_HALF1, BACKDROP_HALF2]) {
    graph.declareTarget(name, (vp) => ({
      label: name,
      width: Math.max(1, Math.floor(vp.pixelSize.width / BACKDROP_DOWNSCALE)),
      height: Math.max(1, Math.floor(vp.pixelSize.height / BACKDROP_DOWNSCALE)),
      format: 'rgba16float',
    }));
  }

  /*
    Downsampled ping-pong pools for plugin effect passes declaring `scale`.
    The same trick as the backdrop chain above, generalised: a bloom's blur
    runs on a sixteenth of the pixels and the upsample is free, because
    whatever reads the result samples the smaller texture linearly.

    `rgba16float` like the rest of the effect chain, and it matters more here
    than anywhere else: a downsampled pass is usually the BRIGHT extract of a
    bloom, and clamping it to 8-bit would throw away exactly the highlights the
    effect exists to spread.

    Always declared, never allocated on demand. The graph resolves targets once
    per frame and dedupes by name and size; a pool that appeared only when some
    plugin happened to want one would allocate mid-frame. The standing cost is
    a quarter plus a sixteenth of a viewport, and nothing renders into them
    until a scaled pass is actually drawn.
  */
  for (const [name, divisor] of [
    [PLUGIN_HALF1, 2], [PLUGIN_HALF2, 2],
    [PLUGIN_QUARTER1, 4], [PLUGIN_QUARTER2, 4],
  ] as const) {
    graph.declareTarget(name, (vp) => ({
      label: name,
      width: Math.max(1, Math.floor(vp.pixelSize.width / divisor)),
      height: Math.max(1, Math.floor(vp.pixelSize.height / divisor)),
      format: 'rgba16float',
    }));
  }

  // Holds a plugin chain's pass-0 input for the whole chain, so a later pass
  // can composite against the original — which by then is several ping-pongs
  // ago and overwritten. Its own target rather than a loan from the effect
  // pool: borrowing would contend with glow's wide lobe and make a chain's
  // legal length depend on what else is stacked on the layer.
  graph.declareTarget(PLUGIN_ORIGIN, (vp) => ({
    label: PLUGIN_ORIGIN,
    width: vp.pixelSize.width,
    height: vp.pixelSize.height,
    format: 'rgba16float',
  }));

  // One isolated-precomp target per nesting depth (see CompositionPass).
  // Depth-capable so a 3D group INSIDE an isolated precomp depth-tests too.
  for (const name of PRECOMP_TARGETS) {
    graph.declareTarget(name, (vp) => ({
      label: name,
      width: vp.pixelSize.width,
      height: vp.pixelSize.height,
      format: 'rgba16float',
      depth: true,
      // A 3D group inside an isolated precomp needs the same treatment.
      samples: MSAA_SAMPLES,
    }));
  }

  return graph;
}
