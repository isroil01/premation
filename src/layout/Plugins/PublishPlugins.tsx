/**
 * Publishing: the signed-in user's own plugins, public or private, and a
 * form to upload a new version.
 *
 * The package is packed and signed OUTSIDE the editor
 * (`scripts/pack-plugin.mjs --key`, or the CI template in examples/plugin-ci):
 * the signing key never enters the app. This form uploads the `.pplugin` with
 * its `.sig` file. Private plugins install only for their publisher; making a
 * plugin public needs a verified publisher (the store refuses otherwise).
 * Plugins are free — there is no price to set.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { Segmented } from '@components/Segmented';
import { api, type StorePluginSummary } from '@core/api/client';
import type { InstalledState } from '@hooks/usePluginStore';
import { StorePluginDetailCard } from './PluginStore';
import styles from './NativePlugins.module.css';

type Visibility = 'public' | 'private';

const VISIBILITY_OPTIONS = [
  { value: 'private' as const, label: 'Private' },
  { value: 'public' as const, label: 'Public' },
];

/** `{signature, publicKey}` from the `.sig` file pack-plugin.mjs writes. */
export function parseSignatureFile(text: string): { signature: string; publicKey: string } | null {
  try {
    const j = JSON.parse(text) as { signature?: unknown; publicKey?: unknown };
    if (typeof j.signature === 'string' && typeof j.publicKey === 'string' && j.signature && j.publicKey) {
      return { signature: j.signature, publicKey: j.publicKey };
    }
  } catch {
    // not JSON
  }
  return null;
}

export function PublishPlugins({ store }: { store: InstalledState }): JSX.Element {
  const [mine, setMine] = useState<Array<StorePluginSummary & { visibility: Visibility }> | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [pkg, setPkg] = useState<File | null>(null);
  const [sig, setSig] = useState<{ signature: string; publicKey: string } | null>(null);
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const load = useCallback(() => {
    api.myPlugins()
      .then((list) => { if (alive.current) setMine(list.filter((p) => p.kind === 'native')); })
      .catch((e: unknown) => { if (alive.current) setError(e instanceof Error ? e.message : 'Sign in to publish plugins.'); });
    api.myPublishers()
      .then((pubs) => { if (alive.current) setVerified(pubs.some((p) => p.verified)); })
      .catch(() => { if (alive.current) setVerified(false); });
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, [load]);

  const changeVisibility = async (id: string, v: Visibility): Promise<void> => {
    setError(null);
    try {
      await api.setPluginVisibility(id, v);
      setNote(`${id} is now ${v}.`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the visibility.');
    }
  };

  const publish = async (): Promise<void> => {
    if (!pkg || !sig) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const out = await api.publishPlugin(pkg, sig.signature, sig.publicKey, visibility);
      setNote(
        `Published ${out.id} ${out.latestVersion}${out.reviewStatus === 'pending' ? ' — held for review before it goes live' : ''}.`
        + (out.warnings.length ? ` Warnings: ${out.warnings.join('; ')}` : ''),
      );
      setPkg(null);
      setSig(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The upload failed.');
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  if (open) return <StorePluginDetailCard id={open} owner store={store} onBack={() => setOpen(null)} />;

  return (
    <section className={styles.card} aria-label="Your plugins">
      <h3 className={styles.cardTitle}>Your plugins</h3>
      {verified === false ? (
        <p className={styles.text}>
          Your publisher is not verified yet, so your plugins can be private (installable by you) but not public.
        </p>
      ) : null}
      {error ? <span className={styles.error} role="alert">{error}</span> : null}
      {note ? <span className={styles.text} role="status">{note}</span> : null}
      {mine && mine.length > 0 ? (
        <ul className={styles.list} aria-label="Your published plugins">
          {mine.map((p) => (
            <li key={p.id} className={styles.row}>
              <Icon name="plugin" size="sm" className={styles.rowIcon} />
              <button type="button" className={styles.rowOpen} onClick={() => setOpen(p.id)} aria-label={`About ${p.name}`}>
                <span className={styles.rowName}>{p.name}</span>
                <span className={styles.rowMeta}>{`v${p.latestVersion} · ${p.installs} installs`}</span>
              </button>
              <Segmented
                size="sm"
                options={VISIBILITY_OPTIONS}
                value={p.visibility}
                onChange={(v) => void changeVisibility(p.id, v)}
                aria-label={`Visibility of ${p.name}`}
              />
            </li>
          ))}
        </ul>
      ) : mine ? (
        <span className={styles.text}>You have not published a native plugin yet.</span>
      ) : null}

      <h3 className={styles.cardTitle}>Publish a version</h3>
      <p className={styles.text}>
        Pack and sign the plugin with <span className={styles.path}>pack-plugin.mjs --key plugin-key.json</span> (it
        ships with the SDK), then choose the <span className={styles.path}>.pplugin</span> and its
        <span className={styles.path}> .sig</span> file here.
      </p>
      <div className={styles.toolbar}>
        <label className={styles.fileLabel}>
          <span>Package (.pplugin)</span>
          <input type="file" accept=".pplugin,application/zip" onChange={(e) => setPkg(e.target.files?.[0] ?? null)} />
        </label>
        <label className={styles.fileLabel}>
          <span>Signature (.sig)</span>
          <input
            type="file"
            accept=".sig,application/json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) { setSig(null); return; }
              void f.text().then((t) => {
                const parsed = parseSignatureFile(t);
                setSig(parsed);
                if (!parsed) setError('That signature file is not one pack-plugin.mjs wrote.');
              });
            }}
          />
        </label>
      </div>
      <div className={styles.toolbar}>
        <Segmented size="sm" options={VISIBILITY_OPTIONS} value={visibility} onChange={setVisibility} aria-label="Visibility of the new version" />
        <span className={styles.spacer} />
        <Button variant="primary" size="sm" leftIcon={<Icon name="upload" size="sm" />} disabled={!pkg || !sig || busy} onClick={() => void publish()}>
          {busy ? 'Uploading…' : 'Publish'}
        </Button>
      </div>
    </section>
  );
}
