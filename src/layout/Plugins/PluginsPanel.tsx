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
 * could search for it — see the note in `PluginsList`. The sidebar is for
 * finding and running things.
 *
 * ── Getting a plugin IN happens on the dashboard ─────────────────────────────
 *
 * Adding a plugin from disk was here too, and is not any more. Installing and
 * publishing are the two halves of the same job — putting a plugin into the
 * world — and they now live together on the dashboard's Plugins page, where
 * there is room to say what a publish involves (a namespace, a signing key, who
 * may see it) instead of a button that starts something a dock column cannot
 * finish.
 *
 * The cost, stated because it is real and it falls on plugin AUTHORS: iterating
 * on a package you are writing means going to the dashboard to reinstall it.
 * The row's **Reload** still works from here and is the fast path once a plugin
 * is in, so the trip is once per plugin rather than once per edit.
 */

import { PluginsList } from './PluginsList';

export function PluginsPanel(): JSX.Element {
  /*
    `canInstall={false}` gates the Add control AND the drop target together —
    see the prop's own note. A dock that still installed on drop while showing
    no way to install would have the affordance gone and the capability intact,
    which is not a smaller surface, only a less honest one.

    `compactActions` stays: it is about width, and it still governs any control
    the search row grows later.
  */
  return <PluginsList compactActions canInstall={false} />;
}
