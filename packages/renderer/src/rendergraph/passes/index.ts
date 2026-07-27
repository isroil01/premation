/** Built-in render passes + a default graph wiring for the standard pipeline. */

import { RenderGraph } from '../RenderGraph';
import { ClearPass } from './ClearPass';
import { BackgroundPass } from './BackgroundPass';
import { CompositionPass, LAYER_TARGET, BLUR_TARGET1, BLUR_TARGET2, MATTE_TARGET, PRECOMP_TARGETS } from './CompositionPass';
import { SelectionPass } from './SelectionPass';
import { OverlayPass } from './OverlayPass';
import { MaskPass, MASK_TARGET } from './MaskPass';
import { EffectPass, SCENE_COLOR_TARGET } from './EffectPass';

export { ClearPass } from './ClearPass';
export { BackgroundPass } from './BackgroundPass';
export { CompositionPass, LAYER_TARGET, BLUR_TARGET1, BLUR_TARGET2, MATTE_TARGET, PRECOMP_TARGETS, MAX_PRECOMP_DEPTH } from './CompositionPass';
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
    format: 'rgba8unorm',
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
    format: 'rgba8unorm',
  }));
  graph.declareTarget(BLUR_TARGET1, (vp) => ({
    label: BLUR_TARGET1,
    width: vp.pixelSize.width,
    height: vp.pixelSize.height,
    format: 'rgba8unorm',
  }));
  graph.declareTarget(BLUR_TARGET2, (vp) => ({
    label: BLUR_TARGET2,
    width: vp.pixelSize.width,
    height: vp.pixelSize.height,
    format: 'rgba8unorm',
  }));
  graph.declareTarget(MATTE_TARGET, (vp) => ({
    label: MATTE_TARGET,
    width: vp.pixelSize.width,
    height: vp.pixelSize.height,
    format: 'rgba8unorm',
  }));
  // One isolated-precomp target per nesting depth (see CompositionPass).
  // Depth-capable so a 3D group INSIDE an isolated precomp depth-tests too.
  for (const name of PRECOMP_TARGETS) {
    graph.declareTarget(name, (vp) => ({
      label: name,
      width: vp.pixelSize.width,
      height: vp.pixelSize.height,
      format: 'rgba8unorm',
      depth: true,
      // A 3D group inside an isolated precomp needs the same treatment.
      samples: MSAA_SAMPLES,
    }));
  }

  return graph;
}
