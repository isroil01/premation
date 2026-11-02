/**
 * Copy Pose / Paste Pose / Mirror Pose: the same three buttons in the Rig panel
 * and over the canvas (Bone tool, Pose mode). The work is `rigPoseActions`.
 */

import { useMemo } from 'react';
import { Button } from '@components/Button';
import { useMirrorJson } from '@hooks/useMirrorFields';
import { t } from '@core/i18n';
import { mirrorPairs } from '@core/rig/poseMirror';
import type { SkeletonRig } from '@core/rig/skeletonCommands';
import { useRigPoseClipboard } from '@stores/rigPoseClipboard';
import { copyRigPose, mirrorRigPose, pasteRigPose } from './rigPoseActions';

export function RigPoseButtons({ nodeId, seconds }: { nodeId: string; seconds: number }): JSX.Element {
  const rig = useMirrorJson<SkeletonRig>(nodeId, 'layer/skeleton');
  const copied = useRigPoseClipboard((s) => s.pose);
  const canMirror = useMemo(() => mirrorPairs(rig).size > 0, [rig]);
  const canPaste = !!copied && (rig?.bones ?? []).some((b) => copied.bones.has(b.id));
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        title={t('editor.rig.copyPoseHint', 'Copy the pose of the selected bones at the playhead (all bones when none are selected)')}
        onClick={() => { void copyRigPose(nodeId, seconds); }}
      >
        {t('editor.rig.copyPose', 'Copy pose')}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={!canPaste}
        title={t('editor.rig.pastePoseHint', 'Key the copied pose at the playhead')}
        onClick={() => { void pasteRigPose(nodeId, seconds); }}
      >
        {t('editor.rig.pastePose', 'Paste pose')}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={!canMirror}
        title={canMirror
          ? t('editor.rig.mirrorPoseHint', 'Swap left and right at the playhead, for the selected bones or the whole rig. Bones with no opposite stay as they are.')
          : t('editor.rig.mirrorPoseNoSides', 'Needs bones with left and right controllers, as Auto-Rig makes')}
        onClick={() => { void mirrorRigPose(nodeId, seconds); }}
      >
        {t('editor.rig.mirrorPose', 'Mirror pose')}
      </Button>
    </>
  );
}
