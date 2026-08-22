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

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { cubicBezierEase, defaultAnimation } from '@motion/animation';
import { EaseLibrarySection } from './EaseLibrarySection';
import { easeCurvePath, easeCurveGuides, EASE_THUMB } from './easeCurvePath';
import { EASE_PRESETS, easePresetById } from '@core/animation/easePresets';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';

const NODE = 'ease-layer';
const PROP = 'transform.x';

// Applying goes through `runAnimEdit`, so it needs the command system — which is
// the point: a click here lands as a real undo step, not a raw track write.
beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

beforeEach(() => {
  defaultAnimation.clear();
  defaultAnimation.setKeyframe(NODE, PROP, 0, 0, 'linear');
  defaultAnimation.setKeyframe(NODE, PROP, 1, 100, 'linear');
});

afterEach(() => {
  cleanup();
  defaultAnimation.clear();
});

const kfAt0 = () => defaultAnimation.getTrackKeyframes(NODE, PROP)!.find((k) => k.t === 0)!;

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
  const renderSection = (bezier?: [number, number, number, number]) =>
    render(<EaseLibrarySection nodeId={NODE} prop={PROP} t={0} bezier={bezier} />);

  it('offers every curve in the library', () => {
    renderSection();
    for (const p of EASE_PRESETS) {
      expect(screen.getByRole('button', { name: p.label })).toBeTruthy();
    }
  });

  it('applying a curve writes its handles onto the keyframe', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Expo Out' }));
    const kf = kfAt0();
    expect(kf.easing).toBe('bezier');
    expect(kf.bezier).toEqual(easePresetById('expo-out')!.bezier);
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

  it('says where Elastic and Bounce actually live', () => {
    // They are absent by design (no single cubic can trace them). An empty
    // absence reads as an oversight; this is the pointer that stops someone
    // "fixing" it by adding a lookalike bezier.
    renderSection();
    expect(screen.getByText(/Elastic and Bounce are generators/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Elastic/i })).toBeNull();
  });
});
