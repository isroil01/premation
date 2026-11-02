/**
 * AssetDrawer — the footage header at the top of the Project panel.
 *
 * After Effects' strip: the selected file's picture beside a few short lines
 * of facts — no key/value table to read. Line one is what the file IS
 * (format, pixels, size); line two is time (duration, frame rate, codec,
 * audio) and appears only for footage that has time; line three is where it
 * is used, each layer a click away. Everything else lives one gesture away:
 * the full path in the name's tooltip, tags in the row menu's Edit Tags…,
 * the interpretation in Interpret Footage.
 *
 * The strip keeps ONE height whether or not a file is selected, so a
 * selection never pushes the list down under the pointer (see
 * `.assetTopInfo` in panels.module.css).
 */

import { useEffect, useState } from 'react';
import { Icon } from '@components/Icon';
import { LABEL_COLORS } from '@core/scene/labelColor';
import type { ImportedAsset } from '@stores/assetStore';
import { formatLabel } from './assetVisuals';
import { formatBytes, formatDuration } from './assetListLogic';
import { assetDiskPath } from './assetReveal';
import { useEngineThumb } from './AssetThumb';
import styles from '@layout/EditorLayout/panels.module.css';
import { t } from '@core/i18n';

export interface AssetDrawerProps {
  asset: ImportedAsset | null;
  /** How many rows are selected — the drawer describes exactly one. */
  selectionCount: number;
  open: boolean;
  onToggle: () => void;
  /** Layer ids referencing the asset, with their names. */
  usedBy: ReadonlyArray<{ id: string; name: string }>;
  onSelectLayers: (layerIds: string[]) => void;
}

function fpsText(fps: number | undefined): string | null {
  if (!fps || fps <= 0) return null;
  return `${fps % 1 === 0 ? fps : fps.toFixed(2)} fps`;
}

/** `2400 × 1350 · 148.8 KB`, with the format first. */
function whatLine(asset: ImportedAsset): string {
  const m = asset.metadata ?? {};
  const parts = [formatLabel(asset)];
  if (m.width && m.height) {
    const par = asset.interpret?.par;
    parts.push(`${Math.round(m.width * (par ?? 1))} × ${m.height}${par && par !== 1 ? ` (${par.toFixed(2)})` : ''}`);
  }
  if (asset.type !== 'audio' && m.hasAlpha) parts.push(t('assets.drawer.alpha', 'Alpha'));
  if (asset.size > 0) parts.push(formatBytes(asset.size));
  return parts.join(' · ');
}

/** `0:07 · 30 fps · H264 · 2 ch` — null for a still. */
function timeLine(asset: ImportedAsset): string | null {
  const m = asset.metadata ?? {};
  if (asset.type === 'image' || !m.duration || m.duration <= 0) return null;
  const parts = [formatDuration(m.duration)];
  const fps = fpsText(asset.interpret?.conformFps ?? m.fps);
  if (fps && asset.type === 'video') parts.push(fps);
  if (m.codec) parts.push(m.codec.toUpperCase());
  if (asset.type === 'video' && m.hasAudioTrack === false) parts.push(t('assets.drawer.noAudio', 'No audio'));
  else if (m.audioChannels) parts.push(t('assets.drawer.channels', '{n} ch', { n: m.audioChannels }));
  return parts.join(' · ');
}

export function AssetDrawer({ asset, selectionCount, open, onToggle, usedBy, onSelectLayers }: AssetDrawerProps): JSX.Element {
  const label = asset?.label ? LABEL_COLORS.find((c) => c.id === asset.label) : undefined;
  const path = asset ? assetDiskPath(asset) : null;
  // The item's picture — a still's own pixels, a video's poster; a file only the
  // engine decodes (a plugin-imported .ppm) shows its engine thumbnail.
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [asset?.id]);
  const engineThumb = useEngineThumb(asset ?? null, imgFailed);
  const thumb = asset ? asset.thumbSrc ?? (engineThumb !== undefined ? engineThumb ?? undefined : asset.type === 'image' ? asset.src : undefined) : undefined;

  const heading = asset
    ? asset.name
    : selectionCount > 1
      ? t('assets.drawer.selected', '{n} assets selected', { n: selectionCount })
      : t('assets.drawer.details', 'Details');
  const time = asset ? timeLine(asset) : null;

  return (
    <div className={styles.assetDrawer} data-asset-drawer="">
      <button
        type="button"
        className={styles.assetDrawerHead}
        onClick={onToggle}
        aria-expanded={open}
        title={path ? `${heading}\n${path}` : heading}
      >
        {label && <span className={styles.assetLabelDot} style={{ background: label.color }} aria-hidden />}
        <span>{heading}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size="sm" />
      </button>
      {open && (
        asset ? (
          <div className={styles.assetDrawerBody}>
            <div className={styles.assetDrawerThumb}>
              {thumb
                ? <img src={thumb} alt="" onError={() => setImgFailed(true)} />
                : <Icon name={asset.type === 'audio' ? 'audio' : asset.type === 'video' ? 'video' : 'image'} size="md" />}
            </div>
            <div className={styles.assetDrawerFacts}>
              <span>{whatLine(asset)}</span>
              {time && <span>{time}</span>}
              {usedBy.length === 0 ? (
                <span className={styles.assetDrawerUnused}>{t('assets.drawer.notUsed', 'Not used in any composition')}</span>
              ) : (
                <button
                  type="button"
                  className={styles.assetDrawerUsed}
                  title={usedBy.map((u) => u.name).join('\n')}
                  onClick={() => onSelectLayers(usedBy.map((u) => u.id))}
                >
                  <Icon name="layers" size="sm" />
                  <span>
                    {usedBy.length === 1
                      ? t('assets.drawer.usedByLayer', 'Used by {name}', { name: usedBy[0]!.name })
                      : t('assets.drawer.usedByLayers', 'Used by {n} layers', { n: usedBy.length })}
                  </span>
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className={styles.assetDrawerEmpty}>
            {selectionCount > 1
              ? t('assets.drawer.selectOne', 'Select one asset to see its details.')
              : t('assets.drawer.selectAsset', 'Select an asset to see its details.')}
          </div>
        )
      )}
    </div>
  );
}
