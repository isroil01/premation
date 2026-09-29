/**
 * 3D IK as palette commands (B4 round 8): select the chain's TIP joint, then
 * Ctrl/Cmd-click the TARGET layer, and run. The chain is the tip's run of 3D
 * ancestors off the document mirror (`mirrorIkChainFromTip`); the solve is the
 * engine's `poseIk3D` (at the playhead) / `bakeIk3D` (the whole composition),
 * the same commands the Inspector's 3D IK section sends.
 */

import { asCommandId } from '@app-types/common';
import { flicksToSeconds } from '@motion/engine-api';
import type { Command } from '@core/commands/Command';
import { mirrorIkChainFromTip } from '@core/mirror/layerFacts';
import { documentMirror } from '@stores/documentMirror';
import { getTime } from '@stores/playbackClockStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { activeCompIdNow } from '@hooks/useMirror';
import { bakeIk3DEdit, poseIk3DEdit } from '@layout/Inspector/ikEdits';

const notify = (level: 'success' | 'warning', message: string): void => {
  useUIStore.getState().notify({ level, message, durationMs: level === 'warning' ? 6000 : 4500 });
};

/** [chain, target] from a two-layer selection (tip first), or the warning to show. */
function readIkSelection(): { target: string; chain: string[] } | string {
  const ids = useSelectionStore.getState().ids;
  if (ids.length !== 2) return 'Select the chain tip first, then Ctrl/Cmd-click the target layer.';
  const chain = mirrorIkChainFromTip(documentMirror(), ids[0]!);
  if (chain.length < 2) return 'The first-selected layer needs at least one 3D parent to form a chain.';
  return { chain, target: ids[1]! };
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
        void poseIk3DEdit(sel.chain, sel.target, getTime()).then((ok) => {
          const joints = sel.chain.length - 1;
          if (ok) notify('success', `Posed ${joints} joint${joints === 1 ? '' : 's'} toward the target.`);
        });
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
        const comp = activeCompIdNow();
        const duration = comp ? flicksToSeconds(documentMirror().comp(comp)?.settings.duration ?? 0) : 0;
        void bakeIk3DEdit(sel.chain, sel.target, 0, Math.max(0, duration)).then((frames) => {
          const joints = sel.chain.length - 1;
          notify(frames > 0 ? 'success' : 'warning', frames > 0
            ? `Baked IK: ${frames} frames of rotation keyframes on ${joints} joint${joints === 1 ? '' : 's'}.`
            : 'Could not bake — chain or target failed to resolve.');
        });
      },
    },
  ];
}
