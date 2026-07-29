/**
 * The SceneGraphPort must announce a change when the 3D VIEW changes.
 *
 * Every node the port emits carries `worldMatrix` / `worldBounds` /
 * `worldCorners` projected through `currentViewProjector`, so switching
 * Front → Top moves every 3D layer on screen even though the scene graph itself
 * is untouched. The Workspace invalidates its hit-test spatial index from this
 * one signal (`scene.onChanged` → `hitTester.markDirty`), so when the view was
 * not part of it the index kept describing the PREVIOUS view: layers were
 * unselectable wherever they had moved to, and their stale positions still
 * answered clicks.
 *
 * Measured before the fix, in Top view after arriving from Left: the index root
 * was still Left's extent, and two of three layers could not be hit at all.
 */

import { createSceneGraphPort } from './ports';
import { useGuidesStore } from '@stores/guidesStore';

describe('SceneGraphPort — the view is an input', () => {
  const initialMode = useGuidesStore.getState().camera3dMode;
  const initialCustom = useGuidesStore.getState().customViews;

  afterEach(() => {
    useGuidesStore.setState({ camera3dMode: initialMode, customViews: initialCustom });
  });

  it('notifies when the ortho view changes', () => {
    const port = createSceneGraphPort();
    let fired = 0;
    const off = port.onChanged(() => { fired += 1; });

    useGuidesStore.getState().setCamera3dMode('left');
    expect(fired).toBeGreaterThan(0);

    const afterLeft = fired;
    useGuidesStore.getState().setCamera3dMode('top');
    expect(fired).toBeGreaterThan(afterLeft);

    off();
  });

  it('notifies when a custom view orbits', () => {
    useGuidesStore.getState().setCamera3dMode('custom1');
    const port = createSceneGraphPort();
    let fired = 0;
    const off = port.onChanged(() => { fired += 1; });

    useGuidesStore.getState().updateCustomView('custom1', { yaw: 42, pitch: -12 });
    expect(fired).toBeGreaterThan(0);

    off();
  });

  it('does not fire for unrelated guide state', () => {
    const port = createSceneGraphPort();
    let fired = 0;
    const off = port.onChanged(() => { fired += 1; });

    // Toggling the grid changes `guidesStore` but not the projection, so the
    // hit-test index does not need rebuilding — a listener that woke for every
    // guide-store write would re-enumerate the scene on each one.
    useGuidesStore.getState().toggleGrid();
    expect(fired).toBe(0);

    useGuidesStore.getState().toggleGrid();
    off();
  });

  it('stops notifying after unsubscribe', () => {
    const port = createSceneGraphPort();
    let fired = 0;
    const off = port.onChanged(() => { fired += 1; });
    off();

    useGuidesStore.getState().setCamera3dMode('right');
    expect(fired).toBe(0);
  });
});
