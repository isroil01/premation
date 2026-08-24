/**
 * Footage bakes at the size it is shown at — never above native.
 */
import { bakeSize } from './AppTextureProvider';

it('bakes at native when no target scale is given (the export path)', () => {
  expect(bakeSize(1920, 1080, { width: 1920, height: 1080 })).toEqual({ w: 1920, h: 1080 });
});

it('follows the displayed size: a 1080p clip in a half-scale view bakes at 960×540', () => {
  expect(bakeSize(1920, 1080, { width: 1920, height: 1080, targetScale: 0.5 })).toEqual({ w: 960, h: 540 });
  expect(bakeSize(1920, 1080, { width: 1920, height: 1080, targetScale: 0.25 })).toEqual({ w: 480, h: 270 });
});

it('never upsamples beyond the source, and keeps the source aspect', () => {
  expect(bakeSize(1920, 1080, { width: 1920, height: 1080, targetScale: 3 })).toEqual({ w: 1920, h: 1080 });
  // A 4K clip in a 1920-wide layer box at 1:1 → bakes at the box size, source aspect.
  expect(bakeSize(3840, 2160, { width: 1920, height: 1080, targetScale: 1 })).toEqual({ w: 1920, h: 1080 });
});

it('treats a bad scale as native', () => {
  expect(bakeSize(1920, 1080, { width: 1920, height: 1080, targetScale: 0 })).toEqual({ w: 1920, h: 1080 });
  expect(bakeSize(1920, 1080, { width: 1920, height: 1080, targetScale: NaN })).toEqual({ w: 1920, h: 1080 });
});
