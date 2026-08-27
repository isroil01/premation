import type { IconName } from '@components/Icon';
import type { ImportedAsset } from '@stores/assetStore';

export interface AssetVisualInfo {
  icon: IconName;
  label: string;
  className: string;
  color: string;
}

/**
 * Derives the visual representation (icon, descriptive type label, styling class, and hex color)
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
      label: 'SVG Vector',
      className: 'assetGlyphSvg',
      color: '#06b6d4',
    };
  }

  // 2. Photoshop & Illustrator design files
  if (ext === 'psd' || ext === 'psb') {
    return {
      icon: 'layers',
      label: 'Photoshop',
      className: 'assetGlyphPsd',
      color: '#3b82f6',
    };
  }
  if (ext === 'ai' || ext === 'eps') {
    return {
      icon: 'shape',
      label: 'Illustrator',
      className: 'assetGlyphPsd',
      color: '#f59e0b',
    };
  }

  // 3. RAW & HDR Image formats
  if (['exr', 'dpx', 'hdr', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raw', 'rw2', 'orf'].includes(ext)) {
    return {
      icon: 'camera',
      label: 'RAW / HDR',
      className: 'assetGlyphRaw',
      color: '#0ea5e9',
    };
  }

  // 4. Animated GIF
  if (ext === 'gif') {
    return {
      icon: 'image',
      label: 'GIF Animation',
      className: 'assetGlyphGif',
      color: '#ec4899',
    };
  }

  // 5. General Raster Images
  if (
    asset.type === 'image' ||
    ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'tiff', 'tif', 'ico', 'heic', 'heif'].includes(ext)
  ) {
    let label = 'Image';
    if (ext === 'png') label = 'PNG Image';
    else if (ext === 'jpg' || ext === 'jpeg') label = 'JPEG Image';
    else if (ext === 'webp') label = 'WebP Image';
    else if (ext === 'avif') label = 'AVIF Image';

    return {
      icon: 'image',
      label,
      className: 'assetGlyphImage',
      color: '#10b981',
    };
  }

  // 6. Pro Cinema Video formats
  if (['mxf', 'mts', 'm2ts', 'r3d', 'braw', 'prores'].includes(ext)) {
    return {
      icon: 'video',
      label: 'Pro Video',
      className: 'assetGlyphVideoPro',
      color: '#a855f7',
    };
  }

  // 7. General Video
  if (
    asset.type === 'video' ||
    ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv', '3gp', 'ts'].includes(ext)
  ) {
    let label = 'Video';
    if (ext === 'mp4') label = 'MP4 Video';
    else if (ext === 'mov') label = 'QuickTime';
    else if (ext === 'webm') label = 'WebM Video';

    return {
      icon: 'video',
      label,
      className: 'assetGlyphVideo',
      color: '#8b5cf6',
    };
  }

  // 8. Audio formats
  if (
    asset.type === 'audio' ||
    ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac', 'aiff', 'aif', 'wma', 'opus', 'alac'].includes(ext)
  ) {
    let label = 'Audio';
    if (ext === 'mp3') label = 'MP3 Audio';
    else if (ext === 'wav') label = 'WAV Audio';
    else if (ext === 'aac' || ext === 'm4a') label = 'AAC Audio';
    else if (ext === 'flac') label = 'FLAC Audio';

    return {
      icon: 'audio',
      label,
      className: 'assetGlyphAudio',
      color: '#f43f5e',
    };
  }

  // 9. Lottie & JSON Animation
  if (ext === 'json' || ext === 'lottie') {
    return {
      icon: 'code',
      label: 'Lottie / JSON',
      className: 'assetGlyphCode',
      color: '#f97316',
    };
  }

  // 10. Fonts
  if (['ttf', 'otf', 'woff', 'woff2'].includes(ext)) {
    return {
      icon: 'type',
      label: 'Font',
      className: 'assetGlyphFont',
      color: '#38bdf8',
    };
  }

  // 11. 3D Models
  if (['gltf', 'glb', 'obj', 'fbx', 'usd', 'usdz', 'dae'].includes(ext)) {
    return {
      icon: '3d',
      label: '3D Model',
      className: 'assetGlyph3D',
      color: '#fb923c',
    };
  }

  // 12. Composition
  if (asset.type === 'comp' || asset.source === 'derived') {
    return {
      icon: 'component',
      label: 'Composition',
      className: 'assetGlyphComp',
      color: '#6366f1',
    };
  }

  // 13. Fallback generic file
  return {
    icon: 'file',
    label: ext ? `${ext.toUpperCase()} File` : 'File',
    className: 'assetGlyphFile',
    color: '#94a3b8',
  };
}

/** Standard real folder color (Warm Manila Amber) */
export const FOLDER_COLOR = '#f5a623';
