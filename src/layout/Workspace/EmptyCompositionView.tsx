/**
 * EmptyCompositionView — The After Effects empty composition start surface.
 *
 * Renders the two iconic cards:
 * 1. "New Composition" — opens the composition settings modal.
 * 2. "New Composition From Footage" — opens file picker or accepts drag & drop to auto-conform comp to media.
 */

import { useState, useRef, useEffect, type DragEvent } from 'react';
import { openNewCompositionDialog } from '@layout/Composition/NewCompositionDialog';
import { useUIStore } from '@stores/uiStore';
import { setViewerEmpty } from '@stores/onboardingStore';
import { importBrowserFilesEdit, importPathsEdit } from '@layout/Assets/assetEdits';
import { compFromFootage } from './footageEdits';
import styles from './EmptyCompositionView.module.css';
import { t } from '@core/i18n';

/** After Effects Composition icon: comp screen frame with circle and triangle shapes */
export function AeCompIcon({ size = 72, className }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 80 80"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Outer comp frame */}
      <rect
        x="8"
        y="14"
        width="64"
        height="52"
        rx="3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Triangle geometry */}
      <polygon
        points="30,26 18,52 42,52"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Circle geometry */}
      <circle
        cx="46"
        cy="44"
        r="11"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

/** After Effects Footage icon: filmstrip with comp screen and geometric shapes */
export function AeFootageIcon({ size = 72, className }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 88 80"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Filmstrip on the left */}
      <rect
        x="6"
        y="14"
        width="22"
        height="52"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
      />
      {/* Film sprocket holes */}
      <rect x="10" y="19" width="4" height="4" rx="0.5" fill="currentColor" />
      <rect x="10" y="28" width="4" height="4" rx="0.5" fill="currentColor" />
      <rect x="10" y="38" width="4" height="4" rx="0.5" fill="currentColor" />
      <rect x="10" y="48" width="4" height="4" rx="0.5" fill="currentColor" />
      <rect x="10" y="57" width="4" height="4" rx="0.5" fill="currentColor" />

      <rect x="20" y="19" width="4" height="4" rx="0.5" fill="currentColor" />
      <rect x="20" y="28" width="4" height="4" rx="0.5" fill="currentColor" />
      <rect x="20" y="38" width="4" height="4" rx="0.5" fill="currentColor" />
      <rect x="20" y="48" width="4" height="4" rx="0.5" fill="currentColor" />
      <rect x="20" y="57" width="4" height="4" rx="0.5" fill="currentColor" />

      {/* Main comp frame */}
      <rect
        x="32"
        y="14"
        width="50"
        height="52"
        rx="3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Triangle geometry */}
      <polygon
        points="50,26 40,52 60,52"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Circle geometry */}
      <circle
        cx="63"
        cy="44"
        r="9"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

export function EmptyCompositionView(): JSX.Element {
  const [footageHover, setFootageHover] = useState(false);
  // No canvas while this is up, so the first-run tour ("draw a shape") waits.
  useEffect(() => {
    setViewerEmpty(true);
    return () => setViewerEmpty(false);
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Desktop: the native picker hands PATHS, so the files are imported through the
  // engine (`importFiles`) and the comp made from the footage ("New Comp from
  // Footage"). The web build has no path: its <input> Files go through the
  // store's importer. Several files: AE's New Comp from Selection, Single
  // Composition — the comp takes the first footage's size, rate and length, and
  // every other file becomes a layer in it (it used to keep only the first).
  const handlePickFootage = (): void => {
    const pick = typeof window !== 'undefined' ? window.motionEditor?.shell?.pickFiles : undefined;
    if (typeof pick !== 'function') {
      fileInputRef.current?.click();
      return;
    }
    void (async () => {
      const chosen = await pick();
      if (!chosen || chosen.length === 0) return;
      const { imported } = await importPathsEdit(chosen);
      if (imported.length > 0) await compFromFootage(imported);
      else {
        useUIStore.getState().notify({
          level: 'error',
          message: t('workspace.emptyComp.importFailed', 'Could not create composition from footage: “{file}” could not be imported.', { file: chosen[0]!.replace(/^.*[\\/]/, '') }),
          durationMs: 4000,
        });
      }
    })();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';  // picking the same files again fires onChange again
    if (files.length === 0) return;
    try {
      // A picked browser `File` carries no path: imported from its bytes.
      const { imported } = await importBrowserFilesEdit(files.map((file) => ({ file })));
      if (imported.length > 0) await compFromFootage(imported);
    } catch (err) {
      useUIStore.getState().notify({
        level: 'error',
        message: t('workspace.emptyComp.createFailed', 'Could not create composition from footage: {error}', { error: (err as Error).message }),
        durationMs: 4000,
      });
    }
  };

  const onDragOverFootage = (e: DragEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    setFootageHover(true);
  };

  const onDragLeaveFootage = (e: DragEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    setFootageHover(false);
  };

  /** The same families the picker's `accept` admits — a dropped .txt used to
   *  sail through, producing a broken "image" asset and a default comp. */
  const isFootageFile = (file: File): boolean =>
    /^(video|image|audio)\//.test(file.type)
    || /\.(mp4|mov|webm|m4v|mkv|avi|wmv|flv|mts|m2ts|mpg|mpeg|vob|ts|mxf|r3d|braw|ari|3gp|ogv|png|jpe?g|gif|svg|webp|bmp|tiff?|exr|hdr|dpx|psd|dng|cr2|cr3|nef|arw|orf|rw2|raf|pef|srw|raw|mp3|wav|aac|m4a|ogg|oga|flac|opus|wma|aif|aiff)$/i.test(file.name);

  const onDropFootage = async (e: DragEvent<HTMLButtonElement>): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    setFootageHover(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    // Every dropped media file (it used to take the first and drop the rest);
    // anything else is named, not silently skipped.
    const media = files.filter(isFootageFile);
    const other = files.find((f) => !isFootageFile(f));
    if (other) {
      useUIStore.getState().notify({
        level: media.length > 0 ? 'warning' : 'error',
        message: t('workspace.emptyComp.notMedia', '“{file}” is not a media file this editor can use as footage.', { file: other.name }),
        durationMs: 4000,
      });
    }
    if (media.length > 0) {
      try {
        const { imported } = await importBrowserFilesEdit(media.map((file) => ({ file })));
        if (imported.length > 0) await compFromFootage(imported);
      } catch (err) {
        useUIStore.getState().notify({
          level: 'error',
          message: t('workspace.emptyComp.createFailed', 'Could not create composition from footage: {error}', { error: (err as Error).message }),
          durationMs: 4000,
        });
      }
    }
  };

  return (
    <div className={styles.container} data-workspace-empty-hint="">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="video/*,image/*,audio/*,.mp4,.mov,.webm,.m4v,.png,.jpg,.jpeg,.gif,.svg,.mp3,.wav,.mxf,.avi,.mts,.m2ts,.mpg,.wmv,.mkv,.dng,.cr2,.cr3,.nef,.arw,.exr,.hdr,.dpx,.psd,.psb,.pdf,.ai"
        style={{ display: 'none' }}
        onChange={(e) => void handleFileSelected(e)}
      />

      <div className={styles.cardsWrapper}>
        {/* Card 1: New Composition */}
        <button
          type="button"
          className={styles.card}
          onClick={() => openNewCompositionDialog()}
          title={t('workspace.emptyComp.newTitle', 'Set up a blank composition — size, frame rate, duration')}
        >
          <div className={styles.iconContainer}>
            <AeCompIcon size={76} className={styles.vectorIcon} />
          </div>
          <div className={styles.cardContent}>
            <h3 className={styles.cardTitle}>{t('workspace.emptyComp.new', 'New Composition')}</h3>
            <span className={styles.cardDesc}>{t('workspace.emptyComp.newDesc', 'Set up a blank composition — resolution, frame rate, and duration')}</span>
          </div>
        </button>

        {/* Card 2: New Composition From Footage */}
        <button
          type="button"
          className={`${styles.card} ${footageHover ? styles.cardDragOver : ''}`}
          onClick={handlePickFootage}
          onDragOver={onDragOverFootage}
          onDragLeave={onDragLeaveFootage}
          onDrop={(e) => void onDropFootage(e)}
          title={t('workspace.emptyComp.fromFootageTitle', 'Create a composition that matches your footage dimensions and duration')}
        >
          <div className={styles.iconContainer}>
            <AeFootageIcon size={76} className={styles.vectorIcon} />
          </div>
          <div className={styles.cardContent}>
            <h3 className={styles.cardTitle}>{t('workspace.emptyComp.fromFootage', 'New Composition From Footage')}</h3>
            <span className={styles.cardDesc}>{t('workspace.emptyComp.fromFootageDesc', 'Import media to automatically match composition size and length')}</span>
          </div>
        </button>
      </div>
    </div>
  );
}
