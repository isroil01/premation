/**
 * Editing one listing.
 *
 * The old shelf expanded every listing into an accordion inside a card inside a
 * modal, so editing a README meant scrolling a 70vh window past the listings
 * you were not editing, with the Save button somewhere below the fold. This is
 * the same fields, arranged as a detail pane: one listing at a time, its
 * sections behind tabs, and a save bar pinned to the bottom of the pane.
 *
 * ## Dirty state is the spine
 *
 * Everything here hangs off "does the form differ from what the server last
 * gave us". It decides whether the save bar exists, which tabs carry a dot, and
 * whether switching listings has to warn first. Keeping the server's copy in a
 * ref and comparing against it — rather than tracking a boolean each field
 * sets — means typing a character and deleting it again correctly returns to
 * clean, which is the difference between a dirty flag people trust and one they
 * learn to ignore.
 *
 * ## What is NOT editable, and why it is said out loud
 *
 * Name and description come out of the signed package. A publisher who cannot
 * find the field to change them should be told the signature covers them, not
 * left hunting — so the Overview tab shows them as read-only values with that
 * sentence attached, rather than omitting them and looking incomplete.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import {
  REGISTRY_CATEGORIES,
  fetchRegistryDetail,
  updateListing,
  type MyRegistryPlugin,
} from '@core/plugins/registry';
import { ListingMediaEditor } from '../ListingMediaEditor';
import { WithdrawDialog } from './WithdrawDialog';
import styles from './PublisherWorkspace.module.css';

const MAX_CATEGORIES = 3;

type TabId = 'overview' | 'media' | 'guide' | 'changelog';

interface ListingForm {
  readme: string;
  changelog: string;
  license: string;
  categories: string[];
}

const EMPTY_FORM: ListingForm = { readme: '', changelog: '', license: '', categories: [] };

const sameForm = (a: ListingForm, b: ListingForm): boolean =>
  a.readme === b.readme &&
  a.changelog === b.changelog &&
  a.license === b.license &&
  a.categories.length === b.categories.length &&
  a.categories.every((c) => b.categories.includes(c));

/** `2026-09-20T…` → `20 Sep 2026`, or empty when the registry sent nothing. */
function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ListingEditor({
  plugin,
  onChanged,
  onError,
  registerDirty,
}: {
  plugin: MyRegistryPlugin;
  onChanged: () => void;
  onError: (message: string | null) => void;
  /** Lets the workspace warn before navigating away from unsaved edits. */
  registerDirty: (dirty: boolean) => void;
}): JSX.Element {
  const [tab, setTab] = useState<TabId>('overview');
  const [form, setForm] = useState<ListingForm>(EMPTY_FORM);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [visBusy, setVisBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

  /** The listing's pictures, and a counter that re-reads them after an upload. */
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [screenshots, setScreenshots] = useState<Array<{ id: string; url: string }>>([]);
  const [mediaRev, setMediaRev] = useState(0);

  /** What the server last gave us — the thing `form` is dirty against. */
  const baseline = useRef<ListingForm>(EMPTY_FORM);
  /** Whether this listing's text fields have already been seeded. */
  const seeded = useRef(false);

  const dirty = loaded && !sameForm(form, baseline.current);
  useEffect(() => registerDirty(dirty), [dirty, registerDirty]);

  // Switching listings resets everything. Without this the next listing opens
  // showing the previous one's README until its own fetch lands.
  useEffect(() => {
    setLoaded(false);
    setForm(EMPTY_FORM);
    baseline.current = EMPTY_FORM;
    seeded.current = false;
    setIconUrl(null);
    setScreenshots([]);
    setTab('overview');
  }, [plugin.id]);

  useEffect(() => {
    let alive = true;
    void fetchRegistryDetail(plugin.id).then((detail) => {
      if (!alive || !detail) {
        // A listing with no detail endpoint answer is still editable — the
        // fields simply start empty rather than the pane sitting on a spinner
        // for ever.
        if (alive) setLoaded(true);
        return;
      }
      setIconUrl(detail.iconUrl ?? null);
      setScreenshots(detail.screenshots ?? []);
      // Text fields seed ONCE per listing. A media upload bumps `mediaRev` and
      // re-runs this effect; re-seeding then would throw away everything typed
      // since, so an icon upload would silently revert an unsaved README.
      //
      // Guarded by a ref rather than by reading `loaded` inside a state
      // updater: an updater must be pure, and React double-invokes them in
      // development, so seeding from inside one runs the side effects twice.
      if (seeded.current) return;
      seeded.current = true;
      const next: ListingForm = {
        readme: detail.readme ?? '',
        changelog: detail.changelog ?? '',
        license: detail.license ?? '',
        categories: detail.categories ?? [],
      };
      baseline.current = next;
      setForm(next);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [plugin.id, mediaRev]);

  // The "Saved" tick is a moment, not a state. It clears itself so the pane
  // does not sit claiming a save that happened two minutes ago.
  useEffect(() => {
    if (!justSaved) return;
    const timer = window.setTimeout(() => setJustSaved(false), 2400);
    return () => window.clearTimeout(timer);
  }, [justSaved]);

  const patch = useCallback((next: Partial<ListingForm>) => {
    setForm((cur) => ({ ...cur, ...next }));
    setJustSaved(false);
  }, []);

  const save = async (): Promise<void> => {
    if (!dirty || saving) return;
    setSaving(true);
    onError(null);
    try {
      await updateListing(plugin.id, {
        readme: form.readme,
        changelog: form.changelog,
        license: form.license,
        categories: form.categories,
      });
      baseline.current = form;
      setJustSaved(true);
      onChanged();
    } catch (err) {
      onError((err as Error).message || 'Could not save the listing.');
    } finally {
      setSaving(false);
    }
  };

  const discard = (): void => {
    setForm(baseline.current);
    setJustSaved(false);
  };

  const toggleVisibility = (): void => {
    const next = plugin.visibility === 'private' ? 'public' : 'private';
    setVisBusy(true);
    onError(null);
    void updateListing(plugin.id, { visibility: next })
      .then(onChanged)
      .catch((err: Error) => onError(err.message || 'Could not change visibility.'))
      .finally(() => setVisBusy(false));
  };

  const toggleCategory = (category: string): void => {
    patch({
      categories: form.categories.includes(category)
        ? form.categories.filter((c) => c !== category)
        : form.categories.length >= MAX_CATEGORIES
          ? form.categories
          : [...form.categories, category],
    });
  };

  /**
   * Which tabs hold an unsaved change — the dot's whole job.
   *
   * Media is never dirty: an upload is committed the moment it lands, so a dot
   * there would promise a save that has already happened.
   */
  const dirtyTabs: Record<TabId, boolean> = useMemo(() => {
    const base = baseline.current;
    const categoriesChanged =
      form.categories.length !== base.categories.length ||
      form.categories.some((c) => !base.categories.includes(c));
    return {
      overview: form.license !== base.license || categoriesChanged,
      media: false,
      guide: form.readme !== base.readme,
      changelog: form.changelog !== base.changelog,
    };
  }, [form]);

  const tabs: Array<{ id: TabId; label: string; count?: number }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'media', label: 'Media', count: screenshots.length + (iconUrl ? 1 : 0) },
    { id: 'guide', label: 'Guide' },
    { id: 'changelog', label: 'Changelog' },
  ];

  return (
    <div className={styles.detail}>
      <header className={styles.detailHeader}>
        <div className={styles.detailTitles}>
          <div className={styles.detailTitleRow}>
            <h3 className={styles.detailTitle}>{plugin.name}</h3>
            <span
              className={`${styles.pill} ${plugin.visibility === 'private' ? styles.pillPrivate : styles.pillPublic}`}
            >
              <span className={`${styles.visDot} ${plugin.visibility === 'private' ? styles.visPrivate : styles.visPublic}`} />
              {plugin.visibility === 'private' ? 'Private' : 'Public'}
            </span>
          </div>
          <span className={styles.detailSub}>{plugin.description}</span>
        </div>

        <div className={styles.detailActions}>
          <Button variant="secondary" size="sm" loading={visBusy} disabled={visBusy} onClick={toggleVisibility}>
            {visBusy ? 'Updating…' : plugin.visibility === 'private' ? 'Make public' : 'Make private'}
          </Button>
          <Button variant="ghost" size="sm" className={styles.dangerText} onClick={() => setWithdrawing(true)}>
            Withdraw…
          </Button>
        </div>
      </header>

      <nav className={styles.tabs} aria-label="Listing sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={[
              styles.tab,
              tab === t.id ? styles.tabActive : '',
              dirtyTabs[t.id] ? styles.tabDirty : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && <span className={styles.tabCount}>{t.count}</span>}
          </button>
        ))}
      </nav>

      <div className={styles.detailScroll}>
        {!loaded ? (
          <LoadingColumn />
        ) : (
          <div className={styles.column}>
            {tab === 'overview' && (
              <>
                <div className={styles.facts}>
                  <div className={styles.fact}>
                    <span className={styles.factValue}>{plugin.installs.toLocaleString()}</span>
                    <span className={styles.factLabel}>Installs</span>
                  </div>
                  <div className={styles.fact}>
                    <span className={styles.factValue}>{plugin.latestVersion}</span>
                    <span className={styles.factLabel}>Latest version</span>
                  </div>
                  <div className={styles.fact}>
                    <span className={styles.factValue}>{formatDate(plugin.updatedAt)}</span>
                    <span className={styles.factLabel}>Last published</span>
                  </div>
                </div>

                {plugin.visibility === 'private' && (
                  <div className={`${styles.notice} ${styles.noticeInfo}`}>
                    <Icon name="info" size="sm" className={styles.noticeIcon} />
                    <div className={styles.noticeBody}>
                      Hidden from marketplace browsing. Only you can install it — copies already installed keep working
                      and keep receiving your updates.
                    </div>
                  </div>
                )}

                <section className={styles.section}>
                  <div className={styles.sectionHead}>
                    <span className={styles.sectionTitle}>Identity</span>
                    <span className={styles.sectionHint}>
                      Read from <code>plugin.json</code> in your signed package. Your signature covers these, so changing
                      them means publishing a new version rather than editing here.
                    </span>
                  </div>
                  <div className={styles.field}>
                    <span className={styles.label}>Plugin id</span>
                    <div className={styles.preview}>{plugin.id}</div>
                  </div>
                </section>

                <section className={styles.section}>
                  <div className={styles.sectionHead}>
                    <span className={styles.sectionTitle}>Categories</span>
                    <span className={styles.sectionHint}>
                      Up to {MAX_CATEGORIES}. These decide where the marketplace files your plugin.
                    </span>
                  </div>
                  <div className={styles.chipRow}>
                    {REGISTRY_CATEGORIES.map((category) => {
                      const on = form.categories.includes(category);
                      return (
                        <button
                          key={category}
                          type="button"
                          className={on ? `${styles.chip} ${styles.chipActive}` : styles.chip}
                          aria-pressed={on}
                          disabled={!on && form.categories.length >= MAX_CATEGORIES}
                          onClick={() => toggleCategory(category)}
                        >
                          {category.replace(/-/g, ' ')}
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className={styles.section}>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`license-${plugin.id}`}>
                      Licence
                    </label>
                    <input
                      id={`license-${plugin.id}`}
                      className={styles.input}
                      value={form.license}
                      onChange={(e) => patch({ license: e.target.value })}
                      placeholder="MIT"
                      maxLength={64}
                    />
                  </div>
                </section>
              </>
            )}

            {tab === 'media' && (
              <section className={styles.section}>
                <div className={styles.sectionHead}>
                  <span className={styles.sectionTitle}>Icon and screenshots</span>
                  <span className={styles.sectionHint}>
                    Pictures save as soon as they upload — they are files, not form fields, so they are not part of the
                    unsaved changes below.
                  </span>
                </div>
                <ListingMediaEditor
                  pluginId={plugin.id}
                  iconUrl={iconUrl}
                  screenshots={screenshots}
                  onChanged={() => {
                    setMediaRev((r) => r + 1);
                    onChanged();
                  }}
                  onError={onError}
                />
              </section>
            )}

            {tab === 'guide' && (
              <section className={styles.section}>
                <div className={styles.sectionHead}>
                  <span className={styles.sectionTitle}>Guide</span>
                  <span className={styles.sectionHint}>
                    Markdown. Headings, lists, code and links render; raw HTML shows as text. This is what someone reads
                    before deciding to install.
                  </span>
                </div>
                <div className={styles.field}>
                  <textarea
                    id={`readme-${plugin.id}`}
                    className={styles.textarea}
                    rows={18}
                    value={form.readme}
                    onChange={(e) => patch({ readme: e.target.value })}
                    placeholder={'## What it does\n\n## How to use it\n\n1. Select a layer\n2. Run “Bounce selection”'}
                    aria-label="Guide"
                  />
                  <span className={styles.charCount}>{form.readme.length.toLocaleString()} characters</span>
                </div>
              </section>
            )}

            {tab === 'changelog' && (
              <section className={styles.section}>
                <div className={styles.sectionHead}>
                  <span className={styles.sectionTitle}>What changed in {plugin.latestVersion}</span>
                  <span className={styles.sectionHint}>
                    Shown to anyone who already has an older version installed, next to the update button.
                  </span>
                </div>
                <div className={styles.field}>
                  <textarea
                    id={`changelog-${plugin.id}`}
                    className={styles.textarea}
                    rows={10}
                    value={form.changelog}
                    onChange={(e) => patch({ changelog: e.target.value })}
                    placeholder={'- Fixed the easing curve on reversed keyframes\n- Added a Danish translation'}
                    aria-label="Changelog"
                  />
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      {(dirty || justSaved) && (
        <div className={styles.saveBar}>
          {dirty ? (
            <>
              <span className={styles.saveBarText}>Unsaved changes to this listing.</span>
              <Button variant="ghost" size="sm" onClick={discard} disabled={saving}>
                Discard
              </Button>
              <Button variant="primary" size="sm" loading={saving} disabled={saving} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save listing'}
              </Button>
            </>
          ) : (
            <span className={styles.savedFlash}>
              <Icon name="success" size="sm" />
              Listing saved
            </span>
          )}
        </div>
      )}

      <WithdrawDialog
        plugin={plugin}
        open={withdrawing}
        onClose={() => setWithdrawing(false)}
        onDone={onChanged}
        onError={onError}
      />
    </div>
  );
}

function LoadingColumn(): JSX.Element {
  return (
    <div className={styles.column} aria-busy="true" aria-label="Loading listing">
      <div className={styles.skeletonStack}>
        <span className={styles.skeletonLine} style={{ width: '38%' }} />
        <span className={styles.skeletonLine} style={{ width: '72%' }} />
        <span className={styles.skeletonLine} style={{ width: '64%' }} />
      </div>
      <div className={styles.skeletonStack}>
        <span className={styles.skeletonLine} style={{ width: '28%' }} />
        <span className={styles.skeletonLine} style={{ height: 96 }} />
      </div>
    </div>
  );
}
