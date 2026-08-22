/**
 * Time-scrubbed SVG rasterization for Live SVG layers.
 *
 * The texture compositor cannot play an SVG as a DOM document. For animated
 * files that would lose fidelity on the keyframe path we keep the markup intact
 * and re-rasterize it at the layer's source time — SMIL via `setCurrentTime`,
 * CSS animations via the Web Animations API.
 *
 * ## Why a SESSION per source, and what the first version got wrong twice
 *
 * v1 serialized the scrubbed live DOM verbatim — but animation state lives in
 * the cascade/timeline, not in markup, so the `<style>` keyframes and SMIL
 * nodes RESTARTED AT ZERO inside the rasterizing `<img>`: every playhead time
 * rendered frame 0 ("parts missing / outside their wrapper" on any
 * staggered-entrance Lottie-site export).
 *
 * v2 froze the frame by inlining COMPUTED styles — correct, but it re-parsed
 * the document, walked EVERY element, and decoded a 2048-px image per frame,
 * per layer. Playback backed up behind 100 ms+ rasters and read as "static and
 * slow".
 *
 * v3 (this file):
 *   • ONE persistent hidden host per source (LRU-capped). Parse once, keep the
 *     animations alive, scrub them per frame.
 *   • Bake ONLY the animated elements. The frame copy keeps the original
 *     `<style>` for all static styling and appends `animation:none !important`
 *     so nothing can re-run; SMIL nodes are removed from the copy and their
 *     targets' animated values written as attributes.
 *   • A loop-aware FRAME CACHE: WAAPI timings give the animation's period, so
 *     an infinite 2 s loop needs ~period × fps distinct frames and every later
 *     playhead lands on a cache hit. Finite animations clamp to their end —
 *     one cached frame serves the whole tail.
 *   • No per-frame rAF wait: reading computed style / animVal forces the sync
 *     style recalc this code needs (the old bare-rAF await also HUNG in hidden
 *     windows, where rAF never fires).
 */

const RASTER_MAX = 4096;
/** Long-edge target for interactive playback (cache-friendly). */
const LIVE_TARGET_LONG = 1024;
/** Long-edge target for exact-timing renders (export / harness). */
const EXPORT_TARGET_LONG = 2048;
/** Distinct frames per second the cache resolves; playhead times snap to this. */
const CACHE_FPS = 30;
/** Rendered frames kept per session (LRU). ~4 MB each at 1024 px, so this is
 *  ~100 MB ceiling per session — enough for scrubbing and short loops, while a
 *  long loop simply re-renders at the (now ~10 ms) frame cost. */
const FRAME_CACHE_CAP = 24;
/** Live DOM sessions kept alive (LRU). */
const SESSION_CAP = 4;

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
 * The CSS properties whose ANIMATED value must be captured per animated
 * element. Everything a Lottie-site exporter (Lottielab / SVGator / Creattie)
 * animates in practice: transforms, paint, opacity, dash draw-ons, visibility
 * gates, and Chromium's CSS `d` path morphing.
 */
const BAKE_PROPS = [
  'transform', 'transform-origin', 'transform-box',
  'opacity', 'fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width',
  'stroke-dasharray', 'stroke-dashoffset',
  'display', 'visibility', 'filter', 'clip-path', 'mask', 'color',
  'stop-color', 'stop-opacity', 'd',
] as const;

/** SMIL-animated geometry attributes exposed as SVGAnimatedLength/Number. */
const SMIL_GEOMETRY_ATTRS = [
  'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2',
] as const;

interface LiveSvgSession {
  host: HTMLDivElement;
  live: SVGSVGElement;
  rw: number;
  rh: number;
  /** Live elements whose frame state must be baked (CSS + SMIL targets). */
  animatedLive: Set<Element>;
  hasSmil: boolean;
  /** Steady-state loop period in seconds, or null when not derivable. */
  period: number | null;
  /** Time from which the state is periodic (delays / finite tails settled). */
  steadyFrom: number;
  /** All animations finite: state is constant from here on. */
  clampTo: number | null;
  frames: Map<string, HTMLCanvasElement>;
  pending: Map<string, Promise<HTMLCanvasElement>>;
}

const sessions = new Map<string, LiveSvgSession>();

/** Test/debug seam: drop live hosts and cached frames. */
export function clearLiveSvgSessions(): void {
  for (const s of sessions.values()) s.host.remove();
  sessions.clear();
}

/** Greatest common divisor on integers ≥ 1. */
function gcd(a: number, b: number): number {
  while (b > 0) { const t = a % b; a = b; b = t; }
  return a;
}

/**
 * Derive the loop structure from the document's Web Animations. SMIL is left
 * unwrapped (its clock is the SVG's own), which only costs cache hits.
 */
function deriveLoop(session: LiveSvgSession): void {
  session.period = null;
  session.clampTo = null;
  session.steadyFrom = 0;
  if (session.hasSmil) return;
  const anims = typeof session.live.getAnimations === 'function'
    ? session.live.getAnimations({ subtree: true })
    : [];
  if (anims.length === 0) return;
  let lcmMs = 1;
  let steadyMs = 0;
  let maxEndMs = 0;
  let anyInfinite = false;
  for (const a of anims) {
    const t = a.effect?.getTiming?.();
    if (!t) return;
    const dur = typeof t.duration === 'number' ? t.duration : NaN;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const delay = t.delay ?? 0;
    if (t.iterations === Infinity) {
      anyInfinite = true;
      const d = Math.max(1, Math.round(dur));
      lcmMs = (lcmMs / gcd(lcmMs, d)) * d;
      if (lcmMs > 120000) return; // incommensurate loops — cache LRU still helps
      steadyMs = Math.max(steadyMs, delay);
    } else {
      const end = delay + dur * (t.iterations ?? 1);
      maxEndMs = Math.max(maxEndMs, end);
      steadyMs = Math.max(steadyMs, end);
    }
  }
  if (anyInfinite) {
    session.period = lcmMs / 1000;
    session.steadyFrom = steadyMs / 1000;
  } else {
    // Everything ends: past the last end the picture is constant.
    session.clampTo = maxEndMs / 1000;
  }
}

function getSession(cacheKey: string, text: string, targetLong: number): LiveSvgSession | null {
  const existing = sessions.get(cacheKey);
  if (existing) {
    // LRU touch.
    sessions.delete(cacheKey);
    sessions.set(cacheKey, existing);
    return existing;
  }
  if (typeof document === 'undefined' || !document.body) return null;

  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') return null;

  let w = parseLen(root.getAttribute('width'));
  let h = parseLen(root.getAttribute('height'));
  const vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const vbW = vb.length === 4 && vb[2]! > 0 ? vb[2]! : 0;
  const vbH = vb.length === 4 && vb[3]! > 0 ? vb[3]! : 0;
  if ((!w || !h) && vbW && vbH) {
    if (w && !h) h = (w * vbH) / vbW;
    else if (h && !w) w = (h * vbW) / vbH;
    else { w = vbW; h = vbH; }
  }
  if (!w || !h) { w = 512; h = 512; }
  const longEdge = Math.max(w, h);
  const scale = Math.min(RASTER_MAX, Math.max(longEdge, targetLong)) / longEdge;
  const rw = Math.max(1, Math.min(RASTER_MAX, Math.round(w * scale)));
  const rh = Math.max(1, Math.min(RASTER_MAX, Math.round(h * scale)));
  if (!root.getAttribute('viewBox') && vbW === 0) root.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const host = document.createElement('div');
  host.setAttribute('data-live-svg', '');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;opacity:0';
  host.appendChild(root.cloneNode(true));
  document.body.appendChild(host);
  const live = host.querySelector('svg') as SVGSVGElement | null;
  if (!live) { host.remove(); return null; }
  live.setAttribute('width', String(rw));
  live.setAttribute('height', String(rh));

  // Animated elements: WAAPI targets (CSS animations/transitions)…
  const animatedLive = new Set<Element>();
  try {
    const anims = typeof live.getAnimations === 'function' ? live.getAnimations({ subtree: true }) : [];
    for (const a of anims) {
      const target = (a.effect as KeyframeEffect | undefined)?.target;
      if (target) animatedLive.add(target);
    }
  } catch { /* getAnimations unavailable */ }
  // …and SMIL targets.
  const smilNodes = live.querySelectorAll('animate, animateTransform, animateMotion, set');
  for (const n of smilNodes) {
    const target = (n as SVGAnimationElement).targetElement ?? n.parentElement;
    if (target) animatedLive.add(target);
  }

  const session: LiveSvgSession = {
    host, live, rw, rh, animatedLive,
    hasSmil: smilNodes.length > 0,
    period: null, steadyFrom: 0, clampTo: null,
    frames: new Map(), pending: new Map(),
  };
  deriveLoop(session);

  sessions.set(cacheKey, session);
  while (sessions.size > SESSION_CAP) {
    const oldest = sessions.keys().next();
    if (oldest.done) break;
    sessions.get(oldest.value)?.host.remove();
    sessions.delete(oldest.value);
  }
  return session;
}

/** Map t onto the cache's canonical timeline (loop wrap / tail clamp). */
function canonicalTime(session: LiveSvgSession, t: number): number {
  let ct = Math.max(0, t);
  if (session.clampTo !== null) ct = Math.min(ct, session.clampTo);
  else if (session.period !== null && ct > session.steadyFrom) {
    ct = session.steadyFrom + ((ct - session.steadyFrom) % session.period);
  }
  return Math.round(ct * CACHE_FPS) / CACHE_FPS;
}

/** Scrub every animation clock in the session to `t` seconds. */
function scrubTo(session: LiveSvgSession, t: number): void {
  const live = session.live;
  try {
    if (typeof live.pauseAnimations === 'function') live.pauseAnimations();
    if (typeof live.setCurrentTime === 'function') live.setCurrentTime(t);
  } catch { /* SMIL unavailable */ }
  try {
    const anims = typeof live.getAnimations === 'function' ? live.getAnimations({ subtree: true }) : [];
    for (const a of anims) {
      try {
        a.pause();
        a.currentTime = t * 1000;
      } catch { /* individual animation */ }
    }
  } catch { /* getAnimations unavailable */ }
}

/**
 * Produce frame markup: clone the scrubbed tree, write each animated element's
 * live state (computed CSS + SMIL animVal) onto its clone, neutralise every
 * animation source in the clone, serialize.
 *
 * The bake targets the CLONE so the live session is never mutated — writing
 * SMIL `animVal`s back as attributes on the live tree would corrupt its base
 * values for later frames.
 */
function serializeFrame(session: LiveSvgSession): string {
  const { live, animatedLive } = session;
  const clone = live.cloneNode(true) as SVGSVGElement;
  const win = live.ownerDocument?.defaultView;

  if (win && typeof win.getComputedStyle === 'function' && animatedLive.size > 0) {
    // cloneNode preserves traversal order, so index-pairing is exact.
    const liveAll = live.querySelectorAll<SVGElement>('*');
    const cloneAll = clone.querySelectorAll<SVGElement>('*');
    for (let i = 0; i < liveAll.length; i++) {
      const el = liveAll[i]!;
      if (!animatedLive.has(el)) continue;
      const copy = cloneAll[i];
      if (!copy) continue;
      // SMIL geometry out of animVal…
      for (const attr of SMIL_GEOMETRY_ATTRS) {
        const animated = (el as unknown as Record<string, { animVal?: { value?: number } } | undefined>)[attr];
        const v = animated?.animVal?.value;
        if (typeof v === 'number' && Number.isFinite(v) && el.hasAttribute(attr)) {
          copy.setAttribute(attr, String(v));
        }
      }
      // …SMIL transforms out of the animated transform list…
      const tl = (el as SVGGraphicsElement).transform;
      if (tl && tl.animVal && tl.baseVal) {
        try {
          const m = tl.animVal.consolidate()?.matrix;
          const b = tl.baseVal.consolidate()?.matrix;
          const differs = m && (!b || m.a !== b.a || m.b !== b.b || m.c !== b.c
            || m.d !== b.d || m.e !== b.e || m.f !== b.f);
          if (m && differs) {
            copy.setAttribute('transform', `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`);
          }
        } catch { /* not consolidatable */ }
      }
      // …CSS animated values as inline style. Inline style would lose to the
      // clone's keyframe animations, but those are switched off wholesale below.
      const cs = win.getComputedStyle(el);
      for (const p of BAKE_PROPS) {
        const v = cs.getPropertyValue(p);
        if (v) copy.style.setProperty(p, v);
      }
    }
  }

  // Neutralise every animation source in the copy: SMIL nodes go entirely;
  // CSS keyframes stay in the stylesheet (static styling still needs it) but
  // can never run again.
  clone.querySelectorAll('animate, animateTransform, animateMotion, set').forEach((n) => n.remove());
  const off = clone.ownerDocument!.createElementNS('http://www.w3.org/2000/svg', 'style');
  off.textContent = '*{animation:none !important;transition:none !important}';
  clone.appendChild(off);
  return new XMLSerializer().serializeToString(clone);
}

async function renderFrame(session: LiveSvgSession, t: number): Promise<HTMLCanvasElement> {
  scrubTo(session, t);
  // No rAF wait: getComputedStyle / animVal reads force the style recalc this
  // needs, synchronously — and a bare rAF await hangs in hidden windows.
  const serialized = serializeFrame(session);
  return drawSerializedSvg(serialized, session.rw, session.rh);
}

async function frameAt(session: LiveSvgSession, timeSec: number): Promise<HTMLCanvasElement> {
  const ct = canonicalTime(session, Number.isFinite(timeSec) ? timeSec : 0);
  const key = ct.toFixed(4);
  const hit = session.frames.get(key);
  if (hit) {
    session.frames.delete(key);
    session.frames.set(key, hit); // LRU touch
    return hit;
  }
  const pending = session.pending.get(key);
  if (pending) return pending;
  const work = renderFrame(session, ct).then((canvas) => {
    session.pending.delete(key);
    session.frames.set(key, canvas);
    while (session.frames.size > FRAME_CACHE_CAP) {
      const oldest = session.frames.keys().next();
      if (oldest.done) break;
      session.frames.delete(oldest.value);
    }
    return canvas;
  }, (err) => {
    session.pending.delete(key);
    throw err;
  });
  session.pending.set(key, work);
  return work;
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
  opts?: { exportQuality?: boolean },
): Promise<ImageBitmap> {
  const text = srcOrMarkup.startsWith('data:')
    ? decodeSvgDataUrl(srcOrMarkup)
    : srcOrMarkup.startsWith('<')
      ? srcOrMarkup
      : await (await fetch(srcOrMarkup)).text();

  const targetLong = opts?.exportQuality ? EXPORT_TARGET_LONG : LIVE_TARGET_LONG;
  const session = getSession(`${targetLong}|${srcOrMarkup}`, text, targetLong);
  if (session) {
    const canvas = await frameAt(session, timeSec);
    return canvasToBitmap(canvas, session.rw, session.rh);
  }

  // No DOM host (jsdom / SSR): static draw of the parsed markup.
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement as unknown as SVGSVGElement;
  let w = parseLen(svg.getAttribute('width'));
  let h = parseLen(svg.getAttribute('height'));
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const vbW = vb.length === 4 && vb[2]! > 0 ? vb[2]! : 0;
  const vbH = vb.length === 4 && vb[3]! > 0 ? vb[3]! : 0;
  if ((!w || !h) && vbW && vbH) { w = w || vbW; h = h || vbH; }
  if (!w || !h) { w = 512; h = 512; }
  const longEdge = Math.max(w, h);
  const scale = Math.min(RASTER_MAX, Math.max(longEdge, targetLong)) / longEdge;
  const rw = Math.max(1, Math.min(RASTER_MAX, Math.round(w * scale)));
  const rh = Math.max(1, Math.min(RASTER_MAX, Math.round(h * scale)));
  svg.setAttribute('width', String(rw));
  svg.setAttribute('height', String(rh));
  if (!svg.getAttribute('viewBox') && vbW === 0) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const canvas = await drawSerializedSvg(new XMLSerializer().serializeToString(svg), rw, rh);
  return canvasToBitmap(canvas, rw, rh);
}

async function canvasToBitmap(canvas: HTMLCanvasElement, rw: number, rh: number): Promise<ImageBitmap> {
  if (typeof createImageBitmap === 'function') {
    // A FRESH bitmap per call: the texture provider closes the bitmaps it is
    // handed, and the cached canvas must survive that.
    return createImageBitmap(canvas, decodeOptions());
  }
  // jsdom / node: synthesize a minimal ImageBitmap-shaped result so Live SVG
  // import tests and headless decode paths stay green without a browser.
  return {
    width: rw,
    height: rh,
    close() { /* no-op */ },
  } as ImageBitmap;
}

async function drawSerializedSvg(serialized: string, rw: number, rh: number): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = rw;
  canvas.height = rh;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return canvas;
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
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}
