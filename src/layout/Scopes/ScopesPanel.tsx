/**
 * Scopes — waveform, RGB parade, vectorscope and histogram of the frame the
 * playhead is on.
 *
 * ## Shape of the thing
 *
 * The panel does three jobs and keeps them apart. It SAMPLES a frame (once,
 * on a 10 Hz timer, in `scopeFrame.ts`), it hands that frame to however many
 * plots are on screen, and each plot ACCUMULATES and PAINTS itself. The split
 * matters because the sample is the expensive half — a canvas readback — and
 * doing it once for four plots rather than four times is the difference
 * between the 2×2 grid being free and it being four times the cost of one.
 *
 * ## Why a timer and not the render loop
 *
 * Nobody reads a scope at 60 Hz; they read it while dragging a curve, and what
 * they need is for it to keep up, not to be frame-exact. 10 Hz is fast enough
 * to feel live and slow enough that the readback never competes with the
 * viewport for the main thread. It is also the rate the frame tap publishes
 * at, so the two cannot drift into doing redundant work.
 *
 * ## Why nothing runs when the panel is not on screen
 *
 * A docked panel on an inactive tab stays mounted, so "unmounted" is not the
 * same as "not visible" and an effect that only cleaned up on unmount would
 * leave a canvas readback running at 10 Hz behind a tab nobody is looking at.
 * The `ResizeObserver` answers the real question: a panel behind another tab
 * measures zero, and zero is what turns the sampler AND the frame-tap
 * subscription off. `visibilitychange` covers the same case for the whole
 * window being hidden.
 *
 * Draws are pushed through a subscriber set rather than React state on
 * purpose. A `setState` at 10 Hz would re-render this subtree six hundred
 * times a minute to change nothing but pixels inside a canvas that React does
 * not own — the plots subscribe once and repaint themselves.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_SCOPE_THEME,
  drawScope,
  histogram,
  parade,
  vectorscope,
  waveform,
  chroma709,
  VECTORSCOPE_MAX_CHROMA,
  type ScopeAccum,
  type ScopeTheme,
} from '@core/video/scopes';
import { useInfoStore } from '@stores/infoStore';
import {
  DEFAULT_FRAME_TAP_HZ,
  setFrameTapInterval,
  setFrameTapRegion,
  subscribeFrames,
} from '@core/engine/frameTap';
import { captureScopeFrame, liveCompRegion, type ScopeFrame, type ScopeFrameMiss } from './scopeFrame';
import { EmptyState } from '@components/EmptyState';
import styles from './ScopesPanel.module.css';

/** Sampling rate. Matches the frame tap's publish ceiling deliberately. */
const SCOPE_HZ = DEFAULT_FRAME_TAP_HZ;

/** Which plot a cell draws. */
export type ScopeKind = 'waveform' | 'parade' | 'vectorscope' | 'histogram';

/** What the view selector offers — the four plots, or all of them at once. */
type ScopeView = ScopeKind | 'all';

const VIEW_TABS: ReadonlyArray<{ id: ScopeView; label: string }> = [
  { id: 'waveform', label: 'Waveform' },
  { id: 'parade', label: 'Parade' },
  { id: 'vectorscope', label: 'Vector' },
  { id: 'histogram', label: 'Histogram' },
  { id: 'all', label: 'All' },
];

const KIND_LABEL: Readonly<Record<ScopeKind, string>> = {
  waveform: 'Waveform',
  parade: 'Parade',
  vectorscope: 'Vector',
  histogram: 'Histogram',
};

// ── Theme ────────────────────────────────────────────────────────────

/**
 * Scope colours, read from the panel's own custom properties.
 *
 * Cached on the document's theme attribute, exactly like the viewport's
 * overlay chrome: `getPropertyValue` forces a style recalculation, and these
 * eight values change when the theme does and at no other time. Resolving them
 * on every one of ten repaints a second would put a layout flush on a timer.
 */
let themeCache: { key: string; theme: ScopeTheme } | null = null;

function scopeThemeOf(el: HTMLElement): ScopeTheme {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  const key = `${root?.getAttribute('data-theme') ?? ''}|${root?.className ?? ''}`;
  if (themeCache && themeCache.key === key) return themeCache.theme;
  let computed: CSSStyleDeclaration | null = null;
  try {
    computed = getComputedStyle(el);
  } catch {
    computed = null;
  }
  const read = (token: string, fallback: string): string =>
    computed?.getPropertyValue(token).trim() || fallback;
  const theme: ScopeTheme = {
    background: read('--scope-bg', DEFAULT_SCOPE_THEME.background),
    graticule: read('--scope-graticule', DEFAULT_SCOPE_THEME.graticule),
    graticuleStrong: read('--scope-graticule-strong', DEFAULT_SCOPE_THEME.graticuleStrong),
    label: read('--scope-label', DEFAULT_SCOPE_THEME.label),
    luma: read('--scope-luma', DEFAULT_SCOPE_THEME.luma),
    red: read('--scope-red', DEFAULT_SCOPE_THEME.red),
    green: read('--scope-green', DEFAULT_SCOPE_THEME.green),
    blue: read('--scope-blue', DEFAULT_SCOPE_THEME.blue),
  };
  themeCache = { key, theme };
  return theme;
}

// ── Accumulation ─────────────────────────────────────────────────────

/**
 * Build the accumulator a plot needs, or an EMPTY one when there is no frame.
 *
 * Empty rather than null so a plot with nothing to show still paints its
 * background and graticule. A scope that goes blank between frames reads as
 * broken; one showing an empty graticule reads as "no signal", which is what
 * is actually true.
 */
export function accumulateFor(
  kind: ScopeKind,
  frame: ScopeFrame | null,
  waveMode: 'luma' | 'rgb',
): ScopeAccum {
  const px = frame?.data ?? new Uint8ClampedArray(0);
  const w = frame?.width ?? 0;
  const h = frame?.height ?? 0;
  // The tap and the cache both hand over a crop that can include transparent
  // letterbox at the edges when the comp is not axis-aligned with the
  // viewport; those pixels are not picture and must not be measured.
  const opts = { ignoreTransparent: true } as const;
  switch (kind) {
    case 'waveform':
      return waveform(px, w, h, { ...opts, mode: waveMode });
    case 'parade':
      return parade(px, w, h, opts);
    case 'vectorscope':
      return vectorscope(px, w, h, opts);
    case 'histogram':
      return histogram(px, w, h, opts);
  }
}

// ── One plot ─────────────────────────────────────────────────────────

type FrameListener = (frame: ScopeFrame | null) => void;

interface ScopePlotProps {
  kind: ScopeKind;
  waveMode: 'luma' | 'rgb';
  /** Register for sampled frames; returns the unsubscriber. */
  subscribe: (fn: FrameListener) => () => void;
}

function ScopePlot({ kind, waveMode, subscribe }: ScopePlotProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Last frame seen, so a resize can repaint without waiting for a sample. */
  const frameRef = useRef<ScopeFrame | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const paint = (): void => {
      const rect = canvas.getBoundingClientRect();
      // Zero-sized is a hidden panel, a collapsed dock or a mid-layout tick.
      // Painting into it would allocate an ImageData for nothing.
      if (rect.width < 2 || rect.height < 2) return;
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const w = Math.max(2, Math.round(rect.width * dpr));
      const h = Math.max(2, Math.round(rect.height * dpr));
      // Assigning width/height CLEARS the canvas, so only do it on a real
      // change — otherwise every repaint throws away the previous frame first
      // and the plot flickers.
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const theme = scopeThemeOf(canvas.parentElement ?? canvas);
      drawScope(ctx, accumulateFor(kind, frameRef.current, waveMode), theme, { width: w, height: h, dpr });
      if (kind === 'vectorscope') drawProbeMarker(ctx, theme, { width: w, height: h, dpr });
    };

    const onFrame: FrameListener = (frame) => {
      frameRef.current = frame;
      paint();
    };

    const off = subscribe(onFrame);
    // Click-to-probe: the pixel under the pointer in the viewport gets a
    // marker on the vectorscope, which is what turns two panels into one
    // tool — "that skin tone, THERE on the line". Only the vectorscope needs
    // to repaint on a probe move, so the other three never subscribe.
    const offProbe =
      kind === 'vectorscope' ? useInfoStore.subscribe(() => paint()) : (): void => {};
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => paint());
      observer.observe(canvas);
    }
    paint();

    return () => {
      off();
      offProbe();
      observer?.disconnect();
    };
  }, [kind, waveMode, subscribe]);

  return (
    <div className={styles.cell}>
      <canvas ref={canvasRef} className={styles.canvas} />
      <span className={styles.cellLabel}>{KIND_LABEL[kind]}</span>
    </div>
  );
}

/**
 * The pixel probe, marked on the vectorscope.
 *
 * The viewport already samples the pixel under the pointer into `infoStore`
 * for the status bar's readout. Plotting that same sample here is the
 * click-to-probe link between the two panels: hover a face and its chroma
 * appears on the skin-tone line, which is the reading colourists actually
 * want and the reason the two panels are worth docking together.
 *
 * The geometry is a deliberate mirror of `drawVectorscope`'s — the same 6px
 * pad, the same centred square, the same `VECTORSCOPE_MAX_CHROMA` radius
 * scale — rather than an export from `core/video/scopes.ts`, so the core
 * module stays a pure frame→raster transform with no notion of a cursor.
 */
function drawProbeMarker(
  ctx: CanvasRenderingContext2D,
  theme: ScopeTheme,
  vp: { width: number; height: number; dpr: number },
): void {
  const probe = useInfoStore.getState();
  if (!probe.present || !probe.rgba) return;
  if (vp.width < 2 || vp.height < 2) return;
  const pad = Math.round(6 * vp.dpr);
  const edge = Math.min(vp.width, vp.height) - 2 * pad;
  if (edge <= 4) return;
  const half = edge / 2;
  const cx = (vp.width - edge) / 2 + half;
  const cy = (vp.height - edge) / 2 + half;

  const { cb, cr } = chroma709(probe.rgba.r / 255, probe.rgba.g / 255, probe.rgba.b / 255);
  const x = cx + (cb / VECTORSCOPE_MAX_CHROMA) * half;
  // +Cr (red) points UP, as in `vectorscopeXY`.
  const y = cy - (cr / VECTORSCOPE_MAX_CHROMA) * half;
  // A probe outside the faceplate is a super-saturated pixel; clamping it to
  // the rim would claim a saturation it does not have, so it is simply not
  // drawn and the reading stays honest.
  if (Math.hypot(x - cx, y - cy) > half) return;

  const r = Math.max(3, 4 * vp.dpr);
  ctx.save();
  // Two rings: a dark one for contrast against a bright trace, a light one on
  // top. The same halo trick the viewport overlays use, for the same reason.
  ctx.lineWidth = Math.max(1, 3 * vp.dpr);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.moveTo(x - r * 2, y);
  ctx.lineTo(x - r, y);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + r * 2, y);
  ctx.moveTo(x, y - r * 2);
  ctx.lineTo(x, y - r);
  ctx.moveTo(x, y + r);
  ctx.lineTo(x, y + r * 2);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, vp.dpr);
  ctx.strokeStyle = theme.graticule;
  ctx.stroke();
  ctx.restore();
}

// ── Panel ────────────────────────────────────────────────────────────

interface Status {
  source: ScopeFrame['source'] | null;
  partial: boolean;
  miss: ScopeFrameMiss | null;
}

const IDLE_STATUS: Status = { source: null, partial: false, miss: null };

function sameStatus(a: Status, b: Status): boolean {
  return a.source === b.source && a.partial === b.partial && a.miss === b.miss;
}

/** The status line's text, and whether it is a warning. */
export function statusText(status: Status): { text: string; warn: boolean } {
  if (status.miss === 'off-screen') {
    return { text: 'Composition is off screen', warn: true };
  }
  if (status.miss === 'no-frame' || !status.source) {
    return { text: 'Waiting for a rendered frame', warn: false };
  }
  if (status.partial) {
    return { text: 'Partial — comp is cropped by the viewport', warn: true };
  }
  // One source now — the engine's frame, through the frame tap.
  return { text: 'Live', warn: false };
}

export function ScopesPanel(): JSX.Element {
  const [view, setView] = useState<ScopeView>('waveform');
  const [waveMode, setWaveMode] = useState<'luma' | 'rgb'>('luma');
  const [status, setStatus] = useState<Status>(IDLE_STATUS);
  const [active, setActive] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const listenersRef = useRef<Set<FrameListener>>(new Set());

  // Stable across renders, so a plot's effect does not tear down and rebuild
  // its subscription every time the panel re-renders for a status change.
  const subscribe = useCallback((fn: FrameListener) => {
    const set = listenersRef.current;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }, []);

  // ── Visibility ─────────────────────────────────────────────────
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    const evaluate = (): void => {
      const shown =
        root.clientWidth > 0 &&
        root.clientHeight > 0 &&
        (typeof document === 'undefined' || document.visibilityState !== 'hidden');
      setActive((prev) => (prev === shown ? prev : shown));
    };

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(evaluate);
      observer.observe(root);
    }
    document.addEventListener('visibilitychange', evaluate);
    evaluate();

    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', evaluate);
    };
  }, []);

  // ── Sampling ───────────────────────────────────────────────────
  useEffect(() => {
    if (!active) {
      // Not merely "stop drawing": with no subscriber the frame tap's publish
      // call returns on a Set.size check, so a hidden panel costs the render
      // loop nothing measurable.
      setStatus((prev) => (sameStatus(prev, IDLE_STATUS) ? prev : IDLE_STATUS));
      return undefined;
    }

    setFrameTapInterval(SCOPE_HZ);
    setFrameTapRegion((w, h) => liveCompRegion(w, h));
    // Subscribing is what ARMS the tap. The published frame is not consumed
    // here — `captureScopeFrame` reads the latest one on our own timer, which
    // keeps a single code path for both sources — so this listener exists to
    // say "somebody wants frames" and nothing else.
    const offTap = subscribeFrames(() => undefined);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const tick = (): void => {
      timer = null;
      if (stopped) return;
      const { frame, miss } = captureScopeFrame();
      const next: Status = {
        source: frame?.source ?? null,
        partial: frame?.partial ?? false,
        miss,
      };
      setStatus((prev) => (sameStatus(prev, next) ? prev : next));
      for (const fn of [...listenersRef.current]) fn(frame);
      timer = setTimeout(tick, 1000 / SCOPE_HZ);
    };

    tick();

    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      offTap();
      setFrameTapRegion(null);
    };
  }, [active]);

  const kinds: readonly ScopeKind[] = useMemo(
    () => (view === 'all' ? ['waveform', 'parade', 'vectorscope', 'histogram'] : [view]),
    [view],
  );

  const line = statusText(status);
  const showWaveMode = view === 'waveform' || view === 'all';

  return (
    <div className={styles.root} ref={rootRef}>
      <div className={styles.controls}>
        <div className={styles.group} role="group" aria-label="Scope">
          {VIEW_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={styles.tab}
              aria-pressed={view === tab.id}
              onClick={() => setView(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {showWaveMode && (
          <div className={styles.group} role="group" aria-label="Waveform channels">
            <button
              type="button"
              className={styles.tab}
              aria-pressed={waveMode === 'luma'}
              onClick={() => setWaveMode('luma')}
              title="Rec.709 luma — one trace"
            >
              Luma
            </button>
            <button
              type="button"
              className={styles.tab}
              aria-pressed={waveMode === 'rgb'}
              onClick={() => setWaveMode('rgb')}
              title="Red, green and blue traces overlaid"
            >
              RGB
            </button>
          </div>
        )}
        <span className={styles.spacer} />
        <span className={`${styles.status} ${line.warn ? styles.warn : ''}`.trim()}>{line.text}</span>
      </div>

      <div className={styles.plotsWrap}>
        <div className={`${styles.plots} ${view === 'all' ? styles.grid2 : ''}`.trim()}>
          {kinds.map((kind) => (
            <ScopePlot key={kind} kind={kind} waveMode={waveMode} subscribe={subscribe} />
          ))}
        </div>
        {/*
          OVER the graticules, not instead of them. `accumulateFor` returns an
          empty accumulator rather than null precisely so a scope with no
          signal still draws its graduated frame — a blank panel reads as a
          broken scope. But an empty graticule only says "no signal"; it never
          said what to do about it, and "Waiting for a rendered frame" in the
          status strip is one line of 11px text at the far right of a toolbar.
          So the graticule keeps its job and this says the rest.
        */}
        {!status.source && (
          <div className={styles.plotsEmpty}>
            <EmptyState
              icon="graph-value"
              title={status.miss === 'off-screen' ? 'Composition is off screen' : 'No signal yet'}
              message={
                status.miss === 'off-screen'
                  ? 'Scroll or zoom the viewport until the composition is visible — the scopes read what the canvas draws.'
                  : 'Play or scrub the composition and the waveform, parade, vectorscope and histogram read the frame on screen.'
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
