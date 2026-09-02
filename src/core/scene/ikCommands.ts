/**
 * 3D IK as palette commands.
 *
 * The interaction is selection-driven rather than modal: select the chain's
 * TIP joint first, then Ctrl/Cmd-click the TARGET layer, and run the command.
 * The chain is discovered by walking the tip's 3D ancestors (stopping at an
 * imported model's root), which is exactly the shape a glTF skeleton imports
 * as — but any parented stack of 3D nulls works.
 *
 * "Bake" solves per frame across the composition and lands real rotation
 * keyframes (see boneIK3d.ts); "Pose" is the one-shot version for stills.
 *
 * Both actions live in `poseIk3DAtTarget` / `bakeIk3DToTarget` rather than in
 * the command bodies, because the inspector's "3D IK" section runs the same
 * two things from an explicitly picked target instead of a two-layer
 * selection. Keeping them here — target resolution, solve, notification —
 * means the panel and the palette cannot drift (ikCommands.test.ts pins that
 * they produce identical joint values).
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from './DefaultSceneGraph';
import { ikChainFromTip, applyIk3D, bakeIk3D, type IkOptions } from './boneIK3d';
import { nodeWorldWithParents3d } from './liveWorld3d';

const notify = (level: 'success' | 'warning', message: string): void => {
  useUIStore.getState().notify({ level, message, durationMs: level === 'warning' ? 6000 : 4500 });
};

/** [tipId, targetId, chain] from the selection, or a warning string. */
function readIkSelection(): { tip: string; target: string; chain: string[] } | string {
  const ids = useSelectionStore.getState().ids;
  if (ids.length !== 2) return 'Select the chain tip first, then Ctrl/Cmd-click the target layer.';
  const [tip, target] = [ids[0]!, ids[1]!];
  const chain = ikChainFromTip(tip);
  if (chain.length < 2) {
    return 'The first-selected layer needs at least one 3D parent to form a chain.';
  }
  return { tip, target, chain };
}

function currentTime(): number {
  const project = useProjectStore.getState();
  const tab = project.activeTabId ? project.tabs[project.activeTabId] : null;
  return tab?.time ?? 0;
}

/**
 * Pose the chain at `targetId` once, at the playhead, and notify.
 *
 * THE one-shot IK entry point: the palette command and the inspector's "3D IK"
 * panel both call it, so a fix to either surface's behaviour cannot land on
 * only one of them. It is deliberately more than `applyIk3D` — resolving the
 * target layer's world origin and reporting the outcome is the part that was
 * previously trapped inside a command body.
 */
export function poseIk3DAtTarget(chain: string[], targetId: string, opts?: IkOptions): boolean {
  const t = currentTime();
  const targetNode = defaultSceneGraph.getNode(targetId);
  const m = targetNode ? nodeWorldWithParents3d(targetNode, t) : null;
  if (!m) { notify('warning', 'The target layer has no resolvable 3D position.'); return false; }
  const ok = applyIk3D(chain, { x: m[12]!, y: m[13]!, z: m[14]! }, t, opts);
  notify(ok ? 'success' : 'warning', ok
    ? `Posed ${chain.length - 1} joint${chain.length === 2 ? '' : 's'} toward the target.`
    : 'Could not resolve the chain.');
  return ok;
}

/**
 * Bake the chain against `targetId` across the whole composition and notify.
 * The bake twin of {@link poseIk3DAtTarget}; returns the frame count (0 = the
 * chain or target failed to resolve).
 */
export function bakeIk3DToTarget(chain: string[], targetId: string, opts?: IkOptions): number {
  const comp = useCompositionStore.getState();
  const fps = comp.fps > 0 ? comp.fps : 30;
  const frames = bakeIk3D(chain, targetId, 0, Math.max(0, comp.durationSeconds), fps, opts);
  notify(frames > 0 ? 'success' : 'warning', frames > 0
    ? `Baked IK: ${frames} frames of rotation keyframes on ${chain.length - 1} joint${chain.length === 2 ? '' : 's'}.`
    : 'Could not bake — chain or target failed to resolve.');
  return frames;
}

export function buildIk3DCommands(): ReadonlyArray<Command> {
  return [
    {
      id: asCommandId('scene.ikPose3d'),
      label: 'Pose 3D IK Chain at Target',
      description:
        'Aim a chain of parented 3D layers (an imported skeleton’s joints, or any 3D nulls) '
        + 'at the second-selected layer, once, at the playhead. Select tip, then target.',
      icon: 'crosshair',
      enabled: () => useSelectionStore.getState().ids.length === 2,
      execute: () => {
        const sel = readIkSelection();
        if (typeof sel === 'string') { notify('warning', sel); return; }
        poseIk3DAtTarget(sel.chain, sel.target);
      },
    },
    {
      id: asCommandId('scene.ikBake3d'),
      label: 'Bake 3D IK to Target (whole comp)',
      description:
        'Solve the chain against the second-selected layer’s ANIMATED position every frame '
        + 'and bake rotation keyframes onto the joints. Select tip, then target.',
      icon: 'crosshair',
      enabled: () => useSelectionStore.getState().ids.length === 2,
      execute: () => {
        const sel = readIkSelection();
        if (typeof sel === 'string') { notify('warning', sel); return; }
        bakeIk3DToTarget(sel.chain, sel.target);
      },
    },
  ];
}
