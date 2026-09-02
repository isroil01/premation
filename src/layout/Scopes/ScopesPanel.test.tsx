/**
 * Scopes panel — the parts that survive jsdom.
 *
 * jsdom has no 2D context, so `drawScope` never runs here and no assertion
 * pretends it does. What IS worth pinning is everything that decides WHETHER
 * it runs and WHAT it would be handed: the plot selection, the empty-frame
 * fallback, and the status line — which is the panel's only honest channel for
 * "this reading does not cover the whole frame", and therefore the one piece
 * of UI here that can actively mislead if it goes wrong.
 */

import { render, screen } from '@testing-library/react';
import { accumulateFor, ScopesPanel, statusText } from './ScopesPanel';
import { compRectInCanvas } from './scopeFrame';
import { SCOPE_BINS } from '@core/video/scopes';
import { frameTapActive } from '@core/rendering/frameTap';

describe('accumulateFor', () => {
  const frame = {
    data: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255]),
    width: 2,
    height: 1,
    source: 'cache' as const,
    partial: false,
    frame: 0,
  };

  it('builds the accumulator each plot asks for', () => {
    expect(accumulateFor('waveform', frame, 'luma').kind).toBe('waveform');
    expect(accumulateFor('parade', frame, 'luma').kind).toBe('parade');
    expect(accumulateFor('vectorscope', frame, 'luma').kind).toBe('vectorscope');
    expect(accumulateFor('histogram', frame, 'luma').kind).toBe('histogram');
  });

  it('honours the waveform channel mode', () => {
    const luma = accumulateFor('waveform', frame, 'luma');
    const rgb = accumulateFor('waveform', frame, 'rgb');
    expect(luma.kind === 'waveform' && luma.channels).toBe(1);
    expect(rgb.kind === 'waveform' && rgb.channels).toBe(3);
  });

  it('returns an EMPTY accumulator rather than nothing when there is no frame', () => {
    // The plot still paints its graticule from this — "no signal", not blank.
    const a = accumulateFor('waveform', null, 'luma');
    expect(a.kind === 'waveform' && a.total).toBe(0);
    expect(a.kind === 'waveform' && a.height).toBe(SCOPE_BINS);
    const h = accumulateFor('histogram', null, 'luma');
    expect(h.kind === 'histogram' && h.total).toBe(0);
  });

  it('ignores transparent letterbox around the comp crop', () => {
    // Two opaque pixels and two fully transparent ones: only the picture counts.
    const withLetterbox = {
      ...frame,
      data: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]),
      width: 4,
      height: 1,
    };
    const a = accumulateFor('histogram', withLetterbox, 'luma');
    expect(a.kind === 'histogram' && a.total).toBe(2);
  });
});

describe('statusText', () => {
  it('says when a reading covers less than the whole frame', () => {
    // The failure this guards: a scope that silently reports on the visible
    // half of a panned-off comp looks exactly like a correct reading.
    expect(statusText({ source: 'cache', partial: true, miss: null })).toEqual({
      text: 'Partial — comp is cropped by the viewport',
      warn: true,
    });
    expect(statusText({ source: null, partial: false, miss: 'off-screen' })).toEqual({
      text: 'Composition is off screen',
      warn: true,
    });
  });

  it('names the source of a whole-frame reading', () => {
    expect(statusText({ source: 'tap', partial: false, miss: null })).toEqual({
      text: 'Live',
      warn: false,
    });
    expect(statusText({ source: 'cache', partial: false, miss: null })).toEqual({
      text: 'From preview cache',
      warn: false,
    });
    expect(statusText({ source: null, partial: false, miss: 'no-frame' }).warn).toBe(false);
  });
});

describe('compRectInCanvas', () => {
  it('folds dpr and preview resolution into one scale factor', () => {
    // 1600 CSS px of viewport rendered into a 3200px buffer (dpr 2), comp at
    // 50% zoom with its origin 100 CSS px in.
    const rect = compRectInCanvas(3200, 1800, 1600, { scale: 0.5, offsetX: 100, offsetY: 50 }, { width: 1920, height: 1080 });
    expect(rect).toEqual({ x: 200, y: 100, width: 1920, height: 1080, whole: true });
  });

  it('clamps to the canvas and flags a cropped comp', () => {
    const rect = compRectInCanvas(800, 600, 800, { scale: 1, offsetX: -100, offsetY: 0 }, { width: 1920, height: 1080 });
    expect(rect?.x).toBe(0);
    expect(rect?.width).toBe(800);
    expect(rect?.whole).toBe(false);
  });

  it('returns null when the comp is entirely off screen', () => {
    expect(compRectInCanvas(800, 600, 800, { scale: 1, offsetX: 900, offsetY: 0 }, { width: 100, height: 100 })).toBeNull();
    expect(compRectInCanvas(800, 600, 800, { scale: 1, offsetX: 0, offsetY: -2000 }, { width: 100, height: 100 })).toBeNull();
  });

  it('refuses degenerate inputs instead of dividing by zero', () => {
    const view = { scale: 1, offsetX: 0, offsetY: 0 };
    const comp = { width: 100, height: 100 };
    expect(compRectInCanvas(0, 600, 800, view, comp)).toBeNull();
    expect(compRectInCanvas(800, 600, 0, view, comp)).toBeNull();
    expect(compRectInCanvas(800, 600, 800, { ...view, scale: 0 }, comp)).toBeNull();
    expect(compRectInCanvas(800, 600, 800, view, { width: 0, height: 100 })).toBeNull();
  });
});

describe('ScopesPanel', () => {
  it('offers the four scopes and a combined view', () => {
    render(<ScopesPanel />);
    for (const label of ['Waveform', 'Parade', 'Vector', 'Histogram', 'All']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('starts on the waveform with its channel toggle', () => {
    render(<ScopesPanel />);
    expect(screen.getByRole('button', { name: 'Waveform' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Luma' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'RGB' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('arms nothing while it measures zero', () => {
    // jsdom reports every element as 0×0, which is exactly the shape of a
    // panel sitting behind another dock tab. The frame tap must stay disarmed:
    // an armed tap makes the viewport's render loop copy and read back pixels
    // ten times a second for a panel nobody can see.
    expect(frameTapActive()).toBe(false);
    render(<ScopesPanel />);
    expect(frameTapActive()).toBe(false);
    expect(screen.getByText('Waiting for a rendered frame')).toBeInTheDocument();
  });
});
