/**
 * Document capability analysis (Phase 5: unified GPU engine).
 *
 * With one engine that renders every feature, the old "backend capability"
 * tables (Canvas2D vs GPU) and backend-picking logic are gone.
 *
 * What remains:
 *   - `DocumentNeeds`  — a set of boolean flags for which features the document
 *     uses.  Still consumed by AI toolHandlers (list_capabilities) and
 *     analytics.
 *   - `analyzeDocument()` — scans the scene graph and populates DocumentNeeds.
 */

import type { SceneGraph } from '@core/scene/SceneGraph';
import { flattenScene } from '@core/scene/sceneDerive';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readNodeEffects, isGpuOnlyEffect } from '@core/effects/effects';
import { readNodeAdjustment } from '@core/effects/adjustment';
import { readNodeMatte } from '@core/effects/matte';
import { readNodeMotionBlur } from '@core/effects/motionBlur';
import { isColorEffect } from '@core/effects/effectColorMatrix';
import { readNodeLayerTime } from '@core/scene/layerTime';
import { isLutEffect } from '@core/effects/colorLut';
import { isCanvas2dOnlyEffect } from '@core/effects/canvas2dEffects';

/** Which capability-gated features a document actually uses. */
export interface DocumentNeeds {
  gpuEffects: boolean;
  adjustmentLayers: boolean;
  trackMattes: boolean;
  lights: boolean;
  textStyling: boolean;
  colorLut: boolean;
  canvas2dEffects: boolean;
  frameBlending: boolean;
  motionBlur: boolean;
  spatialAdjustments: boolean;
}

/**
 * Scan the scene for capability-gated features.
 *
 * Deliberately reads the SCENE, not a single rendered frame: a matte or an
 * adjustment layer that only matters at t=8s must still count.
 */
export function analyzeDocument(
  graph: SceneGraph,
  opts: {
    /** The comp's motion-blur master toggle. When off, per-layer switches draw
     *  nothing, so they must not count as a need. */
    motionBlurEnabled?: boolean;
  } = {},
): DocumentNeeds {
  const needs: DocumentNeeds = {
    gpuEffects: false,
    adjustmentLayers: false,
    trackMattes: false,
    lights: false,
    textStyling: false,
    colorLut: false,
    canvas2dEffects: false,
    frameBlending: false,
    motionBlur: false,
    spatialAdjustments: false,
  };

  for (const node of flattenScene(graph)) {
    const isAdjustment = readNodeAdjustment(node);
    if (isAdjustment) needs.adjustmentLayers = true;
    if (readNodeMatte(node)) needs.trackMattes = true;
    if (readNodeLayerTime(node)?.frameBlend === 'mix') needs.frameBlending = true;
    if ((opts.motionBlurEnabled ?? true) && readNodeMotionBlur(node)) needs.motionBlur = true;

    const kind = readNodeKind(node);
    if (kind === 'light') needs.lights = true;
    if (kind === 'text') needs.textStyling = true;

    for (const fx of readNodeEffects(node)) {
      if (fx.enabled === false) continue;
      if (isGpuOnlyEffect(fx.type)) needs.gpuEffects = true;
      if (isLutEffect(fx.type)) needs.colorLut = true;
      if (isCanvas2dOnlyEffect(fx.type)) needs.canvas2dEffects = true;
      if (isAdjustment && !isColorEffect(fx.type) && !isLutEffect(fx.type)) {
        needs.spatialAdjustments = true;
      }
    }
  }

  return needs;
}
