/**
 * Layer markers survive the round trip through LAYER time.
 *
 * They are stored relative to the layer's in-point so they travel with a trimmed
 * or slid layer, while every surface that draws them works in comp seconds.
 * Writing without reading back through `toAbsoluteTime` puts them on the wrong
 * axis — and until now there was no read path at all, so a marker added from the
 * timeline was simply invisible.
 */

import { getTimelineController } from './TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useProjectStore } from '@stores/projectStore';
import type { SceneNode } from '@core/types';

const NODE = 'lm_rect';

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

beforeEach(() => {
  resetScene();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Main', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  defaultSceneGraph.addChild('comp_root', {
    id: NODE, name: NODE, parent: 'comp_root', children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${NODE}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 10, y: 10, width: 20, height: 20 } },
      { id: `${NODE}_s`, type: 'Style', props: { opacity: 100, fill: '#fff' } },
    ],
  } as never);
  useProjectStore.getState().actions.replaceComps({
    comp_root: {
      id: 'comp_root', name: 'Main', width: 1920, height: 1080, fps: 30,
      durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0,
    },
  });
  const proj = useProjectStore.getState();
  const tabId = proj.actions.openTab('comp_root', ['comp_root'], 'Main');
  proj.actions.setActiveTab(tabId);
  getTimelineController().syncFromScene('comp_root');
});

describe('layer markers', () => {
  it('reads back a marker written at the playhead, in comp time', () => {
    const c = getTimelineController();
    c.seekSeconds(1);
    expect(c.addLayerMarkerAtPlayhead(NODE, 'A')).toBe(true);
    const markers = c.getLayerMarkers(NODE);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.time).toBeCloseTo(1, 2);
    expect(markers[0]!.label).toBe('A');
  });

  it('keeps comp time correct for a layer that does not start at zero', () => {
    const c = getTimelineController();
    const layer = c.getLayersForNode(NODE)[0];
    if (!layer) throw new Error('no layer');
    const fps = c.timeline.getFrameRate().fps;
    c.timeline.setLayerStart(layer.id, Math.round(2 * fps));
    c.seekSeconds(3);
    c.addLayerMarkerAtPlayhead(NODE, 'B');
    // Stored 1s into the layer, read back as 3s on the comp axis. Without the
    // conversion this reads 1 — a marker drawn two seconds early.
    expect(c.getLayerMarkers(NODE)[0]!.time).toBeCloseTo(3, 2);
  });

  it('does not leak layer markers into the comp marker list', () => {
    const c = getTimelineController();
    c.seekSeconds(1);
    c.addLayerMarkerAtPlayhead(NODE, 'C');
    expect(c.getMarkers().some((m) => m.label === 'C')).toBe(false);
  });

  it('returns nothing for a node with no layer', () => {
    expect(getTimelineController().getLayerMarkers('no_such_node')).toEqual([]);
  });
});
