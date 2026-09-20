/**
 * The publisher workspace.
 *
 * Replaces the modal that used to hold all of this. A modal was the wrong
 * container for three reasons, and the layout here is the answer to each:
 *
 *  • **It was a stack, not a structure.** Namespace, every listing, and the
 *    publish form were one column you scrolled through inside a 70vh window.
 *    Now: a rail of listings, and one detail pane showing the thing you picked.
 *  • **Editing happened in accordions.** Opening a listing pushed the ones
 *    below it off screen, and the Save button with them. Now editing has the
 *    whole pane and its own save bar.
 *  • **A modal is dismissable.** Everything in here is real, durable state —
 *    listings, visibility, published packages — and a scrim you can click away
 *    frames it as a detour from the dashboard rather than part of it.
 *
 * ## Unsaved work is defended at this level
 *
 * The rail can switch listings while the detail pane has edits in it, which is
 * the one way to lose work here. The editor reports its dirty state up, and
 * navigation asks before discarding. Putting the guard in the shell rather than
 * the editor is what makes it cover every route out: another listing, the new
 * release view, all of it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { customConfirm } from '@components/Modal/Dialogs';
import type { MyRegistryPlugin } from '@core/plugins/registry';
import { ClaimNamespace } from './ClaimNamespace';
import { ListingEditor } from './ListingEditor';
import { NewRelease } from './NewRelease';
import { usePublisherShelf } from './usePublisherShelf';
import styles from './PublisherWorkspace.module.css';

/** What the detail pane is showing. */
type Selection = { kind: 'listing'; id: string } | { kind: 'new-release' };

export function PublisherWorkspace(): JSX.Element {
  const shelf = usePublisherShelf();
  const [selection, setSelection] = useState<Selection>({ kind: 'new-release' });
  const dirty = useRef(false);

  const registerDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);

  /**
   * Move the detail pane, asking first when there is unsaved work.
   *
   * Async because the confirmation is a real dialog, not the OS one: the app
   * forbids `window.confirm` outright, and rightly — an unstyled browser box in
   * the middle of a themed desktop app reads as a bug, and in the Electron
   * build it can be suppressed entirely, which would silently discard edits.
   */
  const navigate = useCallback(async (next: Selection) => {
    if (dirty.current) {
      const go = await customConfirm(
        'Discard unsaved changes?',
        'This listing has edits you have not saved. Leaving now throws them away.',
        { confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', isDanger: true },
      );
      if (!go) return;
      dirty.current = false;
    }
    setSelection(next);
  }, []);

  const selected: MyRegistryPlugin | null = useMemo(() => {
    if (selection.kind !== 'listing') return null;
    return shelf.listings.find((p) => p.id === selection.id) ?? null;
  }, [selection, shelf.listings]);

  // A listing that vanished — withdrawn, or gone after a reload — must not
  // leave the pane pointing at nothing. In an effect, not during render: the
  // pane is about to render one frame with no selection either way, and a
  // setState during render is how that turns into a loop instead.
  useEffect(() => {
    if (shelf.status !== 'ready') return;
    if (selection.kind !== 'listing' || selected) return;
    dirty.current = false;
    setSelection({ kind: 'new-release' });
  }, [shelf.status, selection, selected]);

  if (shelf.status === 'unavailable') {
    return (
      <div className={styles.centered}>
        <div className={styles.empty}>
          <span className={styles.emptyGlyph}>
            <Icon name="plugin" size="md" />
          </span>
          <span className={styles.emptyTitle}>Publishing is part of the hosted build</span>
          <span className={styles.emptyBody}>
            This edition runs plugins but has no registry to publish them to. You can still install a package from disk
            from the Installed tab.
          </span>
        </div>
      </div>
    );
  }

  if (shelf.status === 'loading') {
    return <LoadingWorkspace />;
  }

  if (shelf.status === 'error') {
    return (
      <div className={styles.centered}>
        <div className={styles.empty}>
          <span className={styles.emptyGlyph}>
            <Icon name="lock" size="md" />
          </span>
          <span className={styles.emptyTitle}>Sign in to publish plugins</span>
          <span className={styles.emptyBody}>{shelf.error}</span>
          <Button variant="secondary" size="sm" onClick={() => void shelf.refresh()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (shelf.status === 'unclaimed') {
    return (
      <div className={styles.detail}>
        {shelf.error && <ErrorBanner message={shelf.error} onDismiss={shelf.dismissError} />}
        <div className={styles.detailScroll}>
          <ClaimNamespace onClaimed={() => void shelf.refresh()} onError={shelf.reportError} />
        </div>
      </div>
    );
  }

  const publisher = shelf.publisher!;
  const initial = (publisher.displayName || publisher.namespace).charAt(0);

  return (
    <div className={styles.workspace}>
      <aside className={styles.rail} aria-label="Your published plugins">
        <div className={styles.railHeader}>
          <span className={styles.avatar} aria-hidden="true">
            {initial}
          </span>
          <span className={styles.identity}>
            <span className={styles.namespace}>
              <span className={styles.namespaceText}>{publisher.namespace}</span>
              {publisher.verified && (
                <span className={styles.verified} title="Verified publisher">
                  <Icon name="success" size="sm" />
                </span>
              )}
            </span>
            <span className={styles.displayName}>{publisher.displayName}</span>
          </span>
        </div>

        <div className={styles.railScroll}>
          <span className={styles.railGroupLabel}>
            {shelf.listings.length === 0
              ? 'No listings yet'
              : `${shelf.listings.length} listing${shelf.listings.length === 1 ? '' : 's'}`}
          </span>

          {shelf.listings.map((plugin) => {
            const active = selection.kind === 'listing' && selection.id === plugin.id;
            return (
              <button
                key={plugin.id}
                type="button"
                className={active ? `${styles.railItem} ${styles.railItemActive}` : styles.railItem}
                aria-current={active ? 'true' : undefined}
                onClick={() => void navigate({ kind: 'listing', id: plugin.id })}
              >
                <span
                  className={`${styles.visDot} ${plugin.visibility === 'private' ? styles.visPrivate : styles.visPublic}`}
                  title={plugin.visibility === 'private' ? 'Private' : 'Public'}
                />
                <span className={styles.railItemLabel}>
                  <span className={styles.railItemName}>{plugin.name}</span>
                  <span className={styles.railItemMeta}>
                    v{plugin.latestVersion} · {plugin.installs.toLocaleString()} installs
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div className={styles.railFooter}>
          <Button
            variant={selection.kind === 'new-release' ? 'primary' : 'secondary'}
            size="sm"
            fullWidth
            icon={<Icon name="plus" size="sm" />}
            onClick={() => void navigate({ kind: 'new-release' })}
          >
            New release
          </Button>
        </div>
      </aside>

      <div className={styles.detail}>
        {shelf.error && <ErrorBanner message={shelf.error} onDismiss={shelf.dismissError} />}

        {selected ? (
          <ListingEditor
            key={selected.id}
            plugin={selected}
            onChanged={() => void shelf.refresh()}
            onError={shelf.reportError}
            registerDirty={registerDirty}
          />
        ) : (
          <NewRelease
            namespace={publisher.namespace}
            onPublished={() => void shelf.refresh()}
            onError={shelf.reportError}
          />
        )}
      </div>
    </div>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }): JSX.Element {
  return (
    <div className={`${styles.notice} ${styles.noticeError}`} role="alert">
      <Icon name="error" size="sm" className={styles.noticeIcon} />
      <div className={styles.noticeBody}>{message}</div>
      <div className={styles.noticeActions}>
        <Button variant="ghost" size="sm" iconOnly onClick={onDismiss} aria-label="Dismiss">
          <Icon name="close" size="sm" />
        </Button>
      </div>
    </div>
  );
}

/**
 * First load.
 *
 * The rail's shape, drawn in placeholders — so the pane arrives at the size it
 * will keep rather than jumping when the data lands, and so the structure is
 * legible before there is anything in it.
 */
function LoadingWorkspace(): JSX.Element {
  return (
    <div className={styles.workspace} aria-busy="true" aria-label="Loading your publisher shelf">
      <aside className={styles.rail}>
        <div className={styles.railHeader}>
          <span className={styles.skeletonRail} style={{ width: 36, height: 36, borderRadius: 'var(--radius-control)' }} />
          <span className={styles.identity} style={{ flex: 1 }}>
            <span className={styles.skeletonLine} style={{ width: '60%' }} />
            <span className={styles.skeletonLine} style={{ width: '80%', marginTop: 6 }} />
          </span>
        </div>
        <div className={styles.railScroll}>
          {[0, 1, 2].map((i) => (
            <span key={i} className={styles.skeletonRail} />
          ))}
        </div>
      </aside>
      <div className={styles.detail}>
        <div className={styles.column}>
          <div className={styles.skeletonStack}>
            <span className={styles.skeletonLine} style={{ width: '34%' }} />
            <span className={styles.skeletonLine} style={{ width: '68%' }} />
          </div>
          <span className={styles.skeletonLine} style={{ height: 140 }} />
        </div>
      </div>
    </div>
  );
}
