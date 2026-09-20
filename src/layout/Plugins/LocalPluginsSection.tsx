/**
 * The plugins folder, in the Plugins panel.
 *
 * This is the desktop half of installing: a directory on the machine that the
 * app scans at launch, the way After Effects scans MediaCore and an OFX host
 * scans its Plugins folder. A vendor installer writes there; an author works
 * there. Neither of them wants to drag a zip onto a panel, and an author
 * REALLY does not want to do it once per edit.
 *
 * It is a section of its own rather than rows mixed into `PluginsList`, and the
 * reason is that these plugins have a different lifecycle. An installed plugin
 * is a copy this app owns, in IndexedDB, that survives until the user removes
 * it. One of these is a mirror of something on disk — it can change under us,
 * it can be unsigned, and "uninstall" is the wrong verb for it (the files are
 * still there; only this app's copy went away). Presenting them as the same
 * kind of thing would make every one of those differences a surprise.
 *
 * What each row does, once: read the package, check what it may do, ask if it
 * has to, install. Everything a plugin is then allowed to do is decided by the
 * same consent screen and the same permission gate as a registry install —
 * where a package came from changes how it gets IN, not what it may do after.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { Modal } from '@components/Modal';
import { customAlert, customConfirm } from '@components/Modal/Dialogs';
import pluginHost from '@core/plugins/PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import {
  consentNeed,
  getLocalPluginState,
  loadLocalPackage,
  loadVerdict,
  localPluginsAvailable,
  openPluginsFolder,
  refreshLocalPlugins,
  subscribeLocalPlugins,
  watchLocalPlugins,
  type LocalPluginCandidate,
} from '@core/plugins/localPlugins';
import {
  developerModeEnabled,
  setDeveloperMode,
  subscribeDeveloperMode,
} from '@core/plugins/developerMode';
import type { PluginPackage } from '@core/plugins/pluginPackage';
import { ConsentSheet, ConsentOverlay } from './ConsentSheet';
import { PluginLogSheet } from './PluginLogSheet';
import styles from './LocalPlugins.module.css';

/** Where a candidate came from, in two words a person can act on. */
const SOURCE_LABEL: Record<LocalPluginCandidate['source'], string> = {
  user: 'Folder',
  machine: 'Shared folder',
  env: 'Dev path',
};

export function LocalPluginsSection(): JSX.Element | null {
  const state = useSyncExternalStore(subscribeLocalPlugins, getLocalPluginState);
  const devMode = useSyncExternalStore(subscribeDeveloperMode, developerModeEnabled);
  const installed = usePluginStore((s) => s.plugins);
  const hydrated = usePluginStore((s) => s.hydrated);
  /**
   * The package waiting on the consent sheet, with its folder's compiled
   * modules beside it.
   *
   * Carried through rather than re-read after the sheet closes: the hashes were
   * measured by the scan that produced this candidate, and a second read would
   * be a second chance for the bytes on disk to have changed between the screen
   * the user approved and the binary that is loaded.
   */
  const [pending, setPending] = useState<
    { pkg: PluginPackage; native?: { dir: string; hashes: Record<string, string> } } | null
  >(null);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showInfoModal, setShowInfoModal] = useState(false);

  // The first scan waits for hydration, because deciding whether a candidate
  // needs consent means comparing it against what is already installed — and
  // before `hydrate()` the installed list is whatever `localStorage` had.
  useEffect(() => {
    if (hydrated && localPluginsAvailable()) void refreshLocalPlugins();
  }, [hydrated]);

  /*
    Watching is developer mode's other half.

    Outside an edit/run loop nothing in these folders changes between launches,
    and a recursive filesystem watch costs handles and wakes the process on
    every write — so it is not on by default. With developer mode on, a save in
    an editor re-scans, which is the loop an author actually wants.
  */
  useEffect(() => {
    if (!devMode || !localPluginsAvailable()) return undefined;
    return watchLocalPlugins(() => { void refreshLocalPlugins(); });
  }, [devMode]);

  const installedById = useMemo(
    () => new Map(installed.map((p) => [p.manifest.id, p])),
    [installed],
  );

  const load = useCallback(
    async (candidate: LocalPluginCandidate): Promise<void> => {
      if (!candidate.manifest) return;
      const verdict = loadVerdict(candidate, devMode);
      if (!verdict.allowed) { void customAlert('This plugin was not loaded', verdict.reason, { isDanger: true }); return; }

      setBusy(candidate.path);
      const { pkg, errors, signature, native } = await loadLocalPackage(candidate);
      setBusy(null);
      if (!pkg) {
        void customAlert('Could not read that package', errors.join('\n'), { isDanger: true });
        return;
      }

      const existing = installedById.get(pkg.manifest.id);
      const need = consentNeed(pkg.manifest, existing, signature);
      if (need === 'publisher') {
        /*
          Trust-on-first-use, locally. A signed package whose key is not the one
          this machine pinned for that id is not an update — it is a different
          author claiming the same name, and the safe answer is to say so rather
          than to offer a consent screen that would read as routine.
        */
        void customAlert(
          'This package was signed by a different key',
          `“${pkg.manifest.name}” is installed on this machine under a different publisher key. `
          + 'Remove the installed copy first if you are sure this one is yours.',
          { isDanger: true },
        );
        return;
      }
      if (need !== 'none') { setPending({ pkg, ...(native ? { native } : {}) }); return; }

      // An unchanged reload. Re-granting exactly what was already granted, so
      // nothing widens by taking this path.
      const err = pluginHost.install(pkg, existing?.granted ?? [], {
        source: candidate.kind === 'archive' ? 'file' : 'folder',
        ...(signature?.ok && signature.publisherKey ? { publisherKey: signature.publisherKey } : {}),
        ...(native ? { native } : {}),
      });
      if (err) void customAlert('Could not load plugin', err, { isDanger: true });
    },
    [devMode, installedById],
  );

  const toggleDevMode = useCallback(async (next: boolean): Promise<void> => {
    if (!next) { setDeveloperMode(false); return; }
    const ok = await customConfirm(
      'Turn on Developer Mode?',
      'Plugins in your plugins folder will be loaded even though nobody has signed them — '
      + 'so nothing can tell you who wrote the code or that it has not been changed since. '
      + 'They still run sandboxed, and still ask for the permissions they need. '
      + 'Turn this on while you are writing a plugin, and off afterwards.',
      { confirmLabel: 'Turn on', isDanger: true },
    );
    if (ok) setDeveloperMode(true);
  }, []);

  if (!state.available) return null;

  return (
    <section className={styles.section} aria-label="Plugins folder">
      <header className={styles.head}>
        <div className={styles.titleGroup}>
          <span className={styles.title}>Plugins folder</span>
          {devMode && (
            <span className={styles.devBadge} title="Developer Mode is enabled">
              Dev
            </span>
          )}
        </div>
        <div className={styles.headActions}>
          <button
            type="button"
            className={styles.iconBtn}
            title="Plugins folder info and settings"
            aria-label="Plugins folder info"
            onClick={() => setShowInfoModal(true)}
          >
            <Icon name="info" size="sm" />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            title="Scan the plugins folders again"
            aria-label="Rescan plugins folders"
            onClick={() => { void refreshLocalPlugins(); }}
          >
            <Icon name="refresh" size="sm" />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            title="Open the plugins folder on this computer"
            aria-label="Open plugins folder"
            onClick={async () => {
              const problem = await openPluginsFolder();
              if (problem) void customAlert('Could not open the folder', problem, { isDanger: true });
            }}
          >
            <Icon name="folder" size="sm" />
          </button>
        </div>
      </header>

      {state.error && <p className={styles.problem}>{state.error}</p>}

      {state.plugins.length === 0 && !state.scanning && (
        <p className={styles.empty}>
          No local plugins found.
        </p>
      )}

      <ul className={styles.list}>
        {state.plugins.map((candidate) => {
          const manifest = candidate.manifest!;
          const existing = installedById.get(manifest.id);
          const verdict = loadVerdict(candidate, devMode);
          const running = existing && pluginHost.isRunning(manifest.id);
          const sameVersion = existing?.manifest.version === manifest.version;
          return (
            <li key={candidate.path} className={styles.row}>
              <div className={styles.rowMain}>
                <span className={styles.name}>{manifest.name}</span>
                <span className={styles.meta}>
                  {manifest.version}
                  {' · '}
                  {SOURCE_LABEL[candidate.source]}
                  {candidate.kind === 'archive' ? ' · package' : ''}
                  {candidate.signature?.ok ? ' · signed' : ''}
                </span>
                <span className={styles.path} title={candidate.path}>{candidate.path}</span>
                {!verdict.allowed && <span className={styles.warn}>{verdict.reason}</span>}
                {verdict.allowed && existing && (
                  <span className={styles.ok}>
                    {sameVersion ? `Loaded${running ? ' · running' : ''}` : `Installed copy is ${existing.manifest.version}`}
                  </span>
                )}
              </div>
              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.action}
                  disabled={!verdict.allowed || busy === candidate.path}
                  onClick={() => { void load(candidate); }}
                >
                  {existing ? 'Reload' : 'Load'}
                </button>
                {existing && (
                  <button
                    type="button"
                    className={styles.action}
                    onClick={() => setLogFor(manifest.id)}
                  >
                    Log
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/*
        Named, not swallowed. A folder that looks like a plugin and is not is
        the commonest thing an author hits, and "it did not appear" with no
        reason sends them to re-read the docs rather than to the typo.
      */}
      {state.broken.length > 0 && (
        <details className={styles.broken}>
          <summary>{state.broken.length} folder(s) could not be read</summary>
          <ul>
            {state.broken.map((b) => (
              <li key={b.path}>
                <code>{b.path}</code>
                <span>{b.problems.join(' ')}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {state.conflicts.length > 0 && (
        <p className={styles.problem}>
          {state.conflicts.map((c) => (
            <span key={c.id}>
              Two copies of <code>{c.id}</code> — using {c.keptVersion} from <code>{c.kept}</code>,
              ignoring <code>{c.ignored.join(', ')}</code>.
            </span>
          ))}
        </p>
      )}

      {pending && (
        <ConsentOverlay>
          <ConsentSheet
            pkg={pending.pkg}
            source="folder"
            {...(pending.native ? { native: pending.native } : {})}
            onDone={() => setPending(null)}
          />
        </ConsentOverlay>
      )}

      {showInfoModal && (
        <Modal
          open={showInfoModal}
          onClose={() => setShowInfoModal(false)}
          title="Plugins Folder"
          description="Local plugin locations and development settings"
          size="sm"
          footer={
            <div className={styles.modalFooterActions}>
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  const problem = await openPluginsFolder();
                  if (problem) void customAlert('Could not open the folder', problem, { isDanger: true });
                }}
              >
                Open Folder
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowInfoModal(false)}
              >
                Done
              </Button>
            </div>
          }
        >
          <div className={styles.modalBody}>
            <label className={styles.devRow}>
              <input
                type="checkbox"
                checked={devMode}
                onChange={(e) => { void toggleDevMode(e.target.checked); }}
              />
              <span>
                <strong>Developer Mode</strong>
                <span className={styles.devHint}>
                  {devMode
                    ? 'Unsigned plugins in these folders are loaded, and a change on disk reloads them.'
                    : 'Off — only signed packages load. Turn on to run a plugin you are writing.'}
                </span>
              </span>
            </label>

            {state.paths.length > 0 && (
              <div className={styles.modalSection}>
                <span className={styles.modalSectionTitle}>Scanned Folders</span>
                <ul className={styles.paths}>
                  {state.paths.map((p) => (
                    <li key={p.dir} title={p.dir}>
                      <span className={styles.pathKind}>{SOURCE_LABEL[p.kind]}</span>
                      <code>{p.dir}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className={styles.modalNote}>
              Put a plugin folder — or a signed <code>.mplugin</code> file — in the folder
              above and press rescan to load it.
            </p>
          </div>
        </Modal>
      )}

      {logFor && <PluginLogSheet pluginId={logFor} onClose={() => setLogFor(null)} />}
    </section>
  );
}
