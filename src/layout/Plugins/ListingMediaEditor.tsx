/**
 * The pictures on a plugin's listing: one icon, up to six screenshots.
 *
 * ── Why this had to be built ────────────────────────────────────────────────
 *
 * Every other piece of this was already finished. The registry stores plugin
 * media, re-encodes it on ingest and serves it; `RegistryPlugin.iconUrl` and
 * `RegistryDetail.screenshots` are read and DRAWN by the browse card and the
 * detail tab. The one missing link was any way for a publisher to supply one —
 * so every listing in the marketplace drew the same generic glyph, and an
 * author who had spent a month on a plugin could not show a single pixel of it.
 *
 * A store whose listings cannot carry a picture is a list of filenames, and
 * that is the thing standing between this marketplace and one a user would
 * browse rather than search.
 *
 * ── An icon replaces; a screenshot appends ──────────────────────────────────
 *
 * The registry enforces both. This surface agrees with it rather than
 * discovering it: there is no "add another icon" button, because a second icon
 * has no meaning, and the screenshot control disappears at the ceiling rather
 * than offering an upload that will be refused.
 *
 * ── Checked here AND there ──────────────────────────────────────────────────
 *
 * Size and type are checked before the upload leaves, so a 5 MB PNG fails in
 * the panel instead of after a round trip — and the registry checks again,
 * because a client-side check is a courtesy and never a control.
 */

import { useRef, useState } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import {
  MAX_PLUGIN_IMAGE_BYTES,
  MAX_PLUGIN_SCREENSHOTS,
  PLUGIN_IMAGE_MIME,
  deletePluginMedia,
  registryMediaUrl,
  uploadPluginMedia,
  type PluginMediaRef,
} from '@core/plugins/registry';
import styles from './ListingMediaEditor.module.css';

export interface ListingMediaEditorProps {
  pluginId: string;
  /** The icon this listing currently carries, as a registry-relative path. */
  iconUrl: string | null;
  screenshots: ReadonlyArray<{ id: string; url: string }>;
  /** Re-read the listing after a change, so the browse card follows. */
  onChanged: () => void;
  onError: (message: string | null) => void;
}


export function ListingMediaEditor({
  pluginId, iconUrl, screenshots, onChanged, onError,
}: ListingMediaEditorProps): JSX.Element {
  const [busy, setBusy] = useState<'icon' | 'screenshot' | null>(null);
  // Optimistic local copies, so the thumbnail appears the instant the upload
  // lands rather than after the parent's refetch — an image upload that shows
  // nothing for a second reads as one that failed.
  const [localIcon, setLocalIcon] = useState<string | null>(null);
  const [localShots, setLocalShots] = useState<PluginMediaRef[]>([]);
  const iconInput = useRef<HTMLInputElement | null>(null);
  const shotInput = useRef<HTMLInputElement | null>(null);

  /* Read at render rather than at module scope. These are imported constants,
     so hoisting them looks free — but it makes importing this file crash for
     any test that mocks the registry and omits one, which is a failure mode
     with no upside. */
  const ACCEPT = PLUGIN_IMAGE_MIME.join(',');
  const MAX_MB = MAX_PLUGIN_IMAGE_BYTES / 1024 / 1024;

  const shots = [...screenshots, ...localShots.filter((s) => !screenshots.some((x) => x.id === s.id))];
  const icon = localIcon ?? registryMediaUrl(iconUrl);
  const atCeiling = shots.length >= MAX_PLUGIN_SCREENSHOTS;

  const upload = async (kind: 'icon' | 'screenshot', file: File): Promise<void> => {
    setBusy(kind);
    onError(null);
    try {
      const ref = await uploadPluginMedia(pluginId, kind, file);
      if (kind === 'icon') setLocalIcon(registryMediaUrl(ref.url));
      else setLocalShots((cur) => [...cur, ref]);
      onChanged();
    } catch (err) {
      onError((err as Error).message || `That ${kind} could not be uploaded.`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (mediaId: string, kind: 'icon' | 'screenshot'): Promise<void> => {
    setBusy(kind);
    onError(null);
    try {
      await deletePluginMedia(mediaId);
      if (kind === 'icon') setLocalIcon(null);
      else setLocalShots((cur) => cur.filter((s) => s.id !== mediaId));
      onChanged();
    } catch (err) {
      onError((err as Error).message || 'That image could not be removed.');
    } finally {
      setBusy(null);
    }
  };

  const pick = (
    input: React.RefObject<HTMLInputElement>,
    kind: 'icon' | 'screenshot',
  ) => (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    // Clear the input either way, so choosing the SAME file twice after a
    // failure still fires a change event.
    if (input.current) input.current.value = '';
    if (file) void upload(kind, file);
  };

  return (
    <>
      <div className={styles.formField}>
        <span className={styles.fieldLabel}>
          Icon — square, at least 128×128. PNG, JPEG or WebP, up to {MAX_MB} MB.
        </span>
        <div className={styles.mediaRow}>
          <div className={styles.iconSlot} data-empty={icon ? undefined : ''}>
            {icon
              ? <img src={icon} alt="" className={styles.iconPreview} />
              : <Icon name="image" size="md" />}
          </div>
          <div className={styles.mediaActions}>
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'icon'}
              disabled={busy !== null}
              onClick={() => iconInput.current?.click()}
            >
              {busy === 'icon' ? 'Uploading…' : icon ? 'Replace icon' : 'Choose icon'}
            </Button>
            {/* No delete for the icon: the registry replaces rather than
                accumulates, so "choose another" is the whole operation, and a
                listing with no icon at all is not a state worth offering. */}
            <span className={styles.mediaHint}>
              Shown on the browse card and at the top of your listing.
            </span>
          </div>
        </div>
        <input
          ref={iconInput}
          type="file"
          accept={ACCEPT}
          className={styles.fileInput}
          aria-label="Choose an icon image"
          onChange={pick(iconInput, 'icon')}
        />
      </div>

      <div className={styles.formField}>
        <span className={styles.fieldLabel}>
          Screenshots — up to {MAX_PLUGIN_SCREENSHOTS}. The first is the one people see first.
        </span>
        <div className={styles.shotGrid}>
          {shots.map((shot) => {
            const url = registryMediaUrl(shot.url);
            return (
              <div key={shot.id} className={styles.shotCard}>
                {url ? <img src={url} alt="" className={styles.shotImg} /> : null}
                <button
                  type="button"
                  className={styles.shotRemove}
                  title="Remove this screenshot"
                  aria-label="Remove this screenshot"
                  disabled={busy !== null}
                  onClick={() => { void remove(shot.id, 'screenshot'); }}
                >
                  <Icon name="close" size="sm" />
                </button>
              </div>
            );
          })}
          {/* Gone at the ceiling rather than present and refused: an upload
              button that cannot upload is worse than no button. */}
          {!atCeiling && (
            <button
              type="button"
              className={styles.shotAdd}
              disabled={busy !== null}
              onClick={() => shotInput.current?.click()}
            >
              {busy === 'screenshot'
                ? <Icon name="refresh" className={styles.spin} size="sm" />
                : <><Icon name="plus" size="sm" /><span>Add</span></>}
            </button>
          )}
        </div>
        {atCeiling && (
          <span className={styles.mediaHint}>
            That is all {MAX_PLUGIN_SCREENSHOTS}. Remove one to add another.
          </span>
        )}
        {/* Gone with its button. An unreachable file input left in the tree is
            still a labelled control a screen reader will offer. */}
        {!atCeiling && (
          <input
            ref={shotInput}
            type="file"
            accept={ACCEPT}
            className={styles.fileInput}
            aria-label="Add a screenshot"
            onChange={pick(shotInput, 'screenshot')}
          />
        )}
      </div>
    </>
  );
}
