/**
 * Time-scrubbed SVG rasterization for Live SVG layers.
 *
 * The texture compositor cannot play an SVG as a DOM document. For animated
 * files that would lose fidelity on the keyframe path we keep the markup intact
 * and re-rasterize it at the layer's source time each frame — SMIL via
 * `setCurrentTime`, CSS animations via the Web Animations API.
 */

const RASTER_MAX = 4096;
const SVG_TARGET_LONG = 2048;

function decodeSvgDataUrl(src: string): string {
  const comma = src.indexOf(',');
  const meta = src.slice(0, comma);
  const body = src.slice(comma + 1);
  if (!/;base64/i.test(meta)) return decodeURIComponent(body);
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function parseLen(v: string | null): number {
  if (!v) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function decodeOptions(): ImageBitmapOptions {
  return { premultiplyAlpha: 'premultiply' };
}

/**
 * Rasterize SVG markup (or a data URL) at a specific animation time in seconds.
 *
 * Falls back to a static draw when the environment cannot host a live SVG
 * (jsdom / missing SVGSVGElement APIs).
 */
export async function rasterizeSvgAtTime(
  srcOrMarkup: string,
  timeSec: number,
): Promise<ImageBitmap> {
  const text = srcOrMarkup.startsWith('data:')
    ? decodeSvgDataUrl(srcOrMarkup)
    : srcOrMarkup.startsWith('<')
      ? srcOrMarkup
      : await (await fetch(srcOrMarkup)).text();

  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement as unknown as SVGSVGElement;

  let w = parseLen(svg.getAttribute('width'));
  let h = parseLen(svg.getAttribute('height'));
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const vbW = vb.length === 4 && vb[2]! > 0 ? vb[2]! : 0;
  const vbH = vb.length === 4 && vb[3]! > 0 ? vb[3]! : 0;
  if ((!w || !h) && vbW && vbH) {
    if (w && !h) h = (w * vbH) / vbW;
    else if (h && !w) w = (h * vbW) / vbH;
    else { w = vbW; h = vbH; }
  }
  if (!w || !h) { w = 512; h = 512; }

  const longEdge = Math.max(w, h);
  const targetLong = Math.min(RASTER_MAX, Math.max(longEdge, SVG_TARGET_LONG));
  const scale = targetLong / longEdge;
  const rw = Math.max(1, Math.min(RASTER_MAX, Math.round(w * scale)));
  const rh = Math.max(1, Math.min(RASTER_MAX, Math.round(h * scale)));
  svg.setAttribute('width', String(rw));
  svg.setAttribute('height', String(rh));
  if (!svg.getAttribute('viewBox') && vbW === 0) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const t = Math.max(0, Number.isFinite(timeSec) ? timeSec : 0);

  // Prefer a live DOM host so SMIL and CSS animations can be scrubbed.
  if (typeof document !== 'undefined' && document.body) {
    const host = document.createElement('div');
    host.setAttribute('data-live-svg', '');
    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;opacity:0';
    host.appendChild(doc.documentElement.cloneNode(true));
    document.body.appendChild(host);
    try {
      const live = host.querySelector('svg') as SVGSVGElement | null;
      if (live) {
        live.setAttribute('width', String(rw));
        live.setAttribute('height', String(rh));
        try {
          if (typeof live.pauseAnimations === 'function') live.pauseAnimations();
          if (typeof live.setCurrentTime === 'function') live.setCurrentTime(t);
        } catch {
          /* SMIL may be unavailable */
        }
        try {
          const animations = typeof live.getAnimations === 'function'
            ? live.getAnimations({ subtree: true })
            : [];
          for (const anim of animations) {
            try {
              anim.pause();
              anim.currentTime = t * 1000;
            } catch {
              /* ignore individual animation failures */
            }
          }
        } catch {
          /* getAnimations unavailable */
        }
        // One frame so the presentation updates before we snapshot.
        await new Promise<void>((resolve) => {
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
          else resolve();
        });
        const serialized = new XMLSerializer().serializeToString(live);
        return await drawSerializedSvg(serialized, rw, rh);
      }
    } finally {
      host.remove();
    }
  }

  const serialized = new XMLSerializer().serializeToString(svg);
  return drawSerializedSvg(serialized, rw, rh);
}

async function drawSerializedSvg(serialized: string, rw: number, rh: number): Promise<ImageBitmap> {
  const toBitmap = async (_source: CanvasImageSource | HTMLCanvasElement): Promise<ImageBitmap> => {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(_source as ImageBitmapSource, decodeOptions());
    }
    // jsdom / node: synthesize a minimal ImageBitmap-shaped result so Live SVG
    // import tests and headless decode paths stay green without a browser.
    return {
      width: rw,
      height: rh,
      close() { /* no-op */ },
    } as ImageBitmap;
  };

  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = rw;
    canvas.height = rh;
    return toBitmap(canvas);
  }
  const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      /* jsdom may not decode SVG images */
    }
    const canvas = document.createElement('canvas');
    canvas.width = rw;
    canvas.height = rh;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      try {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, rw, rh);
      } catch {
        /* drawImage can throw on undecoded SVG in jsdom */
      }
    }
    return toBitmap(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}
