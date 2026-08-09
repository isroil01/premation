/**
 * Plugins, on the editor's own dashboard.
 *
 * The dashboard is where a user manages things that outlive a single project —
 * projects, assets, renders — and installed plugins belong with them. Before
 * this the only route to them was inside an open editor, which meant a user
 * with no project open could not see what they had installed.
 *
 * It renders `PluginsList`, the same component the editor's left rail uses,
 * rather than a dashboard-shaped copy. Two lists of installed plugins that
 * drift apart is the outcome this whole surface has been arranged to avoid, and
 * a second one here would drift fastest — it is the one nobody looks at while
 * developing a plugin. Search, install-from-disk and paging therefore behave
 * identically in both places, because they ARE both places.
 *
 * So the page itself is only two things: the list, and the publisher flow that
 * has no room in a dock column.
 */

import { PluginsList } from '@layout/Plugins/PluginsList';
import { MyPluginsSection } from '@layout/Plugins/MyPluginsSection';
import styles from './DashboardPage.module.css';

export function DashboardPluginsTab(): JSX.Element {
  return (
    <>
      {/*
        No heading here.
        The page already has one: `DashboardPage` renders "Plugins" and a
        description of it above every tab's content. A second "Plugins" heading
        with a second description of the same thing, three lines apart, was two
        answers to a question nobody asked twice — and it pushed the list, the
        only thing on this page anyone came for, below the fold.
      */}

      {/*
        Height-bounded rather than free-flowing. `PluginsList` is a dock panel
        body: its list scrolls INSIDE itself, between a fixed search row and a
        fixed pager. Dropped into a page that also scrolls, that gives two
        nested scrollbars and a pager that drifts off the bottom of the screen.
      */}
      <div className={styles.pluginsPanelHost}>
        <PluginsList />
      </div>

      {/*
        Publishing lives HERE and not in the sidebar. Claiming a namespace and
        editing a listing is a flow with forms and prose in it, and a 280px dock
        column is the wrong place for that — while this page has room. The
        sidebar stays what it should be: find, install, run.

        This heading survives the de-duplication above because it names a
        DIFFERENT thing from the page title. It is the one boundary on the page.
      */}
      <div className={`${styles.sectionHeaderRow} ${styles.publishingHeader}`}>
        <span className={styles.eyebrowBadge}>Developer Platform</span>
        <h2 className={styles.sectionTitle}>Publishing</h2>
        <p className={styles.pluginsSubtitle}>
          Claim a publisher namespace and manage the listings for plugins you have published.
        </p>
      </div>
      <div className={styles.publishingHost}>
        <MyPluginsSection />
      </div>
    </>
  );
}
