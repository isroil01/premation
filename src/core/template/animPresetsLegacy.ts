/**
 * The animation-preset insert against the PAGE REPLICA — the legacy builder
 * (live scene graph + animation engine + timeline controller), kept only as
 * the parity reference for animPresets.ts `buildAnimPresetFragment` (the
 * engine-client build the app uses) and for tests that build fixtures through
 * it. Goes with the replica (docs/TS_ENGINE_REMOVAL.md step 3).
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { bumpScene } from '@stores/sceneStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { liveKf } from './templates/builders';
import { getAnimPreset } from './animPresets';

/** animPresets.ts REF_H / unitFor. */
const REF_H = 720;
const unitFor = (compH: number): number => compH / REF_H;
let seq = 0;

/** Insert an animated preset into the current comp at (x, y) — comp centre when
 *  omitted — starting at the current playhead. Element size + motion scale to
 *  the comp so the result matches the preview card. Returns the new node id. */
export function insertAnimPreset(presetId: string, x?: number, y?: number): string | null {
  const preset = getAnimPreset(presetId);
  if (!preset) return null;
  const comp = useCompositionStore.getState();
  const u = unitFor(comp.height || REF_H);
  const px = x ?? comp.width / 2;
  const py = y ?? comp.height / 2;
  const rootId = activeCompRootId();
  const id = `anim_${(seq += 1)}`;

  preset.build(defaultSceneGraph, id, rootId, px, py, u);
  preset.applyAnimators?.(defaultSceneGraph, id);

  // Start at the playhead so the animation plays from where the user is.
  const ws = useWorkspaceStore.getState();
  const t0 = (ws.activeTabId ? ws.tabs[ws.activeTabId]?.time : 0) ?? 0;
  const tc = getTimelineController();
  // t0 offsets the choreography to the playhead; liveKf maps seconds → layer time.
  preset.animate(liveKf, id, px, py, t0, u);

  useSelectionStore.getState().set([id]);
  tc.syncFromScene();
  bumpScene();
  return id;
}
