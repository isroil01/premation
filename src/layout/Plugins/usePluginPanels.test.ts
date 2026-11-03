/**
 * Installed plugins' dock tabs against the real layout store
 * (usePluginPanels.ts `syncPluginPanels`): docked the first time, the user's
 * layout after that, out of the dock only once the plugin list has settled,
 * and back in their place when the plugin returns.
 */

import type { PluginInfo } from '@motion/engine-api';
import { resetPluginContribForTest, setPluginContrib } from '@core/nativePlugins/pluginContrib';
import { groupOfPanel } from '@core/layout/dockGroups';
import { useLayoutStore } from '@stores/layoutStore';
import type { Absence } from './pluginDockRules';
import { PLUGINS_TAB_SEEN, SEEN_PLUGIN_PANELS_KEY, readSeen, syncPluginPanels } from './usePluginPanels';

jest.mock('./pluginIcons', () => ({
  ...jest.requireActual('./pluginIcons'),
  storeIcon: () => Promise.resolve(null),
}));

function info(over: Partial<PluginInfo>): PluginInfo {
  return {
    id: 'premation.deepglow', name: 'Deep Glow', version: '1.0.0', vendor: '', sdk: '1.2', status: 'loaded', error: '',
    effects: ['premation.deepglow'], gpu: false, panel: true, commands: [], importers: [], outputModules: [], panels: [], presets: [],
    ...over,
  };
}

const PANEL = 'plugin:premation.deepglow';

function docked(id: string): boolean {
  return Object.values(useLayoutStore.getState().panelOrder).some((l) => l?.includes(id));
}

let state: { pending: ReadonlyMap<string, Absence> };

beforeEach(() => {
  localStorage.clear();
  state = { pending: new Map() };
  useLayoutStore.setState({
    panels: {},
    panelOrder: {
      leftSidebar: [],
      leftSidebar_bottom: [],
      rightInspector: [],
      rightInspector_bottom: [],
      centerWorkspace: [],
      bottomTimeline: [],
    },
    activePanelByRegion: {},
    dockGroups: { leftSidebar: [], rightInspector: [] },
  });
  const s = useLayoutStore.getState();
  s.registerPanel({ id: 'properties', title: 'Properties', region: 'rightInspector', closable: true });
  s.registerPanel({ id: 'plugins', title: 'Plugins', region: 'rightInspector', closable: true, onDemand: true });
  useLayoutStore.getState().closePanel('plugins');
});

afterEach(() => resetPluginContribForTest());

describe('plugin panels in the dock', () => {
  it('docks a panel the first time this machine sees it, titled and with the plugin\'s icon', () => {
    setPluginContrib([info({ icon: 'ui/icon.png', panelTitle: 'Studio' })]);
    syncPluginPanels(state);
    const p = useLayoutStore.getState().panels[PANEL];
    expect(p?.title).toBe('Deep Glow Studio');
    expect(p?.iconUrl).toBe('plugin-ui://premation.deepglow/icon.png');
    expect(docked(PANEL)).toBe(true);
    expect(readSeen().has(PANEL)).toBe(true);
    // The Plugins tab docks itself once too.
    expect(docked('plugins')).toBe(true);
    expect(readSeen().has(PLUGINS_TAB_SEEN)).toBe(true);
  });

  it('uses the generic glyph (iconUrl null) when the bundle has no icon', () => {
    setPluginContrib([info({})]);
    syncPluginPanels(state);
    expect(useLayoutStore.getState().panels[PANEL]?.iconUrl).toBeNull();
  });

  it('joins Effect Controls\' group on the right without taking its front tab', () => {
    useLayoutStore.getState().registerPanel({ id: 'effectControls', title: 'Effect Controls', region: 'rightInspector', closable: true });
    useLayoutStore.getState().openPanel('effectControls');
    setPluginContrib([info({})]);
    syncPluginPanels(state);
    const g = groupOfPanel(useLayoutStore.getState().dockGroups.rightInspector, 'effectControls');
    expect(g?.panels).toContain(PANEL);
    expect(g?.active).toBe('effectControls');
  });

  it('keeps a tab the user closed closed when the plugin registers again (next launch)', () => {
    setPluginContrib([info({})]);
    syncPluginPanels(state);
    useLayoutStore.getState().closePanel(PANEL);
    // Next launch: nothing registered yet, the seen list remembers.
    useLayoutStore.getState().unregisterPanel(PANEL);
    setPluginContrib([info({})]);
    syncPluginPanels(state);
    expect(useLayoutStore.getState().panels[PANEL]).toBeDefined();
    expect(docked(PANEL)).toBe(false);
  });

  it('migrates the old seen list: the Plugins tab is not docked again, panels are docked once', () => {
    localStorage.setItem(SEEN_PLUGIN_PANELS_KEY, JSON.stringify([PLUGINS_TAB_SEEN]));
    setPluginContrib([info({})]);
    syncPluginPanels(state);
    expect(docked('plugins')).toBe(false);
    expect(docked(PANEL)).toBe(true);
  });

  it('does not take a tab out on an engine restart\'s briefly empty plugin list', () => {
    setPluginContrib([info({})]);
    syncPluginPanels(state, 0);
    setPluginContrib([]); // the restarting engine answers with nothing
    expect(syncPluginPanels(state, 100)).toBe(true); // waits for a second answer
    expect(useLayoutStore.getState().panels[PANEL]).toBeDefined();
    setPluginContrib([info({})]); // the scan is back
    expect(syncPluginPanels(state, 2000)).toBe(false);
    expect(useLayoutStore.getState().panels[PANEL]).toBeDefined();
    expect(docked(PANEL)).toBe(true);
  });

  it('takes an uninstalled plugin\'s tab out once settled, and brings it back to its place', () => {
    setPluginContrib([info({})]);
    syncPluginPanels(state, 0);
    const groupBefore = groupOfPanel(useLayoutStore.getState().dockGroups.rightInspector, PANEL)?.id;
    setPluginContrib([]);
    syncPluginPanels(state, 100);
    setPluginContrib([]); // the confirming answer
    expect(syncPluginPanels(state, 2000)).toBe(false);
    expect(useLayoutStore.getState().panels[PANEL]).toBeUndefined();
    // Its place is kept (the dock draws only registered panels).
    expect(docked(PANEL)).toBe(true);
    // Reinstalled: back where it was.
    setPluginContrib([info({})]);
    syncPluginPanels(state, 3000);
    expect(useLayoutStore.getState().panels[PANEL]).toBeDefined();
    expect(groupOfPanel(useLayoutStore.getState().dockGroups.rightInspector, PANEL)?.id).toBe(groupBefore);
  });

  it('takes a disabled plugin\'s tab out at once (the engine lists it, not loaded)', () => {
    setPluginContrib([info({})]);
    syncPluginPanels(state, 0);
    setPluginContrib([info({ status: 'disabled' })]);
    expect(syncPluginPanels(state, 10)).toBe(false);
    expect(useLayoutStore.getState().panels[PANEL]).toBeUndefined();
  });

  it('brings a closed tab back closed when a disabled plugin is enabled again', () => {
    setPluginContrib([info({})]);
    syncPluginPanels(state, 0);
    useLayoutStore.getState().closePanel(PANEL);
    setPluginContrib([info({ status: 'disabled' })]);
    syncPluginPanels(state, 10);
    setPluginContrib([info({})]);
    syncPluginPanels(state, 20);
    expect(useLayoutStore.getState().panels[PANEL]).toBeDefined();
    expect(docked(PANEL)).toBe(false);
  });
});
