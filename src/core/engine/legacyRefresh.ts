/**
 * Legacy UI refresh — tells today's editor that the engine changed the document.
 *
 * Until B4 the panels do not read a mirror fed by engine events: they read the
 * scene graph / animation engine directly and re-render on the app bus
 * (`AnimationChanged`, `NodeUpdated`, `SceneGraphChanged`, `DocumentChanged`)
 * and the scene revision. The engine's handlers write through the low-level
 * seams (`writeProp`, node view setters), which announce nothing — so without
 * this step a command lands in the document and the viewport, the Layers panel
 * and the Inspector keep drawing the old value.
 *
 * Called by `LocalEngine` (option `legacyUiRefresh`) after a forward edit and a
 * cancelled gesture, INSIDE its applying window (so its own external-change
 * detector does not read the bus traffic as a foreign edit) and with the
 * debounce recorder held (`restoring`), so no second history entry is scheduled.
 * Undo/redo already refresh through `applyParts` (state.ts).
 *
 * Cost is proportional to what changed: a value edit on one layer (the drag hot
 * path) is one attributed `AnimationChanged` + a revision bump — the same
 * traffic `updateNodeComponentProp` produced — and only a structural change
 * pays for `SceneGraphChanged`. B4 deletes this file (the mirror applies events).
 */

import { getEventBus } from '@core/events/EventBus';
import { bumpScene, bumpSceneRevision } from '@stores/sceneStore';

/** Announce the parts an engine edit changed (part keys from state.ts). */
export function refreshLegacyUi(changedPartKeys: readonly string[]): void {
  if (changedPartKeys.length === 0) return;
  const nodes = new Set<string>();
  let structural = false;
  let clips = false;
  let documentLevel = false;
  for (const k of changedPartKeys) {
    const colon = k.indexOf(':');
    const kind = colon < 0 ? k : k.slice(0, colon);
    const id = colon < 0 ? '' : k.slice(colon + 1);
    switch (kind) {
      case 'node':
      case 'anim':
        nodes.add(id);
        break;
      case 'clips':
        clips = true;
        break;
      case 'order':
        structural = true;
        break;
      default:
        // comp:, tl:, items, project, rq, mb, cm
        structural = true;
        documentLevel = true;
        break;
    }
  }
  const bus = getEventBus();
  // Per-node attribution first: inspector rows keyed on a node revision and
  // the viewport's render request both listen to AnimationChanged{nodeId}.
  for (const nodeId of nodes) bus.emit('AnimationChanged', { nodeId });
  if (clips) bus.emit('DocumentChanged', { source: 'timeline' });
  if (documentLevel) bus.emit('DocumentChanged', { source: 'composition' });
  if (structural) bumpScene();
  else bumpSceneRevision();
}
