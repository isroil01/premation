/**
 * Open a plugin's detail tab.
 *
 * A function rather than an inline store call, because three surfaces reach it
 * — the sidebar, the Plugins menu and the `premation://` deep link — and one of
 * those is untrusted input. Validating the id HERE means every route into the
 * tab system is validated, including ones added later by someone who never read
 * the deep-link handler.
 */

import { REGISTRY_ID_RE } from '@core/plugins/registry';
import { pluginTabId, useEditorTabStore } from '@stores/editorTabStore';

export function openPluginTab(
  pluginId: string,
  title: string,
  opts: { preview?: boolean } = {},
): boolean {
  // Refused before it reaches a fetch or a store lookup. A deep link's id is
  // whatever was in the URL, and persisted tab state survived a reload in
  // localStorage — neither is ours by the time it gets here.
  if (!REGISTRY_ID_RE.test(pluginId)) return false;

  useEditorTabStore.getState().open(
    {
      id: pluginTabId(pluginId),
      kind: 'plugin',
      title: title.slice(0, 60) || pluginId,
      ref: pluginId,
    },
    opts,
  );
  return true;
}
