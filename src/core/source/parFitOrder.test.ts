/**
 * PROBE: pixel aspect ratio must be applied BEFORE fit, not after.
 *
 * Auto-fit contains a source in the frame. PAR stretches a source
 * horizontally. Get the order wrong and the two fight: fit produces a box that
 * exactly fills the frame, PAR then widens it, and an anamorphic clip ends up
 * overflowing the very frame auto-fit just fitted it into — defeating the
 * feature for exactly the footage that needs it most.
 *
 * The contract this pins: everything downstream of `sourceOf` reasons in
 * SQUARE-pixel display size (`width` = stored × par), so fit is always the last
 * word. `storedWidth` keeps the raw number for anyone who needs it.
 */

import type { SceneNode } from '@core/types';

const assets: Array<Record<string, unknown>> = [];

jest.mock('@stores/assetStore', () => ({ useAssetStore: { getState: () => ({ assets }) } }));
jest.mock('@core/scene/sceneDerive', () => ({
  readNodeKind: (n: SceneNode) =>
    (n.components[0]?.props as Record<string, unknown> | undefined)?.__kind ?? 'shape',
}));
jest.mock('@core/scene/compInstance', () => ({ readCompRef: () => null }));

import { footageSourceOf } from './sourceInfo';
import { computeFit } from './fitCommands';

const HD = { width: 1920, height: 1080 };

function videoNode(): SceneNode {
  return {
    id: 'v', name: 'v', visible: true,
    components: [{ id: 'v_t', type: 'Transform', props: { __kind: 'video', assetId: 'a1' } }],
  } as unknown as SceneNode;
}

/** Anamorphic: 1920x1080 stored pixels that DISPLAY at 3840x1080 (PAR 2). */
function pushAnamorphic(par: number) {
  assets.length = 0;
  assets.push({
    id: 'a1', type: 'video', src: 'x',
    metadata: { width: 1920, height: 1080, duration: 5 },
    interpret: { par },
  });
}

beforeEach(() => { assets.length = 0; });

describe('PAR is applied before fit', () => {
  it('reports display size, not stored size, as the intrinsic width', () => {
    pushAnamorphic(2);
    const s = footageSourceOf(videoNode())!;
    expect(s).toMatchObject({ width: 3840, height: 1080, storedWidth: 1920, storedHeight: 1080 });
  });

  it('auto-fits an anamorphic source INSIDE the comp, not overflowing it', () => {
    pushAnamorphic(2);
    const s = footageSourceOf(videoNode())!;
    // This is the composition `insertMedia` performs on import.
    const fitted = computeFit({ width: s.width, height: s.height }, HD, 'contain');

    expect(fitted.width).toBeLessThanOrEqual(HD.width);
    expect(fitted.height).toBeLessThanOrEqual(HD.height);
    // 3840x1080 into 1920x1080 is width-bound: scale 0.5 → 1920x540.
    expect(fitted).toEqual({ width: 1920, height: 540 });
  });

  it('fitting the STORED size would overflow — the bug this guards', () => {
    pushAnamorphic(2);
    const s = footageSourceOf(videoNode())!;
    // Wrong order: fit the stored 1920x1080 (fits exactly), then apply PAR.
    const wrong = computeFit({ width: s.storedWidth, height: s.storedHeight }, HD, 'contain');
    expect(wrong.width * s.par).toBeGreaterThan(HD.width);
  });

  it('preserves the source display aspect through the fit', () => {
    pushAnamorphic(2);
    const s = footageSourceOf(videoNode())!;
    const fitted = computeFit({ width: s.width, height: s.height }, HD, 'contain');
    expect(fitted.width / fitted.height).toBeCloseTo(s.width / s.height, 3);
  });

  it('a sub-1 PAR (vertically stretched) also fits inside', () => {
    pushAnamorphic(0.5); // 1920x1080 stored → 960x1080 displayed
    const s = footageSourceOf(videoNode())!;
    expect(s.width).toBe(960);
    const fitted = computeFit({ width: s.width, height: s.height }, HD, 'contain');
    expect(fitted.width).toBeLessThanOrEqual(HD.width);
    expect(fitted.height).toBeLessThanOrEqual(HD.height);
    expect(fitted).toEqual({ width: 960, height: 1080 });
  });

  it('Set to Native Size returns the DISPLAY size, so the shape stays right', () => {
    pushAnamorphic(2);
    const s = footageSourceOf(videoNode())!;
    expect(computeFit({ width: s.width, height: s.height }, HD, 'native')).toEqual({ width: 3840, height: 1080 });
  });
});
