/**
 * Character rig (Tier 1) edits: Rig Character, Bind to Bone, Detach from Bone.
 * Each is ONE engine command (one undo entry); the engine keeps every part's
 * world transform (core/handlers_character.cpp).
 */
import { edit } from '@core/engine/uiEdits';
import { t } from '@core/i18n';

/** Group `layers` into a new character and rig it (a bone per part, IK legs, controllers). The new id, or null. */
export async function rigCharacter(layers: readonly string[], name?: string): Promise<string | null> {
  if (layers.length === 0) return null;
  const r = await edit(t('character.rigCharacter', 'Rig Character'), {
    type: 'createCharacter',
    layers: [...layers],
    name: name ?? t('character.defaultName', 'Character'),
  });
  if (!r.ok) return null;
  const v = r.value[0] as { layer?: string } | undefined;
  return v?.layer ?? null;
}

/** Make `layers` parts of `character` following `bone` (null = detach: they stay in the character, on no bone). */
export function bindToBone(layers: readonly string[], character: string, bone: string | null): void {
  if (layers.length === 0) return;
  void edit(bone ? t('character.bindToBone', 'Bind to Bone') : t('character.detachFromBone', 'Detach from Bone'), {
    type: 'bindToBone',
    layers: [...layers],
    character,
    ...(bone ? { bone } : {}),
  });
}
