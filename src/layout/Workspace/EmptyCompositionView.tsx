/**
 * EmptyCompositionView — The After Effects empty composition start surface.
 *
 * Renders the two iconic cards:
 * 1. "New Composition" — opens the composition settings modal.
 * 2. "New Composition From Footage" — opens file picker or accepts drag & drop to auto-conform comp to media.
 */

import { useState, useRef, type DragEvent } from 'react';
import { openNewCompositionDialog } from '@layout/Composition/NewCompositionDialog';
import { useAssetStore } from '@stores/assetStore';
import { createCompositionFromFootage } from '@core/composition/compositionOps';
import { useUIStore } from '@stores/uiStore';
import styles from './EmptyCompositionView.module.css';

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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePickFootage = (): void => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const asset = await useAssetStore.getState().addAsset(file);
      await createCompositionFromFootage(asset);
    } catch (err) {
      useUIStore.getState().notify({
        level: 'error',
        message: `Could not create composition from footage: ${(err as Error).message}`,
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

  const onDropFootage = async (e: DragEvent<HTMLButtonElement>): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    setFootageHover(false);
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    if (file) {
      try {
        const asset = await useAssetStore.getState().addAsset(file);
        await createCompositionFromFootage(asset);
      } catch (err) {
        useUIStore.getState().notify({
          level: 'error',
          message: `Could not create composition from footage: ${(err as Error).message}`,
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
        accept="video/*,image/*,audio/*,.mp4,.mov,.webm,.m4v,.png,.jpg,.jpeg,.gif,.svg,.mp3,.wav,.mxf,.avi,.mts,.m2ts,.mpg,.wmv,.mkv,.dng,.cr2,.cr3,.nef,.arw,.exr,.dpx,.psd"
        style={{ display: 'none' }}
        onChange={(e) => void handleFileSelected(e)}
      />

      <div className={styles.cardsWrapper}>
        {/* Card 1: New Composition */}
        <button
          type="button"
          className={styles.card}
          onClick={() => openNewCompositionDialog()}
          title="Set up a blank composition — size, frame rate, duration"
        >
          <div className={styles.iconContainer}>
            <AeCompIcon size={76} className={styles.vectorIcon} />
          </div>
          <div className={styles.cardContent}>
            <h3 className={styles.cardTitle}>New Composition</h3>
            <span className={styles.cardDesc}>Set up a blank composition — resolution, frame rate, and duration</span>
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
          title="Create a composition that matches your footage dimensions and duration"
        >
          <div className={styles.iconContainer}>
            <AeFootageIcon size={76} className={styles.vectorIcon} />
          </div>
          <div className={styles.cardContent}>
            <h3 className={styles.cardTitle}>New Composition From Footage</h3>
            <span className={styles.cardDesc}>Import media to automatically match composition size and length</span>
          </div>
        </button>
      </div>
    </div>
  );
}
