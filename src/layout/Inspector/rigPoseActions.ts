/**
 * Copy Pose, Paste Pose and Mirror Pose: the one implementation behind the Rig
 * panel, the canvas buttons and the commands. Each reads the pose the engine
 * resolves at the playhead (`getRigPose`, the bone tracks and goals before IK)
 * and sends its writes as ONE `edit`, one undo entry.
 *
 * Keying differs on purpose. Paste ALWAYS keys: "this pose, at this time" is the
 * whole point, and a static write would move every other time too. Mirror is a
 * pose edit like a drag, so it follows the rig's rule (`rigAutoKey`), with one
 * addition: a property takes a key when it OR ITS OPPOSITE is animated, or a
 * keyed left arm would pour its value into a static right arm for all time.
 */

import { edit } from '@core/engine/uiEdits';
import { engine } from '@core/engine/engineInstance';
import { compTime } from '@core/engine/propRefs';
import { rigPaths } from '@core/engine/rigPaths';
import { jsonField } from '@core/mirror/layerFields';
import { t } from '@core/i18n';
import { mirrorPairs, mirrorPose, poseScope, poseValues, type RigPoseValues } from '@core/rig/poseMirror';
import type { SkeletonRig } from '@core/rig/skeletonCommands';
import { documentMirror } from '@stores/documentMirror';
import { useRigPoseClipboard } from '@stores/rigPoseClipboard';
import { selectedRigBones } from '@stores/rigSelectionStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { isRigAnimated, poseWriteCommands, rigAutoKey } from './rigEdits';

const skeletonOf = (nodeId: string): SkeletonRig | undefined => jsonField<SkeletonRig>(documentMirror(), nodeId, 'layer/skeleton');

const say = (level: 'info' | 'warning', message: string): void => {
  useUIStore.getState().notify({ level, message, durationMs: 3000 });
};

async function livePose(nodeId: string, seconds: number, ids?: ReadonlySet<string>): Promise<RigPoseValues | null> {
  const res = await engine().query({ type: 'getRigPose', layer: nodeId, time: compTime(seconds), points: [] });
  return res.ok ? poseValues(res.value, ids) : null;
}

/** Copy the selected bones' pose at `seconds` (none selected = the whole skeleton). */
export async function copyRigPose(nodeId: string, seconds: number): Promise<void> {
  const rig = skeletonOf(nodeId);
  const scope = poseScope(rig, selectedRigBones(nodeId));
  if (scope.size === 0) return;
  const pose = await livePose(nodeId, seconds, scope);
  if (!pose) return;
  useRigPoseClipboard.getState().copy(pose);
  say('info', pose.bones.size === 1
    ? t('editor.rig.poseCopiedOne', 'Copied the pose of 1 bone')
    : t('editor.rig.poseCopied', 'Copied the pose of {n} bones', { n: pose.bones.size }));
}

/** Does the copied pose name a bone of this rig? */
export function canPasteRigPose(nodeId: string): boolean {
  const pose = useRigPoseClipboard.getState().pose;
  return !!pose && (skeletonOf(nodeId)?.bones ?? []).some((b) => pose.bones.has(b.id));
}

/** Paste the copied pose at `seconds`: a key on each pose property, bones matched by id. */
export async function pasteRigPose(nodeId: string, seconds: number): Promise<void> {
  const pose = useRigPoseClipboard.getState().pose;
  if (!pose) return;
  const current = await livePose(nodeId, seconds);
  if (!current) return;
  const commands = poseWriteCommands(nodeId, seconds, pose, current, {
    animated: (path) => isRigAnimated(nodeId, path),
    keyChanges: true,
    keyAnchors: true,
  });
  if (commands.length === 0) {
    say('warning', t('editor.rig.posePasteNone', 'None of the copied bones are on this layer'));
    return;
  }
  await edit('Paste Pose', commands);
}

/** Can this rig mirror at all? (A rig with no sides has no opposites.) */
export function canMirrorRigPose(nodeId: string): boolean {
  return mirrorPairs(skeletonOf(nodeId)).size > 0;
}

/** Swap left and right at `seconds`, for the pairs the selection touches (none selected = all). */
export async function mirrorRigPose(nodeId: string, seconds: number): Promise<void> {
  const rig = skeletonOf(nodeId);
  if (!rig) return;
  const current = await livePose(nodeId, seconds);
  if (!current) return;
  const target = mirrorPose(rig, current, poseScope(rig, selectedRigBones(nodeId)));
  if (target.bones.size === 0) {
    say('warning', t('editor.rig.poseMirrorNone', 'No bones here have an opposite side. Controller sides decide left and right.'));
    return;
  }
  const opposite = mirrorPairs(rig);
  /** The same property on the opposite bone: replacing the id cannot touch a sibling path. */
  const oppositePath = (path: string): string | undefined => {
    const id = path.split('/')[2];
    const other = id ? opposite.get(id) : undefined;
    return id && other ? path.replace(rigPaths.bone(id), rigPaths.bone(other)) : undefined;
  };
  await edit('Mirror Pose', poseWriteCommands(nodeId, seconds, target, current, {
    animated: (path) => {
      const other = oppositePath(path);
      return isRigAnimated(nodeId, path) || (!!other && isRigAnimated(nodeId, other));
    },
    keyChanges: rigAutoKey(),
    keyAnchors: false,
  }));
}

/** The layer the pose shortcuts act on: the Bone tool in Pose mode, on a layer with a skeleton. */
function poseToolLayer(): string | null {
  const ui = useUIStore.getState();
  const nodeId = useSelectionStore.getState().ids[0];
  if (ui.activeTool !== 'bone' || ui.boneRigMode !== 'pose' || !nodeId) return null;
  return (skeletonOf(nodeId)?.bones ?? []).length > 0 ? nodeId : null;
}

/** Ctrl+C copies a pose: bones are selected in Pose mode and no keyframes are (those keep the chord). */
export function poseCopyTarget(): string | null {
  const nodeId = poseToolLayer();
  if (!nodeId || selectedRigBones(nodeId).length === 0) return null;
  return useKeyframeSelectionStore.getState().ids.size > 0 ? null : nodeId;
}

/** Ctrl+V pastes a pose: in Pose mode, with a copied pose this rig can take. */
export function posePasteTarget(): string | null {
  const nodeId = poseToolLayer();
  return nodeId && canPasteRigPose(nodeId) ? nodeId : null;
}
