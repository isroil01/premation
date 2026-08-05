/**
 * Guide layers — visible in the comp, absent from anything delivered.
 *
 * ## Two observables, and neither medium sees the other (rule 5·0)
 *
 * **"It appears in the viewport."** Produced by `buildSnapshot` with no
 * `forExport` flag. A unit test on `buildSnapshot` samples exactly that layer,
 * so it is the right medium — and it is also the *easy* half, which is why it
 * is not the one that regresses.
 *
 * **"It does not appear in an export."** That is TWO claims wearing one
 * sentence, and they live in different places:
 *
 *   1. the RULE — `buildSnapshot` drops guide layers when told the frame is
 *      for delivery. Tested here, because `buildSnapshot` produces it.
 *   2. the WIRING — the export paths actually tell it. **Nothing in this file
 *      can see that.** Every assertion below passes with `exportComp` deleted
 *      from all four export call sites, because they construct the flag
 *      themselves. That half is `exportPathsMarkForExport.test.ts`, which reads
 *      the export directory's source, plus the runtime check.
 *
 * Splitting them matters because they fail differently. The rule breaks loudly
 * the moment anyone looks at a frame; the wiring breaks silently, in the output
 * file, which nobody inspects until a client does.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

function shapeNode(id: string, opts: { guide?: boolean; visible?: boolean } = {}): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: opts.visible ?? true, locked: false,
    transform: { position: { x: 10, y: 20 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 10, y: 20 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
      // The flag rides on `fx`, exactly as `setGuideLayer` writes it. Only
      // `true` is ever stored, so the absent case is modelled by omitting it
      // rather than by writing `false` — a shape a real document cannot have.
      ...(opts.guide ? [{ id: `${id}_fx`, type: 'fx', props: { guide: true } }] : []),
    ],
  } as unknown as SceneNode;
}

const COMP = { width: 800, height: 600, background: '#101014' };

function build(nodes: SceneNode[], forExport: boolean) {
  const graph = new SceneGraph();
  for (const n of nodes) graph.addNode(n);
  const anim = new AnimationEngine();
  return buildSnapshot(graph, anim, 0, undefined, undefined, undefined, undefined, {
    ...COMP,
    ...(forExport ? { forExport: true } : {}),
  });
}

const visibilityOf = (snap: ReturnType<typeof buildSnapshot>, id: string): boolean | undefined =>
  snap.layers.find((l) => l.id === id)?.visible;

describe('a guide layer in the VIEWPORT', () => {
  it('is visible, exactly like an ordinary layer', () => {
    const snap = build([shapeNode('normal'), shapeNode('guide', { guide: true })], false);
    expect(visibilityOf(snap, 'normal')).toBe(true);
    expect(visibilityOf(snap, 'guide')).toBe(true);
  });
});

describe('a guide layer in an EXPORTED frame', () => {
  /**
   * The assertion that matters, and the one that regresses silently. Its pair
   * — that the ordinary layer is untouched — is what makes it a guide-layer
   * test rather than a "does forExport break rendering" test: without it, a
   * flag that hid EVERY layer would pass.
   */
  it('is not visible, while its neighbour still is', () => {
    const snap = build([shapeNode('normal'), shapeNode('guide', { guide: true })], true);
    expect(visibilityOf(snap, 'guide')).toBe(false);
    expect(visibilityOf(snap, 'normal')).toBe(true);
  });

  /**
   * It is BUILT and hidden, not omitted. Downstream consumers already handle an
   * invisible layer (`snapshotToFrameScene` skips on `!layer.visible`); a
   * missing entry would be a second shape for them to handle, and indices into
   * `layers` would shift between preview and export.
   */
  it('is still present in the layer list, just hidden', () => {
    const snap = build([shapeNode('guide', { guide: true })], true);
    expect(snap.layers.some((l) => l.id === 'guide')).toBe(true);
  });

  /** The flag does nothing on its own — only in combination with the comp. */
  it('changes nothing for a layer that is not a guide', () => {
    const a = build([shapeNode('plain')], false);
    const b = build([shapeNode('plain')], true);
    expect(visibilityOf(a, 'plain')).toBe(visibilityOf(b, 'plain'));
  });
});

describe('boundaries — what the clean fixture excludes', () => {
  /**
   * A guide layer that is ALSO eye-hidden. The clean fixture has every layer
   * visible, so it cannot tell "hidden because guide" from "hidden because
   * hidden" — an implementation that dropped the eye toggle entirely and kept
   * only the guide rule would pass every test above.
   */
  it('an eye-hidden layer stays hidden in the viewport too', () => {
    const snap = build([shapeNode('off', { visible: false })], false);
    expect(visibilityOf(snap, 'off')).toBe(false);
  });

  /**
   * And the reverse pairing: solo. Guide, solo and the eye toggle are three
   * rules folded into ONE expression, so each needs a case where it is the
   * only one acting — otherwise the expression could drop a term unnoticed.
   */
  it('solo still suppresses a non-soloed layer with no guides present', () => {
    const soloed = { ...shapeNode('star'), solo: true } as SceneNode;
    const snap = build([soloed, shapeNode('other')], false);
    expect(visibilityOf(snap, 'star')).toBe(true);
    expect(visibilityOf(snap, 'other')).toBe(false);
  });

  /**
   * A guide layer that is also SOLOED, exported. Both rules point opposite
   * ways — solo says "only this one", guide says "not this one" — and the
   * fixtures above can never produce the combination. Guide wins: solo is an
   * editing convenience, guide is a statement about the deliverable.
   */
  it('guide beats solo in an export', () => {
    const soloed = { ...shapeNode('g', { guide: true }), solo: true } as SceneNode;
    const snap = build([soloed, shapeNode('other')], true);
    expect(visibilityOf(snap, 'g')).toBe(false);
  });

  /**
   * `forExport` absent and `forExport: false` must agree. Only `true` is ever
   * written, but a comp built by spreading a stored object could carry either.
   */
  it('forExport false is the same as absent', () => {
    const graph = new SceneGraph();
    graph.addNode(shapeNode('guide', { guide: true }));
    const snap = buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined,
      { ...COMP, forExport: false });
    expect(visibilityOf(snap, 'guide')).toBe(true);
  });
});

describe('a guide layer inside a PRECOMP', () => {
  /**
   * The decision, stated: a guide layer inside a nested composition is
   * excluded when that composition renders into an export. AE does this, and
   * the alternative cannot be defended — "reference material, not for
   * delivery" is a property of the layer, and putting the layer one level down
   * does not make it deliverable. A guide layer that reappears once you
   * precompose would be a trap, and precomposing is routine.
   *
   * Mechanically it is free, and that is why the flag rides on `comp`:
   * `buildSnapshot` recurses with `{...comp, width, height}`, so `forExport`
   * propagates through the existing spread. Had it lived on `RenderView` — the
   * other obvious home — it would have been dropped, because the nested call
   * passes `view: undefined` deliberately. This test is what says which of
   * those two the code actually does.
   */
  function nestedGraph(): SceneGraph {
    const graph = new SceneGraph();
    // The inner composition's root, holding one guide and one ordinary layer.
    const innerRoot = {
      id: 'innerRoot', name: 'inner', parent: null, children: ['innerGuide', 'innerPlain'],
      visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: 'ir_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'group' } }],
    } as unknown as SceneNode;
    const innerGuide = { ...shapeNode('innerGuide', { guide: true }), parent: 'innerRoot' } as SceneNode;
    const innerPlain = { ...shapeNode('innerPlain'), parent: 'innerRoot' } as SceneNode;
    // The instance that renders it.
    const instance = {
      id: 'instance', name: 'instance', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{
        id: 'inst_t', type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'comp', __compRef: 'innerRoot', x: 0, y: 0 },
      }],
    } as unknown as SceneNode;
    for (const n of [innerRoot, innerGuide, innerPlain, instance]) graph.addNode(n);
    return graph;
  }

  function nestedSnap(forExport: boolean) {
    return buildSnapshot(nestedGraph(), new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
      ...COMP,
      compSizeOf: () => ({ width: 400, height: 300 }),
      ...(forExport ? { forExport: true } : {}),
    });
  }

  /** Sanity: the precomp really did expand, or everything below is vacuous. */
  it('the nested composition renders at all', () => {
    const snap = nestedSnap(false);
    expect(snap.layers.some((l) => l.id === 'instance')).toBe(true);
  });

  it('propagates forExport into the nested composition', () => {
    const preview = nestedSnap(false);
    const exported = nestedSnap(true);
    const innerOf = (s: ReturnType<typeof buildSnapshot>, id: string): boolean | undefined => {
      const container = s.layers.find((l) => l.id === 'instance');
      return (container?.precompLayers as Array<{ id: string; visible?: boolean }> | undefined)
        // Inner ids are PREFIXED by the instance (`instance::innerGuide`), so
        // match the suffix rather than the bare id — an exact match silently
        // finds nothing and reads as "undefined", not as a failure to locate.
        ?.find((l) => l.id === id || l.id.endsWith(`::${id}`))?.visible;
    };
    // Visible while editing…
    expect(innerOf(preview, 'innerGuide')).toBe(true);
    // …and gone from the deliverable, with its neighbour untouched.
    expect(innerOf(exported, 'innerGuide')).toBe(false);
    expect(innerOf(exported, 'innerPlain')).toBe(true);
  });
});
