/**
 * The source boundary: footage and compositions answer the same questions.
 *
 * The point of this abstraction is that "what size is it, how long is it, at
 * what rate" has ONE answer shape whether the layer shows a 4K clip or a
 * vertical composition. Where these used to be separate paths, footage got
 * intrinsic size and comps did not, or vice versa.
 */

import type { SceneNode } from '@core/types';

const assets: Array<Record<string, unknown>> = [];

jest.mock('@stores/assetStore', () => ({
  useAssetStore: { getState: () => ({ assets }) },
}));
jest.mock('@core/scene/sceneDerive', () => ({
  readNodeKind: (n: SceneNode) =>
    (n.components[0]?.props as Record<string, unknown> | undefined)?.__kind ?? 'shape',
}));
jest.mock('@core/scene/compInstance', () => ({
  readCompRef: (n: SceneNode) =>
    ((n.components[0]?.props as Record<string, unknown> | undefined)?.__compRef as string) ?? null,
}));

import { sourceOf, footageSourceOf, applyLoop, interpretationOf } from './sourceInfo';

function node(kind: string, props: Record<string, unknown> = {}): SceneNode {
  return {
    id: 'n1', name: 'n', visible: true,
    components: [{ id: 'n1_t', type: 'Transform', props: { __kind: kind, ...props } }],
  } as unknown as SceneNode;
}

const COMPS: Record<string, { width: number; height: number; fps: number; durationSeconds: number }> = {
  vertical: { width: 1080, height: 1920, fps: 24, durationSeconds: 8 },
};
const compLookup = (id: string) => COMPS[id];

beforeEach(() => {
  assets.length = 0;
});

describe('footage sources', () => {
  it('reports intrinsic size, duration and probed rate', () => {
    assets.push({ id: 'a1', type: 'video', src: 'x', metadata: { width: 3840, height: 2160, duration: 12, fps: 24 } });
    expect(footageSourceOf(node('video', { assetId: 'a1' }))).toMatchObject({
      kind: 'footage', width: 3840, height: 2160, durationSec: 12, fps: 24,
    });
  });

  it('leaves fps null when nothing probed it — never substitutes the comp rate', () => {
    assets.push({ id: 'a1', type: 'video', src: 'x', metadata: { width: 1920, height: 1080, duration: 5 } });
    expect(footageSourceOf(node('video', { assetId: 'a1' }))?.fps).toBeNull();
  });

  it('conform overrides the probed rate', () => {
    assets.push({ id: 'a1', type: 'video', src: 'x', metadata: { width: 1920, height: 1080, duration: 5, fps: 30 }, interpret: { conformFps: 24 } });
    expect(footageSourceOf(node('video', { assetId: 'a1' }))?.fps).toBe(24);
  });

  it('applies pixel aspect ratio to width only', () => {
    // DV PAL: 720x576 stored, 1.42 PAR → ~1024x576 displayed.
    assets.push({ id: 'a1', type: 'video', src: 'x', metadata: { width: 720, height: 576, duration: 5 }, interpret: { par: 1.4222 } });
    const s = footageSourceOf(node('video', { assetId: 'a1' }))!;
    expect(s).toMatchObject({ width: 1024, height: 576, storedWidth: 720, storedHeight: 576, par: 1.4222 });
  });

  it('defaults to square pixels and a single play', () => {
    assets.push({ id: 'a1', type: 'video', src: 'x', metadata: { width: 100, height: 100 } });
    expect(footageSourceOf(node('video', { assetId: 'a1' }))).toMatchObject({ loopCount: 1, par: 1 });
  });

  it('is null for a layer with no asset', () => {
    expect(footageSourceOf(node('video'))).toBeNull();
  });
});

describe('composition sources — the same questions, answered', () => {
  it('reports its own size, rate and duration', () => {
    const s = sourceOf(node('comp', { __compRef: 'vertical' }), compLookup);
    expect(s).toMatchObject({ kind: 'comp', width: 1080, height: 1920, fps: 24, durationSec: 8 });
  });

  it('returns null rather than guessing when no comp lookup is supplied', () => {
    // A caller with no project store must not silently report the host's size.
    expect(sourceOf(node('comp', { __compRef: 'vertical' }))).toBeNull();
  });

  it('is null for a generative layer', () => {
    expect(sourceOf(node('shape'), compLookup)).toBeNull();
  });
});

describe('interpretationOf', () => {
  it('fills defaults for an un-interpreted file', () => {
    assets.push({ id: 'a1', type: 'video', src: 'x' });
    expect(interpretationOf('a1')).toMatchObject({ par: 1, loopCount: 1 });
  });
});

describe('applyLoop', () => {
  it('passes through inside the first play', () => {
    expect(applyLoop(3, 10, 1)).toBe(3);
  });

  it('does not wrap when loopCount is 1 — the clip just runs out', () => {
    expect(applyLoop(14, 10, 1)).toBe(14);
  });

  it('wraps within the loop count', () => {
    expect(applyLoop(14, 10, 3)).toBeCloseTo(4);
    expect(applyLoop(25, 10, 3)).toBeCloseTo(5);
  });

  it('holds the last frame once the count is exhausted', () => {
    // 3 plays of 10s = 30s; past that it holds rather than snapping to black.
    expect(applyLoop(35, 10, 3)).toBeCloseTo(10, 3);
  });

  it('loops forever on 0', () => {
    expect(applyLoop(105, 10, 0)).toBeCloseTo(5);
  });

  it('is a no-op without a known duration', () => {
    expect(applyLoop(7, null, 0)).toBe(7);
  });
});
