/**
 * M7 — the responsive-time config round-trips through the scene.
 *
 * The pure map is tested in responsiveTime.test.ts. This covers the READ path:
 * a config that cannot be read back is a control that does nothing, which is the
 * failure mode this codebase keeps deleting.
 */

jest.mock('@stores/sceneStore', () => ({ bumpScene: jest.fn() }));

interface FakeNode { id: string; components: Array<{ id: string; type: string; props: Record<string, unknown> }> }
const nodes = new Map<string, FakeNode>();

jest.mock('@core/scene/DefaultSceneGraph', () => ({
  __esModule: true,
  default: { getNode: (id: string) => nodes.get(id) },
}));
jest.mock('@core/scene/activeComp', () => ({ activeCompRootId: () => 'root' }));

import { readResponsiveTime, setResponsiveTime, readActiveResponsiveTime } from './responsiveTimeStore';

const CFG = {
  authoredDurationSec: 5,
  protectedRegions: [{ startSec: 0, endSec: 0.6 }, { startSec: 4.4, endSec: 5 }],
};

describe('responsive-time config storage', () => {
  beforeEach(() => {
    nodes.clear();
    nodes.set('root', { id: 'root', components: [{ id: 'meta', type: 'meta', props: {} }] });
  });

  it('reads back undefined when nothing is stored', () => {
    expect(readResponsiveTime('root')).toBeUndefined();
  });

  it('round-trips a config', () => {
    setResponsiveTime('root', CFG);
    expect(readResponsiveTime('root')).toEqual(CFG);
  });

  it('is reachable for the active comp', () => {
    setResponsiveTime('root', CFG);
    expect(readActiveResponsiveTime()).toEqual(CFG);
  });

  it('clears', () => {
    setResponsiveTime('root', CFG);
    setResponsiveTime('root', undefined);
    expect(readResponsiveTime('root')).toBeUndefined();
  });

  it('ignores a malformed stored value rather than trusting it', () => {
    // Hand-edited or half-migrated data must not reach the time axis, where a
    // NaN duration would desync every keyframe in the comp.
    nodes.get('root')!.components[0]!.props.__responsiveTime = { authoredDurationSec: 'x' };
    expect(readResponsiveTime('root')).toBeUndefined();
    nodes.get('root')!.components[0]!.props.__responsiveTime = { authoredDurationSec: 5 };
    expect(readResponsiveTime('root')).toBeUndefined(); // regions missing
  });

  it('returns undefined for an unknown node', () => {
    expect(readResponsiveTime('no-such-node')).toBeUndefined();
  });

  it('is a no-op on a node with no components rather than throwing', () => {
    nodes.set('bare', { id: 'bare', components: [] });
    expect(() => setResponsiveTime('bare', CFG)).not.toThrow();
    expect(readResponsiveTime('bare')).toBeUndefined();
  });
});
