/**
 * The projector memo must be a pure speed-up — never a source of stale views.
 *
 * It exists because rebuilding the hit-test index called this once per node, and
 * each call walked the whole scene twice to find the camera. The safety property
 * is that the cache cannot outlive the synchronous burst it was built for.
 */

import { currentViewProjector, resetViewProjectorCache } from './viewProjection';
import { useGuidesStore } from '@stores/guidesStore';

describe('view projector cache', () => {
  beforeEach(() => {
    resetViewProjectorCache();
    useGuidesStore.setState({ camera3dMode: 'active' } as never);
  });

  it('hands back the same projector for repeated calls in one task', () => {
    const a = currentViewProjector(800, 600, 0);
    const b = currentViewProjector(800, 600, 0);
    expect(b).toBe(a);
  });

  it('rebuilds for a different time', () => {
    const a = currentViewProjector(800, 600, 0);
    const b = currentViewProjector(800, 600, 1);
    expect(b).not.toBe(a);
  });

  it('rebuilds for a different viewport size', () => {
    const a = currentViewProjector(800, 600, 0);
    expect(currentViewProjector(1920, 1080, 0)).not.toBe(a);
  });

  it('rebuilds when the view mode changes', () => {
    const a = currentViewProjector(800, 600, 0);
    useGuidesStore.setState({ camera3dMode: 'top' } as never);
    expect(currentViewProjector(800, 600, 0)).not.toBe(a);
  });

  it('drops the cache before any other work can run', async () => {
    // The guarantee that makes this safe: a camera edit, a keyframe change or an
    // orbit landing in a LATER task can never be served a projector built
    // before it, no matter which store it touched.
    const a = currentViewProjector(800, 600, 0);
    await Promise.resolve();
    expect(currentViewProjector(800, 600, 0)).not.toBe(a);
  });

  it('still projects — an ortho view maps the comp centre to the centre', () => {
    useGuidesStore.setState({ camera3dMode: 'front' } as never);
    const p = currentViewProjector(800, 600, 0)({ x: 400, y: 300, z: 0 });
    expect(p.x).toBeCloseTo(400, 3);
    expect(p.y).toBeCloseTo(300, 3);
  });
});
