/**
 * Filling a media slot on a template that is placed as a COMP INSTANCE.
 *
 * A template is a composition, and the way you deliver one piece of content to
 * three platforms is to instance that composition into a 16:9, a 9:16 and a 1:1
 * host comp. So the question is what filling the slot does when the layer
 * carrying it exists once in the source and three times on screen.
 *
 * ## The answer, and why it is the right one
 *
 * A `TemplateField` targets a node id, and instance expansion produces
 * RENDER-ONLY clones under prefixed ids (`${instanceId}::${originalId}`) that
 * sample the original's animation. So a fill writes to the SOURCE composition
 * and every instance shows it.
 *
 * For the delivery case that is exactly right: fill once, all three formats get
 * the clip, and nothing has to be kept in sync by hand. The case it does NOT
 * serve is three product variants from one template — per-instance overrides —
 * which is After Effects' Master Properties, a separate feature. See §21.
 *
 * These pin the propagation so it stays a design point rather than quietly
 * becoming per-instance (or quietly breaking) later.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { COMP_REF_PROP } from '@core/scene/compInstance';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { AnimationEngine } from '@motion/animation';
import { useAssetStore } from '@stores/assetStore';
import type { SceneNode } from '@core/types';
import { declareSlot } from './mediaSlots';
import { writeTemplateField } from './templateFields';
import type { TemplateField } from './templateTypes';

const SRC = 'msi-src-comp';
const HOST = 'msi-host-comp';
const SLOT = 'msi-slot';
const INST_A = 'msi-inst-a';
const INST_B = 'msi-inst-b';

/** A 16:9 asset, so a fill into a 400×400 slot visibly reframes. */
const ASSET = {
  id: 'msi-asset', type: 'video', src: 'msi://clip.mp4',
  // Intrinsic size lives in `metadata` — `sourceOf` reads it from there, and a
  // top-level width/height resolves to nothing and silently skips the fit.
  metadata: { width: 1920, height: 1080, duration: 5 },
};

function addComp(id: string): void {
  defaultSceneGraph.addNode({
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
}

/** The placeholder: a square image layer that will become a slot. */
function addSlotLayer(): void {
  defaultSceneGraph.addChild(SRC, {
    id: SLOT, name: SLOT, parent: SRC, children: [], visible: true, locked: false,
    transform: { position: { x: 100, y: 100 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${SLOT}_t`, type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'image', x: 100, y: 100, width: 400, height: 400, src: 'msi://placeholder.png' },
      },
      { id: `${SLOT}_s`, type: 'Style', props: { opacity: 100 } },
    ],
  } as never);
}

function addInstance(id: string, host: string): void {
  defaultSceneGraph.addChild(host, {
    id, name: id, parent: host, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'comp', x: 0, y: 0, [COMP_REF_PROP]: SRC } },
    ],
  } as never);
}

const mediaField: TemplateField = {
  id: 'msi-field', label: 'Clip', kind: 'media',
  target: { nodeId: SLOT, componentType: 'Transform', prop: 'src' },
} as TemplateField;

const slotProps = (): Record<string, unknown> =>
  defaultSceneGraph.getNode(SLOT)!.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>;

/** Every rendered layer whose id traces back to the slot, in any instance. */
function slotLayersIn(rootId: string): Array<{ id: string; width?: number; height?: number }> {
  const snap = buildSnapshot(
    defaultSceneGraph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined,
    { width: 1920, height: 1080, background: '#000', rootId } as never,
  );
  const out: Array<{ id: string; width?: number; height?: number }> = [];
  const walk = (layers: readonly { id: string; width?: number; height?: number; precompLayers?: readonly never[] }[]): void => {
    for (const l of layers) {
      if (l.id.endsWith(SLOT) || l.id.includes(`::${SLOT}`)) out.push({ id: l.id, width: l.width, height: l.height });
      if (l.precompLayers) walk(l.precompLayers as never);
    }
  };
  walk(snap.layers as never);
  return out;
}

beforeEach(() => {
  addComp(SRC);
  addComp(HOST);
  addSlotLayer();
  declareSlot(SLOT, 'contain');
  addInstance(INST_A, HOST);
  addInstance(INST_B, HOST);
  useAssetStore.setState({ assets: [ASSET as never] });
});

afterEach(() => {
  for (const id of [INST_A, INST_B, SLOT, HOST, SRC]) {
    try { defaultSceneGraph.removeNode(id); } catch { /* not added */ }
  }
  useAssetStore.setState({ assets: [] });
});

describe('a slot fill reaches every instance of the template', () => {
  it('writes to the SOURCE composition, not to a clone', () => {
    expect(writeTemplateField(mediaField, ASSET.src)).toBe(true);
    // The original node carries the new source and the refit box.
    expect(slotProps().src).toBe(ASSET.src);
    expect(slotProps().assetId).toBe(ASSET.id);
    // Contain into a 400×400 slot from 16:9 ⇒ full width, letterboxed height.
    expect(slotProps().width).toBeCloseTo(400, 4);
    expect(slotProps().height).toBeCloseTo(225, 4);
  });

  it('both instances render the filled layer at the fitted size', () => {
    writeTemplateField(mediaField, ASSET.src);
    const rendered = slotLayersIn(HOST);
    // One clone per instance, each carrying the fitted box.
    expect(rendered.length).toBeGreaterThanOrEqual(2);
    for (const l of rendered) {
      expect(l.width).toBeCloseTo(400, 4);
      expect(l.height).toBeCloseTo(225, 4);
    }
    // …and they are genuinely distinct clones, not one layer counted twice.
    expect(new Set(rendered.map((l) => l.id)).size).toBe(rendered.length);
  });

  it('there is no per-instance override — this is the documented trade', () => {
    // Filling once changes every instance together. That is what multi-format
    // delivery wants (one clip, three aspect ratios) and is NOT what "three
    // product variants from one template" wants; the latter needs Master
    // Properties, which does not exist. Pinned so the trade stays deliberate.
    writeTemplateField(mediaField, ASSET.src);
    const rendered = slotLayersIn(HOST);
    const sizes = new Set(rendered.map((l) => `${l.width}x${l.height}`));
    expect(sizes.size).toBe(1);
  });

  it('the source composition renders the fill on its own too', () => {
    // Editing the template directly must behave the same as editing it through
    // a host — there is only one node.
    writeTemplateField(mediaField, ASSET.src);
    const direct = slotLayersIn(SRC);
    expect(direct.length).toBe(1);
    expect(direct[0]!.width).toBeCloseTo(400, 4);
    expect(direct[0]!.height).toBeCloseTo(225, 4);
  });
});
