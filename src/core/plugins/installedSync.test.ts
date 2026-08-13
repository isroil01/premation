/**
 * The reconcile is ADDITIVE, in both directions, always.
 *
 * WHY THESE TESTS AND NOT OTHERS. The feature is "your plugins survive a new
 * machine", and the only way to build it badly is to make it capable of
 * deleting. A sync that mirrors the server would wipe a user's library the
 * first time the account read returns empty for a boring reason — signed out,
 * offline, a 500, an edition without a registry — and there is no undo for
 * that. So the assertions here are mostly about what the reconcile does NOT
 * do, and the unreadable-server case is tested separately from the
 * genuinely-empty one because conflating those two IS the bug.
 */

import { reconcileInstalledSet } from './installedSync';
import type { ServerInstall } from './registry';
import type { PluginPermission } from './manifest';
import type { InstalledPlugin } from '@stores/pluginStore';

/** Real permission strings — the union is closed, so typos would not compile. */
const READ: PluginPermission = 'scene:read';
const WRITE: PluginPermission = 'scene:write';

jest.mock('./registry', () => ({
  fetchInstalledSet: jest.fn(),
  recordInstalled: jest.fn(),
}));

import { fetchInstalledSet, recordInstalled } from './registry';

const fetchMock = fetchInstalledSet as jest.MockedFunction<typeof fetchInstalledSet>;
const recordMock = recordInstalled as jest.MockedFunction<typeof recordInstalled>;

function localPlugin(id: string, over: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    manifest: { id, name: id, version: '1.0.0' },
    files: {},
    granted: [READ],
    enabled: true,
    installedAt: 1,
    updatedAt: 1,
    ...over,
  } as unknown as InstalledPlugin;
}

function serverRow(id: string, over: Partial<ServerInstall> = {}): ServerInstall {
  return {
    pluginId: id,
    name: id,
    version: '1.0.0',
    latestVersion: '1.0.0',
    enabled: true,
    granted: [READ],
    installedAt: 'x',
    updatedAt: 'x',
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  recordMock.mockResolvedValue([]);
});

describe('when the account cannot be read', () => {
  it('reports offline and touches nothing', async () => {
    // The case that would destroy a library if it were mistaken for "empty".
    fetchMock.mockRejectedValue(new Error('network'));
    const report = await reconcileInstalledSet([localPlugin('a'), localPlugin('b')]);
    expect(report.offline).toBe(true);
    expect(report.restorable).toEqual([]);
    expect(report.pushed).toEqual([]);
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe('when the account is genuinely empty', () => {
  it('pushes the local set up rather than treating local as wrong', async () => {
    // Distinct from the test above, deliberately: same visible "no rows", and
    // the correct response is the opposite one.
    fetchMock.mockResolvedValue([]);
    const report = await reconcileInstalledSet([localPlugin('a'), localPlugin('b')]);
    expect(report.offline).toBe(false);
    expect(report.pushed).toEqual(['a', 'b']);
    expect(recordMock).toHaveBeenCalledTimes(2);
  });
});

describe('what the account has and this machine does not', () => {
  it('is reported as restorable, NOT installed silently', async () => {
    // Installing software is something a user says yes to. Auto-pulling would
    // also run past the permission consent screen.
    fetchMock.mockResolvedValue([serverRow('gone'), serverRow('here')]);
    const report = await reconcileInstalledSet([localPlugin('here')]);
    expect(report.restorable.map((r) => r.pluginId)).toEqual(['gone']);
  });
});

describe('what this machine has and the account does not', () => {
  it('never deletes locally — it pushes up', async () => {
    fetchMock.mockResolvedValue([]);
    const report = await reconcileInstalledSet([localPlugin('local-only')]);
    expect(report.pushed).toEqual(['local-only']);
    expect(report.restorable).toEqual([]);
  });

  it('keeps going when one push fails', async () => {
    // A local-only package the registry never saw 404s. Abandoning the sync
    // there would strand every plugin after it.
    fetchMock.mockResolvedValue([]);
    recordMock.mockRejectedValueOnce(new Error('404')).mockResolvedValue([]);
    const report = await reconcileInstalledSet([localPlugin('bad'), localPlugin('good')]);
    expect(report.failed).toEqual(['bad']);
    expect(report.pushed).toEqual(['good']);
  });
});

describe('when both sides already agree', () => {
  it('sends nothing', async () => {
    fetchMock.mockResolvedValue([serverRow('a')]);
    const report = await reconcileInstalledSet([localPlugin('a')]);
    expect(report.pushed).toEqual([]);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('still pushes when only the enabled flag differs', async () => {
    // Compared field by field rather than by existence, so a disable made
    // while offline is not lost on the next run.
    fetchMock.mockResolvedValue([serverRow('a', { enabled: true })]);
    const report = await reconcileInstalledSet([localPlugin('a', { enabled: false })]);
    expect(report.pushed).toEqual(['a']);
  });

  it('still pushes when only the version differs', async () => {
    fetchMock.mockResolvedValue([serverRow('a', { version: '1.0.0' })]);
    const local = localPlugin('a');
    (local.manifest as { version: string }).version = '2.0.0';
    expect((await reconcileInstalledSet([local])).pushed).toEqual(['a']);
  });

  it('ignores grant ORDER, which is a set written as an array', async () => {
    fetchMock.mockResolvedValue([serverRow('a', { granted: [WRITE, READ] })]);
    const report = await reconcileInstalledSet([localPlugin('a', { granted: [READ, WRITE] })]);
    expect(report.pushed).toEqual([]);
  });

  it('pushes when the grants genuinely differ', async () => {
    fetchMock.mockResolvedValue([serverRow('a', { granted: [READ] })]);
    const report = await reconcileInstalledSet([localPlugin('a', { granted: [READ, WRITE] })]);
    expect(report.pushed).toEqual(['a']);
  });
});
