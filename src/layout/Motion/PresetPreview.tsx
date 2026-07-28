/**
 * The animated preview thumbnail for one preset.
 *
 * Loops continuously, always — not on hover. You should be able to scan the
 * gallery and see what every preset does at once; requiring a hover means
 * discovering a preset one at a time, which is barely better than AE's "apply
 * it and undo" (AE has no previews at all).
 *
 * Two things keep that affordable:
 *   • one shared clock for every card on screen, not one rAF each, and
 *   • an IntersectionObserver, so cards that have scrolled away stop drawing.
 *
 * Everything drawn comes from the preset's own data (see presetPreview.ts), so
 * a newly authored preset gets a correct preview with no extra work — the old
 * panel faked these with per-preset CSS classes, and anything the author had
 * not hand-written CSS for showed a grey dot.
 */

import { useEffect, useRef, useState } from 'react';
import type { AnimationPreset } from '@core/animation/animationPresets';
import {
  drawPresetFrame,
  previewDuration,
  samplePresetFrame,
} from '@core/animation/presetPreview';
import { phaseFor, prefersReducedMotion, subscribePreviewTick } from './previewTicker';

/** Where in the loop a non-animating card rests. Not 0: most presets START
 *  invisible, and a gallery of blank cards is worse than no gallery. */
const STILL_PHASE = 0.7;

/** Dead time at the end of each loop so a reveal is legible before it restarts
 *  rather than snapping back to nothing. */
const LOOP_HOLD = 0.5;

export function PresetPreview({
  preset,
  width = 132,
  height = 56,
}: {
  preset: AnimationPreset;
  width?: number;
  height?: number;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [theme, setTheme] = useState({ fg: '#e8e8ea', dim: '#8a8a92' });

  // Read the app's text colour once mounted so previews follow the theme
  // instead of hardcoding a light-on-dark assumption.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const fg = cs.getPropertyValue('--color-text-primary').trim();
    const dim = cs.getPropertyValue('--color-text-tertiary').trim();
    if (fg) setTheme({ fg, dim: dim || fg });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const duration = previewDuration(preset);
    const cycle = duration + LOOP_HOLD;
    // Offset each card within its own loop so a grid does not pulse in unison.
    const phase = phaseFor(preset.name) * cycle;

    const paint = (t: number): void => {
      drawPresetFrame(ctx, preset, samplePresetFrame(preset, t), width, height, theme);
    };

    if (prefersReducedMotion()) {
      paint(duration * STILL_PHASE);
      return;
    }

    let unsubscribe: (() => void) | null = null;
    const start = (): void => {
      if (unsubscribe) return;
      unsubscribe = subscribePreviewTick((elapsed) => {
        paint(Math.min((elapsed + phase) % cycle, duration));
      });
    };
    const stop = (): void => {
      unsubscribe?.();
      unsubscribe = null;
    };

    // Only draw what is on screen. Without this, scrolling a long library keeps
    // every card off-screen redrawing at 30fps forever.
    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) (e.isIntersecting ? start : stop)();
        },
        { rootMargin: '120px' },
      );
      observer.observe(canvas);
    } else {
      start(); // jsdom and very old browsers: correctness over frugality.
    }

    // Paint the resting frame immediately so a card is never blank while it
    // waits for its first tick.
    paint(duration * STILL_PHASE);

    return () => {
      observer?.disconnect();
      stop();
    };
  }, [preset, width, height, theme]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, display: 'block' }}
      aria-label={`${preset.name} preview`}
    />
  );
}

export default PresetPreview;
