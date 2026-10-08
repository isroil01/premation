/**
 * The one-time layout migration that lets the 2026-09-15 rail consolidation
 * reach users who have run the app before.
 *
 * Without it, a persisted `panelOrder` lists every panel that USED to be
 * permanent, and the registration in `App` keeps any on-demand panel the
 * persisted order already holds — so an existing user would keep all 21 tabs
 * forever and only fresh installs would see the new rails.
 *
 * The fixture is a literal pre-migration payload (no `version`), not one built
 * from today's type: a migration tested against today's shape proves nothing
 * about yesterday's data.
 */

import { LAYOUT_SCHEMA_VERSION, migratePersistedLayout, type PersistedLayout } from './layoutStore';

const LAYOUT_KEY = 'motion-editor.layout.v1';

/** What `saveLayout` wrote before the schema was versioned. */
const PRE_2_LAYOUT = {
  regions: {
    leftSidebar: { collapsed: false, size: 312 },
    rightInspector: { collapsed: true, size: 401 },
    bottomTimeline: { collapsed: false, size: 333 },
  },
  panelOrder: {
    leftSidebar: ['scene', 'effectControls', 'assets', 'transcript', 'library', 'ai', 'marketplace'],
    leftSidebar_bottom: [],
    rightInspector: ['properties', 'character', 'align', 'swatches', 'info', 'audio', 'scopes', 'preview', 'sourceMonitor', 'tracker', 'rig', 'effects', 'motion', 'presets'],
    rightInspector_bottom: [],
    centerWorkspace: [],
    bottomTimeline: [],
  },
  activePanelByRegion: { leftSidebar: 'scene', rightInspector: 'tracker' },
  leftSidebarPosition: 'right',
  rightInspectorPosition: 'left',
  timelinePosition: 'top',
  leftSidebarSplit: true,
  rightInspectorSplit: false,
} as PersistedLayout;

describe('migratePersistedLayout', () => {
  it('drops the tab order and active tabs of a pre-versioned layout', () => {
    const { layout, migrated } = migratePersistedLayout(PRE_2_LAYOUT);
    expect(migrated).toBe(true);
    expect(layout.panelOrder).toBeUndefined();
    expect(layout.activePanelByRegion).toBeUndefined();
    expect(layout.version).toBe(LAYOUT_SCHEMA_VERSION);
  });

  it('keeps everything the user shaped: sizes, collapsed, sides, splits', () => {
    const { layout } = migratePersistedLayout(PRE_2_LAYOUT);
    expect(layout.regions).toEqual(PRE_2_LAYOUT.regions);
    expect(layout.leftSidebarPosition).toBe('right');
    expect(layout.rightInspectorPosition).toBe('left');
    expect(layout.timelinePosition).toBe('top');
    expect(layout.leftSidebarSplit).toBe(true);
    expect(layout.rightInspectorSplit).toBe(false);
  });

  it('leaves a current layout alone — the user\'s own tab order survives every later boot', () => {
    const current = { ...PRE_2_LAYOUT, version: LAYOUT_SCHEMA_VERSION, panelOrder: { leftSidebar: ['assets', 'scene'] } } as PersistedLayout;
    const { layout, migrated } = migratePersistedLayout(current);
    expect(migrated).toBe(false);
    expect(layout).toBe(current);
  });
});

describe('the store at module load', () => {
  afterEach(() => {
    localStorage.clear();
    jest.resetModules();
  });

  it('boots an old persisted layout with empty tab lists and the user\'s geometry', () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(PRE_2_LAYOUT));
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./layoutStore') as typeof import('./layoutStore');
      const s = mod.useLayoutStore.getState();
      expect(s.panelOrder.leftSidebar).toEqual([]);
      expect(s.panelOrder.rightInspector).toEqual([]);
      expect(s.activePanelByRegion).toEqual({});
      expect(s.regions.leftSidebar.size).toBe(312);
      expect(s.regions.rightInspector.collapsed).toBe(true);
      // Its split cannot carry over: the lists it partitioned were dropped, so
      // the panels form the default groups as they register.
      expect(s.dockGroups).toEqual({ leftSidebar: [], rightInspector: [] });
      // Reported once, so App re-applies the active builtin workspace once.
      expect(mod.consumeLayoutMigration()).toBe(true);
      expect(mod.consumeLayoutMigration()).toBe(false);
    });
  });

  it('keeps the persisted order of a current layout, so an opened on-demand panel stays open', () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({
      ...PRE_2_LAYOUT,
      version: LAYOUT_SCHEMA_VERSION,
      panelOrder: { ...PRE_2_LAYOUT.panelOrder, leftSidebar: ['assets', 'library', 'ai', 'scene'] },
    }));
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./layoutStore') as typeof import('./layoutStore');
      expect(mod.useLayoutStore.getState().panelOrder.leftSidebar).toEqual(['assets', 'library', 'ai', 'scene']);
      expect(mod.consumeLayoutMigration()).toBe(false);
    });
  });
});

describe('Reset Layout', () => {
  it('re-docks permanent panels but not on-demand ones', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { useLayoutStore } = require('./layoutStore') as typeof import('./layoutStore');
      const s = useLayoutStore.getState();
      s.registerPanel({ id: 'assets', region: 'leftSidebar', title: 'Project' });
      s.registerPanel({ id: 'scene', region: 'leftSidebar', title: 'Layers', onDemand: true });
      s.resetLayout();
      expect(useLayoutStore.getState().panelOrder.leftSidebar).toEqual(['assets']);
      expect(useLayoutStore.getState().activePanelByRegion.leftSidebar).toBe('assets');
    });
  });
});
