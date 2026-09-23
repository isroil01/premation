/**
 * The Layers panel's eye / lock / solo / shy switches, through the engine API
 * (B3 reference migration — docs/B3_PATTERNS.md "simple set" and "multi-select
 * batch").
 *
 * Same rules the panel always had: ANCHORED on the clicked row (it acts on the
 * whole selection when the row is part of it, on that row alone otherwise), the
 * clicked row's state decides the direction for the whole set, and the lot is
 * ONE undo step. What changed is the write: one `setLayerSwitches` per layer in
 * one labelled batch, instead of assigning `node.visible` inside
 * `runDocumentEdit`. The engine records the inverse, refreshes the panels and
 * refuses what it cannot do with a typed error (toasted by `edit`).
 *
 * A composition ROOT is not a layer in the API (it is an item), so its row's
 * switches keep the legacy writer until compositions migrate.
 */

import type { Command, LayerSwitchesPatch } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isLayer } from '@core/engine/doc';
import { edit } from '@core/engine/uiEdits';
import { toggleSelectedLocked, toggleSelectedSolo, toggleSelectedVisible } from '@core/scene/sceneInsert';
import { layerFlagAvailable, layerFlagDef, readLayerFlag, type LayerFlag } from '@core/scene/layerFlags';
import { nextQuality, readNodeQuality, type LayerQuality } from '@core/effects/layerQuality';
import { notifyGuideLayerChange } from '@core/effects/layerSwitchFeedback';
import { getNodeEffects } from '@core/effects/effects';
import { isLayerAudioMuted } from '@core/audio/audioLayerSwitches';
import { notifyCameraTipIfMissing } from '@core/workspace/cameraNav';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { useRenderQualityStore } from '@stores/renderQualityStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';

export type LayerSwitch = 'visible' | 'locked' | 'solo' | 'shy';

/** The ids an action on `anchorId` applies to: the selection when the row is in it, else the row. */
export function anchoredLayerIds(anchorId: string): string[] {
  const sel = useSelectionStore.getState().ids;
  return sel.includes(anchorId) ? [...sel] : [anchorId];
}

/** The switch's current state on one node (a display read — direct until B4). */
function readSwitch(nodeId: string, sw: LayerSwitch): boolean {
  const n = defaultSceneGraph.getNode(nodeId);
  if (!n) return false;
  if (sw === 'visible') return n.visible !== false;
  return (n as unknown as Record<LayerSwitch, unknown>)[sw] === true;
}

const LABELS: Record<LayerSwitch, [on: string, off: string]> = {
  visible: ['Show layer', 'Hide layer'],
  locked: ['Lock layer', 'Unlock layer'],
  solo: ['Solo layer', 'Unsolo layer'],
  shy: ['Enable Shy', 'Disable Shy'],
};

const LEGACY: Partial<Record<LayerSwitch, (anchorId: string) => void>> = {
  visible: toggleSelectedVisible,
  locked: toggleSelectedLocked,
  solo: toggleSelectedSolo,
};

/**
 * The commands that set `sw` to `next` on every layer of `ids` (non-layers
 * skipped). Exported for tests and for callers that fold it into a bigger batch.
 */
export function switchCommands(ids: readonly string[], sw: LayerSwitch, next: boolean): Command[] {
  const patch: LayerSwitchesPatch = { [sw]: next };
  // One command per layer: `setLayerSwitches` takes the layers of ONE
  // composition, and a selection may span several (a precomp's layers and the
  // outer comp's). The batch keeps them one undo entry.
  return ids.filter((id) => isLayer(id)).map((id) => ({ type: 'setLayerSwitches', layers: [id], patch }) as Command);
}

/** Toggle `sw` anchored on the clicked row (see the file header). */
export async function toggleLayerSwitchAnchored(anchorId: string, sw: LayerSwitch): Promise<void> {
  if (!defaultSceneGraph.getNode(anchorId)) return;
  if (!isLayer(anchorId)) {
    // A composition root's row: no API switch yet (see the header).
    LEGACY[sw]?.(anchorId);
    return;
  }
  const ids = anchoredLayerIds(anchorId);
  const next = !readSwitch(anchorId, sw);
  const cmds = switchCommands(ids, sw, next);
  if (cmds.length === 0) return;
  const [on, off] = LABELS[sw];
  const verb = next ? on : off;
  await edit(cmds.length === 1 ? verb : `${verb} (${cmds.length} layers)`, cmds);
}

// ── The AE switch column (layerFlags) over a selection ────────────────

const QUALITY_LABEL: Readonly<Record<LayerQuality, string>> = {
  best: 'Quality: Best',
  draft: 'Quality: Draft',
  wireframe: 'Quality: Wireframe',
};

/** The `setLayerSwitches` patch that puts `flag` at `next`. */
export function flagPatch(flag: LayerFlag, next: boolean | LayerQuality): LayerSwitchesPatch {
  const on = next === true;
  switch (flag) {
    case 'quality': return { quality: next as LayerQuality };
    case 'fxEnabled': return { effectsEnabled: on };
    case 'frameBlend': return { frameBlend: on ? 'frameMix' : 'off' };
    case 'shy': return { shy: on };
    case 'collapse': return { collapse: on };
    case 'motionBlur': return { motionBlur: on };
    case 'adjustment': return { adjustment: on };
    case 'guide': return { guide: on };
    case 'preserveTransparency': return { preserveTransparency: on };
    case 'threeD': return { threeD: on };
  }
}

function notify(message: string, level: 'info' | 'success' | 'warning' = 'info', durationMs = 3200): void {
  useUIStore.getState().notify({ level, message, durationMs });
}

/**
 * One AE switch across a selection as ONE undo step, anchored on `anchorId`
 * — `layerFlags.toggleLayerFlags`' rules through the engine: the anchor's state
 * decides the direction (a cycling switch lands the whole set on the anchor's
 * NEXT position), layers that cannot carry the flag are skipped and reported
 * once, and the label names the position the set moves TO. One
 * `setLayerSwitches` per layer (a selection may span compositions) in one
 * batch, with the feedback the legacy toggle gave.
 */
export async function toggleLayerFlagsEdit(ids: ReadonlyArray<string>, flag: LayerFlag, anchorId?: string): Promise<void> {
  const targets = ids.filter((id) => {
    const n = defaultSceneGraph.getNode(id);
    return !!n && isLayer(id) && layerFlagAvailable(n, flag);
  });
  const def = layerFlagDef(flag);
  const refused = ids.length - targets.length;
  if (refused > 0) {
    notify(refused === 1 ? `${def.label} isn't available for that layer` : `${def.label} isn't available for ${refused} of the selected layers`, 'warning', 2600);
  }
  if (targets.length === 0) return;
  const anchor = defaultSceneGraph.getNode(anchorId && targets.includes(anchorId) ? anchorId : targets[0]!);
  if (!anchor) return;
  const next: boolean | LayerQuality = def.cycles ? nextQuality(readNodeQuality(anchor)) : !readLayerFlag(anchor, flag);
  const verb = typeof next === 'string' ? QUALITY_LABEL[next] : `${next ? 'Enable' : 'Disable'} ${def.label}`;
  const patch = flagPatch(flag, next);
  const res = await edit(
    targets.length === 1 ? verb : `${verb} (${targets.length} layers)`,
    targets.map((id) => ({ type: 'setLayerSwitches', layers: [id], patch }) as Command),
  );
  if (!res.ok || typeof next !== 'boolean') return;
  // The feedback `toggleLayerFlag` gave (layerSwitchFeedback.ts / cameraNav).
  if (flag === 'guide') notifyGuideLayerChange(next, targets.length > 1);
  else if (flag === 'threeD' && next) notifyCameraTipIfMissing((message, level) => notify(message, level));
  else if (flag === 'motionBlur' && next) {
    const mb = useMotionBlurStore.getState();
    if (!mb.enabled) {
      // B3-legacy: engine gap — the composition motion-blur MASTER (`enabled`) is not a field of the
      // API's MotionBlurSettings; AE's dual gate still turns it on here (a store setting, as before).
      mb.setEnabled(true);
      notify('Motion Blur enabled for this layer and the composition', 'success');
    }
    if (useRenderQualityStore.getState().draft) {
      notify('Draft preview is on — motion blur samples are paused until draft is off', 'warning');
    }
  } else if (flag === 'adjustment' && next && targets.some((id) => getNodeEffects(id).length === 0)) {
    notify('Adjustment layer is on — add effects to grade layers beneath it');
  }
}

// ── The audio switch (the speaker next to the eye) ────────────────────

/**
 * The speaker, anchored like the other row switches: the clicked row's state
 * decides mute or unmute for every audible layer of the set. `audible` is the
 * row's own "makes sound" test. One `setLayerSwitches{audioEnabled}` entry.
 */
export async function toggleAudioAnchoredEdit(anchorId: string, audible: (id: string) => boolean): Promise<void> {
  const ids = anchoredLayerIds(anchorId).filter((id) => isLayer(id) && audible(id));
  if (ids.length === 0) return;
  const anchor = ids.includes(anchorId) ? anchorId : ids[0]!;
  // Muted anchor → unmute the set (audioEnabled: true), and vice versa.
  const audioEnabled = isLayerAudioMuted(anchor);
  const verb = audioEnabled ? 'Unmute layer audio' : 'Mute layer audio';
  await edit(
    ids.length === 1 ? verb : `${verb} (${ids.length} layers)`,
    ids.map((id) => ({ type: 'setLayerSwitches', layers: [id], patch: { audioEnabled } }) as Command),
  );
}
