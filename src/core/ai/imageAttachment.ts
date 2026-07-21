/**
 * Turn a user-supplied image (file picker, drag, or a pasted screenshot) into
 * something safe to send to a model: downscaled so a 4K screenshot doesn't
 * become a 10MB base64 blob, re-encoded as JPEG on a white background.
 *
 * 1280px on the long edge keeps UI text in screenshots readable while landing
 * around 100–300KB — well inside every provider's inline-image limit and our
 * gateway's body cap.
 */

import type { AiImage } from '@motion/ai-tools';

export interface PendingImage extends AiImage {
  /** Ready-to-render data URL for the thumbnail strip / chat bubble. */
  dataUrl: string;
}

const MAX_DIM = 1280;
const JPEG_QUALITY = 0.85;

/** Hard cap per prompt — more reference images than this just dilutes focus. */
export const MAX_ATTACHMENTS = 3;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image.'));
    img.src = url;
  });
}

export async function processImageFile(file: File | Blob): Promise<PendingImage | null> {
  if (!file.type.startsWith('image/')) return null;
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const cx = canvas.getContext('2d');
    if (!cx) return null;
    // JPEG has no alpha — transparent sketches land on white, not black.
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, w, h);
    cx.drawImage(img, 0, 0, w, h);

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    return { mediaType: 'image/jpeg', dataBase64: dataUrl.slice(comma + 1), dataUrl };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
