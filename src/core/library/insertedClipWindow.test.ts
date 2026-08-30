/**
 * The clip bar an inserted library item gets, and whether it means anything.
 *
 * Two defects, reported together as "the timeline shows it as fully fit instead
 * of where it finishes, and moving it to start at 2s is very wrongly working".
 * They compound, which is why neither was obvious on its own:
 *
 *  1. `syncFromScene` seeds every new generative layer a bar of the WHOLE
 *     composition starting at zero. Right for a shape the user just drew; wrong
 *     for a finished 0.9-second lower third dropped at two seconds, where the
 *     bar then said nothing true about when the thing plays or when it is over.
 *
 *  2. That bar governed nothing anyway. A library item is a GROUP, the renderer
 *     draws the group's MEMBERS, and `syncFromScene` deliberately gives the
 *     group the clip and its members none — so both the in/out gate and the
 *     keyframe time axis asked each drawn layer for its own clips, found none,
 *     and treated that as "no constraints". Dragging the bar to two seconds
 *     changed the picture not at all.
 *
 * Read through `buildSnapshot`, the same evaluation the viewport uses: a layer
 * the snapshot still draws outside its bar is a layer the bar does not control.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { useSelectionStore } from '@stores/selectionStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { getTimelineController } from '@core/timeline/TimelineController';
import { usePreferenceStore } from '@stores/preferenceStore';
import type { SceneNode } from '@core/types';

import { MOGRAPH_ITEMS, insertMographItem, mographDuration } from './mographLibrary';
import { insertPrimitive } from '@core/scene/sceneInsert';

const COMP = { width: 1920, height: 1080, background: '#101014', rootId: 'comp_root' };
/** The composition these tests run in. Long, so a short item's bar is obvious. */
const COMP_SECONDS = 10;
const FPS = 30;

function reset(): void {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  // Synchronous settle — nothing pumps the frame clock under jest, so the
  // autoplay branch would leave the playhead parked at the start forever.
  usePreferenceStore.getState().set('editorReduceMotion', true);
  getTimelineController().seekSeconds(0);
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root',
    name: 'Composition 1',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  useSelectionStore.getState().set([]);
}

const snapAt = (t: number) =>
  buildSnapshot(defaultSceneGraph, defaultAnimation, t, undefined, undefined, undefined, undefined, COMP);

/** Ids the snapshot actually emitted at `t`. */
const drawnAt = (t: number): Set<string> => new Set(snapAt(t).layers.map((l) => l.id));

/** The one clip backing `nodeId`, in seconds. */
function windowOf(nodeId: string): { start: number; end: number } | null {
  const clip = getTimelineController().getLayersForNode(nodeId)[0];
  if (!clip) return null;
  return { start: clip.start / FPS, end: (clip.start + clip.duration) / FPS };
}

/** A short, non-looping item — the shape the report was about. */
const SHORT_ITEM = MOGRAPH_ITEMS.find((i) => !i.loop && mographDuration(i) < COMP_SECONDS / 2);
const LOOP_ITEM = MOGRAPH_ITEMS.find((i) => i.loop);

beforeEach(reset);

describe('an inserted item gets a bar the length of its own animation', () => {
  it('is nowhere near the length of the composition', () => {
    expect(SHORT_ITEM).toBeDefined();
    const id = insertMographItem(SHORT_ITEM!.id)!;
    const win = windowOf(id);

    expect(win).not.toBeNull();
    // The whole complaint: it used to be exactly the comp.
    expect(win!.end - win!.start).toBeLessThan(COMP_SECONDS / 2);
    expect(win!.end - win!.start).toBeCloseTo(mographDuration(SHORT_ITEM!) + 1 / FPS, 1);
  });

  it('starts where the playhead was, not at zero', () => {
    getTimelineController().seekSeconds(2);
    const id = insertMographItem(SHORT_ITEM!.id)!;
    expect(windowOf(id)!.start).toBeCloseTo(2, 2);
  });

  it('includes the frame the animation settles on', () => {
    // Clip spans are end-EXCLUSIVE and a choreography's last keyframe sits at
    // exactly its duration, so a naive [t0, t0+duration] window trims off the
    // pose the whole move was travelling toward.
    const id = insertMographItem(SHORT_ITEM!.id)!;
    const kids = defaultSceneGraph.getChildren(id).map((n) => n.id as string);
    const drawn = drawnAt(mographDuration(SHORT_ITEM!));
    expect(kids.filter((k) => !drawn.has(k))).toEqual([]);
  });

  it('leaves a LOOPING item full-length, because its animation has no end', () => {
    expect(LOOP_ITEM).toBeDefined();
    const id = insertMographItem(LOOP_ITEM!.id)!;
    const win = windowOf(id)!;
    expect(win.end - win.start).toBeCloseTo(COMP_SECONDS, 1);
  });

  it('leaves a hand-drawn layer full-length, as it always was', () => {
    // The seeding rule is right for a blank layer; this fix is about finished
    // choreography, and must not have changed what drawing a shape does.
    insertPrimitive('shape', 'Rect');
    // The app mirrors the scene into the timeline from a SceneGraphChanged
    // listener that jest has no boot to install, so the seeding this test is
    // about has to be asked for explicitly.
    getTimelineController().syncFromScene('comp_root');
    const id = defaultSceneGraph.getChildren('comp_root').at(-1)!.id as string;
    const win = windowOf(id)!;
    expect(win.end - win.start).toBeCloseTo(COMP_SECONDS, 1);
  });
});

describe("a group's bar governs the layers inside it", () => {
  it('draws nothing before the bar starts', () => {
    getTimelineController().seekSeconds(2);
    const id = insertMographItem(SHORT_ITEM!.id)!;
    const kids = defaultSceneGraph.getChildren(id).map((n) => n.id as string);
    expect(kids.length).toBeGreaterThan(0);

    // One second BEFORE the bar. Every member used to draw here, because each
    // one has no clip of its own and that read as "always live".
    const drawn = drawnAt(1);
    expect(kids.filter((k) => drawn.has(k))).toEqual([]);
  });

  it('draws nothing after the bar ends', () => {
    const id = insertMographItem(SHORT_ITEM!.id)!;
    const kids = defaultSceneGraph.getChildren(id).map((n) => n.id as string);
    const drawn = drawnAt(COMP_SECONDS - 1);
    expect(kids.filter((k) => drawn.has(k))).toEqual([]);
  });

  it('draws inside the bar', () => {
    // The control. A gate that refused everything would pass both tests above.
    getTimelineController().seekSeconds(2);
    const id = insertMographItem(SHORT_ITEM!.id)!;
    const kids = defaultSceneGraph.getChildren(id).map((n) => n.id as string);
    const drawn = drawnAt(2 + mographDuration(SHORT_ITEM!) / 2);
    expect(kids.some((k) => drawn.has(k))).toBe(true);
  });

  /*
    A pose fingerprint over EVERY member and BOTH an animated transform and
    opacity.

    The previous version of this sampled `opacity` on `getChildren(id)[0]`
    alone, and that member's opacity is 1.00 for the whole choreography — so it
    asserted a constant against a constant and passed against a renderer that
    sampled the moved layer at raw comp time and drew the settled end pose at
    every frame of the bar. VERIFIED in the live app before this was widened:
    at 5s every offset read `1.00@960.0` (settled) where the same offsets at 0s
    read `1.00@675.0 → 1.00@857.4 → 1.00@948.6` (moving).

    The lesson is the general one: a fingerprint that omits the property the
    animation actually drives is not a fingerprint. Include position.
  */
  const poseOf = (groupId: string, t: number): string => {
    const snap = snapAt(t);
    return defaultSceneGraph
      .getChildren(groupId)
      .map((n) => {
        const l = snap.layers.find((x) => x.id === n.id);
        return l ? `${l.opacity.toFixed(2)}@${l.x.toFixed(1)},${l.y.toFixed(1)}` : 'absent';
      })
      .join(' | ');
  };

  it('MOVES the animation with the bar, rather than only hiding it', () => {
    // Dragging a bar to four seconds has to mean "this happens at four
    // seconds", not "this is invisible until four seconds and then shows its
    // end pose".
    const id = insertMographItem(SHORT_ITEM!.id)!;
    const controller = getTimelineController();
    const clip = controller.getLayersForNode(id)[0]!;
    const duration = mographDuration(SHORT_ITEM!);
    // Several offsets, so a single coincidental match cannot carry the test.
    const offsets = [0, duration / 3, duration / 2, (duration * 2) / 3];

    const before = offsets.map((o) => poseOf(id, o));
    // The control: the choreography must actually MOVE across these offsets,
    // or every assertion below holds for a layer that never animates and the
    // test proves nothing.
    expect(new Set(before).size).toBeGreaterThan(1);

    controller.setClipStart(clip.id, 4);
    controller.invalidateLayerIndex();

    // The SAME points of the animation, now four seconds later.
    expect(offsets.map((o) => poseOf(id, 4 + o))).toEqual(before);
  });

  it('does not show the settled end pose for the whole moved bar', () => {
    // The specific failure the widened fingerprint above caught: the gate moved
    // correctly, so the item appeared at the right time and looked fixed — but
    // it was being sampled at RAW COMP TIME, which for a 0.87s choreography at
    // 4s is long past the end, so every frame of the bar drew the final pose.
    const id = insertMographItem(SHORT_ITEM!.id)!;
    const controller = getTimelineController();
    const clip = controller.getLayersForNode(id)[0]!;
    const duration = mographDuration(SHORT_ITEM!);

    controller.setClipStart(clip.id, 4);
    controller.invalidateLayerIndex();

    const start = poseOf(id, 4);
    const settled = poseOf(id, 4 + duration);
    expect(start).not.toBe(settled);
  });
});
