/**
 * Editor chrome must paint over the finished picture, not under it.
 *
 * The bug this guards: `OverlayPass` and `SelectionPass` both write SURFACE, as
 * do `ClearPass`, `BackgroundPass` and `CompositionPass`. `RenderGraph.compile`
 * derives ordering from `reads` and `after` ONLY — a shared WRITE creates no
 * edge — and chrome declared `after: ['text']`, a pass that does not exist in
 * any graph this codebase builds. `compile()` links an `after` entry only when
 * the named pass is active, so the dangling name was silently no constraint and
 * chrome floated to the front.
 *
 * The visible symptom was reported as an effects bug: add any effect to any
 * layer and the composition grid rows / borders vanish, remove it and they come
 * back. The frame routes through SCENE_COLOR_TARGET whenever the scene has
 * effects, and `EffectPass` blits that target over the whole viewport with
 * REPLACE (see its F10/F12 note) — so it overwrote grid lines and guides that
 * had already been drawn straight to SURFACE. Layers survived because they live
 * inside scene-color; only chrome was lost.
 *
 * Asserting the ORDER rather than the pixels is deliberate: this is a scheduling
 * invariant, and a pixel test would need a grid and an effect in the same scene
 * to catch it — which is exactly the combination nobody had rendered.
 */
import { buildDefaultGraph, EffectPass, SCENE_COLOR_TARGET } from '../rendergraph/passes';
import { SURFACE } from '../rendergraph/RenderPass';

/** Compile the production graph the way `Renderer.renderViewport` configures it. */
function compiledOrder(needsEffect: boolean): string[] {
  const graph = buildDefaultGraph();
  const effect = graph.getPass('effect');
  if (effect) {
    effect.enabled = needsEffect;
    graph.invalidate();
    // Renderer re-asserts this every frame; the graph's shape depends on it,
    // since CompositionPass.writes reads it through a getter.
    EffectPass.activeColorTarget = needsEffect ? SCENE_COLOR_TARGET : SURFACE;
  }
  return graph.compile().map((p) => p.name);
}

describe('render pass order — chrome paints last', () => {
  afterEach(() => {
    // Static shared across every Renderer in the page; leaving it pointed at
    // scene-color would corrupt unrelated suites.
    EffectPass.activeColorTarget = SURFACE;
  });

  it('draws overlay after composition when there are no effects', () => {
    const order = compiledOrder(false);
    expect(order).toContain('overlay');
    expect(order.indexOf('overlay')).toBeGreaterThan(order.indexOf('composition'));
  });

  it('draws overlay AFTER the effect blit, which replaces the surface', () => {
    const order = compiledOrder(true);
    const effect = order.indexOf('effect');
    expect(effect).toBeGreaterThanOrEqual(0);
    // The regression: chrome before the blit is chrome that gets erased.
    expect(order.indexOf('overlay')).toBeGreaterThan(effect);
  });

  it('no longer builds a selection pass at all', () => {
    // It drew `scene.selection`, which the adapter set to [] unconditionally.
    // Asserted rather than merely deleted: `after` entries naming an absent
    // pass are silently no constraint, so a half-revert would be invisible.
    expect(compiledOrder(false)).not.toContain('selection');
    expect(compiledOrder(true)).not.toContain('selection');
  });

  it('never names a pass in `after` that the graph does not build', () => {
    const graph = buildDefaultGraph();
    const passes = (graph as unknown as { passes: Array<{ name: string; after?: readonly string[] }> }).passes;
    const names = new Set(passes.map((p) => p.name));
    for (const p of passes) {
      for (const dep of p.after ?? []) {
        // A dangling name is not an error the graph reports — it is an ordering
        // constraint that silently does not exist. That is how this shipped.
        expect(names.has(dep)).toBe(true);
      }
    }
  });
});
