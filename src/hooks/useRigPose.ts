/**
 * A layer's rig as the ENGINE resolves it at a time (`getRigPose`, B4 round 5,
 * ENGINE_API.md §15.14): the live and solved bone pose, every IK goal with its
 * chain mode, and one vertex's bind weights — what the Rigging panel shows and
 * plans its IK/FK switch from. Asked again when the layer's header, property
 * tree or keys change in the mirror, or the time / vertex change (the panel's
 * throttled workspace time — never per played frame). Undefined until the first
 * answer lands; while a new answer is on its way the previous one for the same
 * layer stays.
 */

import { useEffect, useState } from 'react';
import type { RigPose } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { compTime } from '@core/engine/propRefs';
import { useMirrorKeys } from './useMirror';

export function useRigPose(layer: string | null | undefined, seconds: number, vertex: number | null = null): RigPose | undefined {
  const rev = useMirrorKeys(layer ? [`layer:${layer}`, `tree:${layer}`, `keys:${layer}`] : []);
  const [answer, setAnswer] = useState<{ layer: string; pose: RigPose } | null>(null);
  useEffect(() => {
    if (!layer) return undefined;
    let live = true;
    void engine()
      .query({ type: 'getRigPose', layer, time: compTime(seconds), points: [], ...(vertex !== null ? { vertex } : {}) })
      .then((res) => {
        if (live && res.ok) setAnswer({ layer, pose: res.value });
      });
    return () => {
      live = false;
    };
  }, [layer, rev, seconds, vertex]);
  return answer && answer.layer === layer ? answer.pose : undefined;
}
