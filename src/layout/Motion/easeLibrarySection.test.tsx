/**
 * The ease library section: thumbnails that cannot lie, and a click that writes.
 *
 * Two things are worth pinning here and nothing else is:
 *
 *  1. The thumbnail is SAMPLED from the curve it applies. A hand-drawn preview
 *     would drift from the curve silently, and the user would be picking a
 *     picture rather than a curve — so the path is checked against
 *     `cubicBezierEase` directly, not against a stored string.
 *  2. A click reaches the keyframe through the shared apply path. Rendering 24
 *     buttons that do nothing is the failure mode a snapshot test would miss.
 */

import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { cubicBezierEase, defaultAnimation, makeKeyframeId } from '@motion/animation';
import { EaseLibrarySection } from './EaseLibrarySection';
import { easeCurvePath, easeCurveGuides, EASE_THUMB } from './easeCurvePath';
import { EASE_PRESETS, easePresetById } from '@core/animation/easePresets';
import { useCustomEaseStore } from '@stores/customEaseStore';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';

afterEach(() => {
  cleanup();
  // The saved-curve library is persistent by design, so a test that saves one
  // would otherwise add a chip to every later test's grid.
  useCustomEaseStore.setState({ curves: [] });
  globalThis.localStorage?.clear();
});

describe('easeCurvePath', () => {
  it('starts at the bottom-left and ends at the top-right of the padded box', () => {
    const { pad, width, height } = EASE_THUMB;
    const d = easeCurvePath([0.33, 0, 0.67, 1]);
    const pts = d.split(' ').map((s) => s.slice(1).split(',').map(Number) as [number, number]);
    expect(pts[0]![0]).toBeCloseTo(pad, 1);
    expect(pts[0]![1]).toBeCloseTo(height - pad, 1);
    expect(pts[pts.length - 1]![0]).toBeCloseTo(width - pad, 1);
    expect(pts[pts.length - 1]![1]).toBeCloseTo(pad, 1);
  });

  it('traces the same curve the interpolator will run', () => {
    // The whole point of sampling rather than hand-drawing: every plotted point
    // has to agree with cubicBezierEase, so a corrected control point moves the
    // thumbnail too.
    const bezier = easePresetById('expo-out')!.bezier;
    const { pad, height, samples } = EASE_THUMB;
    const spanY = height - pad * 2;
    const pts = easeCurvePath(bezier).split(' ').map((s) => s.slice(1).split(',').map(Number) as [number, number]);
    for (let i = 0; i <= samples; i++) {
      const expectedY = pad + (1 - cubicBezierEase(bezier, i / samples)) * spanY;
      expect(pts[i]![1]).toBeCloseTo(expectedY, 1);
    }
  });

  it('lets an overshoot leave the guide band instead of clamping it', () => {
    // A Back curve clamped to the box would look identical to a plain ease —
    // the one property that makes the family worth picking would be invisible.
    const guides = easeCurveGuides();
    const ys = easeCurvePath(easePresetById('back-out')!.bezier)
      .split(' ')
      .map((s) => Number(s.split(',')[1]));
    expect(Math.min(...ys)).toBeLessThan(guides.y1); // above the "1" line (y down)
  });
});

describe('EaseLibrarySection', () => {
  // Applying writes through the engine API (B3): a real layer with Opacity
  // keys at 0 s and 1 s, built through the engine; a click is awaited.
  let h: Harness & { engine: LocalEngine };
  let L = '';
  const OP = 'opacity';
  beforeEach(async () => {
    h = await setupAppEngine();
    L = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'L', init: [] })).layer;
    await h.run({
      type: 'addKeyframes',
      keys: [0, 1].map((sec) => ({
        prop: { layer: L, path: 'transform/opacity' }, time: sec * 705_600_000,
        value: { kind: 'scalar' as const, value: sec * 100 }, easing: 'linear' as const, spatialIn: [], spatialOut: [],
      })),
    });
  });
  afterEach(async () => {
    await h.dispose();
  });
  const idle = async (): Promise<void> => {
    await act(async () => { await engineIdle(); await engineIdle(); });
  };
  const keyAt = (t: number) => defaultAnimation.getTrackKeyframes(L, OP)!.find((k) => Math.abs(k.t - t) < 1e-9)!;
  const renderSection = (bezier?: [number, number, number, number]) =>
    render(<EaseLibrarySection keyframeIds={[makeKeyframeId(L, OP, 0)]} bezier={bezier} />);

  it('offers every curve in the library', () => {
    renderSection();
    for (const p of EASE_PRESETS) {
      expect(screen.getByRole('button', { name: p.label })).toBeTruthy();
    }
  });

  it('applying a curve writes its handles onto the keyframe — one undo entry', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Expo Out' }));
    await idle();
    const kf = keyAt(0);
    expect(kf.easing).toBe('bezier');
    expect(kf.bezier).toEqual(easePresetById('expo-out')!.bezier);
    expect(historyLabels().at(-1)).toBe('Set keyframe easing: expo-out');
    await h.run({ type: 'undo' });
    expect(keyAt(0).easing ?? 'linear').toBe('linear');
    await h.run({ type: 'redo' });
    expect(keyAt(0).bezier).toEqual(easePresetById('expo-out')!.bezier);
  });

  it('marks the curve the keyframe is already on, and only that one', () => {
    renderSection(easePresetById('quint-in')!.bezier);
    expect(screen.getByRole('button', { name: 'Quint In' })).toHaveAttribute('aria-pressed', 'true');
    const pressed = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
  });

  it('marks nothing when the keyframe carries no bezier', () => {
    renderSection(undefined);
    expect(
      screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true'),
    ).toHaveLength(0);
  });

  it('applies to EVERY selected keyframe, not just the focused one', async () => {
    // The reason this takes ids instead of one (node, prop, t): the graph
    // editor's selection spans keyframes, and "ease these eight" is the whole
    // point of having a library.
    render(
      <EaseLibrarySection
        keyframeIds={[makeKeyframeId(L, OP, 0), makeKeyframeId(L, OP, 1)]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Quart In' }));
    await idle();
    for (const t of [0, 1]) {
      expect(keyAt(t).bezier).toEqual(easePresetById('quart-in')!.bezier);
    }
  });

  it('saves the focused keyframe’s curve as a named entry that then applies', async () => {
    const custom: [number, number, number, number] = [0.9, 0.02, 0.1, 0.98];
    const { unmount } = renderSection(custom);
    fireEvent.change(screen.getByLabelText('New ease curve name'), { target: { value: 'Snap' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(useCustomEaseStore.getState().curves.map((c) => c.label)).toContain('Snap');
    unmount();

    // A saved curve is a chip like any other, and applies to the selection.
    // (Custom curves go through the ease clipboard store's raw-handles write.)
    const before = historyLabels().length;
    render(<EaseLibrarySection keyframeIds={[makeKeyframeId(L, OP, 0)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Snap' }));
    await idle();
    expect(keyAt(0).bezier).toEqual(custom);
    expect(keyAt(0).easing).toBe('bezier');
    // One undo entry, and undo takes the curve back off.
    expect(historyLabels()).toHaveLength(before + 1);
    expect(historyLabels().at(-1)).toBe('Apply Custom Easing Curve');
    await h.run({ type: 'undo' });
    expect(keyAt(0).bezier).toBeUndefined();
  });

  it('says where Elastic and Bounce actually live', () => {
    // They are absent by design (no single cubic can trace them). An empty
    // absence reads as an oversight; this is the pointer that stops someone
    // "fixing" it by adding a lookalike bezier.
    renderSection();
    expect(screen.getByText(/Elastic and Bounce are generators/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Elastic/i })).toBeNull();
  });
});
