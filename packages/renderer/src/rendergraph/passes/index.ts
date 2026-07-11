/** Built-in render passes + a default graph wiring for the standard pipeline. */

import { RenderGraph } from '../RenderGraph';
import { ClearPass } from './ClearPass';
import { BackgroundPass } from './BackgroundPass';
import { ShapePass } from './ShapePass';
import { ImagePass } from './ImagePass';
import { VideoPass } from './VideoPass';
import { TextPass } from './TextPass';
import { SelectionPass } from './SelectionPass';
import { OverlayPass } from './OverlayPass';
import { MaskPass, MASK_TARGET } from './MaskPass';
import { EffectPass, SCENE_COLOR_TARGET } from './EffectPass';

export { ClearPass } from './ClearPass';
export { BackgroundPass } from './BackgroundPass';
export { ShapePass } from './ShapePass';
export { ImagePass } from './ImagePass';
export { VideoPass } from './VideoPass';
export { TextPass } from './TextPass';
export { SelectionPass } from './SelectionPass';
export { OverlayPass } from './OverlayPass';
export { MaskPass, MASK_TARGET } from './MaskPass';
export { EffectPass, SCENE_COLOR_TARGET } from './EffectPass';
export * from './passUtils';

/**
 * The standard pipeline: clear → background → shapes → images → video → text →
 * selection → overlay. Mask/effect passes are registered (disabled) with their
 * transient targets declared, ready to enable. Pass order is *derived* from each
 * pass's `after`/reads/writes by the graph, not from this insertion order.
 */
export function buildDefaultGraph(): RenderGraph {
  const graph = new RenderGraph();
  graph
    .addPass(new ClearPass())
    .addPass(new BackgroundPass())
    .addPass(new ShapePass())
    .addPass(new ImagePass())
    .addPass(new VideoPass())
    .addPass(new TextPass())
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

  return graph;
}
