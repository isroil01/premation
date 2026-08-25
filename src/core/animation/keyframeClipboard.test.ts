/**
 * Timeline Ctrl+C/V must preserve spatial path tangents — the Edit-menu
 * clipboard already did; keyframeClipboard was dropping si/so so pasted paths
 * came back as polylines.
 */

import { defaultAnimation, makeKeyframeId } from '@motion/animation';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import {
  clearClipboard,
  copyKeyframes,
  pasteKeyframes,
  hasClipboard,
} from './keyframeClipboard';

describe('keyframeClipboard spatial fidelity', () => {
  beforeEach(() => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    clearClipboard();
    for (const id of ['src', 'dst']) {
      defaultAnimation.removeTrack(id, 'x');
      defaultAnimation.removeTrack(id, 'y');
    }
  });

  it('round-trips si/so and continuous across copy/paste', () => {
    defaultAnimation.setKeyframe('src', 'x', 0, 0);
    defaultAnimation.setKeyframe('src', 'y', 0, 0);
    defaultAnimation.setKeyframe('src', 'x', 1, 100);
    defaultAnimation.setKeyframe('src', 'y', 1, 50);
    defaultAnimation.setSpatialTangent('src', 'x', 0, { so: 40 });
    defaultAnimation.setSpatialTangent('src', 'y', 0, { so: 20 });
    defaultAnimation.setSpatialTangent('src', 'x', 1, { si: -30 });
    defaultAnimation.setSpatialTangent('src', 'y', 1, { si: -10 });
    defaultAnimation.updateKeyframe('src', 'x', 1, { continuous: false });
    defaultAnimation.updateKeyframe('src', 'y', 1, { continuous: false });

    const ids = new Set([
      makeKeyframeId('src', 'x', 0),
      makeKeyframeId('src', 'y', 0),
      makeKeyframeId('src', 'x', 1),
      makeKeyframeId('src', 'y', 1),
    ]);
    copyKeyframes(ids);
    expect(hasClipboard()).toBe(true);

    pasteKeyframes(['dst'], 2);

    const x0 = defaultAnimation.getTrackKeyframes('dst', 'x')!.find((k) => Math.abs(k.t - 2) < 1e-6)!;
    const y0 = defaultAnimation.getTrackKeyframes('dst', 'y')!.find((k) => Math.abs(k.t - 2) < 1e-6)!;
    const x1 = defaultAnimation.getTrackKeyframes('dst', 'x')!.find((k) => Math.abs(k.t - 3) < 1e-6)!;
    const y1 = defaultAnimation.getTrackKeyframes('dst', 'y')!.find((k) => Math.abs(k.t - 3) < 1e-6)!;

    expect(x0.so).toBe(40);
    expect(y0.so).toBe(20);
    expect(x1.si).toBe(-30);
    expect(y1.si).toBe(-10);
    expect(x1.continuous).toBe(false);
    expect(y1.continuous).toBe(false);
    expect(x0.value).toBe(0);
    expect(x1.value).toBe(100);
  });
});
