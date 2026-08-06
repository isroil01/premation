/**
 * The Plugins panel, wrapped in the editor's dock chrome.
 *
 * Thin on purpose: `PluginsPanel` is the single implementation of Browse /
 * Installed / My Plugins, and this exists only so the dock can mount it beside
 * Scene, Assets and Library. Anything that grows here rather than there is the
 * beginning of a second copy.
 */

import { Panel } from '@components/Panel';
import { PluginsPanel } from './PluginsPanel';

export function PluginsMarketplacePanel(): JSX.Element {
  return (
    // No `onClose`, so no ✕. It was here and it was already inert — the panel is
    // `closable: false` and `hideHeader`, so nothing ever drew the button — but
    // an inert close handler on a permanent panel is the line someone deletes
    // `hideHeader` next to and does not think about. `noPluginPanelClose.test.ts`
    // is why it stays gone.
    <Panel id="marketplace" title="Plugins" icon="plugin" hideHeader noScroll>
      <PluginsPanel />
    </Panel>
  );
}
