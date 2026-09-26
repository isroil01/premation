/**
 * videoPosters — a first-frame poster for a video asset, made lazily.
 *
 * `assetStore` thumbnails IMAGES at import (`makeImageThumb`) and leaves video
 * and audio without one, so a grid of clips would be a grid of icons. This
 * module fills the gap on demand: the first card that needs a poster seeks a
 * hidden `<video>` a little way in (a frame at 0 is often black or a logo
 * card) and rasterises it into a small data URL, which is then shared by
 * every row and card showing that asset for the rest of the session.
 *
 * Bounded on purpose: at most two decoders run at once, the rest queue, and
 * a failed decode is remembered as `null` so an unplayable container does not
 * get retried on every scroll.
 *
 * Not persisted — it is a few KB per clip and cheaper to remake than to
 * version in IndexedDB beside the asset record.
 */

import { attachVideoSrc, detachVideoSrc } from '@core/rendering/localBlobSource';

const POSTER_W = 160;
const POSTER_H = 90;
const MAX_CONCURRENT = 2;
/** A decode that never fires `seeked` must not hold its slot forever. */
const TIMEOUT_MS = 8000;

type Listener = (url: string | null) => void;

const posters = new Map<string, string | null>();
const waiting = new Map<string, Listener[]>();
const queue: Array<{ id: string; src: string }> = [];
let active = 0;

/** The cached poster: a data URL, `null` when it could not be made, or
 *  `undefined` when nobody has asked yet. Synchronous. */
export function peekVideoPoster(assetId: string): string | null | undefined {
  return posters.get(assetId);
}

/**
 * Ask for a poster. `onReady` fires once, with the result, unless the poster
 * was already known (then it fires synchronously). Returns an unsubscribe
 * for a card that unmounts before the decode finishes.
 */
export function requestVideoPoster(assetId: string, src: string, onReady: Listener): () => void {
  const known = posters.get(assetId);
  if (known !== undefined) {
    onReady(known);
    return () => {};
  }
  const list = waiting.get(assetId);
  if (list) {
    list.push(onReady);
  } else {
    waiting.set(assetId, [onReady]);
    queue.push({ id: assetId, src });
    pump();
  }
  return () => {
    const cur = waiting.get(assetId);
    if (!cur) return;
    const i = cur.indexOf(onReady);
    if (i !== -1) cur.splice(i, 1);
  };
}

function settle(id: string, url: string | null): void {
  posters.set(id, url);
  const list = waiting.get(id) ?? [];
  waiting.delete(id);
  for (const l of list) l(url);
}

function pump(): void {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift()!;
    active += 1;
    void makePoster(job.src)
      .catch(() => null)
      .then((url) => {
        active -= 1;
        settle(job.id, url);
        pump();
      });
  }
}

function makePoster(src: string): Promise<string | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    let done = false;
    const finish = (url: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('error', onError);
      detachVideoSrc(v);
      v.removeAttribute('src');
      try { v.load(); } catch { /* ignore */ }
      resolve(url);
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    const onError = (): void => finish(null);
    const onSeeked = (): void => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = POSTER_W;
        canvas.height = POSTER_H;
        const ctx = canvas.getContext('2d');
        if (!ctx || !v.videoWidth || !v.videoHeight) return finish(null);
        // Cover, not stretch: the well is 16:9 and the clip may not be.
        const scale = Math.max(POSTER_W / v.videoWidth, POSTER_H / v.videoHeight);
        const w = v.videoWidth * scale;
        const h = v.videoHeight * scale;
        ctx.drawImage(v, (POSTER_W - w) / 2, (POSTER_H - h) / 2, w, h);
        finish(canvas.toDataURL('image/webp', 0.8));
      } catch {
        finish(null);
      }
    };
    const onMeta = (): void => {
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      // A tenth of the way in, capped at half a second past the start.
      v.currentTime = Math.min(0.5, d * 0.1);
    };
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('error', onError);
    attachVideoSrc(v, src);
  });
}
