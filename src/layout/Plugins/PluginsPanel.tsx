/**
 * The Plugins sidebar panel.
 *
 * Thin on purpose. `PluginsList` is the one implementation of finding,
 * installing and managing plugins; this exists only so the left dock can mount
 * it beside Scene, Assets and Library. Anything that grows here rather than
 * there is the beginning of a second copy.
 *
 * There are no sections. Browse / Installed / My Plugins used to be tabs here,
 * and they made a user decide which container their answer lived in before they
 * could search for it — see the note in `PluginsList`. Publishing lives on the
 * dashboard's Plugins page, which has room for a flow; the sidebar is for
 * finding and running things.
 */

import { PluginsList } from './PluginsList';

export function PluginsPanel(): JSX.Element {
  // The one difference between the two surfaces, and it is a width: a labelled
  // "Add plugin" button would take a third of the search row in a 280px dock.
  return <PluginsList compactActions />;
}
