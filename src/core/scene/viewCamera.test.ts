/**
 * "Look through a specific camera" — AE's per-camera entries in the 3D View
 * list.
 *
 * The active-camera rule always takes the TOPMOST enabled camera, so with two
 * cameras in a comp the lower one could be edited but never seen. A
 * `camera:<id>` view names the node to look through instead; everything that
 * resolves a camera for a view goes through `viewCameraNode`, and a name that
 * can no longer be looked through must fall back to the active camera rather
 * than to a blank or default-camera frame.
 */

import SceneGraph from '@core/scene/SceneGraph';
import {
  lookThroughCamera,
  lookThroughCameras,
  readSceneCamera,
  readSceneDof,
  viewCameraNode,
} from '@core/scene/camera3d';
import {
  cameraViewMode,
  cameraViewNodeId,
  isCameraViewMode,
  isSceneCameraView,
  orthoViewOf,
} from '@core/scene/cameraViewMode';

import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/sceneKind';

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

/**
 * One comp, in paint order (back → front): `low` (focal 1000, DOF on) under
 * `high` (focal 4000), plus a solid. `high` is the active camera.
 */
function twoCameraComp(opts: { lowVisible?: boolean } = {}): SceneGraph {
  const g = new SceneGraph();
  g.addNode(node('root', 'group'));
  g.addChild('root', node('low', 'camera', { x: 0, y: 0, focalLength: 1000, dofStrength: 12 }, { visible: opts.lowVisible ?? true }));
  g.addChild('root', node('solid', 'solid'));
  g.addChild('root', node('high', 'camera', { x: 0, y: 0, focalLength: 4000 }));
  return g;
}

describe('camera view modes (string helpers)', () => {
  it('round-trips a node id through the mode string', () => {
    const mode = cameraViewMode('cam_7');
    expect(mode).toBe('camera:cam_7');
    expect(isCameraViewMode(mode)).toBe(true);
    expect(cameraViewNodeId(mode)).toBe('cam_7');
  });

  it('keeps ids that themselves contain a colon intact', () => {
    expect(cameraViewNodeId(cameraViewMode('comp:a::cam'))).toBe('comp:a::cam');
  });

  it('is not a camera view for any other mode, or for a bare prefix', () => {
    for (const m of ['active', 'front', 'top', 'custom1', 'camera:', 'camera', '', undefined, null]) {
      expect(isCameraViewMode(m)).toBe(false);
      expect(cameraViewNodeId(m)).toBeNull();
    }
  });

  it('isSceneCameraView: Active Camera and camera views are the shot; the rest are not', () => {
    expect(isSceneCameraView('active')).toBe(true);
    expect(isSceneCameraView('camera:high')).toBe(true);
    for (const m of ['front', 'back', 'left', 'right', 'top', 'bottom', 'custom1', 'custom2', 'custom3']) {
      expect(isSceneCameraView(m)).toBe(false);
    }
  });

  it('orthoViewOf is a whitelist — a camera view is never cast to an axis view', () => {
    expect(orthoViewOf('top')).toBe('top');
    expect(orthoViewOf('bottom')).toBe('bottom');
    expect(orthoViewOf('active')).toBeNull();
    expect(orthoViewOf('custom2')).toBeNull();
    expect(orthoViewOf('camera:front')).toBeNull();
    expect(orthoViewOf('sideways')).toBeNull();
  });
});

describe('viewCameraNode — the camera a view looks through', () => {
  it("'active' (and every non-camera mode) is the topmost camera", () => {
    const g = twoCameraComp();
    expect(viewCameraNode(g, 'active', 'root')?.id).toBe('high');
    expect(viewCameraNode(g, 'top', 'root')?.id).toBe('high');
    expect(viewCameraNode(g, undefined, 'root')?.id).toBe('high');
  });

  it('a camera view looks through the NAMED camera, not the topmost', () => {
    const g = twoCameraComp();
    expect(viewCameraNode(g, cameraViewMode('low'), 'root')?.id).toBe('low');
  });

  it('the named camera ignores liveness — previewing a camera outside its bar is the point', () => {
    const g = twoCameraComp();
    const onlyHighLive = { isLiveAt: (id: string) => id === 'high' };
    expect(viewCameraNode(g, cameraViewMode('low'), 'root', onlyHighLive)?.id).toBe('low');
  });

  it('falls back to the active camera when the named node is gone', () => {
    const g = twoCameraComp();
    expect(viewCameraNode(g, cameraViewMode('deleted'), 'root')?.id).toBe('high');
  });

  it('falls back when the named node is not a camera', () => {
    const g = twoCameraComp();
    expect(viewCameraNode(g, cameraViewMode('solid'), 'root')?.id).toBe('high');
  });

  it('falls back when the named camera is disabled', () => {
    const g = twoCameraComp({ lowVisible: false });
    expect(viewCameraNode(g, cameraViewMode('low'), 'root')?.id).toBe('high');
  });

  it('falls back when the named camera belongs to another composition', () => {
    const g = twoCameraComp();
    g.addNode(node('otherRoot', 'group'));
    g.addChild('otherRoot', node('elsewhere', 'camera', { x: 0, y: 0 }));
    expect(viewCameraNode(g, cameraViewMode('elsewhere'), 'root')?.id).toBe('high');
  });

  it('the fallback still honours the active rule, liveness included', () => {
    const g = twoCameraComp();
    const onlyLowLive = { isLiveAt: (id: string) => id === 'low' };
    expect(viewCameraNode(g, cameraViewMode('deleted'), 'root', onlyLowLive)?.id).toBe('low');
  });
});

describe('readSceneCamera / readSceneDof honour the view', () => {
  it('projects through the named camera', () => {
    const g = twoCameraComp();
    expect(readSceneCamera(g, 1920, 1080, undefined, 'root').focalLength).toBe(4000);
    const viaLow = readSceneCamera(g, 1920, 1080, undefined, 'root', undefined, { view: cameraViewMode('low') });
    expect(viaLow.focalLength).toBe(1000);
  });

  it('reads depth of field off the SAME camera it projects through', () => {
    const g = twoCameraComp();
    // `high` has no blur level, so the shot has no DOF …
    expect(readSceneDof(g, 1920, 1080, undefined, 'root')).toBeNull();
    // … but looking through `low` gets low's.
    const dof = readSceneDof(g, 1920, 1080, undefined, 'root', { view: cameraViewMode('low') });
    expect(dof?.strength).toBe(12);
  });

  it('a stale view renders exactly like Active Camera', () => {
    const g = twoCameraComp();
    const active = readSceneCamera(g, 1920, 1080, undefined, 'root');
    const stale = readSceneCamera(g, 1920, 1080, undefined, 'root', undefined, { view: cameraViewMode('gone') });
    expect(stale).toEqual(active);
  });
});

describe('the camera list the view menus show', () => {
  it('lists every enabled camera in the comp, topmost first', () => {
    const g = twoCameraComp();
    expect(lookThroughCameras(g, 'root').map((n) => n.id)).toEqual(['high', 'low']);
  });

  it('omits disabled cameras — they would only ever fall back', () => {
    const g = twoCameraComp({ lowVisible: false });
    expect(lookThroughCameras(g, 'root').map((n) => n.id)).toEqual(['high']);
    expect(lookThroughCamera(g, 'low', 'root')).toBeNull();
  });
});
