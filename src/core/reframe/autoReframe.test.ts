/**
 * Auto-reframe end to end, minus the GPU.
 *
 * The analysis pass is a real render, so the renderer is stubbed and fed
 * synthetic frames — a bright block that walks left to right, then jumps back
 * on a cut. Everything after that is the real thing: the real saliency, the
 * real path builder, the real composition ops, the real scene graph and the
 * real animation engine.
 *
 * That split is deliberate. `saliency.test.ts` and `reframePath.test.ts` own
 * the maths; what is only checkable HERE is the wiring, which is where this
 * feature could plausibly be wrong while every unit passes: a new comp at the
 * wrong size, an instance at the wrong scale, keyframes on the wrong node or on
 * the wrong time axis, or a source composition quietly modified.
 */

const frames: Uint8ClampedArray[] = [];
let analysisWidth = 0;
let analysisHeight = 0;
/**
 * Which frame the stubbed reader hands back next.
 *
 * A cursor rather than `frames.shift()`: shifting mutates the array the render
 * loop is iterating, so the loop stopped at half the frames and the pixels no
 * longer matched the index they were rendered for. The symptom was a pan that
 * never moved — which is exactly what a broken auto-reframe looks like, and is
 * why this stub is worth being careful about.
 */
let cursor = 0;

jest.mock('@core/export/offlineRenderer', () => ({
  renderOffline: async (
    params: { width: number; height: number },
    onFrame: (canvas: unknown, frame: number, total: number) => void,
  ) => {
    if (params.width !== AW || params.height !== AH) {
      throw new Error(
        `the stub's frames are ${AW}×${AH} but the analyser asked for ${params.width}×${params.height}`,
      );
    }
    analysisWidth = params.width;
    analysisHeight = params.height;
    cursor = 0;
    const total = frames.length;
    for (let i = 0; i < total; i++) await onFrame({}, i, total);
    return total;
  },
}));

jest.mock('@core/export/videoSink', () => ({
  readCanvasPixels: () => {
    const data = frames[cursor++];
    return data ? { data, width: analysisWidth, height: analysisHeight } : null;
  },
}));

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useProjectStore } from '@stores/projectStore';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import { autoReframeComposition, targetSizeFor } from './autoReframe';

const SOURCE_ID = 'comp_source';
/**
 * The analysis size the module asks for: its own 160-px width, and the height
 * that keeps the 1920×1080 source's aspect.
 *
 * Synthetic frames must be exactly this, because the analyser reads pixels at
 * the size it RENDERED at, not at whatever size the stub hands back. Frames of
 * the wrong size read mostly zeros, and the symptom is a pan that never moves —
 * indistinguishable from the feature being broken. The stub asserts the match
 * rather than trusting this comment.
 */
const AW = 160;
const AH = 90;

/** A frame with a bright block at normalised x, over a given background. */
function blockAt(x: number, background = 40): Uint8ClampedArray {
  const px = new Uint8ClampedArray(AW * AH * 4);
  for (let i = 0; i < AW * AH; i++) {
    px[i * 4] = background;
    px[i * 4 + 1] = background;
    px[i * 4 + 2] = background;
    px[i * 4 + 3] = 255;
  }
  const cx = Math.round(x * (AW - 1));
  for (let y = Math.round(AH * 0.35); y < Math.round(AH * 0.65); y++) {
    for (let dx = -8; dx <= 8; dx++) {
      const px_ = Math.max(0, Math.min(AW - 1, cx + dx));
      const i = (y * AW + px_) * 4;
      px[i] = 230;
      px[i + 1] = 230;
      px[i + 2] = 230;
    }
  }
  return px;
}

function seedSource(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);

  const root: SceneNode = {
    id: SOURCE_ID,
    name: 'Master',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: `${SOURCE_ID}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  };
  defaultSceneGraph.addNode(root);

  const actions = useProjectStore.getState().actions;
  actions.updateComp(SOURCE_ID, {
    id: SOURCE_ID,
    name: 'Master',
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 2,
    background: '#000000',
    transparent: false,
    startFrame: 0,
  });
  actions.openTab(SOURCE_ID, [SOURCE_ID], 'Master');
  getTimelineController().syncFromScene(SOURCE_ID);
}

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

beforeEach(() => {
  frames.length = 0;
  cursor = 0;
  seedSource();
});

/**
 * A subject walking right on a dark background, then a CUT to a different
 * shot: same subject on the left, over a much brighter background.
 *
 * The background change is what makes it a cut. Cut detection compares luma
 * DISTRIBUTIONS, so a block sliding across an unchanged frame is correctly not
 * a cut however far it travels — which is the right behaviour and was worth
 * discovering here rather than on someone's footage.
 */
function walkThenCut(): void {
  for (let i = 0; i < 12; i++) frames.push(blockAt(0.2 + (i / 11) * 0.6, 25));
  for (let i = 0; i < 12; i++) frames.push(blockAt(0.15, 190));
}

describe('targetSizeFor', () => {
  it('keeps the short edge, so retargeting never invents resolution', () => {
    expect(targetSizeFor({ width: 1920, height: 1080 }, 9 / 16)).toEqual({ width: 1080, height: 1920 });
  });

  it('makes a square from the short edge', () => {
    expect(targetSizeFor({ width: 1920, height: 1080 }, 1)).toEqual({ width: 1080, height: 1080 });
  });

  it('always produces even dimensions, which every encoder wants', () => {
    const size = targetSizeFor({ width: 1921, height: 1081 }, 4 / 5);
    expect(size.width % 2).toBe(0);
    expect(size.height % 2).toBe(0);
  });
});

describe('autoReframeComposition', () => {
  it('creates a NEW composition at the target size', async () => {
    walkThenCut();
    const result = await autoReframeComposition({
      sourceCompId: SOURCE_ID,
      target: { width: 1080, height: 1920 },
    });

    const created = useProjectStore.getState().comps[result.compId];
    expect(created?.width).toBe(1080);
    expect(created?.height).toBe(1920);
    expect(result.compId).not.toBe(SOURCE_ID);
  });

  it('leaves the source composition completely untouched', async () => {
    walkThenCut();
    const before = { ...(useProjectStore.getState().comps[SOURCE_ID] as object) };
    const childrenBefore = defaultSceneGraph.getChildren(SOURCE_ID).length;

    await autoReframeComposition({ sourceCompId: SOURCE_ID, target: { width: 1080, height: 1920 } });

    expect(useProjectStore.getState().comps[SOURCE_ID]).toEqual(before);
    expect(defaultSceneGraph.getChildren(SOURCE_ID)).toHaveLength(childrenBefore);
  });

  it('carries the source fps and duration onto the new composition', async () => {
    walkThenCut();
    const result = await autoReframeComposition({
      sourceCompId: SOURCE_ID,
      target: { width: 1080, height: 1920 },
    });
    const created = useProjectStore.getState().comps[result.compId];
    expect(created?.fps).toBe(30);
    expect(created?.durationSeconds).toBe(2);
  });

  it('places the source as an instance, scaled to COVER the new frame', async () => {
    walkThenCut();
    const result = await autoReframeComposition({
      sourceCompId: SOURCE_ID,
      target: { width: 1080, height: 1920 },
    });

    const node = defaultSceneGraph.getNode(result.nodeId);
    const transform = node?.components.find((c) => c.type === 'Transform');
    // 1920 tall from 1080 → 1.777…; anything less would letterbox, which is
    // the one result a reframe must never produce.
    expect(transform?.props.scaleX).toBeCloseTo(1920 / 1080, 4);
    expect(transform?.props.scaleY).toBeCloseTo(1920 / 1080, 4);
  });

  it('writes a pan onto the instance, on both axes', async () => {
    walkThenCut();
    const result = await autoReframeComposition({
      sourceCompId: SOURCE_ID,
      target: { width: 1080, height: 1920 },
    });

    const props = defaultAnimation.animatedProps(result.nodeId);
    expect(props).toContain('x');
    expect(props).toContain('y');
    expect(result.keyframes).toBeGreaterThan(0);
  });

  it('follows the subject: the pan actually moves as the subject walks', async () => {
    walkThenCut();
    const result = await autoReframeComposition({
      sourceCompId: SOURCE_ID,
      target: { width: 1080, height: 1920 },
    });

    const xs = (defaultAnimation.getTrackKeyframes(result.nodeId, 'x') ?? []).map((k) => k.value as number);
    expect(xs.length).toBeGreaterThan(1);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(50);
  });

  it('centres the pan on the target frame, not on the origin', async () => {
    walkThenCut();
    const result = await autoReframeComposition({
      sourceCompId: SOURCE_ID,
      target: { width: 1080, height: 1920 },
    });

    // Values are absolute layer positions in the new comp, so they live around
    // its centre. Writing the raw offsets instead would park the source's
    // corner at the top-left and render mostly empty frame.
    const xs = (defaultAnimation.getTrackKeyframes(result.nodeId, 'x') ?? []).map((k) => k.value as number);
    for (const x of xs) expect(Math.abs(x - 540)).toBeLessThan(1200);
    const ys = (defaultAnimation.getTrackKeyframes(result.nodeId, 'y') ?? []).map((k) => k.value as number);
    for (const y of ys) expect(y).toBeCloseTo(960, 3);
  });

  it('finds the cut and reports it', async () => {
    walkThenCut();
    const result = await autoReframeComposition({
      sourceCompId: SOURCE_ID,
      target: { width: 1080, height: 1920 },
    });
    expect(result.cuts).toBeGreaterThanOrEqual(1);
  });

  it('refuses a composition that does not exist', async () => {
    await expect(
      autoReframeComposition({ sourceCompId: 'nope', target: { width: 1080, height: 1920 } }),
    ).rejects.toThrow(/no composition/i);
  });

  it('refuses a target too small to render', async () => {
    walkThenCut();
    await expect(
      autoReframeComposition({ sourceCompId: SOURCE_ID, target: { width: 1, height: 1 } }),
    ).rejects.toThrow(/too small/i);
  });
});
