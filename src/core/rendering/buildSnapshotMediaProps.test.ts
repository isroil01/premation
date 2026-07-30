/**
 * PROBE: the old Media-panel props were write-only — proven by behaviour.
 *
 * A grep found writes and no readers, but props can reach the renderer through a
 * generic passthrough (`readBase` scans EVERY component and copies a fixed set
 * of keys; an effect or style resolver could pick up others). A grep cannot see
 * that. So this asserts the only thing that actually matters: a layer carrying
 * `fitMode`, `cropTop/Right/Bottom/Left`, `speed`, `startOffset`, `loop` and
 * `muted` produces a render layer BYTE-IDENTICAL to one without them.
 *
 * If any of these ever gain a real reader, this test fails and tells whoever
 * added it that the Media panel's controls need to come back with it.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

const COMP = { width: 1920, height: 1080 };

/** The full set the Media panel used to write. */
const DEAD_PROPS = {
  fitMode: 'fit',
  cropTop: 120,
  cropRight: 240,
  cropBottom: 60,
  cropLeft: 300,
  speed: 0.25,
  startOffset: 3.5,
  loop: true,
  muted: true,
};

function scene(kind: string, extra: Record<string, unknown>) {
  const g = new SceneGraph();
  g.addNode({
    id: 'root', name: 'root', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'root_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  g.addChild('root', {
    id: 'clip', name: 'clip', parent: 'root', children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: 'clip_t',
        type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: kind,
          x: 960, y: 540, width: 1280, height: 720,
          src: 'blob:clip.mp4', assetId: 'asset1',
          ...extra,
        },
      },
      { id: 'clip_s', type: 'Style', props: { opacity: 100 } },
    ],
  } as unknown as SceneNode);
  return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
    ...COMP, background: '#000', rootId: 'root',
  } as never);
}

describe.each(['video', 'image'])('%s layer — dead Media props', (kind) => {
  it('renders identically with and without them', () => {
    const plain = scene(kind, {});
    const withProps = scene(kind, DEAD_PROPS);

    // The whole render layer, not a sampled field: anything the props touched —
    // geometry, clip rect, filters, source timing — would show up here.
    expect(withProps.layers).toEqual(plain.layers);
  });

  it('leaves the layer at its authored size (no fit, no crop applied)', () => {
    expect(scene(kind, DEAD_PROPS).layers[0]).toMatchObject({ width: 1280, height: 720 });
  });

  it('does not shift source time (speed / startOffset are inert)', () => {
    const a = scene(kind, {}).layers[0];
    const b = scene(kind, { ...DEAD_PROPS }).layers[0];
    expect(b?.sourceTime).toEqual(a?.sourceTime);
  });
});
