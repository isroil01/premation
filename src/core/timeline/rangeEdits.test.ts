/**
 * Lift, Extract and Ripple Delete.
 *
 * The whole feature is one boolean — does the hole close — so the test that
 * matters is the one that runs the SAME range through both and shows the
 * difference in where the bar after it ends up. Everything else about these
 * three is shared code, and a test per verb would just be the same assertions
 * three times.
 *
 * The boundary predicates are tested separately and exhaustively, because they
 * are where an off-by-one leaves a one-frame sliver at every cut — which nobody
 * notices until a delivered file has a black flash in it. `Clip.end` is
 * EXCLUSIVE; both predicates are written against that and would silently
 * disagree with the engine if it were not.
 */

import { barIsInsideRange, barStraddles, workAreaRange } from './rangeEdits';
import { getTimelineController } from './TimelineController';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useProjectStore } from '@stores/projectStore';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';

describe('range boundaries', () => {
  it('counts a bar that ends exactly at the range end as inside', () => {
    // `end` is EXCLUSIVE, so a bar occupying frames 10..19 has end 20 and is
    // wholly inside [10, 20). Treating this as a straddle leaves a zero-length
    // piece behind at every cut.
    expect(barIsInsideRange({ start: 10, end: 20 }, 10, 20)).toBe(true);
  });

  it('does not count a bar that pokes out of either side', () => {
    expect(barIsInsideRange({ start: 9, end: 20 }, 10, 20)).toBe(false);
    expect(barIsInsideRange({ start: 10, end: 21 }, 10, 20)).toBe(false);
  });

  it('straddles only STRICTLY inside — a boundary that touches an edge is not a cut', () => {
    expect(barStraddles({ start: 0, end: 30 }, 15)).toBe(true);
    // Splitting at a bar's own start or end produces a zero-length piece.
    expect(barStraddles({ start: 0, end: 30 }, 0)).toBe(false);
    expect(barStraddles({ start: 0, end: 30 }, 30)).toBe(false);
  });
});

// ── The edits, against a real comp ──────────────────────────────────

const NODE_A = 're_a';
const NODE_B = 're_b';

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

function addShape(id: string): void {
  defaultSceneGraph.addChild('comp_root', {
    id, name: id, parent: 'comp_root', children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 10, y: 10, width: 20, height: 20 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#fff' } },
    ],
  } as never);
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  resetScene();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Main', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  addShape(NODE_A);
  addShape(NODE_B);
  useProjectStore.getState().actions.replaceComps({
    comp_root: {
      id: 'comp_root', name: 'Main', width: 1920, height: 1080, fps: 30,
      durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0,
    },
  });
  const proj = useProjectStore.getState();
  const tabId = proj.actions.openTab('comp_root', ['comp_root'], 'Main');
  proj.actions.setActiveTab(tabId);
  getTimelineController().syncFromScene('comp_root');
});

/** Two bars in sequence: A over 0–2s, B over 4–6s. Returns their layer ids. */
function layOutBars(): { a: string; b: string; fps: number } {
  const c = getTimelineController();
  const fps = c.fps;
  const a = c.getLayersForNode(NODE_A)[0]!;
  const b = c.getLayersForNode(NODE_B)[0]!;
  c.timeline.setLayerStart(a.id, 0);
  c.timeline.trimLayer(a.id, 'end', Math.round(2 * fps));
  c.timeline.setLayerStart(b.id, Math.round(4 * fps));
  c.timeline.trimLayer(b.id, 'end', Math.round(6 * fps));
  c.invalidateLayerIndex();
  return { a: a.id, b: b.id, fps };
}

describe('lift and extract', () => {
  it('LIFT removes the material and leaves the hole', async () => {
    const { b, fps } = layOutBars();
    const c = getTimelineController();
    const { liftRange } = await import('./rangeEdits');

    const result = await liftRange({ start: 0, end: 2 });
    expect(result.deletedClips).toBeGreaterThan(0);
    expect(result.rippled).toBe(0);
    // B has not moved: that is the entire difference between the two verbs.
    expect(c.timeline.getLayer(b)!.start).toBe(Math.round(4 * fps));
  });

  it('EXTRACT removes the same material and closes the hole', async () => {
    const { b, fps } = layOutBars();
    const c = getTimelineController();
    const { extractRange } = await import('./rangeEdits');

    const result = await extractRange({ start: 0, end: 2 });
    expect(result.deletedClips).toBeGreaterThan(0);
    // B slides left by the range's length: 4s − 2s = 2s.
    expect(c.timeline.getLayer(b)!.start).toBe(Math.round(2 * fps));
  });

  it('splits a bar the range cuts through instead of deleting it whole', async () => {
    const { a, fps } = layOutBars();
    const c = getTimelineController();
    const { liftRange } = await import('./rangeEdits');

    // Only the second half of A is inside the range.
    const result = await liftRange({ start: 1, end: 2 });
    expect(result.splits).toBeGreaterThan(0);
    const left = c.timeline.getLayer(a);
    // The surviving left half still starts at 0 and now ends at 1s.
    expect(left?.start).toBe(0);
    expect(left?.end).toBe(Math.round(1 * fps));
  });

  it('refuses a sub-frame range rather than rounding up into the next frame', async () => {
    layOutBars();
    const { extractRange } = await import('./rangeEdits');
    const result = await extractRange({ start: 1, end: 1.001 });
    expect(result).toEqual({ removedSeconds: 0, splits: 0, deletedClips: 0, rippled: 0 });
  });

  it('scopes to the given nodes when asked', async () => {
    const { a, b } = layOutBars();
    const c = getTimelineController();
    const { extractRange } = await import('./rangeEdits');

    // A range crossing BOTH bars, restricted to B's node. A must survive.
    await extractRange({ start: 0, end: 6 }, [NODE_B]);
    expect(c.timeline.getLayer(a)).toBeDefined();
    expect(c.timeline.getLayer(b)).toBeUndefined();
  });
});

describe('workAreaRange', () => {
  it('is null with no work area, rather than falling back to a range nobody set', () => {
    const c = getTimelineController();
    c.clearWorkArea();
    expect(workAreaRange()).toBeNull();
  });

  it('reports the work area when there is one', () => {
    const c = getTimelineController();
    c.seekSeconds(1);
    c.setWorkAreaIn();
    c.seekSeconds(3);
    c.setWorkAreaOut();
    const range = workAreaRange();
    expect(range).not.toBeNull();
    expect(range!.start).toBeCloseTo(1, 1);
    expect(range!.end).toBeCloseTo(3, 1);
  });
});

/**
 * B and N pressed OUTSIDE the current work area. B used to clamp to one frame
 * before the existing out-point, so with a work area of 0–2 s, pressing B at 6 s
 * did nothing visible at all (seen in the desktop app setting up an export
 * range). AE moves the area instead.
 */
describe('B / N outside the current work area', () => {
  it('B past the out-point moves the in-point there and pushes the out-point to the end', () => {
    const c = getTimelineController();
    c.setWorkArea(0, 2);
    c.seekSeconds(6);
    c.setWorkAreaIn();
    const wa = c.getWorkArea()!;
    expect(wa.start).toBeCloseTo(6, 1);
    expect(wa.end).toBeGreaterThan(wa.start);
  });

  it('N before the in-point pulls the in-point back to the start', () => {
    const c = getTimelineController();
    c.setWorkArea(5, 8);
    c.seekSeconds(3);
    c.setWorkAreaOut();
    const wa = c.getWorkArea()!;
    expect(wa.start).toBeCloseTo(0, 1);
    expect(wa.end).toBeCloseTo(3, 1);
  });

  it('inside the area they still trim it, as before', () => {
    const c = getTimelineController();
    c.setWorkArea(1, 8);
    c.seekSeconds(3); c.setWorkAreaIn();
    c.seekSeconds(6); c.setWorkAreaOut();
    const wa = c.getWorkArea()!;
    expect(wa.start).toBeCloseTo(3, 1);
    expect(wa.end).toBeCloseTo(6, 1);
  });
});
