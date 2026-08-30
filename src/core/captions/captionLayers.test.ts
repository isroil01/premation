/**
 * Cues → layers → cues.
 *
 * The round trip is the whole claim of this module: a caption is a text layer
 * whose clip bar is its cue, so exporting has to read the BARS and not anything
 * remembered at import. Every test below is really the same question — after
 * the user moves, retimes or edits a caption, does the file say what the
 * picture shows.
 *
 * Runs against the real scene graph and the real timeline controller, because
 * the wiring is the part that breaks: `trimClipTo` clamps an inverted clip, and
 * getting the two edges in the wrong order silently produces one-frame
 * captions that no unit test of the format would ever see.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useProjectStore } from '@stores/projectStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import {
  CAPTION_PROP,
  captionNodes,
  insertCaptionLayers,
  isCaptionNode,
  readCaptionCues,
  removeCaptionLayers,
} from './captionLayers';
import type { Cue } from './captionFormat';

const CUES: Cue[] = [
  { start: 1, end: 3, text: 'The first caption' },
  { start: 4, end: 6, text: 'The second caption' },
];

function root(): SceneNode {
  return {
    id: 'comp_root',
    name: 'comp_root',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  };
}

// Captions are inserted inside a document transaction, and a transaction
// suspends the command history — so the suite needs a real CommandSystem even
// though nothing here presses undo.
beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

beforeEach(() => {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultSceneGraph.addNode(root());

  // A comp long enough to hold the cues — a shorter one would clamp the bars
  // and the test would be measuring the clamp.
  useProjectStore.getState().actions.updateComp('comp_root', {
    id: 'comp_root',
    name: 'Main',
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 10,
    background: '#000000',
    transparent: false,
    startFrame: 0,
  });
  getTimelineController().syncFromScene('comp_root');
});

describe('insertCaptionLayers', () => {
  it('creates one layer per cue', () => {
    const result = insertCaptionLayers(CUES);
    expect(result.nodeIds).toHaveLength(2);
    expect(captionNodes('comp_root')).toHaveLength(2);
  });

  it('marks each layer so it can be found again', () => {
    insertCaptionLayers(CUES);
    for (const node of captionNodes('comp_root')) expect(isCaptionNode(node)).toBe(true);
  });

  it('writes the cue text into the layer', () => {
    insertCaptionLayers([{ start: 0, end: 1, text: 'Hello there' }]);
    const node = captionNodes('comp_root')[0] as SceneNode;
    const text = node.components.find((c) => c.type === 'Text');
    expect(text?.props.content).toBe('Hello there');
    expect(text?.props[CAPTION_PROP]).toBe(true);
  });

  it('times each clip bar to its cue, which is the whole design', () => {
    insertCaptionLayers(CUES);
    const cues = readCaptionCues('comp_root');
    expect(cues[0]?.start).toBeCloseTo(1, 2);
    expect(cues[0]?.end).toBeCloseTo(3, 2);
    expect(cues[1]?.start).toBeCloseTo(4, 2);
    expect(cues[1]?.end).toBeCloseTo(6, 2);
  });

  it('does not collapse a cue to a single frame', () => {
    // The failure this guards: trimming the head before the tail inverts the
    // clip, the timeline clamps it, and every caption becomes one frame long.
    insertCaptionLayers(CUES);
    for (const cue of readCaptionCues('comp_root')) {
      expect(cue.end - cue.start).toBeGreaterThan(1);
    }
  });

  it('sizes captions from the composition, not from a fixed pixel value', () => {
    insertCaptionLayers([{ start: 0, end: 1, text: 'Hello' }]);
    const node = captionNodes('comp_root')[0] as SceneNode;
    const fontSize = node.components.find((c) => c.type === 'Text')?.props.fontSize as number;
    // 5% of a 1080-tall comp. The exact number matters less than that it scales.
    expect(fontSize).toBe(54);
  });

  it('places captions near the bottom of the frame', () => {
    insertCaptionLayers([{ start: 0, end: 1, text: 'Hello' }]);
    const node = captionNodes('comp_root')[0] as SceneNode;
    const transform = node.components.find((c) => c.type === 'Transform');
    expect(transform?.props.x).toBe(960);
    expect(transform?.props.y).toBeGreaterThan(900);
  });

  it('wraps a long caption rather than letting it run off the frame', () => {
    const long = 'This is a very long caption indeed and it will certainly not fit on one line of video';
    insertCaptionLayers([{ start: 0, end: 3, text: long }]);
    const content = captionNodes('comp_root')[0]?.components.find((c) => c.type === 'Text')?.props.content;
    expect(String(content)).toContain('\n');
  });

  it('drops overlapping cues and says how many', () => {
    const result = insertCaptionLayers([
      { start: 0, end: 5, text: 'first' },
      { start: 0.001, end: 4, text: 'swallowed' },
    ]);
    expect(result.nodeIds).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });

  it('creates nothing for an empty cue list', () => {
    expect(insertCaptionLayers([]).nodeIds).toHaveLength(0);
  });
});

describe('readCaptionCues', () => {
  it('reports a re-timed caption at its NEW time', () => {
    insertCaptionLayers([{ start: 1, end: 3, text: 'moved' }]);
    const controller = getTimelineController();
    const nodeId = (captionNodes('comp_root')[0] as SceneNode).id;
    const layer = controller.getLayersForNode(nodeId)[0];
    controller.trimClipTo(layer!.id, 'end', 8);
    controller.trimClipTo(layer!.id, 'start', 6);
    controller.invalidateLayerIndex();

    const cues = readCaptionCues('comp_root');
    expect(cues[0]?.start).toBeCloseTo(6, 2);
    expect(cues[0]?.end).toBeCloseTo(8, 2);
  });

  it('ignores layers that are not captions', () => {
    insertCaptionLayers([{ start: 0, end: 1, text: 'a caption' }]);
    const plain = root();
    plain.id = 'plain_layer';
    plain.parent = 'comp_root';
    defaultSceneGraph.addChild('comp_root', plain);
    getTimelineController().syncFromScene('comp_root');

    expect(readCaptionCues('comp_root')).toHaveLength(1);
  });

  it('returns cues in time order however the layers are stacked', () => {
    insertCaptionLayers([
      { start: 4, end: 5, text: 'later' },
      { start: 1, end: 2, text: 'earlier' },
    ]);
    expect(readCaptionCues('comp_root').map((c) => c.text)).toEqual(['earlier', 'later']);
  });
});

describe('removeCaptionLayers', () => {
  it('removes every caption and reports the count', () => {
    insertCaptionLayers(CUES);
    expect(removeCaptionLayers('comp_root')).toBe(2);
    expect(captionNodes('comp_root')).toHaveLength(0);
  });

  it('leaves other layers alone', () => {
    insertCaptionLayers(CUES);
    const plain = root();
    plain.id = 'plain_layer';
    plain.parent = 'comp_root';
    defaultSceneGraph.addChild('comp_root', plain);

    removeCaptionLayers('comp_root');
    expect(defaultSceneGraph.getNode('plain_layer')).toBeDefined();
  });

  it('is a no-op on a composition with no captions', () => {
    expect(removeCaptionLayers('comp_root')).toBe(0);
  });
});
