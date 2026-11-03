import { useEffect } from 'react';
import { useMirrorLayer } from '@hooks/useMirror';
import { useRigSelectionStore } from '@stores/rigSelectionStore';

/**
 * The layer whose rig the Bone tool and the Rigging panel edit for the picked
 * layer `picked`: the picked layer itself, or — for a PART of a character (a
 * layer that follows one of its character's bones) — the character, with the
 * part's bone selected. Picking an arm in the Layers tree or on the canvas
 * then edits the arm's bone, with no hunt for its character.
 */
export function useRigTarget(picked: string | null | undefined): string | null {
  const layer = useMirrorLayer(picked ?? null);
  const character = layer?.parentBone && layer.parent ? layer.parent : null;
  const bone = character ? layer?.parentBone ?? null : null;

  useEffect(() => {
    if (!character || !bone) return;
    const rig = useRigSelectionStore.getState();
    // A pick of the part selects its bone once; a bone picked since on the character stays.
    if (rig.nodeId === character && rig.boneIds.includes(bone)) return;
    rig.selectBone(character, bone);
  }, [character, bone]);

  return character ?? picked ?? null;
}
