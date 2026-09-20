/**
 * Plugins, on the editor's own dashboard.
 *
 * The dashboard is where a user manages things that outlive a single project —
 * projects, assets, renders — and plugins belong with them, in both directions:
 * the ones you have installed, and the ones you publish.
 *
 * Those are two jobs, so this is two views behind one switch rather than one
 * page trying to be both. Installed renders `PluginsList`, the same component
 * the editor's left rail uses — two lists of installed plugins that drift apart
 * is the outcome this surface has been arranged to avoid, and a dashboard-
 * shaped copy would drift fastest because it is the one nobody looks at while
 * developing a plugin.
 *
 * ## Why publishing stopped being a modal
 *
 * It used to open `MyPluginsSection` in a `lg` dialog with a 70vh scroll: claim
 * a namespace, every listing as an accordion, and the publish form, stacked in
 * one column. That put durable state — listings, visibility, published
 * packages — behind a scrim you dismiss by clicking beside it, and made editing
 * a README something you did through a letterbox.
 *
 * It is a view now, with the page's full height, and the URL remembers which
 * one you were on.
 */

import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PluginsList } from '@layout/Plugins/PluginsList';
import { PublisherWorkspace } from '@layout/Plugins/publisher/PublisherWorkspace';
import styles from './DashboardPage.module.css';

const VIEWS = ['installed', 'publishing'] as const;
type View = (typeof VIEWS)[number];

const isView = (value: string | null): value is View => value != null && (VIEWS as readonly string[]).includes(value);

export function DashboardPluginsTab(): JSX.Element {
  /*
    `?view=` so a publisher can bookmark the shelf, and so "Publish plugin" in
    the installed list lands somewhere a refresh keeps.

    Through the router's own `useSearchParams`, NOT `window.location.search`.
    The app runs on a hash router, so the query string lives inside the hash
    (`#/dashboard?tab=plugins&view=publishing`) and `location.search` is empty
    there — a hand-rolled reader looks in the wrong place, and the deep link
    silently opens the default view instead. The router already knows where the
    query is; asking it is also what makes back and forward work without a
    popstate listener of our own.
  */
  const [searchParams, setSearchParams] = useSearchParams();
  const param = searchParams.get('view');
  const view: View = isView(param) ? param : 'installed';

  const show = useCallback(
    (next: View) => {
      const params = new URLSearchParams(searchParams);
      // The default view leaves no trace in the URL; only the deliberate one does.
      if (next === 'installed') params.delete('view');
      else params.set('view', next);
      // `replace` rather than push: flipping between two views of one page is
      // not a navigation anyone wants to unwind one click at a time.
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  return (
    <>
      {/*
        No heading here. `DashboardPage` already prints "Plugins" above whichever
        tab is showing, and this page printing its own underneath is how it used
        to open with the same word twice. The two views are named by their tabs
        instead, which is both the accessible name and the visible one.
      */}
      <div className={styles.pluginsViewSwitch}>
        <div className={styles.segmentedGroup} role="tablist" aria-label="Plugin views">
          <button
            type="button"
            role="tab"
            id="plugins-tab-installed"
            aria-controls="plugins-view"
            aria-selected={view === 'installed'}
            className={`${styles.segment} ${view === 'installed' ? styles.segmentActive : ''}`}
            onClick={() => show('installed')}
          >
            Installed
          </button>
          <button
            type="button"
            role="tab"
            id="plugins-tab-publishing"
            aria-controls="plugins-view"
            aria-selected={view === 'publishing'}
            className={`${styles.segment} ${view === 'publishing' ? styles.segmentActive : ''}`}
            onClick={() => show('publishing')}
          >
            Publishing
          </button>
        </div>
      </div>

      <div
        className={styles.pluginsPanelHost}
        id="plugins-view"
        role="tabpanel"
        aria-labelledby={view === 'installed' ? 'plugins-tab-installed' : 'plugins-tab-publishing'}
      >
        {view === 'installed' ? (
          <PluginsList onPublishPlugin={() => show('publishing')} />
        ) : (
          <PublisherWorkspace />
        )}
      </div>
    </>
  );
}
