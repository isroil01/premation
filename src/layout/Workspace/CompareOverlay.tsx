/**
 * Snapshot comparison — the drawing half of `compareStore`.
 *
 * `F5` freezes the frame, `Shift+F5` shows it, and this paints the result in one of
 * four ways:
 *
 *   toggle        the snapshot instead of the live frame (`flip` swaps back)
 *   side-by-side  snapshot in the left half, live showing through on the right
 *   wipe          a draggable divider between the two
 *   difference    |live − snapshot|, brightened
 *
 * ## What it does NOT draw
 *
 * The LIVE frame — for three of the four modes. This canvas is transparent
 * wherever the live picture should show, and the content canvas underneath is
 * the live picture. That is what makes a wipe free: no readback, no second
 * render, one `drawImage` of a bitmap we already hold, clipped.
 *
 * Difference is the exception, because subtracting needs both images. The live
 * copy for it is taken by the render loop inside the draw task
 * (`captureLiveFrame`) — a WebGL canvas cannot be read anywhere else — and
 * this repaints when a new one lands.
 *
 * ## Scaling
 *
 * A snapshot is drawn at the STAGE's size, not the size it was captured at, so
 * that resizing the panel after taking one does not desync the two halves of a
 * wipe. It is a comparison of pictures, not of pixel grids; the note in the
 * chip says which framing the snapshot was taken under so a zoom difference is
 * never read as a render difference.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  activeSnapshot,
  liveFrame,
  subscribeLiveFrame,
  useCompareStore,
  type CompareSnapshot,
} from '@stores/compareStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import styles from './CompareOverlay.module.css';

/** How much |live − snapshot| is amplified so a subtle drift is visible. */
const DIFFERENCE_GAIN = 4;

/** Keyboard step for the wipe divider, as a fraction of the stage width. */
const WIPE_KEY_STEP = 0.02;

export function CompareOverlay(): JSX.Element | null {
  const visible = useCompareStore((s) => s.visible);
  const mode = useCompareStore((s) => s.mode);
  const wipe = useCompareStore((s) => s.wipe);
  const showingSnapshot = useCompareStore((s) => s.showingSnapshot);
  const snapshots = useCompareStore((s) => s.snapshots);
  const activeId = useCompareStore((s) => s.activeId);
  const setWipe = useCompareStore((s) => s.setWipe);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const snap = activeSnapshot({ snapshots, activeId });

  // Track the stage's CSS size; the canvas backing store follows it at DPR so
  // a snapshot is not resampled twice on a HiDPI screen.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible]);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !snap || size.w < 1 || size.h < 1) return;
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const bw = Math.max(1, Math.round(size.w * dpr));
    const bh = Math.max(1, Math.round(size.h * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    drawCompare(ctx, snap, mode, wipe, showingSnapshot, size);
  }, [snap, mode, wipe, showingSnapshot, size]);

  useLayoutEffect(paint, [paint]);

  // Difference mode repaints on every fresh live copy; the other modes have
  // nothing new to draw between renders.
  useEffect(() => {
    if (!visible || mode !== 'difference') return;
    return subscribeLiveFrame(paint);
  }, [visible, mode, paint]);

  // Dragging the divider. Pointer capture rather than window listeners so a
  // drag that leaves the stage still tracks, and releases cleanly.
  const onDividerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const root = rootRef.current;
      if (!root) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const rect = root.getBoundingClientRect();
      const move = (x: number): void => setWipe((x - rect.left) / Math.max(1, rect.width));
      move(e.clientX);
      const onMove = (ev: PointerEvent): void => move(ev.clientX);
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [setWipe],
  );

  if (!visible || !snap) return null;
  // Toggle mode showing the LIVE frame draws nothing at all — the chip would
  // otherwise claim a comparison is on screen when the picture is unchanged.
  const inert = mode === 'toggle' && !showingSnapshot;

  return (
    <div ref={rootRef} className={styles.root} data-compare-overlay={mode}>
      {!inert && <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />}
      {mode === 'wipe' && (
        <button
          type="button"
          className={styles.divider}
          style={{ left: `${wipe * 100}%` }}
          role="slider"
          aria-label="Comparison wipe"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(wipe * 100)}
          aria-valuetext={`${Math.round(wipe * 100)}% snapshot`}
          onPointerDown={onDividerDown}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { setWipe(wipe - WIPE_KEY_STEP); e.preventDefault(); }
            else if (e.key === 'ArrowRight') { setWipe(wipe + WIPE_KEY_STEP); e.preventDefault(); }
            else if (e.key === 'Home') { setWipe(0); e.preventDefault(); }
            else if (e.key === 'End') { setWipe(1); e.preventDefault(); }
          }}
        >
          <span className={styles.dividerGrip} />
        </button>
      )}
      <div className={styles.chip}>
        {snap.label}
        <span className={styles.chipSide}>{describeFraming(snap)}</span>
      </div>
    </div>
  );
}

/**
 * A note when the snapshot was taken at a DIFFERENT zoom or pan from the one
 * on screen now — the single most common way a comparison lies. Empty when
 * the framings agree, so the chip stays quiet in the normal case.
 */
function describeFraming(snap: CompareSnapshot): string {
  let view: { scale: number; offsetX: number; offsetY: number };
  try {
    view = getWorkspaceController().getView();
  } catch {
    return '';
  }
  const zoomed = Math.abs(view.scale - snap.view.scale) > 1e-3;
  const panned =
    Math.abs(view.offsetX - snap.view.offsetX) > 0.5 || Math.abs(view.offsetY - snap.view.offsetY) > 0.5;
  if (!zoomed && !panned) return '';
  return zoomed ? '· taken at a different zoom' : '· taken at a different pan';
}

/**
 * The painter. Split out and exported so the modes can be unit-tested against
 * a 2D context stub without mounting the viewport.
 */
export function drawCompare(
  ctx: CanvasRenderingContext2D,
  snap: CompareSnapshot,
  mode: 'toggle' | 'side-by-side' | 'wipe' | 'difference',
  wipe: number,
  showingSnapshot: boolean,
  size: { w: number; h: number },
): void {
  const { w, h } = size;
  switch (mode) {
    case 'toggle':
      if (showingSnapshot) ctx.drawImage(snap.bitmap, 0, 0, w, h);
      return;

    case 'side-by-side': {
      // Snapshot on the left half, live showing through on the right. Each
      // half shows the MIDDLE of its picture rather than a squashed copy —
      // squashing changes every edge, which is the thing being compared.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w / 2, h);
      ctx.clip();
      ctx.drawImage(snap.bitmap, 0, 0, w, h);
      ctx.restore();
      return;
    }

    case 'wipe': {
      const x = Math.max(0, Math.min(w, wipe * w));
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, x, h);
      ctx.clip();
      ctx.drawImage(snap.bitmap, 0, 0, w, h);
      ctx.restore();
      return;
    }

    case 'difference': {
      const live = liveFrame();
      // Draw the snapshot, then the live frame in `difference`, then multiply
      // the result up so a one-value drift is not a black frame. Without the
      // live copy there is nothing to subtract — show the snapshot alone
      // rather than an empty stage that reads as "no difference".
      ctx.drawImage(snap.bitmap, 0, 0, w, h);
      if (!live) return;
      ctx.save();
      ctx.globalCompositeOperation = 'difference';
      ctx.drawImage(live, 0, 0, w, h);
      // `lighter` against itself is the cheapest gain that stays on the GPU:
      // each pass doubles, so two passes are ×4.
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 1; i < DIFFERENCE_GAIN; i *= 2) ctx.drawImage(ctx.canvas, 0, 0, w, h);
      ctx.restore();
      return;
    }
  }
}
