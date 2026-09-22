/**
 * Who a recovery snapshot belongs to.
 *
 * Identity used to come from the `/editor/:projectId` route alone. Only the
 * cloud editor has that route — the desktop editor runs on plain `/editor`
 * with its project held by the ProjectManager — so `captureRecovery` returned
 * null for every desktop project and autosave never wrote a snapshot. A
 * force-quit after minutes of work offered nothing on relaunch.
 */

import { captureRecovery, restoreRecovery, SCRATCH_PROJECT_ID, type RecoverySnapshot } from './recovery';
import { RecoverySerializer, decodeRecoveryBody } from './recoverySerializer';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';

type Ref = { id: string; name: string; path: string | null };
const pm = {
  current: null as Ref | null,
  booted: true,
  resume: jest.fn((name: string, path: string | null) => ({ id: 'proj_resumed', name, path })),
};

jest.mock('@core/services/coreServices', () => ({
  ...jest.requireActual('@core/services/coreServices'),
  getProjectManager: () => {
    if (!pm.booted) throw new Error('core services not registered');
    return { getState: () => ({ current: pm.current }), resume: pm.resume };
  },
}));

beforeEach(() => {
  pm.current = null;
  pm.booted = true;
  pm.resume.mockClear();
  window.location.hash = '#/editor';
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultAnimation.clear();
});

describe('captureRecovery identity', () => {
  test('a cloud project is keyed by its route id and carries no file binding', () => {
    window.location.hash = '#/editor/cloud_42';
    pm.current = { id: 'proj_ignored', name: 'x', path: 'cloud_42' };
    const snap = captureRecovery(0)!;
    expect(snap.projectId).toBe('cloud_42');
    expect(snap.project).toBeUndefined();
  });

  test('a desktop project on plain /editor is captured, keyed by the ProjectManager', () => {
    pm.current = { id: 'proj_abc', name: 'Promo', path: 'C:/work/Promo.motion' };
    const snap = captureRecovery(1.5);
    expect(snap).not.toBeNull();
    expect(snap!.projectId).toBe('proj_abc');
    expect(snap!.project).toEqual({ name: 'Promo', path: 'C:/work/Promo.motion' });
    expect(snap!.time).toBe(1.5);
  });

  test('a new, never-saved desktop project is captured with a null path', () => {
    pm.current = { id: 'proj_new', name: 'Untitled', path: null };
    expect(captureRecovery(0)!.project).toEqual({ name: 'Untitled', path: null });
  });

  test('work with no project at all is still captured, under the scratch id', () => {
    expect(captureRecovery(0)!.projectId).toBe(SCRATCH_PROJECT_ID);
  });

  test('before core services boot it falls back to scratch instead of throwing', () => {
    pm.booted = false;
    expect(captureRecovery(0)!.projectId).toBe(SCRATCH_PROJECT_ID);
  });
});

describe('the file binding survives storage', () => {
  function roundTrip(snap: RecoverySnapshot): RecoverySnapshot | null {
    const result = new RecoverySerializer().run({ seq: 1, snap: { ...snap, savedAt: 42 }, force: true, folder: false });
    if (result.status !== 'write') throw new Error(`expected a write, got ${result.status}`);
    return decodeRecoveryBody(result.body);
  }

  test('project name and path come back from the stored body', () => {
    pm.current = { id: 'proj_abc', name: 'Promo', path: 'C:/work/Promo.motion' };
    const back = roundTrip(captureRecovery(0)!);
    expect(back?.projectId).toBe('proj_abc');
    expect(back?.project).toEqual({ name: 'Promo', path: 'C:/work/Promo.motion' });
  });

  test('a body without a binding (older build, cloud) decodes without one', () => {
    window.location.hash = '#/editor/cloud_42';
    expect(roundTrip(captureRecovery(0)!)?.project).toBeUndefined();
  });
});

describe('restoreRecovery', () => {
  test('rebinds a desktop project so Save writes back to its file', () => {
    pm.current = { id: 'proj_abc', name: 'Promo', path: 'C:/work/Promo.motion' };
    const snap = captureRecovery(0)!;
    pm.current = null; // a fresh launch: nothing is open yet
    restoreRecovery(snap);
    expect(pm.resume).toHaveBeenCalledWith('Promo', 'C:/work/Promo.motion');
  });

  test('leaves a cloud or scratch snapshot unbound', () => {
    restoreRecovery(captureRecovery(0)!);
    expect(pm.resume).not.toHaveBeenCalled();
  });
});
