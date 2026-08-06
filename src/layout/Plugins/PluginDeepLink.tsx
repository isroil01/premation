/**
 * `premation://plugin/<id>` — the dashboard's Install button, landing here.
 *
 * Three things have to happen, in this order, and the order is the whole
 * component: focus the window (done in the main process, which owns it), open
 * the Plugins panel, and open that plugin's tab. Doing the last two in the
 * other order shows a detail tab with no visible route back to the list it
 * came from.
 *
 * The id is validated AGAIN here. The main process already refused anything
 * malformed, and that is not a reason to trust this: IPC is its own boundary,
 * and the value is about to become a fetch URL and a store key. `openPluginTab`
 * does the check, so every route into the tab system is covered — including
 * ones added later by someone who never read this file.
 */

import { useEffect } from 'react';
import { useLayoutStore } from '@stores/layoutStore';
import { useUIStore } from '@stores/uiStore';
import { openPluginTab } from './openPluginTab';

/** The dock panel id registered in `panelDefs.ts`. */
const PLUGINS_PANEL_ID = 'marketplace';

export function PluginDeepLink(): null {
  useEffect(() => {
    const api = window.motionEditor;
    if (!api?.onPluginDeepLink) return;

    return api.onPluginDeepLink(({ id }) => {
      // Refused before anything is fetched or looked up. `openPluginTab`
      // returns false for an id that does not match the registry's pattern.
      const opened = openPluginTab(id, id);
      if (!opened) {
        useUIStore.getState().notify({
          level: 'warning',
          message: 'That plugin link is not valid.',
          durationMs: 4000,
        });
        return;
      }
      // The panel first, so the tab that opens has its list beside it.
      useLayoutStore.getState().openPanel(PLUGINS_PANEL_ID);
    });
  }, []);

  return null;
}
