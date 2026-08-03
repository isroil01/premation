/**
 * Migration: layouts saved by the OLD workspace system must survive its deletion.
 *
 * WHY THIS EXISTS. There were two parallel workspace systems:
 *
 *   core/layout/workspaceLayouts.ts   4 presets, key 'workspaceLayouts',
 *                                     read ONLY by Customize ▸ Workspaces
 *   core/layout/workspaceManager.ts   8 presets, key 'workspace.userWorkspaces',
 *                                     read ONLY by the TopNav dropdown
 *
 * A layout saved in one never appeared in the other, and both shipped a preset
 * named "Default". The first is now deleted — and anything a user saved under
 * its key would have been silently orphaned with it, which is the failure this
 * migration and this test exist to prevent.
 *
 * The fixtures below are literal pre-change `WorkspaceLayout` objects, not
 * objects built from the current type: a migration tested against today's shape
 * proves nothing about yesterday's data.
 */

import { migrateLegacyLayouts, type WorkspaceSnapshot } from './workspaceManager';

const LEGACY_KEY = 'workspaceLayouts';
const CURRENT_KEY = 'workspace.userWorkspaces';
const MIGRATED_FLAG = 'workspace.legacyLayoutsMigrated';

/** In-memory stand-in for the SettingsManager. */
const store = new Map<string, unknown>();

jest.mock('@core/services/coreServices', () => ({
  getSettingsManager: () => ({
    get: <T,>(key: string, fallback: T): T => (store.has(key) ? (store.get(key) as T) : fallback),
    set: <T,>(key: string, value: T): void => { store.set(key, value); },
  }),
}));

/** Exactly what the deleted module wrote: no `id`, keyed by `name`. */
const LEGACY_FIXTURE = [
  {
    name: 'My Editing Layout',
    regions: {
      leftSidebar: { size: 300, collapsed: false },
      rightInspector: { size: 420, collapsed: false },
      bottomTimeline: { size: 500, collapsed: false },
    },
    panelOrder: {
      leftSidebar: ['scene', 'assets'],
      rightInspector: ['properties', 'effects'],
      centerWorkspace: [],
      bottomTimeline: [],
    },
    activePanelByRegion: { leftSidebar: 'scene', rightInspector: 'properties' },
  },
  // A built-in from the old system. Must NOT be carried across — this manager
  // ships its own presets, and importing these would duplicate them under
  // slightly different geometry.
  {
    name: 'Minimal',
    builtin: true,
    regions: { leftSidebar: { size: 340, collapsed: true } },
  },
];

beforeEach(() => {
  store.clear();
});

describe('legacy workspace-layout migration', () => {
  it('carries a user layout across, preserving geometry and panel assignment', () => {
    store.set(LEGACY_KEY, LEGACY_FIXTURE);

    migrateLegacyLayouts();

    const carried = store.get(CURRENT_KEY) as WorkspaceSnapshot[];
    expect(carried).toHaveLength(1);
    const [ws] = carried;
    expect(ws!.name).toBe('My Editing Layout');
    expect(ws!.builtin).toBe(false);
    // The old shape had no id; the new one is keyed by it, so one is minted.
    expect(ws!.id).toBeTruthy();
    expect(ws!.regions.bottomTimeline).toEqual({ size: 500, collapsed: false });
    expect(ws!.panelOrder?.rightInspector).toEqual(['properties', 'effects']);
    expect(ws!.activePanelByRegion?.leftSidebar).toBe('scene');
  });

  it('does not import the old system\'s built-in presets', () => {
    store.set(LEGACY_KEY, LEGACY_FIXTURE);
    migrateLegacyLayouts();
    const names = (store.get(CURRENT_KEY) as WorkspaceSnapshot[]).map((w) => w.name);
    expect(names).not.toContain('Minimal');
  });

  it('runs once — a second call does not duplicate', () => {
    store.set(LEGACY_KEY, LEGACY_FIXTURE);
    migrateLegacyLayouts();
    migrateLegacyLayouts();
    migrateLegacyLayouts();
    expect(store.get(CURRENT_KEY) as WorkspaceSnapshot[]).toHaveLength(1);
    expect(store.get(MIGRATED_FLAG)).toBe(true);
  });

  it('leaves the legacy key intact, so a rollback still finds its data', () => {
    store.set(LEGACY_KEY, LEGACY_FIXTURE);
    migrateLegacyLayouts();
    // Idempotency comes from the flag, NOT from destroying the source. A user
    // who rolls back to a build with the old system keeps their layouts.
    expect(store.get(LEGACY_KEY)).toEqual(LEGACY_FIXTURE);
  });

  it('keeps the existing entry when both systems used the same name', () => {
    // This manager's own saves are the newer of the two systems, so they win.
    store.set(CURRENT_KEY, [{ id: 'user-1', name: 'My Editing Layout', regions: {} }]);
    store.set(LEGACY_KEY, LEGACY_FIXTURE);

    migrateLegacyLayouts();

    const all = store.get(CURRENT_KEY) as WorkspaceSnapshot[];
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe('user-1');
  });

  it('is a no-op, and still marks itself done, when there is nothing to migrate', () => {
    migrateLegacyLayouts();
    expect(store.get(CURRENT_KEY)).toBeUndefined();
    expect(store.get(MIGRATED_FLAG)).toBe(true);
  });
});
