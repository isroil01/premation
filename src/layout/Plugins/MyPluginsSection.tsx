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
import styles from './MyPluginsSection.module.css';

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
      <div className={styles.cardShell}>
        <div className={styles.stateBox}>
          <span className={styles.stateTitle}>Publishing isn&rsquo;t available in this edition.</span>
          <span>The registry is part of the hosted build.</span>
        </div>
      </div>
    );
  }

  if (publishers === null) {
    return (
      <div className={styles.cardShell}>
        <div className={styles.stateBox}>
          <Icon name="refresh" className={styles.spin} size="md" />
          <span>Loading publisher shelf…</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {error && (
        <div className={styles.errorBanner}>
          <Icon name="error" size="sm" />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontWeight: 600 }}>{error}</span>
            <span style={{ fontSize: '0.75rem', opacity: 0.85 }}>Sign in to publish plugins.</span>
          </div>
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
          <div className={styles.cardShell}>
            <div className={styles.sectionSubheader}>
              <span className={styles.sectionTitle}>Your Published Listings</span>
              <span className={styles.countBadge}>
                {published.length === 0 ? '0 published' : `${published.length} published`}
              </span>
            </div>

            {published.length === 0 ? (
              <div className={styles.stateBox} style={{ padding: '20px 0' }}>
                <Icon name="info" size="md" />
                <span style={{ fontSize: '0.84rem' }}>Nothing published under this namespace yet.</span>
              </div>
            ) : (
              published.map((p) => (
                <PublishedRow
                  key={p.id}
                  plugin={p}
                  onError={setError}
                  onChanged={() => void reload()}
                />
              ))
            )}
          </div>

          <div className={styles.cardShell}>
            <div className={styles.sectionSubheader}>
              <span className={styles.sectionTitle}>Publish Package</span>
              <span style={{ fontSize: '0.74rem', color: 'var(--color-text-secondary, #a6a6a6)' }}>
                Release a new plugin or update an existing listing
              </span>
            </div>
            <PublishForm
              namespace={publishers[0]!.namespace}
              onDone={() => void reload()}
              onError={setError}
            />
          </div>
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

  const previewId = namespace.trim() ? `${namespace.trim().toLowerCase()}.easing-lab` : 'acme.easing-lab';

  return (
    <div className={styles.cardShell}>
      <div className={styles.registerBox}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span className={styles.sectionTitle}>Choose a Publisher Namespace</span>
          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary, #a6a6a6)', lineHeight: 1.45 }}>
            Your namespace forms the permanent prefix for all your published plugin IDs. For instance:{' '}
            <code className={styles.previewBadge}>{previewId}</code>
          </span>
        </div>

        <div className={styles.formField}>
          <label className={styles.fieldLabel} htmlFor="reg-namespace">Namespace ID (permanent)</label>
          <input
            id="reg-namespace"
            className={styles.input}
            placeholder="acme"
            aria-label="Namespace"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
          />
        </div>

        <div className={styles.formField}>
          <label className={styles.fieldLabel} htmlFor="reg-displayname">Display Name (author / studio)</label>
          <input
            id="reg-displayname"
            className={styles.input}
            placeholder="Acme Studio"
            aria-label="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          style={{ alignSelf: 'flex-start', marginTop: '4px' }}
          disabled={busy || !namespace.trim() || !displayName.trim()}
          onClick={() => void submit()}
        >
          {busy ? (
            <>
              <Icon name="refresh" className={styles.spin} size="sm" />
              <span>Registering…</span>
            </>
          ) : (
            'Register namespace'
          )}
        </button>
      </div>
    </div>
  );
}

function PublisherRow({ publisher }: { publisher: PublisherRecord }): JSX.Element {
  const initial = publisher.displayName ? publisher.displayName.charAt(0).toUpperCase() : publisher.namespace.charAt(0).toUpperCase();

  return (
    <div className={styles.publisherBanner}>
      <div className={styles.publisherInfo}>
        <div className={styles.publisherAvatar}>{initial}</div>
        <div className={styles.publisherMeta}>
          <div className={styles.publisherNamespaceRow}>
            <span className={styles.publisherNamespace}>{publisher.namespace}</span>
            {publisher.verified && (
              <span className={styles.verifiedBadge} title="Verified publisher">
                <Icon name="success" size="sm" /> Verified
              </span>
            )}
          </div>
          <span className={styles.publisherDisplayName}>{publisher.displayName}</span>
        </div>
      </div>
    </div>
  );
}

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
      : cur.length >= 3 ? cur
      : [...cur, c],
    );
  };

  return (
    <div className={styles.pluginCard}>
      <div className={styles.pluginCardHeader}>
        <div className={styles.pluginMainInfo}>
          <div className={styles.pluginNameRow}>
            <span className={styles.pluginName}>{plugin.name}</span>
            <span className={styles.pluginVersion}>v{plugin.latestVersion}</span>
          </div>

          <div className={styles.pluginBadgesRow}>
            <span className={`${styles.badge} ${styles.badgeInstalls}`}>
              <Icon name="download" size="sm" />
              {plugin.installs.toLocaleString()} installs
            </span>
            <span className={`${styles.badge} ${plugin.visibility === 'private' ? styles.badgePrivate : styles.badgePublic}`}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
              {plugin.visibility === 'private' ? 'Private' : 'Public'}
            </span>
          </div>
        </div>

        <div className={styles.actionRow}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSecondary}`}
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
          <button
            type="button"
            className={`${styles.btn} ${open ? styles.btnPrimary : styles.btnSecondary}`}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Close' : 'Edit listing'}
          </button>
        </div>
      </div>

      {plugin.visibility === 'private' && (
        <div className={styles.infoNote}>
          Hidden from marketplace browsing. Only you can view or install it — existing copies already installed keep working smoothly.
        </div>
      )}

      {!confirmDelete ? (
        <div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            style={{ fontSize: '0.74rem', padding: '4px 8px' }}
            onClick={() => setConfirmDelete(true)}
          >
            Withdraw…
          </button>
        </div>
      ) : (
        <div className={styles.withdrawCard}>
          <div className={styles.withdrawTitle}>
            <Icon name="warning" size="sm" />
            <span>Withdraw {plugin.name} permanently?</span>
          </div>
          <div className={styles.withdrawDesc}>
            The listing and every published version will be deleted from the registry. Installed copies will remain functional. Consider using <strong>Make private instead</strong> if you only want to stop new public downloads.
          </div>
          <div className={styles.withdrawActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnDanger}`}
              disabled={deleting}
              onClick={() => {
                setDeleting(true);
                onError(null);
                void deletePublishedPlugin(plugin.id)
                  .then(onChanged)
                  .catch((err: Error) => {
                    onError(err.message || 'Could not withdraw the plugin.');
                    setDeleting(false);
                    setConfirmDelete(false);
                  });
              }}
            >
              {deleting ? 'Withdrawing…' : 'Withdraw permanently'}
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSecondary}`}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {open && !loaded && (
        <div className={styles.stateBox} style={{ padding: '12px' }}>
          <Icon name="refresh" className={styles.spin} size="sm" />
          <span style={{ fontSize: '0.78rem' }}>Loading listing details…</span>
        </div>
      )}

      {open && loaded && (
        <div className={styles.editorDrawer}>
          <div className={styles.infoNote}>
            Name and summary are verified from <code>plugin.json</code> in your signed package. Edit README, changelog, categories, and license below to refine your listing.
          </div>

          <div className={styles.formField}>
            <label className={styles.fieldLabel} htmlFor={`readme-${plugin.id}`}>
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
          </div>

          <div className={styles.formField}>
            <label className={styles.fieldLabel} htmlFor={`changelog-${plugin.id}`}>
              What changed in this version
            </label>
            <textarea
              id={`changelog-${plugin.id}`}
              className={styles.textarea}
              rows={4}
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
            />
          </div>

          <div className={styles.formField}>
            <span className={styles.fieldLabel}>Categories (up to 3)</span>
            <div className={styles.categoryGrid}>
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
            </div>
          </div>

          <div className={styles.formField}>
            <label className={styles.fieldLabel} htmlFor={`license-${plugin.id}`}>Licence</label>
            <input
              id={`license-${plugin.id}`}
              className={styles.input}
              placeholder="MIT"
              value={license}
              onChange={(e) => setLicense(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' }}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? (
                <>
                  <Icon name="refresh" className={styles.spin} size="sm" />
                  <span>Saving…</span>
                </>
              ) : (
                'Save listing'
              )}
            </button>
            {saved && (
              <span style={{ fontSize: '0.78rem', color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Icon name="success" size="sm" /> Saved
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function publishBridge(): ((req: unknown) => Promise<unknown>) | null {
  const w = window as unknown as { motionEditor?: { pluginPublish?: (r: unknown) => Promise<unknown> } };
  return w.motionEditor?.pluginPublish ?? null;
}

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
  const [isDragOver, setIsDragOver] = useState(false);

  if (!bridge) return <SigningSteps namespace={namespace} />;

  const submit = async (): Promise<void> => {
    if (!file) return;
    setBusy(true);
    onError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = (await bridge({ bytes, visibility })) as
        { ok: boolean; error?: string; cancelled?: boolean };
      if (!res.ok && !res.cancelled) onError(res.error || 'The publish failed.');
      if (res.ok) { setFile(null); onDone(); }
    } catch (err) {
      onError((err as Error).message || 'The publish failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setFile(e.dataTransfer.files[0]);
    }
  };

  return (
    <div className={styles.publishForm}>
      <div
        className={`${styles.dropzone} ${isDragOver ? styles.dropzoneActive : ''}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
      >
        <input
          type="file"
          accept=".zip,.mplugin"
          aria-label="Package"
          className={styles.hiddenFileInput}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        {!file ? (
          <>
            <div className={styles.dropzoneIcon}>
              <Icon name="upload" size="md" />
            </div>
            <div className={styles.dropzoneText}>
              Drag &amp; drop package archive (.zip or .mplugin)
            </div>
            <div className={styles.dropzoneHint}>
              Package ID must start with <code>{namespace}.</code> in <code>plugin.json</code>
            </div>
          </>
        ) : (
          <div className={styles.fileBadge}>
            <Icon name="file" size="sm" />
            <span>{file.name}</span>
            <span style={{ opacity: 0.6, fontSize: '0.74rem' }}>
              ({(file.size / 1024).toFixed(1)} KB)
            </span>
            <button
              type="button"
              className={styles.btnGhost}
              style={{ padding: '2px 6px', marginLeft: 8 }}
              onClick={(e) => { e.stopPropagation(); setFile(null); }}
            >
              <Icon name="close" size="sm" />
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span className={styles.fieldLabel}>Who can see this listing</span>
        <div className={styles.radioGrid}>
          <label className={`${styles.radioCard} ${visibility === 'public' ? styles.radioCardActive : ''}`}>
            <input
              type="radio"
              name="visibility"
              value="public"
              className={styles.radioInput}
              checked={visibility === 'public'}
              onChange={() => setVisibility('public')}
              aria-label="Public"
            />
            <div className={styles.radioContent}>
              <span className={styles.radioTitle}>Public Marketplace</span>
              <span className={styles.radioDesc}>Visible to everyone in the plugin store for instant installation.</span>
            </div>
          </label>

          <label className={`${styles.radioCard} ${visibility === 'private' ? styles.radioCardActive : ''}`}>
            <input
              type="radio"
              name="visibility"
              value="private"
              className={styles.radioInput}
              checked={visibility === 'private'}
              onChange={() => setVisibility('private')}
              aria-label="Private"
            />
            <div className={styles.radioContent}>
              <span className={styles.radioTitle}>Private Listing</span>
              <span className={styles.radioDesc}>Only you can view and install this plugin package.</span>
            </div>
          </label>
        </div>
      </div>

      <div className={styles.securityNote}>
        <Icon name="lock" size="sm" className={styles.securityIcon} />
        <span>Your private signing key is requested once by desktop system prompt and is never stored or transmitted to the renderer.</span>
      </div>

      <button
        type="button"
        className={`${styles.btn} ${styles.btnPrimary}`}
        style={{ padding: '10px 18px', fontSize: '0.85rem', alignSelf: 'flex-start' }}
        disabled={busy || !file}
        onClick={() => void submit()}
      >
        {busy ? (
          <>
            <Icon name="refresh" className={styles.spin} size="sm" />
            <span>Publishing package…</span>
          </>
        ) : (
          <>
            <Icon name="lock" size="sm" />
            <span>Choose signing key and publish</span>
          </>
        )}
      </button>
    </div>
  );
}

function SigningSteps({ namespace }: { namespace: string }): JSX.Element {
  const code = `node scripts/sign-plugin.mjs keygen
# set "id": "${namespace}.<name>" in plugin.json
node scripts/sign-plugin.mjs sign    ./${namespace}-<name>.zip
node scripts/sign-plugin.mjs publish ./${namespace}-<name>.zip`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span className={styles.sectionTitle}>Publish from the command line</span>
        <span style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary, #a6a6a6)' }}>
          Your signing key stays local to your terminal environment.
        </span>
      </div>

      <div className={styles.terminalBox}>
        <div className={styles.terminalHeader}>
          <div className={styles.terminalDots}>
            <span className={styles.dotRed} />
            <span className={styles.dotYellow} />
            <span className={styles.dotGreen} />
          </div>
          <span className={styles.terminalTitle}>bash / zsh</span>
        </div>
        <pre className={styles.codeContent}>{code}</pre>
      </div>
    </div>
  );
}
