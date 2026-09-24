/**
 * The expression engine's providers — engine-side wiring, installed once at
 * boot (src/providers/Providers.tsx calls it; it moved here from there).
 *
 * `@motion/animation` is framework-independent: every fact an expression reads
 * about the document it does not own (other layers, the composition, markers,
 * text bounds, coordinate spaces, ctrl() rigs, audio level) comes through one
 * of these providers, and its change sink is how its mutations reach the app
 * bus. They read the TypeScript engine's document directly because they ARE
 * the engine (they move into the engine process with it, D1) — not UI reads
 * (docs/B4_MIRROR.md).
 */

import { resolveLayerRef, defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useCompositionStore } from '@stores/compositionStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { getEventBus } from '@core/events/EventBus';
import { measureTextNodeBoxes } from '@core/text/measureText';
import { readNodeKind } from '@core/scene/sceneDerive';
import { layerSpaceAt } from '@core/scene/layerSpace';
import { audioEngine } from '@core/audio/AudioEngine';
import { controlValue } from '@core/animation/expressionControls';

/** Install every expression provider and the change sink (idempotent: each replaces the last). */
export function installExpressionProviders(): void {
  // Bind the (framework-independent) animation engine's change sink onto
  // the app EventBus so its mutations surface as 'AnimationChanged'. Must
  // run before any engine emit (seeding below) reaches its listeners.
  defaultAnimation.setChangeListener((nodeId) =>
    getEventBus().emit('AnimationChanged', { nodeId }),
  );
  // Audio-reactive expressions read live amplitude from the AudioEngine.
  defaultAnimation.setAudioLevelProvider(() => audioEngine.currentLevel());
  // ctrl('name') expressions read slider-control rigs from the scene.
  defaultAnimation.setControlProvider((name, t) => controlValue(name, t));
  // The remaining four providers had NO callers, so the engine kept its
  // placeholder defaults and the expression API quietly lied: layer
  // always returned 0, thisComp.width was a hardcoded 1920 regardless of
  // the real comp, and thisLayer.name was the string 'Layer'. A plausible
  // wrong number is worse than an error — it fails silently on exactly
  // the comps where people rely on it.
  defaultAnimation.setLayerResolver((name) => {
    let found: string | null = null;
    defaultSceneGraph.traverse((n) => {
      if (found === null && n.name === name) found = n.id;
    });
    return found;
  });
  defaultAnimation.setBaseValueProvider((nodeId, prop) => {
    const node = defaultSceneGraph.getNode(nodeId);
    if (!node) return undefined;
    // Transform first (where x/y/rotation live), then every other
    // component: opacity sits on Style, and `value` on it must not be 0.
    const t = node.components.find((c) => c.type === 'Transform');
    for (const c of t ? [t, ...node.components.filter((o) => o !== t)] : node.components) {
      const v = c.props[prop as string];
      if (typeof v === 'number') return v;
    }
    return undefined;
  });
  defaultAnimation.setCompInfoProvider(() => {
    const comp = useCompositionStore.getState().comp();
    let numLayers = 0;
    defaultSceneGraph.traverse(() => { numLayers += 1; });
    return {
      width: comp.width,
      height: comp.height,
      duration: comp.durationSeconds,
      fps: comp.fps,
      numLayers,
    };
  });
  defaultAnimation.setLayerInfoProvider((nodeId) => {
    const comp = useCompositionStore.getState().comp();
    const node = defaultSceneGraph.getNode(nodeId);
    const t = node?.components.find((c) => c.type === 'Transform');
    const w = t?.props.width;
    const h = t?.props.height;
    return {
      name: node?.name ?? 'Layer',
      width: typeof w === 'number' ? w : comp.width,
      height: typeof h === 'number' ? h : comp.height,
    };
  });
  /**
   * `sourceRectAtTime` — a layer's CONTENT bounds, not its box.
   *
   * For TEXT this is the whole value of the function: the box is whatever
   * the user dragged, while the bounds are where the glyphs actually are,
   * and an auto-sizing plate needs the second. `measureTextNodeBoxes`
   * already does the real measurement (it is what buildSnapshot uses), so
   * this is a lookup rather than an estimate — `estimateNodeBounds` in
   * anchor.ts is deliberately NOT used here, because for text it returns a
   * hardcoded 300×50.
   *
   * The time argument is honoured through `evaluateNode(nodeId, t)`, which
   * resolves the node's animated props at `t` before measuring. Without
   * that, a plate behind text whose size or tracking is animated would
   * measure the playhead's bounds while sitting on another frame.
   *
   * Non-text layers have no ink/font distinction, so they report their
   * transform box and `extents` makes no difference — stated here rather
   * than silently returning the same thing twice.
   */
  defaultAnimation.setSourceRectProvider((nodeId, t, extents) => {
    const node = defaultSceneGraph.getNode(nodeId);
    if (!node) return undefined;
    if (readNodeKind(node) === 'text') {
      const overrides: Record<string, unknown> = {};
      for (const [prop, v] of defaultAnimation.evaluateNode(nodeId, t)) overrides[prop] = v;
      const boxes = measureTextNodeBoxes(node, overrides);
      if (boxes) {
        // extents → the FONT box (stable per font and line count);
        // default → the glyph INK box (tight, what a plate wants).
        const b = extents ? boxes.font : boxes.ink;
        return { top: b.top, left: b.left, width: b.width, height: b.height };
      }
    }
    const tr = node.components.find((c) => c.type === 'Transform');
    const w = tr?.props.width;
    const h = tr?.props.height;
    if (typeof w !== 'number' || typeof h !== 'number') return undefined;
    return { top: -h / 2, left: -w / 2, width: w, height: h };
  });
  /**
   * `toComp` / `toWorld` / `fromComp` / `fromWorld` — coordinate spaces.
   *
   * `name` is null for the layer the expression is on, or another layer's
   * name. Resolution matches `layer(name, prop)`: by name, first match.
   *
   * Everything real happens in `layerSpaceAt`, which composes nothing of
   * its own — it routes to `worldMatrixOf` (2D), `nodeWorldWithParents3d`
   * (3D) and `readSceneCamera`, the same three the renderer uses.
   */
  defaultAnimation.setLayerSpaceProvider((self, name, t) => {
    const comp = useCompositionStore.getState().comp();
    let nodeId: string | null = self;
    if (name !== null) {
      // Through the same resolution as `layer()`, so a `#<id>` reference
      // survives a rename here too. Two lookups with different rules
      // would mean `layer('#id', …)` worked and `toComp` on the same
      // reference silently did not.
      nodeId = resolveLayerRef(name, (n: string) => {
        let found: string | null = null;
        defaultSceneGraph.traverse((node) => {
          if (found === null && node.name === n) found = node.id;
        });
        return found;
      });
    }
    if (nodeId === null) return undefined;
    return layerSpaceAt(nodeId, t, { width: comp.width, height: comp.height });
  });
  /**
   * `marker.*` — comp and layer markers.
   *
   * Goes through `getMarkers` / `getLayerMarkers` rather than reading
   * `timeline.markers` directly, deliberately. `getLayerMarkers` is the
   * ONE place that undoes the layer-relative storage (via
   * `toAbsoluteTime`), and a second copy of that conversion here is the
   * §2·0 shape: two readers of one rule, nothing forcing them to agree,
   * and a discrepancy that shows up only on a trimmed or slid layer.
   *
   * `label` maps to `name` because that is the field the app's marker
   * commands fill; `comment` is the note. Both are exposed so a
   * `marker.key("...")` lookup works whichever one the user typed into.
   */
  defaultAnimation.setMarkerProvider((nodeId, scope) => {
    const ctrl = getTimelineController();
    const src = scope === 'comp' ? ctrl.getMarkers() : ctrl.getLayerMarkers(nodeId);
    return src.map((m) => ({
      time: m.time,
      duration: m.duration,
      name: m.label,
      comment: m.comment,
    }));
  });
}
