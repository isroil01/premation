/**
 * The motion-graphics insert against the PAGE REPLICA — the legacy builder
 * (live scene graph + animation engine + timeline controller), kept only as
 * the parity reference for mographLibrary.ts `buildMographFragment` (the
 * engine-client build the app uses) and for tests that still build fixtures
 * through it. Goes with the replica (docs/TS_ENGINE_REMOVAL.md step 3).
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { bumpScene } from '@stores/sceneStore';
import { getTimelineController, compToKeyframeTime } from '@core/timeline/TimelineController';
import { setInsertedClipWindow } from './clipWindow';
import { defaultAnimation } from '@motion/animation';
import { setNodeMotionBlur } from '@core/effects/motionBlur';
import { liveKf } from '@core/template/templates/builders';
import { MOGRAPH_ID_PROP, nameMographParts } from './mographParams';
import type { SceneNode } from '@core/types';
import { getMographItem, mographDuration, previewMographItem, type MographOps } from './mographLibrary';

/** Reference comp height the items are authored at (mographLibrary.ts REF_H). */
const REF_H = 720;

let seq = 0;

/** Insert a motion-graphics item at (x, y) — comp centre when omitted —
 *  starting at the playhead, then preview it. Returns the group node id, or null. */
export function insertMographItem(mgId: string, x?: number, y?: number): string | null {
  const id = buildMographItem(mgId, x, y);
  if (id) previewMographItem(mgId);
  return id;
}

/**
 * The BUILDER alone (B3z): the item's layer set, keys, expressions and bar,
 * selected — no preview. The editor runs it off-document and inserts the
 * result as ONE `pasteLayers` (offDocument.ts), then calls
 * {@link previewMographItem}.
 */
export function buildMographItem(mgId: string, x?: number, y?: number): string | null {
  const item = getMographItem(mgId);
  if (!item) return null;
  const comp = useCompositionStore.getState();
  const u = (comp.height || REF_H) / REF_H;
  const px = x ?? comp.width / 2;
  const py = y ?? comp.height / 2;
  const rootId = activeCompRootId();
  const baseId = `mg_${(seq += 1)}_${Math.random().toString(36).slice(2, 6)}`;

  // Group wrapper so the element moves/scales as one unit.
  const group = {
    id: baseId, name: item.name, parent: rootId, children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true, locked: false,
    // The catalog id rides on the group so the subtree stays recognisable as
    // ONE inserted element afterwards — that is what lets the Inspector offer
    // its text and colour blanks instead of leaving the user to hunt for the
    // right child layer and guess which prop is safe to touch.
    components: [{ id: `${baseId}_m`, type: 'group', props: { [SCENE_KIND_PROP]: 'group', [MOGRAPH_ID_PROP]: item.id } }],
  } as unknown as SceneNode;
  defaultSceneGraph.addChild(rootId, group);
  item.build(defaultSceneGraph, baseId, baseId, px, py, u);
  // Builders default a node's name to its id; unrenamed, the Layers panel fills
  // with `mg_3_kf9a_rule`. Name the parts after what the ids describe.
  nameMographParts(baseId);

  const ws = useWorkspaceStore.getState();
  const t0 = (ws.activeTabId ? ws.tabs[ws.activeTabId]?.time : 0) ?? 0;
  item.animate(liveKf, baseId, px, py, t0, u);

  // Expressions + text data keyframes onto the LIVE engine (canonical time).
  const liveOps: MographOps = {
    expr: (id, prop, src) => defaultAnimation.setExpression(id, prop, src),
    textKf: (id, timeSec, value) =>
      defaultAnimation.setDataKeyframe(id, 'text.source', 'text', compToKeyframeTime(id, timeSec), value),
  };
  item.decorate?.(liveOps, baseId, px, py, t0, u);

  // Per-layer motion-blur switch for whip/slam moves (renders when the comp's
  // motion-blur master switch is on).
  for (const sfx of item.motionBlurIds ?? []) setNodeMotionBlur(`${baseId}${sfx}`, true);

  useSelectionStore.getState().set([baseId]);
  getTimelineController().syncFromScene();

  /*
    The bar says what the item IS: it starts where it was dropped and ends when
    its choreography does.

    `syncFromScene` has just seeded a full-comp bar starting at zero, which is
    right for a layer the user drew and wrong for a finished 0.9-second lower
    third dropped at two seconds — the timeline would say nothing true about
    when it plays or when it is over, which is most of what a timeline is for.

    A LOOPING item keeps the full bar: its animation is a rule with no end, so
    an arbitrary window would be a lie in the other direction.
  */
  if (!item.loop) setInsertedClipWindow(baseId, t0, mographDuration(item));
  bumpScene();
  return baseId;
}
