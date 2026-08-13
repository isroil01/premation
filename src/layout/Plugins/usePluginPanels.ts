/**
 * Keeps the dock's registered panels in step with what is installed.
 *
 * Every other panel in the editor is registered once, from a list that ships
 * with the build. Plugin panels cannot be: the set changes when the user
 * installs, uninstalls, enables or disables something, and it changes again
 * when a plugin fails to boot and hands its rail slot to the next one in line.
 * So this runs the same registration the static list gets, and re-runs it
 * whenever the answer would be different.
 *
 * It also does the tidying nothing else will. `unregisterPanel` cleans up ids
 * the store knows about, but a PERSISTED layout outlives the plugin that put
 * an id in it: uninstall a plugin, and `panelOrder` keeps a `plugin:…` entry
 * that nothing will ever register again. `DockPanel` filters those out so they
 * are invisible, which is exactly why they would otherwise accumulate in
 * localStorage forever, one per plugin the user ever tried.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { useLayoutStore } from '@stores/layoutStore';
import { usePluginStore } from '@stores/pluginStore';
import pluginHost from '@core/plugins/PluginHost';
import { parseDedicatedPanelId, pluginPanelDefs } from './pluginPanelDefs';

export function usePluginPanelRegistration(): void {
  // Two subscriptions, because the answer depends on both. The STORE says what
  // is installed and enabled; the HOST says which of those are in `error` and
  // therefore allocated last. Subscribing here is also what re-renders the
  // shell so `getAllPanelRenderers()` picks up the new entries — a panel
  // registered with no renderer draws an empty pane.
  usePluginStore((s) => s.plugins);
  useSyncExternalStore((cb) => pluginHost.subscribe(cb), () => pluginHost.getRevision());

  const defs = pluginPanelDefs();
  // The effect must re-run when a def CHANGES, not only when one is added or
  // removed — a renamed panel or a plugin that just took over a freed slot has
  // the same count and a different rail. Comparing the flattened defs is what
  // catches both; comparing `defs.length` would catch neither.
  const signature = defs.map((d) => `${d.id}|${d.title}|${d.icon}|${d.region}|${d.weight}`).join('\n');

  useEffect(() => {
    const layout = useLayoutStore.getState();
    const wanted = new Set(defs.map((d) => d.id));

    // Gone: uninstalled, disabled, or demoted to the shared host because a
    // higher-priority plugin took the slot. All three mean the tab goes away,
    // and `unregisterPanel` is what also drops it from `panelOrder` and moves
    // the active tab off it rather than leaving the region pointing at nothing.
    for (const id of Object.keys(layout.panels)) {
      if (parseDedicatedPanelId(id) && !wanted.has(id)) layout.unregisterPanel(id);
    }

    // Never registered in this session and never will be — a plugin the user
    // removed while the app was closed. Not reachable through `unregisterPanel`,
    // which needs `panels[id]` to exist.
    useLayoutStore.setState((s) => {
      for (const region of Object.keys(s.panelOrder) as (keyof typeof s.panelOrder)[]) {
        s.panelOrder[region] = s.panelOrder[region].filter(
          (id) => !parseDedicatedPanelId(id) || wanted.has(id) || s.panels[id],
        );
      }
    });

    // Registered LAST, so a slot freed above is available to whatever claims it
    // in the same pass. `registerPanel` honours a region already in the
    // persisted layout, so a plugin panel the user dragged to the other dock
    // stays where they put it.
    for (const d of defs) {
      layout.registerPanel({
        id: d.id,
        title: d.title,
        icon: d.icon,
        region: d.region,
        weight: d.weight,
        closable: d.closable,
      });
    }
    // `defs` is rebuilt every render; `signature` is what actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}
