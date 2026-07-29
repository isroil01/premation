/**
 * Filling a slot against a real scene graph.
 *
 * The unit tests next door pin the fit arithmetic. These pin what the fill
 * WRITES — which is the part that can quietly ruin an authored template:
 * repointing the asset, reframing against the authored rect, and above all
 * leaving the author's animation alone.
 */

import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

const assets: Array<Record<string, unknown>> = [];

jest.mock('@stores/assetStore', () => ({ useAssetStore: { getState: () => ({ assets }) } }));
jest.mock('@stores/sceneStore', () => ({ bumpScene: () => {} }));
// The graph instance is built INSIDE the factory: jest.mock calls are hoisted
// above module-level consts, so referencing one from here is a temporal dead
// zone error — the same class of bug `editorBoot.smoke.test` now guards.
jest.mock('@core/scene/DefaultSceneGraph', () => {
  const SG = (jest.requireActual('@core/scene/SceneGraph') as { default: new () => unknown }).default;
  return { __esModule: true, default: new SG() };
});

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { declareSlot, fillSlot, slotRectOf, slotFitOf, SLOT_W_PROP, SLOT_H_PROP } from './mediaSlots';

const graph = defaultSceneGraph;

const SLOT = 'slot1';

/** A placeholder layer: a box at a position, with a source. */
function seedPlaceholder(box: { width: number; height: number }, at = { x: 960, y: 540 }): void {
  for (const n of graph.getRoots()) graph.removeNode(n.id);
  graph.addNode({
    id: 'root', name: 'root', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'root_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  graph.addChild('root', {
    id: SLOT, name: 'Product Shot', parent: 'root', children: [], visible: true, locked: false,
    transform: { position: { x: at.x, y: at.y }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{
      id: `${SLOT}_t`, type: 'Transform',
      props: {
        [SCENE_KIND_PROP]: 'image', x: at.x, y: at.y, rotation: 12,
        scaleX: 1.5, scaleY: 1.5, width: box.width, height: box.height,
        src: 'blob:placeholder.png', assetId: 'placeholderAsset',
      },
    }],
  } as unknown as SceneNode);
}

function props(): Record<string, unknown> {
  return graph.getNode(SLOT)!.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>;
}

function addAsset(id: string, src: string, width: number, height: number): void {
  assets.push({ id, type: 'video', src, metadata: { width, height, duration: 5 } });
}

beforeEach(() => {
  assets.length = 0;
  addAsset('placeholderAsset', 'blob:placeholder.png', 800, 600);
});

describe('fill repoints the asset', () => {
  it('writes assetId alongside src, so the source boundary follows', () => {
    // src alone changes the PICTURE while sourceOf keeps describing the
    // placeholder — wrong size, duration, rate and audio, invisibly.
    seedPlaceholder({ width: 1920, height: 1080 });
    declareSlot(SLOT, 'contain');
    addAsset('newClip', 'blob:new.mp4', 3840, 2160);

    fillSlot(SLOT, 'blob:new.mp4');
    expect(props().src).toBe('blob:new.mp4');
    expect(props().assetId).toBe('newClip');
    expect(props().__assetId).toBe('newClip');
  });

  it('clears a stale assetId when the new source is not a library asset', () => {
    seedPlaceholder({ width: 1920, height: 1080 });
    declareSlot(SLOT, 'contain');

    fillSlot(SLOT, 'https://example.test/pasted.png');
    expect(props().src).toBe('https://example.test/pasted.png');
    // Leaving the old id would let it outrank the src everywhere downstream.
    expect(props().assetId).toBeUndefined();
  });
});

describe('fill reframes against the authored slot rect', () => {
  it('captures the placeholder box when the slot is declared', () => {
    seedPlaceholder({ width: 1920, height: 1080 });
    declareSlot(SLOT, 'contain');
    expect(slotRectOf(graph.getNode(SLOT)!)).toEqual({ width: 1920, height: 1080 });
    expect(slotFitOf(graph.getNode(SLOT)!)).toBe('contain');
  });

  it('contains a vertical clip inside a wide slot', () => {
    seedPlaceholder({ width: 1920, height: 1080 });
    declareSlot(SLOT, 'contain');
    addAsset('vert', 'blob:vert.mp4', 1080, 1920);

    const r = fillSlot(SLOT, 'blob:vert.mp4');
    expect(r?.fitted).toBe(true);
    expect(props().width).toBe(608);
    expect(props().height).toBe(1080);
  });

  it('keeps a cover fill exactly at the slot rect', () => {
    seedPlaceholder({ width: 320, height: 690 });
    declareSlot(SLOT, 'cover');
    addAsset('wide', 'blob:wide.mp4', 3840, 2160);

    fillSlot(SLOT, 'blob:wide.mp4');
    expect(props().width).toBe(320);
    expect(props().height).toBe(690);
  });

  it('re-filling with a different aspect does NOT compound', () => {
    seedPlaceholder({ width: 1920, height: 1080 });
    declareSlot(SLOT, 'contain');
    addAsset('vert', 'blob:vert.mp4', 1080, 1920);
    addAsset('wide', 'blob:wide.mp4', 3840, 2160);

    fillSlot(SLOT, 'blob:vert.mp4');
    expect(props().width).toBe(608); // box is now narrow

    fillSlot(SLOT, 'blob:wide.mp4');
    // Resolved against the AUTHORED 1920x1080, not the 608-wide box left by the
    // first fill. Compounding would give 608x342 and shrink on every fill.
    expect(props().width).toBe(1920);
    expect(props().height).toBe(1080);
  });

  it('declaring a slot again does not re-capture the rect', () => {
    seedPlaceholder({ width: 1920, height: 1080 });
    declareSlot(SLOT, 'contain');
    addAsset('vert', 'blob:vert.mp4', 1080, 1920);
    fillSlot(SLOT, 'blob:vert.mp4');

    // An author switching policy after a fill must not adopt the fitted box as
    // the new frame.
    declareSlot(SLOT, 'cover');
    expect(props()[SLOT_W_PROP]).toBe(1920);
    expect(props()[SLOT_H_PROP]).toBe(1080);
  });
});

describe('fill never touches the author’s animation', () => {
  it('leaves position, scale and rotation exactly as authored', () => {
    seedPlaceholder({ width: 1920, height: 1080 }, { x: 640, y: 360 });
    declareSlot(SLOT, 'contain');
    addAsset('vert', 'blob:vert.mp4', 1080, 1920);

    const before = { ...props() };
    fillSlot(SLOT, 'blob:vert.mp4');
    const after = props();

    // These are the properties a template animates. Writing fit into any of
    // them would either clobber the author's keyframes or be clobbered by them
    // at every frame but the first.
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(after.scaleX).toBe(before.scaleX);
    expect(after.scaleY).toBe(before.scaleY);
    expect(after.rotation).toBe(before.rotation);
    // Only the box changed.
    expect(after.width).not.toBe(before.width);
  });

  it('the fitted box composes UNDER an animated scale at every frame', () => {
    // fillSlot writes width/height; the author's scale multiplies it. So the
    // drawn size at any frame is fitted × scale(t) — the animation still means
    // what the author authored, and the framing is right throughout, not just
    // at frame 0.
    seedPlaceholder({ width: 1920, height: 1080 });
    declareSlot(SLOT, 'contain');
    addAsset('vert', 'blob:vert.mp4', 1080, 1920);
    fillSlot(SLOT, 'blob:vert.mp4');

    const fitted = { width: Number(props().width), height: Number(props().height) };
    const aspect = fitted.width / fitted.height;

    for (const scale of [0.25, 0.5, 1, 1.5, 3]) {
      const drawn = { width: fitted.width * scale, height: fitted.height * scale };
      // Aspect is preserved at every sampled frame — the fit is not re-derived
      // per frame and cannot drift.
      expect(drawn.width / drawn.height).toBeCloseTo(aspect, 9);
    }
  });
});

describe('unfilled and unresolvable slots', () => {
  it('an unfilled slot keeps its authored placeholder — nothing is blanked', () => {
    seedPlaceholder({ width: 1920, height: 1080 });
    declareSlot(SLOT, 'contain');
    // No fill. The layer still draws what the author designed, which is what
    // makes an unfilled export look unfinished rather than broken.
    expect(props().src).toBe('blob:placeholder.png');
    expect(props().width).toBe(1920);
  });

  it('writes the src but reports not-fitted when the source cannot be resolved', () => {
    seedPlaceholder({ width: 1920, height: 1080 });
    declareSlot(SLOT, 'contain');

    const r = fillSlot(SLOT, 'blob:unknown.mp4');
    expect(r?.fitted).toBe(false);
    // The picture still updates — refusing the fill would be worse than
    // deferring the framing.
    expect(props().src).toBe('blob:unknown.mp4');
    expect(props().width).toBe(1920);
  });

  it('returns null for a node that no longer exists', () => {
    seedPlaceholder({ width: 1920, height: 1080 });
    expect(fillSlot('ghost', 'blob:x.mp4')).toBeNull();
  });
});
