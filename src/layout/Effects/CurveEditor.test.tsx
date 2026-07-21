/**
 * CurveEditor — the tone-curve control for the Curves effect.
 *
 * The point-manipulation logic (add / remove / drag, endpoint pinning) that
 * produces the curve points lives in pure helpers, tested directly here; the
 * LUT math those points feed is in colorLut.test. A render smoke test confirms
 * the component mounts and draws a handle per point.
 */

import { render } from '@testing-library/react';
import { CurveEditor, addPoint, removePoint, movePoint, sortPoints } from './CurveEditor';

const RAMP: [number, number][] = [[0, 0], [255, 255]];

describe('point helpers', () => {
  describe('sortPoints', () => {
    it('sorts by input X', () => {
      expect(sortPoints([[255, 255], [128, 60], [0, 0]])).toEqual([[0, 0], [128, 60], [255, 255]]);
    });
    it('falls back to a straight ramp for < 2 points', () => {
      expect(sortPoints([[128, 128]])).toEqual(RAMP);
    });
  });

  describe('addPoint', () => {
    it('inserts a point in sorted order', () => {
      expect(addPoint(RAMP, 128, 200)).toEqual([[0, 0], [128, 200], [255, 255]]);
    });
    it('clamps the X into the interior (never on an endpoint)', () => {
      expect(addPoint(RAMP, 0, 128)[1]![0]).toBe(1);
      expect(addPoint(RAMP, 255, 128).find((p) => p[0] > 0 && p[0] < 255)![0]).toBe(254);
    });
    it('clamps Y to 0..255', () => {
      expect(addPoint(RAMP, 100, 999)[1]![1]).toBe(255);
      expect(addPoint(RAMP, 100, -50)[1]![1]).toBe(0);
    });
  });

  describe('removePoint', () => {
    it('removes an interior point', () => {
      expect(removePoint([[0, 0], [128, 128], [255, 255]], 1)).toEqual(RAMP);
    });
    it('never removes an endpoint', () => {
      expect(removePoint(RAMP, 0)).toEqual(RAMP);
      expect(removePoint(RAMP, 1)).toEqual(RAMP);
    });
  });

  describe('movePoint', () => {
    it('moves an interior point in X and Y', () => {
      expect(movePoint([[0, 0], [128, 128], [255, 255]], 1, 160, 60)).toEqual([[0, 0], [160, 60], [255, 255]]);
    });
    it('pins an endpoint X and moves only its Y', () => {
      expect(movePoint(RAMP, 0, 100, 128)).toEqual([[0, 128], [255, 255]]);
      expect(movePoint(RAMP, 1, 100, 128)).toEqual([[0, 0], [255, 128]]);
    });
    it('keeps an interior point between its neighbours in X', () => {
      const pts: [number, number][] = [[0, 0], [100, 100], [150, 150], [255, 255]];
      // Try to drag the middle point past its right neighbour.
      const moved = movePoint(pts, 1, 200, 100);
      expect(moved[1]![0]).toBe(149); // clamped to right neighbour − 1
    });
  });
});

describe('render', () => {
  it('draws one handle per control point plus the curve path', () => {
    const { container } = render(<CurveEditor value={[[0, 0], [128, 200], [255, 255]]} onChange={() => {}} />);
    expect(container.querySelectorAll('circle')).toHaveLength(3);
    expect(container.querySelector('path')).not.toBeNull();
  });

  it('falls back to a straight ramp when given too few points', () => {
    const { container } = render(<CurveEditor value={[]} onChange={() => {}} />);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
  });
});
