/** Built-in render passes + a default graph wiring for the standard pipeline. */

import { RenderGraph } from '../RenderGraph';
import { ClearPass } from './ClearPass';
import { BackgroundPass } from './BackgroundPass';
import { CompositionPass, LAYER_TARGET, BLUR_TARGET1, BLUR_TARGET2, MATTE_TARGET } from './CompositionPass';
import { SelectionPass } from './SelectionPass';
import { OverlayPass } from './OverlayPass';
import { MaskPass, MASK_TARGET } from './MaskPass';
import { EffectPass, SCENE_COLOR_TARGET } from './EffectPass';

export { ClearPass } from './ClearPass';
export { BackgroundPass } from './BackgroundPass';
export { CompositionPass, LAYER_TARGET, BLUR_TARGET1, BLUR_TARGET2, MATTE_TARGET } from './CompositionPass';
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

  return graph;
}
