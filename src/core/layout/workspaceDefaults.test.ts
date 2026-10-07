/**
 * The builtin workspaces agree with the panel registry.
 *
 * Default is what a fresh session looks like, so its tab lists must be exactly
 * the PERMANENT panels of `panelDefs.ts`, in rail order. When the rails were cut
 * to Project / Library / AI and Properties / Audio (2026-09-15), the two lists
 * lived in two files; this is what stops the next change landing in one.
 */

import { PANEL_DEFS } from '@layout/EditorLayout/panelDefs';
import type { RegionId } from '@stores/layoutStore';

const settings = new Map<string, unknown>();
jest.mock('@core/services/coreServices', () => ({
  getSettingsManager: () => ({
    get: <T,>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback),
    set: <T,>(key: string, value: T): void => { settings.set(key, value); },
  }),
}));

import { BUILTIN_WORKSPACES, reconcileActiveWorkspace } from './workspaceManager';
import { useLayoutStore } from '@stores/layoutStore';

const permanent = (region: RegionId): string[] =>
  PANEL_DEFS.filter((d) => d.region === region && !d.onDemand).map((d) => d.id);

describe('the permanent panel sets', () => {
  it('are Project, Effect Controls, Layers on the left and the AE Default column (Properties, Info, Audio, Preview, Effects & Presets, Align, Character) on the right', () => {
    expect(permanent('leftSidebar')).toEqual(['assets', 'effectControls', 'scene']);
    expect(permanent('rightInspector')).toEqual(['properties', 'info', 'audio', 'preview', 'effects', 'align', 'character']);
    expect(PANEL_DEFS.find((d) => d.id === 'assets')?.title).toBe('Project');
  });

  it('Default lists exactly those, in rail order', () => {
    const def = BUILTIN_WORKSPACES.find((w) => w.id === 'default')!;
    expect(def.panelOrder?.leftSidebar).toEqual(permanent('leftSidebar'));
    expect(def.panelOrder?.rightInspector).toEqual(permanent('rightInspector'));
  });

  it('every builtin names only registered panels, each once, in its own home side', () => {
    const known = new Map(PANEL_DEFS.map((d) => [d.id, d.region]));
    for (const ws of BUILTIN_WORKSPACES) {
      for (const [region, ids] of Object.entries(ws.panelOrder ?? {})) {
        expect({ ws: ws.id, region, dupes: ids.length !== new Set(ids).size }).toEqual({ ws: ws.id, region, dupes: false });
        for (const id of ids) expect({ ws: ws.id, id, known: known.has(id) }).toEqual({ ws: ws.id, id, known: true });
      }
      for (const [region, id] of Object.entries(ws.activePanelByRegion ?? {})) {
        expect({ ws: ws.id, region, listed: ws.panelOrder?.[region as RegionId]?.includes(id!) })
          .toEqual({ ws: ws.id, region, listed: true });
      }
    }
  });

  it('the specialised workspaces open what their job needs', () => {
    const ws = (id: string) => BUILTIN_WORKSPACES.find((w) => w.id === id)!;
    expect(ws('animation').panelOrder?.rightInspector).toEqual(['properties', 'motion', 'rig']);
    expect(ws('color').panelOrder?.rightInspector?.[0]).toBe('scopes');
    expect(ws('color-grading').panelOrder?.rightInspector?.slice(0, 2)).toEqual(['scopes', 'properties']);
    expect(ws('ai-focus').panelOrder?.leftSidebar?.[0]).toBe('ai');
    expect(ws('motion-design').panelOrder?.rightInspector).toContain('motion');
  });
});

describe('reconcileActiveWorkspace', () => {
  beforeEach(() => {
    settings.clear();
    useLayoutStore.setState({
      panels: {},
      panelOrder: {
        leftSidebar: ['assets', 'library', 'ai'],
        leftSidebar_bottom: [],
        rightInspector: ['properties', 'audio'],
        rightInspector_bottom: [],
        centerWorkspace: [],
        bottomTimeline: [],
      },
      activePanelByRegion: { leftSidebar: 'assets', rightInspector: 'properties' },
    });
  });

  it('puts an active builtin\'s panels back after the migration dropped them', () => {
    settings.set('workspace.activeId', 'color');
    const sizeBefore = useLayoutStore.getState().regions.rightInspector.size;
    expect(reconcileActiveWorkspace()).toBe(true);
    const s = useLayoutStore.getState();
    expect(s.panelOrder.rightInspector).toEqual(['scopes', 'properties', 'swatches']);
    expect(s.activePanelByRegion.rightInspector).toBe('scopes');
    // Geometry is the user's, not the preset's.
    expect(s.regions.rightInspector.size).toBe(sizeBefore);
  });

  it('does not replay a user-saved workspace, whose lists predate the migration', () => {
    settings.set('workspace.userWorkspaces', [
      { id: 'user-1', name: 'Mine', regions: {}, panelOrder: { leftSidebar: ['scene', 'effectControls'] } },
    ]);
    settings.set('workspace.legacyLayoutsMigrated', true);
    settings.set('workspace.activeId', 'user-1');
    expect(reconcileActiveWorkspace()).toBe(false);
    expect(useLayoutStore.getState().panelOrder.leftSidebar).toEqual(['assets', 'library', 'ai']);
  });
});
