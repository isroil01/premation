/**
 * Force Motion Blur — the override, and what it deliberately does NOT override.
 *
 * Motion blur needs three things: the comp switch, the layer switch, and actual
 * movement. This effect exists to override the first two. Overriding the third
 * as well is the tempting mistake: it would make the effect "work" on a static
 * layer in the sense that it runs, while producing an identical image at N
 * times the cost — a control that does nothing but make the frame slower.
 */

import { readForceMotionBlur } from './forceMotionBlur';
import type { Effect } from './effects';

const fx = (params: Record<string, number>, enabled = true): Effect =>
  ({ id: 'fx_fmb', type: 'force-motion-blur', enabled, params }) as Effect;

describe('readForceMotionBlur', () => {
  it('is null when the effect is absent, so the comp settings still decide', () => {
    expect(readForceMotionBlur([])).toBeNull();
    expect(readForceMotionBlur([{ id: 'a', type: 'blur', params: {} } as Effect])).toBeNull();
  });

  it('is null when disabled — switching it off must restore the comp behaviour', () => {
    expect(readForceMotionBlur([fx({ shutterAngle: 180, samples: 8 }, false)])).toBeNull();
  });

  it('reads the shutter and sample count', () => {
    expect(readForceMotionBlur([fx({ shutterAngle: 360, samples: 16 })]))
      .toEqual({ shutterAngle: 360, samples: 16 });
  });

  it('falls back to registry defaults for omitted params', () => {
    expect(readForceMotionBlur([fx({})])).toEqual({ shutterAngle: 180, samples: 12 });
  });

  it('is null at a zero-degree shutter, not a run of identical samples', () => {
    // A shutter open for no time is no blur. Sampling it would draw N copies of
    // one instant — the cost of blur with none of the picture.
    expect(readForceMotionBlur([fx({ shutterAngle: 0, samples: 12 })])).toBeNull();
  });

  it('clamps to the same ranges the composition’s own motion blur accepts', () => {
    // A forced layer must not be able to ask the sampler for something the comp
    // could never request.
    expect(readForceMotionBlur([fx({ shutterAngle: 5000, samples: 999 })]))
      .toEqual({ shutterAngle: 720, samples: 32 });
    expect(readForceMotionBlur([fx({ shutterAngle: 90, samples: 1 })])!.samples).toBe(2);
  });

  it('rounds the sample count — it indexes sub-frame times', () => {
    expect(readForceMotionBlur([fx({ shutterAngle: 180, samples: 8.7 })])!.samples).toBe(9);
  });
});
