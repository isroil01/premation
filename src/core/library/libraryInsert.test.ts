/**
 * The ASSET-LIBRARY INSERT PATH — "what actually happens when you click a card".
 *
 * `libraryCatalogs.test.ts` covers the pure cores: catalog integrity, recipe
 * maths, SFX synthesis. Every one of those passes while the panels stay broken,
 * because none of them calls the function the button calls. The four exported
 * inserts — `insertMographItem`, `applyTransitionItem`, `insertLottieItem` —
 * write into the live SceneGraph + AnimationEngine, and nothing asserted that
 * the write LANDS, that the nodes are reachable from the composition root, or
 * that they resolve to something a renderer would draw.
 *
 * So this file drives the live singletons the way the panel does and reads the
 * result back through `buildSnapshot` — the same evaluation the viewport uses.
 * A card that inserts nodes the snapshot drops is a card that "does nothing"
 * on screen no matter how healthy its catalog entry looks.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { useSelectionStore } from '@stores/selectionStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { getTimelineController } from '@core/timeline/TimelineController';
import { getNodeMask } from '@core/effects/mask';
import { usePreferenceStore } from '@stores/preferenceStore';
import type { SceneNode } from '@core/types';

import { MOGRAPH_ITEMS, insertMographItem, mographDuration } from './mographLibrary';
import { TRANSITION_ITEMS, applyTransitionItem } from './transitionLibrary';
import { LOTTIE_ITEMS, insertLottieItem } from './lottieLibrary';

const COMP = { width: 1920, height: 1080, background: '#101014', rootId: 'comp_root' };

/** Lottie inserts run inside a document transaction, which the app opens at
 *  boot. Jest has no boot, so stand one up. */
function bootCommandSystem(): void {
  const services: any = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  };
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) }));
}

function reset(): void {
  bootCommandSystem();
  // Reduce-motion makes the settle SYNCHRONOUS (seek straight to the resting
  // frame) instead of "play, then park on a timer". Nothing pumps the frame
  // clock under jest, so the autoplay branch would leave the playhead parked at
  // the start forever and prove nothing. The resting frame is the same either
  // way — that is what these assertions are about.
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

/** A plain content layer to aim layer-mode transitions at. */
function contentLayer(id: string): string {
  defaultSceneGraph.addChild('comp_root', {
    id, name: id, parent: 'comp_root', children: [], visible: true, locked: false,
    transform: { position: { x: 960, y: 540 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 960, y: 540, rotation: 0, width: 400, height: 300 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode);
  return id;
}

const snapAt = (t: number) =>
  buildSnapshot(defaultSceneGraph, defaultAnimation, t, undefined, undefined, undefined, undefined, COMP);

/** Layers a viewer would actually see: opaque, and not collapsed to nothing.
 *  `RenderLayer.opacity` is 0..1 (NOT the 0..100 the authoring props use). */
const visible = (layers: ReadonlyArray<{ opacity?: number; scaleX?: number }>) =>
  layers.filter((l) => (l.opacity ?? 1) > 0.01 && Math.abs(l.scaleX ?? 1) > 0.01);

/** Ids of every descendant of `rootId`, excluding the root itself. */
function descendants(rootId: string): string[] {
  const out: string[] = [];
  const walk = (id: string): void => {
    for (const child of defaultSceneGraph.getNode(id)?.children ?? []) {
      const cid = typeof child === 'string' ? child : (child as { id: string }).id;
      out.push(cid);
      walk(cid);
    }
  };
  walk(rootId);
  return out;
}

// ── Motion GFX ───────────────────────────────────────────────────────

describe('Motion GFX — inserting a card builds a group the renderer can draw', () => {
  beforeEach(reset);

  it.each(MOGRAPH_ITEMS.map((i) => [i.id, i] as const))(
    '%s lands under the active comp with drawable children',
    (id, item) => {
      const groupId = insertMographItem(id);
      expect(groupId).not.toBeNull();

      // The group is a real child of the composition root — not an orphan.
      const group = defaultSceneGraph.getNode(groupId!);
      expect(group).toBeTruthy();
      expect(group!.parent).toBe('comp_root');

      // `build` authored real geometry underneath it.
      const kids = descendants(groupId!);
      expect(kids.length).toBeGreaterThan(0);

      // And the snapshot — the viewport's own evaluation — actually carries
      // them. A node the snapshot drops is a node that never appears on screen.
      const drawn = new Set(snapAt(mographDuration(item)).layers.map((l) => l.id));
      const missing = kids.filter((k) => !drawn.has(k));
      expect(missing).toEqual([]);
    },
  );

  it.each(MOGRAPH_ITEMS.map((i) => [i.id, i] as const))(
    '%s leaves the playhead on a frame where it is actually visible',
    (id, item) => {
      insertMographItem(id);
      // THE regression this file exists for. The choreography is written
      // starting at the playhead, so the frame the user is looking at when the
      // click lands is its opening keyframe — for 13 of these items that was
      // every layer at opacity 0 / scale 0, i.e. a click that appeared to do
      // nothing. `previewChoreography` now parks the playhead on the settled
      // frame; assert that frame really does show something.
      const resting = getTimelineController().currentSeconds;
      const shown = visible(snapAt(resting).layers);
      expect(shown.length).toBeGreaterThan(0);

      // And pin the failure mode itself: for entrance items the opening frame
      // is genuinely blank, which is exactly why resting there was the bug.
      if (!item.loop) expect(resting).toBeGreaterThan(0);
    },
  );
});

// ── Transitions ──────────────────────────────────────────────────────

describe('Transitions — applying a card keyframes the live engine', () => {
  beforeEach(reset);

  it.each(TRANSITION_ITEMS.filter((t) => !t.solidOnly).map((i) => [i.id, i] as const))(
    '%s keyframes the selected layer',
    (id) => {
      const target = contentLayer('subject');
      useSelectionStore.getState().set([target]);

      const res = applyTransitionItem(id);
      expect(res).not.toBeNull();
      expect(res!.mode).toBe('layer');
      expect(res!.nodeIds).toContain(target);

      // Keyframes landed on the LIVE engine for that node — the panel's toast
      // says "keyframed onto 1 layer", so tracks must exist.
      expect(defaultAnimation.hasAnimation(target)).toBe(true);
      expect(defaultAnimation.getAnimatedPropPaths(target).length).toBeGreaterThan(0);

      // The subject must not have VANISHED. Every one of these recipes opens on
      // opacity 0, so before the preview settle landed, applying a transition
      // to a layer made that layer disappear from the frame the user was
      // looking at — the single most alarming way for a panel to look broken.
      const resting = getTimelineController().currentSeconds;
      expect(visible(snapAt(resting).layers).length).toBeGreaterThan(0);
    },
  );

  it.each(TRANSITION_ITEMS.map((i) => [i.id, i] as const))(
    '%s falls back to choreographed solids with no selection',
    (id) => {
      useSelectionStore.getState().set([]);
      const res = applyTransitionItem(id);
      expect(res).not.toBeNull();
      expect(res!.mode).toBe('solid');
      expect(res!.nodeIds.length).toBeGreaterThan(0);
      // Every inserted solid is reachable from the comp root and drawn.
      const drawn = new Set(snapAt(0).layers.map((l) => l.id));
      for (const nid of res!.nodeIds) expect(drawn.has(nid)).toBe(true);
    },
  );

  // Iris is excluded: it holds a full-frame panel at opacity 100 for the whole
  // window on purpose and reveals through an animated ellipse MASK, which a
  // box-and-opacity test cannot see. It gets its own assertion below.
  //
  // TWO-SIDED on purpose. These were fixed in the wrong direction twice: first
  // the resting frame hid the whole composition behind the panel, then the
  // correction moved it to the end where the panel is off-frame and nothing is
  // on screen at all. Each fix satisfied a one-sided test and reintroduced the
  // opposite complaint. Asserting only "not covering" or only "visible" cannot
  // hold this; both together can.
  it.each(TRANSITION_ITEMS.filter((t) => !t.irisMask).map((i) => [i.id] as const))(
    '%s rests visible on screen AND without hiding the comp',
    (id) => {
      useSelectionStore.getState().set([]);
      const res = applyTransitionItem(id)!;
      const solids = new Set(res.nodeIds);
      const resting = getTimelineController().currentSeconds;
      const panels = snapAt(resting).layers.filter((l) => solids.has(l.id));

      // Fraction of the frame the panels actually paint over.
      let covered = 0;
      for (const l of panels) {
        const op = l.opacity ?? 1;
        if (op <= 0.01) continue;
        const w = Math.abs(l.width * (l.scaleX ?? 1));
        const h = Math.abs(l.height * (l.scaleY ?? 1));
        const ix = Math.max(0, Math.min(COMP.width, (l.x ?? 0) + w / 2) - Math.max(0, (l.x ?? 0) - w / 2));
        const iy = Math.max(0, Math.min(COMP.height, (l.y ?? 0) + h / 2) - Math.max(0, (l.y ?? 0) - h / 2));
        covered += (ix * iy * op) / (COMP.width * COMP.height);
      }
      expect(covered).toBeGreaterThan(0.05); // you can SEE that something happened
      expect(covered).toBeLessThan(0.95);    // and your composition is still there
    },
  );

  it.each(TRANSITION_ITEMS.filter((t) => t.solidOnly && !t.irisMask).map((i) => [i.id] as const))(
    '%s panel actually MOVES on screen across the transition',
    (id) => {
      useSelectionStore.getState().set([]);
      const res = applyTransitionItem(id)!;
      const target = res.nodeIds[0]!;

      // The bug this pins: the panel used to be inserted as an AE "solid", and
      // buildSnapshot pins a solid "to comp centre at comp size, regardless of
      // its transform". So every wipe wrote a perfect x/y choreography onto a
      // layer that the renderer nailed to the middle of the frame — a
      // motionless block of colour over the comp. Sampling the ANIMATION would
      // have looked fine; only the rendered position shows it.
      const item = TRANSITION_ITEMS.find((t) => t.id === id)!;
      const positions = [0, 0.25, 0.5, 0.75, 1].map((f) => {
        const l = snapAt(item.duration * f).layers.find((x) => x.id === target);
        return l ? `${Math.round(l.x ?? 0)},${Math.round(l.y ?? 0)},${(l.opacity ?? 1).toFixed(2)}` : 'gone';
      });
      // At least two distinct rendered states across the window.
      expect(new Set(positions).size).toBeGreaterThan(1);
    },
  );

  it.each([['tr-wipe-right'], ['tr-wipe-left'], ['tr-wipe-down'], ['tr-wipe-up']] as const)(
    '%s sweeps the FULL frame — clean in, total cover at the midpoint, clean out',
    (id) => {
      useSelectionStore.getState().set([]);
      const res = applyTransitionItem(id)!;
      const panel = res.nodeIds[0]!;
      const d = TRANSITION_ITEMS.find((t) => t.id === id)!.duration;

      const coverageAt = (t: number): number => {
        const l = snapAt(t).layers.find((x) => x.id === panel);
        if (!l || (l.opacity ?? 1) <= 0.01) return 0;
        const w = Math.abs(l.width * (l.scaleX ?? 1));
        const h = Math.abs(l.height * (l.scaleY ?? 1));
        const ix = Math.max(0, Math.min(COMP.width, (l.x ?? 0) + w / 2) - Math.max(0, (l.x ?? 0) - w / 2));
        const iy = Math.max(0, Math.min(COMP.height, (l.y ?? 0) + h / 2) - Math.max(0, (l.y ?? 0) - h / 2));
        return (ix * iy * (l.opacity ?? 1)) / (COMP.width * COMP.height);
      };

      // The offsets were authored around 0, as though the comp centre were the
      // origin. It is (W/2, H/2). Unnoticed while the panel was a pinned solid,
      // that put "fully covering" at the frame's left EDGE and left the wipe
      // still halfway across when it should have exited — a wipe that covers
      // half the screen and stops, which is not a wipe.
      expect(coverageAt(0)).toBeLessThan(0.02);      // enters clean
      expect(coverageAt(d / 2)).toBeGreaterThan(0.98); // covers the cut
      expect(coverageAt(d)).toBeLessThan(0.02);      // leaves clean
    },
  );

  it('applying several transitions in a row inserts several panels, not one', () => {
    // Apply selects what it produced, so the NEXT apply used to find that panel
    // in the selection and take the layer path — keyframing itself onto the
    // existing panel instead of inserting its own. Three clicks produced one
    // layer carrying three choreographies fighting over the same x/opacity
    // tracks, which also wrecked the first transition. Seeking between applies
    // changed nothing, because the behaviour keys off the SELECTION, not time.
    const ids: string[] = [];
    for (const id of ['tr-fade', 'tr-glitch-cut', 'tr-zoom-through']) {
      const res = applyTransitionItem(id)!;
      expect(res.mode).toBe('solid');
      ids.push(...res.nodeIds);
    }
    expect(new Set(ids).size).toBe(3);

    // Each panel carries exactly ONE transition's worth of choreography.
    const children = (defaultSceneGraph.getNode('comp_root')?.children ?? [])
      .map((c) => (typeof c === 'string' ? c : (c as { id: string }).id));
    expect(children.length).toBe(3);
  });

  it('a real layer stays targetable across repeated applies', () => {
    // The panel exclusion must not make ordinary layers untargetable — applying
    // a transition to your own layer, twice, is legitimate.
    const target = contentLayer('subject');
    useSelectionStore.getState().set([target]);
    expect(applyTransitionItem('tr-fade')!.mode).toBe('layer');
    expect(applyTransitionItem('tr-slide-left')!.mode).toBe('layer');
  });

  it('every transition applied with NO selection produces a DIFFERENT result', () => {
    // The cards each preview their own motion, because they call
    // `transitionRecipe`. Apply used to send anything that was not solid-only
    // through `solidRecipe`, whose `default:` arm is a generic wipe-right — so
    // thirteen different items inserted the identical sweeping rectangle,
    // separable only by duration. The previews were honest and the results were
    // all the same, which is the most confusing possible pairing.
    const fingerprints = new Map<string, string[]>();
    for (const item of TRANSITION_ITEMS) {
      reset();
      const res = applyTransitionItem(item.id)!;
      const nodeId = res.nodeIds[0]!;
      const props = defaultAnimation.getAnimatedPropPaths(nodeId).sort();
      const fp = [
        res.nodeIds.length,
        ...props.map((p) => `${p}:${(defaultAnimation.getTrackKeyframes(nodeId, p) ?? [])
          .map((k) => `${k.t.toFixed(2)}=${Math.round(k.value)}`).join(',')}`),
      ].join('|');
      const bucket = fingerprints.get(fp) ?? [];
      bucket.push(item.id);
      fingerprints.set(fp, bucket);
    }
    const collisions = [...fingerprints.values()].filter((ids) => ids.length > 1);
    expect(collisions).toEqual([]);
  });

  it('the iris reveals through an ANIMATED mask, not a permanent full-frame cover', () => {
    useSelectionStore.getState().set([]);
    const res = applyTransitionItem('tr-iris')!;
    const panel = res.nodeIds[0]!;
    // The panel is deliberately opaque for the whole window, so the ONLY thing
    // stopping it from being a block of colour over the comp is the mask. If
    // that ever stops animating, the item silently becomes the exact defect the
    // sibling test guards against everywhere else.
    expect(defaultAnimation.isDataAnimated(panel, 'mask.points')
      || defaultAnimation.getAnimatedPropPaths(panel).some((p) => p.includes('mask'))
      || getNodeMask(panel).paths.length > 0).toBe(true);
  });

  it('a GROUP really leaves the frame — its content box drives the move, not a 100px stub', () => {
    // A group has no Transform component: it sits at its origin while its
    // children are laid out in absolute comp coordinates. Read naively that is
    // a 100×100 box at (0,0), so "slide off to the left" resolved to a ~90px
    // nudge and the element never left the screen — it just sat there, shifted.
    const groupId = insertMographItem('mg-lower-line')!;
    useSelectionStore.getState().set([groupId]);
    const t0 = getTimelineController().currentSeconds;

    const res = applyTransitionItem('tr-slide-left');
    expect(res!.mode).toBe('layer');
    expect(res!.nodeIds).toContain(groupId);

    // At the START of a slide entrance the whole element must be off-frame.
    const startX = defaultAnimation.sample(groupId, 'x', t0);
    expect(startX).toBeDefined();
    // The children sit around comp centre, so clearing the frame needs a
    // displacement of roughly a comp-width — nothing like the old ~90px.
    expect(Math.abs(startX!)).toBeGreaterThan(COMP.width / 2);
  });
});

// ── Lottie ───────────────────────────────────────────────────────────

describe('Lottie — inserting a card lands drawable layers', () => {
  beforeEach(reset);

  it.each(LOTTIE_ITEMS.map((i) => [i.id, i] as const))(
    '%s inserts layers the snapshot draws',
    (id) => {
      const ids = insertLottieItem(id);
      expect(ids.length).toBeGreaterThan(0);
      const drawn = new Set(snapAt(0).layers.map((l) => l.id));
      // At least the inserted roots must survive into the snapshot.
      const survivors = ids.filter((nid) => drawn.has(nid) || descendants(nid).some((d) => drawn.has(d)));
      expect(survivors.length).toBeGreaterThan(0);
    },
  );
});
