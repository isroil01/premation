/**
 * P7d: the loaded native plugins' panels in the dock — each effect plugin's
 * own panel (its `ui/index.html`) and every manifest panel. Called once by the
 * editor shell; re-runs on every plugin-list answer, and the shell re-renders,
 * so the dock renderers (panelRenderers.ts) pick up a newly installed plugin.
 *
 * Installed plugins are tabs of their own, as After Effects docks extension
 * panels (owner-approved mockup board 2, 2026-11-03; the rules are
 * pluginDockRules.ts):
 *
 *   • the first time this machine sees a plugin panel it is DOCKED — on the
 *     right, in Effect Controls' group when that is there — and from then on
 *     the user's layout decides: a tab the user closed stays closed;
 *   • the tab carries the plugin's own icon (the manifest's, else the store
 *     listing's, else the generic plugin glyph) and its title;
 *   • a plugin that stops contributing the panel (uninstalled, disabled,
 *     failed, locked) takes its tab out of the dock once the plugin list has
 *     settled, keeping its place (`parkPanel`): when the plugin comes back,
 *     the tab returns where it was.
 *
 * The "seen" list is editor state on this machine (localStorage, every access
 * wrapped), never the project document. It is the same list the Plugins tab's
 * one-time docking always used (`plugins`), now holding panel ids as well.
 */

import { useEffect } from 'react';
import { engine } from '@core/engine/engineInstance';
import {
  hasLoadedPlugins,
  pluginContribRevision,
  pluginInfo,
  pluginPanels,
  refreshPluginContrib,
  type PluginPanelEntry,
} from '@core/nativePlugins/pluginContrib';
import { groupOfPanel } from '@core/layout/dockGroups';
import { usePluginContrib } from '@hooks/usePluginContrib';
import { useLayoutStore, type PanelRegistration } from '@stores/layoutStore';
import { pluginIconUrl, storeIcon } from './pluginIcons';
import {
  ABSENCE_CONFIRM_MS,
  dockOnRegister,
  pluginPanelMenuTitle,
  pluginPanelTitle,
  settleAbsences,
  type Absence,
} from './pluginDockRules';

export const SEEN_PLUGIN_PANELS_KEY = 'premation.pluginPanels.seen.v1';
/** In the seen list once the Plugins tab has been docked for this machine's first plugin. */
export const PLUGINS_TAB_SEEN = 'plugins';

/** Plugin panels are `plugin:<id>` (an effect plugin's own) or `plugin:<id>/<panel>`. */
export function isPluginPanelId(id: string): boolean {
  return id.startsWith('plugin:');
}

export function readSeen(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(SEEN_PLUGIN_PANELS_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeSeen(seen: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(SEEN_PLUGIN_PANELS_KEY, JSON.stringify([...seen]));
  } catch {
    // A blocked store: a plugin's panel docks again next launch, which is harmless.
  }
}

/** The dock registration for a plugin panel (`iconUrl` null: the generic glyph until a picture is known). */
export function pluginPanelRegistration(entry: PluginPanelEntry, iconUrl: string | null): PanelRegistration {
  const info = pluginInfo(entry.plugin);
  return {
    id: entry.panelId,
    title: pluginPanelTitle(entry, info),
    menuTitle: pluginPanelMenuTitle(entry, info),
    icon: 'plugin',
    iconUrl,
    region: 'rightInspector',
    weight: 4,
    closable: true,
    onDemand: true,
  };
}

/** Every dock id on any side, registered or not (a parked plugin panel keeps its place there). */
function dockedIds(): Set<string> {
  const s = useLayoutStore.getState();
  return new Set(Object.values(s.panelOrder).flat());
}

/**
 * A first-time plugin panel: into Effect Controls' group when that is on the
 * right (an effect's own panel belongs beside its controls), without taking
 * the front of the group from what the user had there.
 */
function placeFirstTime(panelId: string): void {
  const s = useLayoutStore.getState();
  const group = groupOfPanel(s.dockGroups.rightInspector, 'effectControls');
  if (!group) return;
  const front = group.active;
  s.movePanelToGroup(panelId, group.id);
  if (front) useLayoutStore.getState().setGroupActive(group.id, front);
}

/**
 * One plugin-list answer applied to the dock. Exported for tests; `state`
 * carries the absences waiting for a second answer between calls.
 * Returns whether some absence still waits (the caller asks the engine again).
 */
export function syncPluginPanels(state: { pending: ReadonlyMap<string, Absence> }, now: number = Date.now()): boolean {
  const store = useLayoutStore.getState();
  const entries = pluginPanels();
  const current = new Set(entries.map((p) => p.panelId));
  const inLayout = dockedIds();
  const seen = readSeen();
  let seenChanged = false;

  for (const p of entries) {
    const own = pluginIconUrl(pluginInfo(p.plugin));
    if (store.panels[p.panelId]) {
      // Already there: refresh what a rescan can change (the title, the manifest icon).
      const prev = store.panels[p.panelId]!;
      const reg = pluginPanelRegistration(p, own ?? prev.iconUrl ?? null);
      if (prev.title !== reg.title || prev.menuTitle !== reg.menuTitle || prev.iconUrl !== reg.iconUrl) {
        useLayoutStore.getState().registerPanel(reg);
      }
    } else {
      // registerPanel docks the panel (at its saved place, else appended to its home side).
      useLayoutStore.getState().registerPanel(pluginPanelRegistration(p, own));
      const action = dockOnRegister({ inLayout: inLayout.has(p.panelId), seen: seen.has(p.panelId) });
      if (action === 'close') useLayoutStore.getState().closePanel(p.panelId);
      else if (!inLayout.has(p.panelId)) placeFirstTime(p.panelId);
    }
    if (!own) fillStoreIcon(p);
    if (!seen.has(p.panelId)) {
      seen.add(p.panelId);
      seenChanged = true;
    }
  }

  // The Plugins tab docks itself once, the first time this machine has a plugin.
  if (hasLoadedPlugins() && !seen.has(PLUGINS_TAB_SEEN)) {
    if (!inLayout.has('plugins')) useLayoutStore.getState().openPanel('plugins');
    seen.add(PLUGINS_TAB_SEEN);
    seenChanged = true;
  }
  if (seenChanged) writeSeen(seen);

  // Registered plugin panels this answer no longer contributes.
  const missing = new Set(Object.keys(useLayoutStore.getState().panels).filter((id) => isPluginPanelId(id) && !current.has(id)));
  const definitive = new Set<string>();
  for (const id of missing) {
    const pluginId = id.slice('plugin:'.length).split('/')[0] ?? '';
    const info = pluginInfo(pluginId);
    if (info && info.status !== 'loaded') definitive.add(id);
  }
  const step = settleAbsences(state.pending, missing, definitive, pluginContribRevision(), now);
  state.pending = step.pending;
  for (const id of step.remove) useLayoutStore.getState().parkPanel(id);
  return step.pending.size > 0;
}

/** The store listing's icon, once it is known, for a plugin whose bundle has none. */
function fillStoreIcon(entry: PluginPanelEntry): void {
  void storeIcon(entry.plugin).then((url) => {
    if (!url) return;
    const p = useLayoutStore.getState().panels[entry.panelId];
    if (!p || p.iconUrl === url) return;
    useLayoutStore.getState().registerPanel(pluginPanelRegistration(entry, url));
  });
}

/** Absences waiting for a second answer, across the shell's re-renders. */
const absenceState: { pending: ReadonlyMap<string, Absence> } = { pending: new Map() };

export function usePluginPanels(): number {
  const revision = usePluginContrib();
  useEffect(() => {
    // Revision 0: the engine has not answered yet — an empty list means nothing.
    if (revision === 0) return undefined;
    const waiting = syncPluginPanels(absenceState);
    if (!waiting) return undefined;
    // Ask again a moment later: the second answer settles whether the panel is really gone.
    const timer = setTimeout(() => {
      try {
        void refreshPluginContrib(engine());
      } catch {
        // No engine right now: the next answer (its restart's) settles it.
      }
    }, ABSENCE_CONFIRM_MS + 100);
    return () => clearTimeout(timer);
  }, [revision]);
  return revision;
}
