/**
 * Publishing a package.
 *
 * Its own view in the workspace rather than a form stapled to the bottom of the
 * listings — it is the thing a publisher comes here to do most often, and it
 * was previously the furthest thing from the top.
 *
 * ## The private key never enters this process
 *
 * That is the whole security story of plugin updates: "the same author signed
 * this" only means something if the key lives somewhere the app cannot read.
 * So the renderer sends package BYTES and a visibility to the main process,
 * which asks the OS for the key file, signs there, and uploads. There is no
 * key field on this screen and there must never be one — `MyPluginsSection`'s
 * test suite asserts exactly that, and the assertion is the feature.
 *
 * A browser tab has no main process to hand off to and no file dialog to ask
 * with, so it gets the command-line recipe instead of a broken form.
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import type { PluginVisibility } from '@core/plugins/registry';
import styles from './PublisherWorkspace.module.css';

/** The desktop bridge that owns the signing key, or null in a browser tab. */
function publishBridge(): ((req: unknown) => Promise<unknown>) | null {
  const w = window as unknown as { motionEditor?: { pluginPublish?: (r: unknown) => Promise<unknown> } };
  return w.motionEditor?.pluginPublish ?? null;
}

const ACCEPTED = '.zip,.mplugin';

export function NewRelease({
  namespace,
  onPublished,
  onError,
}: {
  namespace: string;
  onPublished: () => void;
  onError: (message: string | null) => void;
}): JSX.Element {
  const bridge = publishBridge();
  const [file, setFile] = useState<File | null>(null);
  const [visibility, setVisibility] = useState<PluginVisibility>('public');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const submit = async (): Promise<void> => {
    if (!file || busy) return;
    setBusy(true);
    onError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Exactly two fields. The test pins `Object.keys(arg)` so nothing can
      // quietly start travelling alongside the package.
      const res = (await bridge!({ bytes, visibility })) as {
        ok: boolean;
        error?: string;
        cancelled?: boolean;
      };
      // A cancelled key picker is a decision, not a failure — reporting it as
      // an error trains people to ignore the error banner.
      if (!res.ok && !res.cancelled) onError(res.error || 'The publish failed.');
      if (res.ok) {
        setFile(null);
        onPublished();
      }
    } catch (err) {
      onError((err as Error).message || 'The publish failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.detail}>
      <header className={styles.detailHeader}>
        <div className={styles.detailTitles}>
          <div className={styles.detailTitleRow}>
            <h3 className={styles.detailTitle}>New release</h3>
          </div>
          <span className={styles.detailSub}>
            Upload a signed package to publish a new plugin, or a new version of one you have already published.
          </span>
        </div>
      </header>

      <div className={styles.detailScroll}>
        <div className={styles.column}>
          {!bridge ? (
            <CommandLineSteps namespace={namespace} />
          ) : (
            <>
              <section className={styles.section}>
                <div
                  className={dragging ? `${styles.dropzone} ${styles.dropzoneActive}` : styles.dropzone}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    const dropped = e.dataTransfer.files?.[0];
                    if (dropped) setFile(dropped);
                  }}
                >
                  {!file && (
                    <input
                      type="file"
                      accept={ACCEPTED}
                      aria-label="Package"
                      className={styles.dropzoneInput}
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    />
                  )}

                  {file ? (
                    <div className={styles.chosenFile}>
                      <Icon name="file" size="sm" />
                      <span className={styles.chosenName}>{file.name}</span>
                      <span className={styles.chosenSize}>{(file.size / 1024).toFixed(1)} KB</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        onClick={() => setFile(null)}
                        aria-label="Choose a different package"
                      >
                        <Icon name="close" size="sm" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <span className={styles.dropzoneGlyph}>
                        <Icon name="upload" size="md" />
                      </span>
                      <span className={styles.dropzoneTitle}>Drop your package here, or click to choose</span>
                      <span className={styles.dropzoneHint}>
                        A .zip or .mplugin whose id in plugin.json starts with <code>{namespace}.</code>
                      </span>
                    </>
                  )}
                </div>
              </section>

              <section className={styles.section}>
                <div className={styles.sectionHead}>
                  <span className={styles.sectionTitle}>Who can see it</span>
                </div>
                <div className={styles.choices} role="radiogroup" aria-label="Who can see this listing">
                  <VisibilityChoice
                    value="public"
                    current={visibility}
                    onSelect={setVisibility}
                    title="Public marketplace"
                    desc="Anyone can find and install it from the plugin browser."
                  />
                  <VisibilityChoice
                    value="private"
                    current={visibility}
                    onSelect={setVisibility}
                    title="Private listing"
                    desc="Only you can see or install it. You can make it public at any time."
                  />
                </div>
              </section>

              <div className={`${styles.notice} ${styles.noticeInfo}`}>
                <Icon name="lock" size="sm" className={styles.noticeIcon} />
                <div className={styles.noticeBody}>
                  Your signing key is read once by a system file prompt, used to sign, and discarded. It is never sent
                  anywhere and this window never sees it.
                </div>
              </div>

              <div>
                <Button
                  variant="primary"
                  size="md"
                  loading={busy}
                  disabled={busy || !file}
                  icon={busy ? undefined : <Icon name="lock" size="sm" />}
                  onClick={() => void submit()}
                >
                  {busy ? 'Publishing package…' : 'Choose signing key and publish'}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function VisibilityChoice({
  value,
  current,
  onSelect,
  title,
  desc,
}: {
  value: PluginVisibility;
  current: PluginVisibility;
  onSelect: (v: PluginVisibility) => void;
  title: string;
  desc: string;
}): JSX.Element {
  const active = current === value;
  return (
    <label className={active ? `${styles.choice} ${styles.choiceActive}` : styles.choice}>
      <input
        type="radio"
        name="visibility"
        value={value}
        className={styles.choiceInput}
        checked={active}
        onChange={() => onSelect(value)}
        aria-label={title}
      />
      <span className={styles.choiceMark}>
        <span className={styles.choiceDot} />
      </span>
      <span className={styles.choiceBody}>
        <span className={styles.choiceTitle}>{title}</span>
        <span className={styles.choiceDesc}>{desc}</span>
      </span>
    </label>
  );
}

function CommandLineSteps({ namespace }: { namespace: string }): JSX.Element {
  const code = `node scripts/sign-plugin.mjs keygen
# set "id": "${namespace}.<name>" in plugin.json
node scripts/sign-plugin.mjs sign    ./${namespace}-<name>.zip
node scripts/sign-plugin.mjs publish ./${namespace}-<name>.zip`;

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>Publish from the command line</span>
        <span className={styles.sectionHint}>
          Publishing from this window needs the desktop app, which is what holds the file dialog your signing key is
          chosen with. In a browser tab, the terminal does the same job and your key never leaves it.
        </span>
      </div>

      <div className={styles.terminal}>
        <div className={styles.terminalBar}>
          <Icon name="code" size="sm" />
          <span>bash / zsh</span>
        </div>
        <pre className={styles.terminalCode}>{code}</pre>
      </div>
    </section>
  );
}
