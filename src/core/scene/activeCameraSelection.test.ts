/**
 * ONE camera-selection rule, shared by every consumer.
 *
 * The renderer took the LAST camera in a composition (topmost — correct) while
 * `findCameraNav`, which is what the C tool and Alt-drag navigate with, took the
 * FIRST. Paint order is back-to-front, so "first" is the BOTTOM-most camera:
 * with two cameras in a comp the user looked through one and every camera drag
 * moved the other. Nothing on screen explained it.
 *
 * Neither site checked whether the camera was enabled or live at the current
 * time, so a hidden camera — or one trimmed to the back half of the comp —
 * still steered the frame.
 */

import SceneGraph from '@core/scene/SceneGraph';
import { activeCameraNode } from '@core/scene/camera3d';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

function node(
  id: string,
  kind: string,
  props: Record<string, unknown> = {},
  extra: Partial<SceneNode> = {},
): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, ...props } }],
    ...extra,
  } as unknown as SceneNode;
}

/** A comp holding, in paint order (back → front), the given camera ids. */
function comp(rootId: string, cams: Array<{ id: string; visible?: boolean }>): SceneGraph {
  const g = new SceneGraph();
  g.addNode(node(rootId, 'group'));
  for (const c of cams) {
    g.addChild(rootId, node(c.id, 'camera', { x: 0, y: 0 }, { visible: c.visible ?? true }));
  }
  return g;
}

describe('the active camera is the TOPMOST one', () => {
  it('takes the last in paint order, not the first', () => {
    const g = comp('root', [{ id: 'bottom' }, { id: 'top' }]);
    expect(activeCameraNode(g, 'root')?.id).toBe('top');
  });

  it('falls through to the next camera down when the topmost is hidden', () => {
    const g = comp('root', [{ id: 'bottom' }, { id: 'top', visible: false }]);
    expect(activeCameraNode(g, 'root')?.id).toBe('bottom');
  });

  it('returns null when every camera is hidden', () => {
    const g = comp('root', [{ id: 'a', visible: false }, { id: 'b', visible: false }]);
    expect(activeCameraNode(g, 'root')).toBeNull();
  });
});

describe('the active camera must be LIVE at the current time', () => {
  it('skips a camera whose layer is outside its in/out range', () => {
    const g = comp('root', [{ id: 'bottom' }, { id: 'top' }]);
    // `top` is trimmed away at this frame ⇒ the shot falls to `bottom`.
    const live = activeCameraNode(g, 'root', { isLiveAt: (id) => id !== 'top' });
    expect(live?.id).toBe('bottom');
  });

  it('returns null when no camera is live', () => {
    const g = comp('root', [{ id: 'a' }, { id: 'b' }]);
    expect(activeCameraNode(g, 'root', { isLiveAt: () => false })).toBeNull();
  });

  it('without a liveness gate every camera counts (unchanged default)', () => {
    const g = comp('root', [{ id: 'a' }, { id: 'b' }]);
    expect(activeCameraNode(g, 'root')?.id).toBe('b');
  });
});

describe('a camera belongs to its own composition', () => {
  it('never returns a camera from a different comp', () => {
    const g = new SceneGraph();
    g.addNode(node('rootA', 'group'));
    g.addNode(node('rootB', 'group'));
    g.addChild('rootA', node('camA', 'camera', { x: 0, y: 0 }));
    g.addChild('rootB', node('camB', 'camera', { x: 0, y: 0 }));
    expect(activeCameraNode(g, 'rootA')?.id).toBe('camA');
    expect(activeCameraNode(g, 'rootB')?.id).toBe('camB');
  });

  it('returns null for a comp with no camera, even when a sibling comp has one', () => {
    const g = new SceneGraph();
    g.addNode(node('rootA', 'group'));
    g.addNode(node('rootB', 'group'));
    g.addChild('rootB', node('camB', 'camera', { x: 0, y: 0 }));
    expect(activeCameraNode(g, 'rootA')).toBeNull();
  });
});
