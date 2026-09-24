/**
 * Time Stretch dialog: the Stretch Factor and New Duration fields are linked
 * both ways, and OK applies the factor with the chosen Hold in Place point.
 */

import { render, screen, fireEvent } from '@testing-library/react';

const applyTimeStretch = jest.fn();

// B3z: OK sends `timeStretchLayers` through the timeline's edit helper.
jest.mock('@layout/Timeline/timelineEdits', () => ({
  timeStretchEdit: (...args: unknown[]) => applyTimeStretch(...args),
}));

// The document mirror (B4): a 30 fps composition; every layer one 60-frame bar
// at 100 %. 'solid' has no source — every other id stands in for footage.
jest.mock('@stores/documentMirror', () => {
  const F = 705_600_000;
  return {
    documentMirror: () => ({
      layer: (id: string) => ({
        id,
        comp: 'c',
        kind: id === 'solid' ? 'solid' : 'video',
        timing: { inPoint: 0, outPoint: 2 * F, startTime: 0, stretch: 1 },
      }),
      comp: () => ({ settings: { frameRate: { num: 30, den: 1 } } }),
    }),
  };
});
jest.mock('@core/scene/layerTime', () => ({
  getNodeLayerTime: () => ({ stretch: 100, reverse: false, freeze: false, freezeTime: 0, frameBlend: 'none' }),
}));
jest.mock('@core/animation/layerTimeCommands', () => {
  const clamp = (p: number): number => Math.max(1, Math.min(1000, Math.round(p)));
  return {
    clampStretch: clamp,
    clampSignedStretch: (p: number) => (p < 0 ? -clamp(-p) : clamp(p)),
    // A solid stretched earlier shows its stored value; footage its rate (100 here).
    stretchValueOf: (id: string) => (id === 'solid200' ? 200 : 100),
  };
});

import {
  TimeStretchDialog,
  baseDurationFrames,
  durationForStretch,
  stretchForDuration,
} from './TimeStretchDialog';

describe('Time Stretch linkage maths', () => {
  it('base duration undoes the current stretch', () => {
    expect(baseDurationFrames(120, 200)).toBe(60);
    expect(durationForStretch(60, 150)).toBe(90);
    expect(stretchForDuration(60, 30)).toBe(50);
    expect(stretchForDuration(0, 30)).toBe(100);
  });
});

describe('TimeStretchDialog', () => {
  beforeEach(() => applyTimeStretch.mockClear());

  it('typing a factor updates the duration; typing a duration updates the factor', () => {
    render(<TimeStretchDialog ids={['a']} close={() => {}} />);
    const factor = screen.getByLabelText('Stretch factor') as HTMLInputElement;
    const duration = screen.getByLabelText('New duration') as HTMLInputElement;

    fireEvent.change(factor, { target: { value: '200' } });
    expect(screen.getByText(/New Duration — 120 frames/)).toBeInTheDocument();

    fireEvent.change(duration, { target: { value: '30f' } });
    expect(factor.value).toBe('50');
  });

  it('OK applies the factor with the chosen Hold in Place point, then closes', () => {
    const close = jest.fn();
    render(<TimeStretchDialog ids={['a']} close={close} />);
    fireEvent.change(screen.getByLabelText('Stretch factor'), { target: { value: '150' } });
    fireEvent.click(screen.getByLabelText(/Layer Out-point/));
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(applyTimeStretch).toHaveBeenCalledWith(['a'], 150, 'out');
    expect(close).toHaveBeenCalled();
  });

  it('a layer with no source takes a negative factor (a reverse, same length); footage does not', () => {
    const { unmount } = render(<TimeStretchDialog ids={['solid']} close={() => {}} />);
    fireEvent.change(screen.getByLabelText('Stretch factor'), { target: { value: '-100' } });
    expect(screen.getByText(/New Duration — 60 frames/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(applyTimeStretch).toHaveBeenCalledWith(['solid'], -100, expect.any(String));
    unmount();

    applyTimeStretch.mockClear();
    render(<TimeStretchDialog ids={['a']} close={() => {}} />);
    fireEvent.change(screen.getByLabelText('Stretch factor'), { target: { value: '-100' } });
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled();
  });

  it('opens on the layer’s stored absolute stretch, not 100 %', () => {
    render(<TimeStretchDialog ids={['solid200']} close={() => {}} />);
    expect((screen.getByLabelText('Stretch factor') as HTMLInputElement).value).toBe('200');
    // The 60-frame bar at 200 % is 30 frames at 100 %; typing 100 halves it.
    fireEvent.change(screen.getByLabelText('Stretch factor'), { target: { value: '100' } });
    expect(screen.getByText(/New Duration — 30 frames/)).toBeInTheDocument();
  });
});
