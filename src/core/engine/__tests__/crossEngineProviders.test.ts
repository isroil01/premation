/**
 * The app's expression providers (src/providers/Providers.tsx) for the
 * cross-engine replay (crossEngine.test.ts).
 *
 * The C++ engine's expression host (native/engine/src/core/docexpr.cpp)
 * implements the providers the EDITOR binds into `defaultAnimation` at boot;
 * a bare TypeScript engine runs with AnimationEngine's placeholder defaults
 * (thisComp.width 1920, fps 60, layer() → 0 …). Comparing evaluated
 * expression values like with like needs the TypeScript side to answer as the
 * app does — this installs the same bindings (Providers.tsx can't be imported:
 * it is a React component with the whole app behind it).
 *
 * One deliberate difference: `sourceRectAtTime` on a TEXT layer. The app
 * measures glyphs with the renderer's shaper (measureTextNodeBoxes), which
 * neither jsdom nor the C++ document core has; both report the Transform box.
 *
 * Every file under __tests__ runs as a jest suite, hence the `.test.ts` name
 * and the one check at the bottom.
 */

import { defaultAnimation, resolveLayerRef } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useCompositionStore } from '@stores/compositionStore';
import { controlValue } from '@core/animation/expressionControls';
import { layerSpaceAt } from '@core/scene/layerSpace';
import { getTimelineController } from '@core/timeline/TimelineController';

function nodeByName(name: string): string | null {
  let found: string | null = null;
  defaultSceneGraph.traverse((n) => {
    if (found === null && n.name === name) found = n.id;
  });
  return found;
}

/** Bind Providers.tsx's expression providers onto `defaultAnimation` (idempotent). */
export function installAppExpressionProviders(): void {
  const a = defaultAnimation;
  a.setControlProvider((name, t) => controlValue(name, t));
  a.setLayerResolver((name) => nodeByName(name));
  a.setBaseValueProvider((nodeId, prop) => {
    const node = defaultSceneGraph.getNode(nodeId);
    if (!node) return undefined;
    const t = node.components.find((c) => c.type === 'Transform');
    for (const c of t ? [t, ...node.components.filter((o) => o !== t)] : node.components) {
      const v = (c.props as Record<string, unknown>)[prop as string];
      if (typeof v === 'number') return v;
    }
    return undefined;
  });
  a.setCompInfoProvider(() => {
    const comp = useCompositionStore.getState().comp();
    let numLayers = 0;
    defaultSceneGraph.traverse(() => { numLayers += 1; });
    return { width: comp.width, height: comp.height, duration: comp.durationSeconds, fps: comp.fps, numLayers };
  });
  a.setLayerInfoProvider((nodeId) => {
    const comp = useCompositionStore.getState().comp();
    const node = defaultSceneGraph.getNode(nodeId);
    const t = node?.components.find((c) => c.type === 'Transform');
    const w = (t?.props as Record<string, unknown> | undefined)?.width;
    const h = (t?.props as Record<string, unknown> | undefined)?.height;
    return { name: node?.name ?? 'Layer', width: typeof w === 'number' ? w : comp.width, height: typeof h === 'number' ? h : comp.height };
  });
  a.setSourceRectProvider((nodeId) => {
    const node = defaultSceneGraph.getNode(nodeId);
    if (!node) return undefined;
    const tr = node.components.find((c) => c.type === 'Transform');
    const w = (tr?.props as Record<string, unknown> | undefined)?.width;
    const h = (tr?.props as Record<string, unknown> | undefined)?.height;
    if (typeof w !== 'number' || typeof h !== 'number') return undefined;
    return { top: -h / 2, left: -w / 2, width: w, height: h };
  });
  a.setLayerSpaceProvider((self, name, t) => {
    const comp = useCompositionStore.getState().comp();
    const nodeId = name !== null ? resolveLayerRef(name, nodeByName) : self;
    if (nodeId === null) return undefined;
    return layerSpaceAt(nodeId, t, { width: comp.width, height: comp.height });
  });
  a.setMarkerProvider((nodeId, scope) => {
    const ctrl = getTimelineController();
    const src = scope === 'comp' ? ctrl.getMarkers() : ctrl.getLayerMarkers(nodeId);
    return src.map((m) => ({ time: m.time, duration: m.duration, name: m.label, comment: m.comment }));
  });
}

test('installs the app expression providers', () => {
  expect(() => installAppExpressionProviders()).not.toThrow();
});
