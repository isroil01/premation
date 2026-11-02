import type { IconName } from '@components/Icon';
import type { ImportedAsset } from '@stores/assetStore';
import { t } from '@core/i18n';

export interface AssetVisualInfo {
  icon: IconName;
  label: string;
  className: string;
  color: string;
}

/**
 * Derives the visual representation (icon, descriptive type label, styling class, and colour token)
 * for an asset or file item based on its type and filename extension.
 */
export function getAssetVisualInfo(
  asset: Pick<ImportedAsset, 'name'> & { type?: string; source?: string }
): AssetVisualInfo {
  const name = asset.name.toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';

  // 1. Vector & SVG
  if (ext === 'svg') {
    return {
      icon: 'shape',
      label: t('assets.type.svg', 'SVG Vector'),
      className: 'assetGlyphSvg',
      color: 'var(--color-filetype-image)',
    };
  }

  // 2. Photoshop & Illustrator design files
  if (ext === 'psd' || ext === 'psb') {
    return {
      icon: 'layers',
      label: 'Photoshop',
      className: 'assetGlyphPsd',
      color: 'var(--color-filetype-image)',
    };
  }
  if (ext === 'ai' || ext === 'eps') {
    return {
      icon: 'shape',
      label: 'Illustrator',
      className: 'assetGlyphPsd',
      color: 'var(--color-filetype-image)',
    };
  }

  // 3. RAW & HDR Image formats
  if (['exr', 'dpx', 'hdr', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raw', 'rw2', 'orf'].includes(ext)) {
    return {
      icon: 'camera',
      label: t('assets.type.rawHdr', 'RAW / HDR'),
      className: 'assetGlyphRaw',
      color: 'var(--color-filetype-image)',
    };
  }

  // 4. Animated GIF
  if (ext === 'gif') {
    return {
      icon: 'image',
      label: t('assets.type.gif', 'GIF Animation'),
      className: 'assetGlyphGif',
      color: 'var(--color-filetype-image)',
    };
  }

  // 5. General Raster Images
  if (
    asset.type === 'image' ||
    ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'tiff', 'tif', 'ico', 'heic', 'heif'].includes(ext)
  ) {
    let label = t('assets.type.image', 'Image');
    if (ext === 'png') label = t('assets.type.png', 'PNG Image');
    else if (ext === 'jpg' || ext === 'jpeg') label = t('assets.type.jpeg', 'JPEG Image');
    else if (ext === 'webp') label = t('assets.type.webp', 'WebP Image');
    else if (ext === 'avif') label = t('assets.type.avif', 'AVIF Image');

    return {
      icon: 'image',
      label,
      className: 'assetGlyphImage',
      color: 'var(--color-filetype-image)',
    };
  }

  // 6. Pro Cinema Video formats
  if (['mxf', 'mts', 'm2ts', 'r3d', 'braw', 'prores'].includes(ext)) {
    return {
      icon: 'video',
      label: t('assets.type.proVideo', 'Pro Video'),
      className: 'assetGlyphVideoPro',
      color: 'var(--color-filetype-video)',
    };
  }

  // 7. General Video
  if (
    asset.type === 'video' ||
    ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv', '3gp', 'ts'].includes(ext)
  ) {
    let label = t('assets.type.video', 'Video');
    if (ext === 'mp4') label = t('assets.type.mp4', 'MP4 Video');
    else if (ext === 'mov') label = 'QuickTime';
    else if (ext === 'webm') label = t('assets.type.webm', 'WebM Video');

    return {
      icon: 'video',
      label,
      className: 'assetGlyphVideo',
      color: 'var(--color-filetype-video)',
    };
  }

  // 8. Audio formats
  if (
    asset.type === 'audio' ||
    ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac', 'aiff', 'aif', 'wma', 'opus', 'alac'].includes(ext)
  ) {
    let label = t('assets.type.audio', 'Audio');
    if (ext === 'mp3') label = t('assets.type.mp3', 'MP3 Audio');
    else if (ext === 'wav') label = t('assets.type.wav', 'WAV Audio');
    else if (ext === 'aac' || ext === 'm4a') label = t('assets.type.aac', 'AAC Audio');
    else if (ext === 'flac') label = t('assets.type.flac', 'FLAC Audio');

    return {
      icon: 'audio',
      label,
      className: 'assetGlyphAudio',
      color: 'var(--color-filetype-audio)',
    };
  }

  // 9. Lottie & JSON Animation
  if (ext === 'json' || ext === 'lottie') {
    return {
      icon: 'code',
      label: 'Lottie / JSON',
      className: 'assetGlyphCode',
      color: 'var(--color-filetype-data)',
    };
  }

  // 10. Fonts
  if (['ttf', 'otf', 'woff', 'woff2'].includes(ext)) {
    return {
      icon: 'type',
      label: t('assets.type.font', 'Font'),
      className: 'assetGlyphFont',
      color: 'var(--color-filetype-font)',
    };
  }

  // 11. 3D Models
  if (['gltf', 'glb', 'obj', 'fbx', 'usd', 'usdz', 'dae'].includes(ext)) {
    return {
      icon: '3d',
      label: t('assets.type.model3d', '3D Model'),
      className: 'assetGlyph3D',
      color: 'var(--color-filetype-other)',
    };
  }

  // 12. Composition
  if (asset.type === 'comp' || asset.source === 'derived') {
    return {
      icon: 'component',
      label: t('assets.type.composition', 'Composition'),
      className: 'assetGlyphComp',
      color: 'var(--color-filetype-comp)',
    };
  }

  // 13. Fallback generic file
  return {
    icon: 'file',
    label: ext ? t('assets.type.extFile', '{ext} File', { ext: ext.toUpperCase() }) : t('assets.type.file', 'File'),
    className: 'assetGlyphFile',
    color: 'var(--color-filetype-other)',
  };
}

/** Extensions whose usual name is not the extension itself. */
const FORMAT_NAMES: Record<string, string> = { jpg: 'JPEG', jpe: 'JPEG', tif: 'TIFF', aif: 'AIFF', m4a: 'AAC', mpg: 'MPEG', mts: 'AVCHD', m2ts: 'AVCHD' };

/**
 * The file FORMAT alone — `JPEG`, `PNG`, `MP4`, `WAV` — for the Type column and
 * the details header, where "JPEG Image" repeats what the thumbnail already
 * says. A name without an extension falls back to the descriptive label.
 */
export function formatLabel(asset: Pick<ImportedAsset, 'name'> & { type?: string; source?: string }): string {
  const name = asset.name.toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  if (!ext || ext.length > 5 || !/^[a-z0-9]+$/.test(ext)) return getAssetVisualInfo(asset).label;
  return FORMAT_NAMES[ext] ?? ext.toUpperCase();
}

/** Standard real folder color (Warm Manila Amber) */
export const FOLDER_COLOR = 'var(--color-amber-500)';
