/**
 * The publisher shelf, inside the editor.
 *
 * This used to be a link to the web dashboard, which is the wrong answer for a
 * desktop app: the person publishing a plugin is sitting in the editor with the
 * package open, and sending them to a browser to claim a namespace means
 * leaving the tool to do a step that belongs to it.
 *
 * Publishing happens here too now, including the visibility choice. What has NOT
 * changed is where the private key lives: it never enters the renderer and the
 * app never stores it. The form sends package bytes and a visibility to the main
 * process, which asks for the key file, signs, attaches the session and uploads.
 * That key is the whole basis of "an update came from the same author", and a UI
 * that held on to it would defeat the guarantee it exists to provide — so the
 * cost is one file picker per publish, deliberately.
 *
 * The command-line path still works and is what a browser tab falls back to,
 * where there is no file dialog to ask with and no main process to keep it out
 * of.
 *
 * Kept deliberately short. A publisher needs a namespace, a way to publish, and
 * somewhere to write their listing. Anything else on this screen is standing
 * between them and publishing.
 */

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@components/Icon';
import { pluginRegistryEnabled } from '@core/config/edition';
import {
  REGISTRY_CATEGORIES,
  deletePublishedPlugin,
  fetchRegistryDetail,
  myPublishedPlugins,
  myPublishers,
  registerPublisher,
  updateListing,
  type MyRegistryPlugin,
  type PluginVisibility,
  type PublisherRecord,
} from '@core/plugins/registry';
import styles from './PluginsPanel.module.css';

export function MyPluginsSection(): JSX.Element {
  const [publishers, setPublishers] = useState<PublisherRecord[] | null>(null);
  const [published, setPublished] = useState<MyRegistryPlugin[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [pubs, mine] = await Promise.all([myPublishers(), myPublishedPlugins()]);
      setPublishers(pubs);
      setPublished(mine);
    } catch (err) {
      // Almost always "not signed in". Say that, rather than a raw status.
      setPublishers([]);
      setError((err as Error).message || 'Could not load your publisher details.');
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  if (!pluginRegistryEnabled()) {
    return (
      <div className={styles.state}>
        <span className={styles.stateTitle}>Publishing isn&rsquo;t available in this edition.</span>
        <span>The registry is part of the hosted build.</span>
      </div>
    );
  }

  if (publishers === null) return <div className={styles.state}><span>Loading…</span></div>;

  return (
    <div className={styles.list}>
      {error && (
        <div className={styles.state}>
          <span className={styles.stateTitle}>{error}</span>
          <span>Sign in to publish plugins.</span>
        </div>
      )}

      {!error && publishers.length === 0 && (
        <RegisterNamespace
          busy={busy}
          setBusy={setBusy}
          onDone={() => void reload()}
          onError={setError}
        />
      )}

      {publishers.map((p) => (
        <PublisherRow key={p.id} publisher={p} />
      ))}

      {publishers.length > 0 && (
        <>
          <div className={styles.searchRow}>
            <span className={styles.rowMeta}>
              {published.length === 0
                ? 'Nothing published yet.'
                : `${published.length} published`}
            </span>
          </div>
          {published.map((p) => (
            <PublishedRow key={p.id} plugin={p} onError={setError} onChanged={() => void reload()} />
          ))}
          {/* Always available, not only when the shelf is empty: a publisher's
              second plugin needs this as much as their first, and hiding it
              after one publish sent them back to the command line. */}
          <PublishForm
            namespace={publishers[0]!.namespace}
            onDone={() => void reload()}
            onError={setError}
          />
        </>
      )}
    </div>
  );
}

function RegisterNamespace({
  busy, setBusy, onDone, onError,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
  onDone: () => void;
  onError: (e: string | null) => void;
}): JSX.Element {
  const [namespace, setNamespace] = useState('');
  const [displayName, setDisplayName] = useState('');

  const submit = async (): Promise<void> => {
    setBusy(true);
    onError(null);
    try {
      await registerPublisher(namespace.trim().toLowerCase(), displayName.trim());
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.state}>
      <span className={styles.stateTitle}>Choose a namespace.</span>
      <span>
        It becomes the first part of every plugin id you publish — <code>acme.easing-lab</code>.
        It can&rsquo;t be changed later, because plugin ids are permanent.
      </span>
      <input
        className={styles.search}
        placeholder="acme"
        aria-label="Namespace"
        value={namespace}
        onChange={(e) => setNamespace(e.target.value)}
      />
      <input
        className={styles.search}
        placeholder="Acme Studio"
        aria-label="Display name"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
      />
      <button
        type="button"
        className={styles.stateAction}
        disabled={busy || !namespace.trim() || !displayName.trim()}
        onClick={() => void submit()}
      >
        {busy ? 'Registering…' : 'Register namespace'}
      </button>
    </div>
  );
}

/**
 * A namespace you own.
 *
 * One line, because that is all there is to say. There was a domain
 * verification flow here — enter a domain, publish a DNS TXT record or a
 * well-known file, come back and press Check — for an optional badge. Removed.
 *
 * It was ceremony placed directly in the path of the one thing a publisher
 * actually came here to do, and it made a solo author with no company domain
 * think they could not publish. The badge is now something an operator grants,
 * which is both rarer and more honest: a self-served claim about a domain is
 * not evidence anyone was checking.
 */
function PublisherRow({ publisher }: { publisher: PublisherRecord }): JSX.Element {
  return (
    <div className={styles.row} style={{ alignItems: 'center' }}>
      <span className={styles.rowIcon}><Icon name="user" size="md" /></span>
      <span className={styles.rowBody}>
        <span className={styles.rowTop}>
          <span className={styles.rowName}>{publisher.namespace}</span>
          <span className={styles.rowPublisher}>{publisher.displayName}</span>
          {publisher.verified && (
            <span className={styles.rowVerified} title="Verified publisher">
              <Icon name="success" size="sm" />
            </span>
          )}
        </span>
      </span>
    </div>
  );
}

/**
 * One published plugin, with its listing editor.
 *
 * WHAT IS EDITABLE HERE, and what is not, is the whole point of this component:
 *
 *   • `name` and `description` come from `plugin.json` and are read out of the
 *     SIGNED package at publish time. They are NOT fields here, deliberately —
 *     if a listing could claim a name or a summary the package does not carry,
 *     the listing would be an advertisement rather than a description. Change
 *     them in the manifest and publish.
 *   • The README, changelog, categories and licence describe the LISTING. They
 *     live outside the signed bytes so that fixing a typo is a save, not a new
 *     signed version every installed copy is asked to update to.
 *
 * That split is why the fields below look incomplete at first glance. They are
 * everything a publisher can change without cutting a release.
 */
function PublishedRow({
  plugin, onError, onChanged,
}: {
  plugin: MyRegistryPlugin;
  onError: (e: string | null) => void;
  onChanged: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [visBusy, setVisBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [readme, setReadme] = useState('');
  const [changelog, setChangelog] = useState('');
  const [license, setLicense] = useState('');
  const [categories, setCategories] = useState<string[]>([]);

  // Fetched only when the editor is opened, and only once. The shelf is a list;
  // pulling every plugin's README to render rows nobody expanded would make it
  // slower for exactly the publishers who have the most plugins.
  useEffect(() => {
    if (!open || loaded) return;
    let alive = true;
    void fetchRegistryDetail(plugin.id).then((d) => {
      if (!alive || !d) return;
      setReadme(d.readme ?? '');
      setChangelog(d.changelog ?? '');
      setLicense(d.license ?? '');
      setCategories(d.categories ?? []);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [open, loaded, plugin.id]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaved(false);
    onError(null);
    try {
      await updateListing(plugin.id, { readme, changelog, license, categories });
      setSaved(true);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleCategory = (c: string): void => {
    setCategories((cur) =>
      cur.includes(c) ? cur.filter((x) => x !== c)
      // Capped at three. A plugin listed in nine categories is in none of them.
      : cur.length >= 3 ? cur
      : [...cur, c],
    );
  };

  return (
    <div className={styles.row} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <span className={styles.rowTop}>
        <span className={styles.rowName}>{plugin.name}</span>
        <span className={styles.rowPublisher}>{plugin.latestVersion}</span>
      </span>
      <span className={styles.rowMeta}>
        <span>{plugin.installs.toLocaleString()} installs</span>
        <span>{plugin.visibility === 'private' ? 'Private' : 'Public'}</span>
        <button
          type="button"
          className={styles.mini}
          disabled={visBusy}
          onClick={() => {
            const next = plugin.visibility === 'private' ? 'public' : 'private';
            setVisBusy(true);
            onError(null);
            void updateListing(plugin.id, { visibility: next })
              .then(onChanged)
              .catch((err: Error) => onError(err.message || 'Could not change visibility.'))
              .finally(() => setVisBusy(false));
          }}
        >
          {plugin.visibility === 'private' ? 'Make public' : 'Make private'}
        </button>
        <button type="button" className={styles.mini} onClick={() => setOpen((v) => !v)}>
          {open ? 'Close' : 'Edit listing'}
        </button>
      </span>

      {/*
        Going private is reversible and says so; deleting is not, so it asks.
        The two sit together because they are the same decision at different
        strengths — "stop offering this" and "stop offering this and throw away
        the listing" — and a publisher reaching for the second usually wants the
        first.
      */}
      {plugin.visibility === 'private' && (
        <span className={styles.rowMeta}>
          Hidden from the marketplace. Only you can install it — copies already
          installed elsewhere keep working.
        </span>
      )}

      <span className={styles.rowMeta}>
        {!confirmDelete ? (
          <button type="button" className={styles.mini} onClick={() => setConfirmDelete(true)}>
            Withdraw…
          </button>
        ) : (
          <>
            <span>
              Withdraw <strong>{plugin.name}</strong> permanently? The listing and every
              version go. Copies already installed keep working — this stops new
              installs, it does not recall anything. Consider Make&nbsp;private instead.
            </span>
            <button
              type="button"
              className={styles.mini}
              disabled={deleting}
              onClick={() => {
                setDeleting(true);
                onError(null);
                void deletePublishedPlugin(plugin.id)
                  .then(onChanged)
                  .catch((err: Error) => {
                    // Thrown, not swallowed: a publisher told this worked when
                    // it did not stops watching a plugin that is still on sale.
                    onError(err.message || 'Could not withdraw the plugin.');
                    setDeleting(false);
                    setConfirmDelete(false);
                  });
              }}
            >
              {deleting ? 'Withdrawing…' : 'Withdraw permanently'}
            </button>
            <button type="button" className={styles.mini} onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </>
        )}
      </span>

      {open && !loaded && <span className={styles.rowMeta}>Loading listing…</span>}

      {open && loaded && (
        <>
          <span className={styles.rowMeta}>
            Name and summary come from <code>plugin.json</code> — they are read from the signed
            package, so a listing cannot claim what the package does not say.
          </span>

          <label className={styles.rowMeta} htmlFor={`readme-${plugin.id}`}>
            Guide (Markdown). Headings, lists, code, links. Raw HTML shows as text.
          </label>
          <textarea
            id={`readme-${plugin.id}`}
            className={styles.textarea}
            rows={8}
            value={readme}
            onChange={(e) => setReadme(e.target.value)}
            placeholder={'## What it does\n\n## How to use it\n\n1. Select a layer\n2. Run “Bounce selection”'}
          />

          <label className={styles.rowMeta} htmlFor={`changelog-${plugin.id}`}>
            What changed in this version
          </label>
          <textarea
            id={`changelog-${plugin.id}`}
            className={styles.textarea}
            rows={4}
            value={changelog}
            onChange={(e) => setChangelog(e.target.value)}
          />

          <span className={styles.rowMeta}>Categories (up to 3)</span>
          <span className={styles.filters}>
            {REGISTRY_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                className={categories.includes(c) ? `${styles.chip} ${styles.chipActive}` : styles.chip}
                aria-pressed={categories.includes(c)}
                onClick={() => toggleCategory(c)}
              >
                {c.replace(/-/g, ' ')}
              </button>
            ))}
          </span>

          <label className={styles.rowMeta} htmlFor={`license-${plugin.id}`}>Licence</label>
          <input
            id={`license-${plugin.id}`}
            className={styles.search}
            placeholder="MIT"
            value={license}
            onChange={(e) => setLicense(e.target.value)}
          />

          <span className={styles.rowActions}>
            <button
              type="button"
              className={`${styles.mini} ${styles.miniPrimary}`}
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save listing'}
            </button>
            {saved && <span className={styles.rowMeta}>Saved.</span>}
          </span>
          <span className={styles.rowMeta}>
            Icons and screenshots are uploaded from the web dashboard, where there is room to see
            them.
          </span>
        </>
      )}
    </div>
  );
}

/**
 * The signing commands, with the user's real namespace already in them.
 *
 * A generic snippet with `<your-namespace>` in it is a snippet everybody pastes
 * wrong exactly once.
 */
/** The main-process publish verb, or null outside the desktop shell. */
function publishBridge(): ((req: unknown) => Promise<unknown>) | null {
  const w = window as unknown as { motionEditor?: { pluginPublish?: (r: unknown) => Promise<unknown> } };
  return w.motionEditor?.pluginPublish ?? null;
}

/**
 * Publish a package, and choose who can see it.
 *
 * ── Why the key is not a field here ──────────────────────────────────────────
 *
 * There is no key input on this form, and that is the design. The renderer sends
 * BYTES and a visibility choice; the main process asks for the key file, signs,
 * attaches the session and uploads. So the private key is never in the renderer,
 * never stored by the app, and never held past the call — which is what keeps
 * "this update came from the same author" meaning something. A stolen signing
 * key cannot be undone by blocking a version; the publisher has to rotate it and
 * every installed copy has to agree.
 *
 * The consequence the user feels is one file picker per publish. That is the
 * price, and it is stated on the button rather than left as a surprise.
 */
function PublishForm({
  namespace, onDone, onError,
}: {
  namespace: string;
  onDone: () => void;
  onError: (e: string | null) => void;
}): JSX.Element {
  const bridge = publishBridge();
  const [file, setFile] = useState<File | null>(null);
  const [visibility, setVisibility] = useState<PluginVisibility>('public');
  const [busy, setBusy] = useState(false);

  // No bridge means this is a browser tab, where there is no file dialog to ask
  // for a key and no main process to keep it out of. Say so and show the CLI.
  if (!bridge) return <SigningSteps namespace={namespace} />;

  const submit = async (): Promise<void> => {
    if (!file) return;
    setBusy(true);
    onError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = (await bridge({ bytes, visibility })) as
        { ok: boolean; error?: string; cancelled?: boolean };
      // Cancelling the key picker is not a failure. Reporting it as one teaches
      // people to ignore the error line.
      if (!res.ok && !res.cancelled) onError(res.error || 'The publish failed.');
      if (res.ok) { setFile(null); onDone(); }
    } catch (err) {
      onError((err as Error).message || 'The publish failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.state}>
      <span className={styles.stateTitle}>Publish a plugin.</span>
      <span>
        Zip the folder containing <code>plugin.json</code>. Its <code>id</code> must start with{' '}
        <code>{namespace}.</code> — the registry refuses a package published under
        someone else&rsquo;s namespace.
      </span>

      <input
        type="file"
        accept=".zip,.mplugin"
        aria-label="Package"
        className={styles.search}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />

      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className={styles.rowMeta}>Who can see it</legend>
        {(['public', 'private'] as const).map((v) => (
          <label key={v} className={styles.rowMeta} style={{ display: 'block' }}>
            <input
              type="radio"
              name="visibility"
              value={v}
              checked={visibility === v}
              onChange={() => setVisibility(v)}
            />{' '}
            {v === 'public'
              ? 'Public — listed in the marketplace, anyone can install it'
              : 'Private — only you can see or install it'}
          </label>
        ))}
      </fieldset>

      <span className={styles.rowMeta}>
        You can change this later. Note that going private stops new installs and
        does not remove copies people already have.
      </span>

      <button
        type="button"
        className={styles.stateAction}
        disabled={busy || !file}
        onClick={() => void submit()}
      >
        {busy ? 'Publishing…' : 'Choose signing key and publish'}
      </button>
      <span className={styles.rowMeta}>
        Your signing key is read once to sign this package and is never stored.
      </span>
    </div>
  );
}

function SigningSteps({ namespace }: { namespace: string }): JSX.Element {
  return (
    <div className={styles.state}>
      <span className={styles.stateTitle}>Publish from the command line.</span>
      <span>
        Your signing key never leaves this machine — it is what proves an update came from you.
      </span>
      <code className={styles.rowDesc} style={{ userSelect: 'all', whiteSpace: 'pre-wrap', textAlign: 'left' }}>
        {`node scripts/sign-plugin.mjs keygen
# set "id": "${namespace}.<name>" in plugin.json
node scripts/sign-plugin.mjs sign    ./${namespace}-<name>.zip
node scripts/sign-plugin.mjs publish ./${namespace}-<name>.zip`}
      </code>
    </div>
  );
}
