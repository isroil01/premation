/**
 * A `cover` media slot crops in UV space, so it cannot overflow its slot.
 *
 * Cover has to fill the slot rect and discard the overflow. The obvious
 * implementation — scale the quad until it covers, then clip — needs a clipping
 * step, and a cover that forgets to clip is WORSE than the unfitted default it
 * replaces: instead of a squashed image inside the slot you get the user's
 * footage painted over the rest of the composition.
 *
 * So the geometry never grows. The quad stays exactly the slot rect and the
 * crop happens in the texture's own coordinates. This asserts both halves at
 * the snapshot level: the emitted layer is slot-sized, and it carries a uvRect
 * that selects the centred sub-region of the source.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { SLOT_FIT_PROP, SLOT_W_PROP, SLOT_H_PROP } from '@core/template/mediaSlots';

const COMP = { width: 1920, height: 1080 };

const assets: Array<Record<string, unknown>> = [];
jest.mock('@stores/assetStore', () => ({ useAssetStore: { getState: () => ({ assets }) } }));

function scene(box: { width: number; height: number }, fit?: string) {
  const g = new SceneGraph();
  g.addNode({
    id: 'root', name: 'root', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'root_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  g.addChild('root', {
    id: 'slot', name: 'slot', parent: 'root', children: [], visible: true, locked: false,
    transform: { position: { x: 960, y: 540 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: 'slot_t', type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'video', x: 960, y: 540,
          width: box.width, height: box.height,
          src: 'blob:clip.mp4', assetId: 'clip',
          ...(fit ? { [SLOT_FIT_PROP]: fit, [SLOT_W_PROP]: box.width, [SLOT_H_PROP]: box.height } : {}),
        },
      },
      { id: 'slot_s', type: 'Style', props: { opacity: 100 } },
    ],
  } as unknown as SceneNode);
  return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
    ...COMP, background: '#000', rootId: 'root',
  } as never);
}

function setSource(width: number, height: number): void {
  assets.length = 0;
  assets.push({ id: 'clip', type: 'video', src: 'blob:clip.mp4', metadata: { width, height, duration: 5 } });
}

describe('cover slot', () => {
  it('emits a uvRect that crops a tall source to the slot aspect', () => {
    setSource(1080, 1920); // 9:16 into a 16:9 slot
    const layer = scene({ width: 1920, height: 1080 }, 'cover').layers[0] as unknown as Record<string, unknown>;
    const uv = layer.uvRect as { x: number; y: number; width: number; height: number };

    expect(uv).toBeDefined();
    expect(uv.width).toBeCloseTo(1, 6);          // full width kept
    expect(uv.height).toBeLessThan(1);           // top and bottom cropped
    expect(uv.y).toBeCloseTo((1 - uv.height) / 2, 6); // centred
  });

  it('keeps the drawn box at the slot rect — no overflow, ever', () => {
    setSource(1080, 1920);
    const layer = scene({ width: 1920, height: 1080 }, 'cover').layers[0] as unknown as Record<string, unknown>;
    expect(layer.width).toBe(1920);
    expect(layer.height).toBe(1080);
  });

  it('crops a wide source into a narrow slot on the other axis', () => {
    setSource(3840, 2160); // 16:9 into a phone screen
    const layer = scene({ width: 320, height: 690 }, 'cover').layers[0] as unknown as Record<string, unknown>;
    const uv = layer.uvRect as { x: number; width: number; height: number };
    expect(uv.height).toBeCloseTo(1, 6);
    expect(uv.width).toBeLessThan(0.3);
    expect(uv.x).toBeCloseTo((1 - uv.width) / 2, 6);
    // Still exactly the slot.
    expect(layer.width).toBe(320);
    expect(layer.height).toBe(690);
  });

  it('emits no uvRect when the aspects already match', () => {
    setSource(3840, 2160);
    const layer = scene({ width: 1920, height: 1080 }, 'cover').layers[0] as unknown as Record<string, unknown>;
    // Nothing to crop — the renderer keeps its default full-texture path.
    expect(layer.uvRect).toBeUndefined();
  });
});

describe('non-cover slots', () => {
  it('a contain slot emits no uvRect — it letterboxes by box size instead', () => {
    setSource(1080, 1920);
    const layer = scene({ width: 608, height: 1080 }, 'contain').layers[0] as unknown as Record<string, unknown>;
    expect(layer.uvRect).toBeUndefined();
  });

  it('a layer that is not a slot at all emits no uvRect', () => {
    setSource(1080, 1920);
    const layer = scene({ width: 1920, height: 1080 }).layers[0] as unknown as Record<string, unknown>;
    expect(layer.uvRect).toBeUndefined();
  });

  it('emits no uvRect when the source size is unknown', () => {
    assets.length = 0; // metadata not resolved yet
    const layer = scene({ width: 1920, height: 1080 }, 'cover').layers[0] as unknown as Record<string, unknown>;
    expect(layer.uvRect).toBeUndefined();
  });
});
