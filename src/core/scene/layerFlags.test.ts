/**
 * The AE switch verbs, as ONE set.
 *
 * Why this file exists: the knowledge of where each switch WRITES used to live
 * inline in `App.tsx`'s timeline handler, so nothing could test it without
 * standing the editor up, and anything else that wanted the same switch copied
 * it. What is pinned here is the part that copies get wrong:
 *   • a switch whose kind cannot carry it is refused, not lit (3D on a camera);
 *   • a composition root has no layer switches at all;
 *   • (the anchored multi-layer toggle, ONE undo entry, is the engine route —
 *     layout/Scene/layerSwitchEdits.test.ts).
 */

import defaultSceneGraph from './DefaultSceneGraph';
import {
  LAYER_FLAGS,
  describeLayerFlag,
  layerFlagAvailable,
  layerFlagDef,
  layerFlagRefusalReason,
  readLayerFlag,
  toggleLayerFlag,
} from './layerFlags';
import { readNodeQuality } from '@core/effects/layerQuality';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import { useSelectionStore } from '@stores/selectionStore';
import type { SceneNode } from '@core/types';

function node(id: string, kind: string, parent: string | null = 'root'): SceneNode {
  return {
    id,
    name: id,
    parent,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, width: 10, height: 10 } }],
  } as unknown as SceneNode;
}

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) } as never));
});

beforeEach(() => {
  useSelectionStore.getState().set([]);
  for (const r of [...defaultSceneGraph.getRoots()]) defaultSceneGraph.removeNode(r.id);
  defaultSceneGraph.addNode(node('root', 'group', null));
  defaultSceneGraph.addChild('root', node('a', 'shape'));
  defaultSceneGraph.addChild('root', node('b', 'shape'));
  defaultSceneGraph.addChild('root', node('cam', 'camera'));
  defaultSceneGraph.addChild('root', node('txt', 'text'));
  defaultSceneGraph.addChild('root', node('vid', 'video'));
});

const get = (id: string): SceneNode => defaultSceneGraph.getNode(id)!;

describe('the table', () => {
  it('gives every flag a label and either an icon or a glyph', () => {
    for (const def of LAYER_FLAGS) {
      expect(def.label).toBeTruthy();
      expect(def.title).toBeTruthy();
      expect(def.icon ?? def.glyph).toBeTruthy();
      expect(layerFlagDef(def.id)).toBe(def);
    }
  });
});

describe('availability', () => {
  it('refuses 3D on a kind the renderer cannot project', () => {
    // Lighting a cube that changes no pixel is the failure mode this prevents.
    expect(layerFlagAvailable(get('cam'), 'threeD')).toBe(false);
    expect(layerFlagAvailable(get('a'), 'threeD')).toBe(true);
  });

  it('gives a composition root no layer switches at all', () => {
    for (const def of LAYER_FLAGS) {
      expect(layerFlagAvailable(get('root'), def.id)).toBe(false);
    }
    expect(layerFlagRefusalReason(get('root'), 'shy')).toBe('A composition has no layer switches');
  });

  it('says WHY a refused flag is refused, in the layer\'s own terms', () => {
    expect(layerFlagRefusalReason(get('cam'), 'threeD')).toBe("3D Layer isn't available for camera layers");
    expect(layerFlagRefusalReason(get('a'), 'threeD')).toBeNull();
  });
});

describe('read and toggle', () => {
  it('round-trips shy, which is view state with no render meaning', () => {
    expect(readLayerFlag(get('a'), 'shy')).toBe(false);
    toggleLayerFlag('a', 'shy');
    expect(readLayerFlag(get('a'), 'shy')).toBe(true);
    toggleLayerFlag('a', 'shy');
    expect(readLayerFlag(get('a'), 'shy')).toBe(false);
  });

  it('honours an explicit target instead of inverting', () => {
    toggleLayerFlag('a', 'shy', true);
    toggleLayerFlag('a', 'shy', true);
    expect(readLayerFlag(get('a'), 'shy')).toBe(true);
  });

  it('refuses rather than writes when the kind cannot carry the flag', () => {
    expect(toggleLayerFlag('cam', 'threeD')).toBe(false);
    expect(readLayerFlag(get('cam'), 'threeD')).toBe(false);
  });

  it('reads fx as ON until it is explicitly turned off', () => {
    expect(readLayerFlag(get('a'), 'fxEnabled')).toBe(true);
    toggleLayerFlag('a', 'fxEnabled');
    expect(readLayerFlag(get('a'), 'fxEnabled')).toBe(false);
  });
});

describe('the three switches the Layers panel could not reach', () => {
  /*
    Collapse / Quality / Frame Blending lived in `layout/Timeline/layerSwitches`
    — a LAYOUT module holding core verbs — so the only panel that could offer
    them was the one they happened to sit next to. They are here now, and the
    timeline's three functions are thin wrappers over these.
  */
  it('gives the sunburst its per-layer meaning rather than one fixed name', () => {
    // AE draws ONE switch and gives it one meaning per layer type; calling it
    // "Collapse Transformations" on a text layer names something text cannot do.
    expect(describeLayerFlag(get('txt'), 'collapse').label).toBe('Continuous Rasterize');
    expect(layerFlagAvailable(get('txt'), 'collapse')).toBe(true);
    // A shape with no vector body and no comp behind it gets no sunburst.
    expect(layerFlagAvailable(get('cam'), 'collapse')).toBe(false);
  });

  it('round-trips continuous rasterize on a vector layer', () => {
    expect(readLayerFlag(get('txt'), 'collapse')).toBe(false);
    toggleLayerFlag('txt', 'collapse');
    expect(readLayerFlag(get('txt'), 'collapse')).toBe(true);
  });

  it('offers frame blending only where there are source frames to blend', () => {
    expect(layerFlagAvailable(get('vid'), 'frameBlend')).toBe(true);
    expect(layerFlagAvailable(get('a'), 'frameBlend')).toBe(false);
    toggleLayerFlag('vid', 'frameBlend');
    expect(readLayerFlag(get('vid'), 'frameBlend')).toBe(true);
  });

  it('cycles Quality through the three AE positions rather than toggling', () => {
    expect(readNodeQuality(get('a'))).toBe('best');
    toggleLayerFlag('a', 'quality');
    expect(readNodeQuality(get('a'))).toBe('draft');
    toggleLayerFlag('a', 'quality');
    expect(readNodeQuality(get('a'))).toBe('wireframe');
    toggleLayerFlag('a', 'quality');
    expect(readNodeQuality(get('a'))).toBe('best');
  });

  it('reads Quality as "on" when it is off its default, and names the position', () => {
    // A lit switch means "not the default", which is what a reader scanning a
    // column of switches takes it to mean; the NAME carries which position.
    expect(readLayerFlag(get('a'), 'quality')).toBe(false);
    expect(describeLayerFlag(get('a'), 'quality').label).toBe('Quality: Best');
    toggleLayerFlag('a', 'quality');
    expect(readLayerFlag(get('a'), 'quality')).toBe(true);
    expect(describeLayerFlag(get('a'), 'quality').label).toBe('Quality: Draft');
  });

  it('gives no quality switch to the chrome-only kinds', () => {
    expect(layerFlagAvailable(get('cam'), 'quality')).toBe(false);
    expect(layerFlagAvailable(get('a'), 'quality')).toBe(true);
  });
});
