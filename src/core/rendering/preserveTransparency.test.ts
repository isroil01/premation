/**
 * Preserve Underlying Transparency — the switch, the route, and the composite.
 *
 * ## Rule 5·0 — the observable, the layer, the medium
 *
 * The observable is COMPOSITED ALPHA: the layer must be invisible where nothing
 * is beneath it, and must not ADD coverage where something is. That is produced
 * in the BLEND_COMBINE fragment shader, from the backdrop texture's alpha.
 *
 * So a snapshot assertion cannot see this feature at all — the snapshot is the
 * input to compositing, not its output. Three different media are needed, one
 * per layer of the claim:
 *
 *   the switch      → the scene graph, read back through `readNode…`
 *   the ROUTE       → `layerToRenderable` + the samplable-target decision,
 *                     because a correct shader that is never reached renders
 *                     nothing and fails silently
 *   the COMPOSITE   → the shader SOURCE, in both dialects
 *
 * ## Why the shader is asserted on its source, in both dialects
 *
 * `blendModeParity.test.ts` already establishes the reason: the render-test gate
 * runs ONE backend per invocation, so a branch added to WGSL and missed in GLSL
 * renders correctly on a WebGPU machine and wrong on WebGL2 — and "wrong" here
 * is the fallthrough, which looks like an ordinary layer rather than a crash.
 * Pixel goldens cannot catch that class; source parity can.
 */

import { readNodePreserveTransparency, setNodePreserveTransparency, getNodePreserveTransparency } from '@core/effects/preserveTransparency';
import { layerToRenderable, snapshotToFrameScene } from './snapshotToFrameScene';
import { BUILTIN_SHADERS } from '@motion/renderer';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { RenderLayer, RenderSnapshot } from './RenderBackend';
import type { SceneNode } from '@core/types';

const ID = 'put_layer';

function addNode(): void {
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
  defaultSceneGraph.addNode({
    id: ID, name: ID, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${ID}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, width: 100, height: 60 } },
    ],
  } as unknown as SceneNode);
}

beforeEach(addNode);

// ── The switch ─────────────────────────────────────────────────────

describe('the fx switch', () => {
  it('is OFF for a layer nobody has touched', () => {
    expect(readNodePreserveTransparency(defaultSceneGraph.getNode(ID)!)).toBe(false);
  });

  it('round-trips through the scene graph', () => {
    setNodePreserveTransparency(ID, true);
    expect(getNodePreserveTransparency(ID)).toBe(true);
    setNodePreserveTransparency(ID, false);
    expect(getNodePreserveTransparency(ID)).toBe(false);
  });

  it('stores NOTHING when off, so an untouched project does not grow a field', () => {
    setNodePreserveTransparency(ID, true);
    setNodePreserveTransparency(ID, false);
    const fx = defaultSceneGraph.getNode(ID)!.components.find((c) => c.type === 'fx');
    expect(fx?.props.preserveTransparency).toBeUndefined();
  });
});

// ── The route (F30: a correct shader that is never reached) ────────

describe('the route to the backdrop-sampling path', () => {
  const layer = (extra: Partial<RenderLayer> = {}): RenderLayer => ({
    id: ID, kind: 'shape', x: 0, y: 0, width: 100, height: 60, opacity: 1, ...extra,
  } as RenderLayer);

  it('carries the flag onto the Renderable', () => {
    expect(layerToRenderable(layer({ preserveTransparency: true })).preserveTransparency).toBe(true);
  });

  it('leaves it absent when off — not `false`', () => {
    // An explicit `false` would make every untouched layer carry the key into
    // the frame scene, which is noise the batcher has to compare.
    expect(layerToRenderable(layer()).preserveTransparency).toBeUndefined();
  });

  it('COMPOSES with an advanced blend rather than replacing it', () => {
    // The whole reason this is not a member of the blend enum: "Multiply AND
    // preserve transparency" has to be representable.
    const r = layerToRenderable(layer({ blend: 'multiply', preserveTransparency: true }));
    expect({ adv: r.advancedBlend, put: r.preserveTransparency })
      .toEqual({ adv: 1, put: true });
  });

  it('is set with a NORMAL blend too — the common case, and advancedBlend stays 0', () => {
    // The bug this pins: routing keyed on `advancedBlend > 0` alone would miss
    // every Normal + preserve-transparency layer, which is most of them, and
    // the switch would light up while changing no pixel.
    const r = layerToRenderable(layer({ blend: 'normal', preserveTransparency: true }));
    expect({ adv: r.advancedBlend ?? 0, put: r.preserveTransparency })
      .toEqual({ adv: 0, put: true });
  });

  /**
   * F30 — the crossing between "the flag is on the Renderable" and "the frame
   * has a target the shader can SAMPLE".
   *
   * This gap was measured, not guessed. Dropping `preserveTransparency` from the
   * samplable-target condition left the entire renderer suite green — 1139
   * tests — because every assertion above watches one side of the seam and none
   * watched the crossing. Without that target `CompositionPass` finds `sceneTex`
   * null and falls through to a plain draw: the switch lights up and no pixel
   * changes, which is the dead-control shape this codebase keeps finding.
   */
  const snapshotOf = (l: RenderLayer): RenderSnapshot => ({
    width: 100, height: 100, background: '#000000', transparent: false, layers: [l],
  } as RenderSnapshot);

  it('POSITIVE CONTROL: the fixture actually produces a renderable', () => {
    // `flattenLayers` drops anything without `visible`, and the first draft of
    // this fixture omitted it — so the seam assertion below was reading a scene
    // with no layers in it and failing for the wrong reason. A fixture that
    // silently flattens to nothing would equally have made it PASS vacuously
    // once the expectation flipped.
    const scene = snapshotToFrameScene(snapshotOf(layer({ visible: true, preserveTransparency: true })));
    expect(scene.renderables.length).toBeGreaterThan(0);
  });

  it('forces the samplable scene target, even with a NORMAL blend', () => {
    const scene = snapshotToFrameScene(
      snapshotOf(layer({ visible: true, blend: 'normal', preserveTransparency: true })));
    expect(scene.hasEffects).toBe(true);
  });

  it('POSITIVE CONTROL: the same layer WITHOUT the switch does not force it', () => {
    // Otherwise the assertion above could hold because every frame sets
    // `hasEffects`, and would prove nothing about this feature.
    const scene = snapshotToFrameScene(snapshotOf(layer({ visible: true, blend: 'normal' })));
    expect(scene.hasEffects).toBe(false);
  });
});

// ── The composite, in both dialects ────────────────────────────────

describe('BLEND_COMBINE implements it in WGSL and GLSL', () => {
  const blend = BUILTIN_SHADERS.find((s) => s.name === 'blend-combine');
  const wgsl = blend?.wgsl ?? '';
  const glsl = blend?.glsl?.fragment ?? '';

  it('POSITIVE CONTROL: both dialect sources were actually found', () => {
    // Otherwise every assertion below passes against empty strings.
    expect({ wgsl: wgsl.length > 500, glsl: glsl.length > 500 })
      .toEqual({ wgsl: true, glsl: true });
  });

  it('both branch on the cr0.y flag', () => {
    expect({ wgsl: /cr0\.y\s*>\s*0\.5/.test(wgsl), glsl: /cr0\.y\s*>\s*0\.5/.test(glsl) })
      .toEqual({ wgsl: true, glsl: true });
  });

  it('both write the SAME composite — ao = ad, and co scaled by ad', () => {
    // Compared as normalised text so a formula edited in one dialect and not
    // the other fails here rather than on someone else's GPU.
    const formula = (src: string): string[] => {
      const m = /cr0\.y\s*>\s*0\.5[\s\S]{0,240}?\{([\s\S]*?)\}/.exec(src);
      return (m?.[1] ?? '').split('\n').map((l) => l.replace(/\s+/g, '').replace(/;$/, '')).filter(Boolean);
    };
    expect(formula(wgsl)).toEqual(formula(glsl));
    expect(formula(wgsl)).toContain('ao=ad');
  });

  it('both exclude the matte family, so the exclusion cannot drift', () => {
    expect({ wgsl: /mode\s*<\s*31/.test(wgsl), glsl: /mode\s*<\s*31/.test(glsl) })
      .toEqual({ wgsl: true, glsl: true });
  });
});

// ── The arithmetic, derived on paper ───────────────────────────────

/**
 * The shipped composite, and the shortcut that looks equivalent.
 *
 * Both are written here so the test can show they DIFFER. Restating the shipped
 * formula is circular on its own — the positive control below is what makes it
 * meaningful: it pins the one input where the two disagree, so a future edit to
 * the shortcut form fails instead of quietly passing.
 */
const atop = (as: number, ad: number, cs: number, cb: number): { co: number; ao: number } =>
  ({ co: ad * (as * cs + (1 - as) * cb), ao: ad });
/** Scale source alpha by backdrop alpha, keep the source-over line. */
const naive = (as: number, ad: number, cs: number, cb: number): { co: number; ao: number } => {
  const a = as * ad;
  return { co: a * (1 - ad) * cs + a * ad * cs + (1 - a) * ad * cb, ao: a + ad - a * ad };
};

describe('the values this was derived from, before any code', () => {
  it.each([
    ['an OPAQUE backdrop leaves the layer unchanged', 1, 1, 1, 0, 1, 1],
    ['NOTHING beneath makes it invisible', 1, 0, 1, 0, 0, 0],
    ['a HALF-covered backdrop shows it at half', 1, 0.5, 1, 0, 0.5, 0.5],
  ])('%s', (_label, as, ad, cs, cb, expectedCo, expectedAo) => {
    const r = atop(as, ad, cs, cb);
    expect({ co: r.co, ao: r.ao }).toEqual({ co: expectedCo, ao: expectedAo });
  });

  it('POSITIVE CONTROL: the naive shortcut DISAGREES at the half-covered case', () => {
    // This is the input that rules the shortcut out, and the reason the three
    // rows above are not merely restating the implementation. The shortcut adds
    // coverage (0.75) exactly where the layer is supposed to be clipped by it.
    const good = atop(1, 0.5, 1, 0);
    const bad = naive(1, 0.5, 1, 0);
    expect(bad.ao).toBeCloseTo(0.75, 6);
    expect(good.ao).toBeCloseTo(0.5, 6);
    expect(bad.ao).not.toBeCloseTo(good.ao, 3);
  });

  it('never ADDS coverage, for any source alpha over any backdrop', () => {
    // The defining property, asserted over a derived grid rather than one point.
    for (let as = 0; as <= 1.0001; as += 0.25) {
      for (let ad = 0; ad <= 1.0001; ad += 0.25) {
        expect({ as, ad, ok: atop(as, ad, 1, 0).ao <= ad + 1e-9 })
          .toEqual({ as, ad, ok: true });
      }
    }
  });
});
