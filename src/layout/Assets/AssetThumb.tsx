/**
 * AssetThumb — the picture of an asset, at either size the panel draws it.
 *
 * Images use the thumbnail `assetStore` already generates at import; video
 * gets a first-frame poster on demand (`videoPosters`); audio and anything
 * undecodable fall back to the type glyph. A clip carries its duration in
 * the corner, and — on the grid card only — hovering SCRUBS it: the pointer's
 * x across the well maps to time, the way Premiere's bin previews do, so
 * you can find the shot without opening the source monitor.
 *
 * The scrub `<video>` is created on hover and torn down on leave; a grid of
 * two hundred clips must not hold two hundred decoders.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@components/Icon';
import type { ImportedAsset } from '@stores/assetStore';
import { attachVideoSrc, detachVideoSrc } from '@core/assets/local/localBlobSource';
import { getAssetVisualInfo } from './assetVisuals';
import { formatDuration } from './assetListLogic';
import { peekVideoPoster, requestVideoPoster } from './videoPosters';
import styles from '@layout/EditorLayout/panels.module.css';

export interface AssetThumbProps {
  asset: ImportedAsset;
  /** `row` is the 32×18 list well; `card` fills the grid card at 16:9. */
  variant: 'row' | 'card';
  /** Hover-to-scrub. Video only; ignored for the row well. */
  scrub?: boolean;
}

function useVideoPoster(asset: ImportedAsset): string | null {
  const wanted = asset.type === 'video' && !asset.thumbSrc;
  const [poster, setPoster] = useState<string | null>(() => (wanted ? peekVideoPoster(asset.id) ?? null : null));
  useEffect(() => {
    if (!wanted) return;
    const known = peekVideoPoster(asset.id);
    if (known !== undefined) {
      setPoster(known);
      return;
    }
    return requestVideoPoster(asset.id, asset.src, (url) => setPoster(url));
  }, [asset.id, asset.src, wanted]);
  return wanted ? poster : null;
}

export function AssetThumb({ asset, variant, scrub = false }: AssetThumbProps): JSX.Element {
  const poster = useVideoPoster(asset);
  const src = asset.thumbSrc ?? (asset.type === 'image' ? asset.src : poster);
  const visual = getAssetVisualInfo(asset);
  const glyphClass = (styles as Record<string, string>)[visual.className] ?? styles.assetGlyphFile;
  const duration = asset.metadata?.duration;
  const canScrub = scrub && variant === 'card' && asset.type === 'video';

  const wellRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubFrac, setScrubFrac] = useState(0);

  // Attach on hover, detach on leave — never while the card merely exists.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!scrubbing) {
      detachVideoSrc(v);
      return;
    }
    attachVideoSrc(v, asset.src);
    return () => detachVideoSrc(v);
  }, [scrubbing, asset.src]);

  const onMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!canScrub) return;
    const well = wellRef.current;
    const v = videoRef.current;
    if (!well || !v) return;
    const rect = well.getBoundingClientRect();
    const frac = rect.width > 0 ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0;
    setScrubFrac(frac);
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : duration ?? 0;
    if (d > 0 && v.readyState >= 1) v.currentTime = frac * d;
  };

  return (
    <div
      ref={wellRef}
      className={`${styles.assetThumb} ${variant === 'row' ? styles.assetThumbRow : styles.assetCardThumb}`}
      onMouseEnter={canScrub ? () => setScrubbing(true) : undefined}
      onMouseLeave={canScrub ? () => setScrubbing(false) : undefined}
      onMouseMove={canScrub ? onMove : undefined}
      data-scrubbing={scrubbing || undefined}
    >
      {src ? (
        <img src={src} alt="" className={styles.assetThumbImg} draggable={false} />
      ) : (
        <Icon name={visual.icon} size={variant === 'row' ? 'sm' : 'md'} className={`${styles.assetGlyph} ${glyphClass}`} />
      )}
      {canScrub && (
        <video
          ref={videoRef}
          className={`${styles.assetThumbVideo}${scrubbing ? ` ${styles.assetThumbVideoOn}` : ''}`}
          muted
          playsInline
          preload="metadata"
          aria-hidden
        />
      )}
      {scrubbing && <span className={styles.assetScrubBar} style={{ width: `${scrubFrac * 100}%` }} />}
      {duration != null && duration > 0 && (
        <span className={styles.assetDurationBadge}>{formatDuration(duration)}</span>
      )}
    </div>
  );
}
