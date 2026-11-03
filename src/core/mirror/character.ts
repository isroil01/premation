/**
 * Character rig (Tier 1): a CHARACTER is a group layer whose skeleton has bones
 * (`LayerInfo.character`); its PARTS are the group's children, each following
 * one bone (`LayerInfo.parentBone`). The engine places the parts
 * (core/bone_link.hpp); these helpers only name things for the UI.
 */
import type { LayerInfo } from '@motion/engine-api';

/** The slice of a stored skeleton the UI names bones from. */
export interface CharacterSkeleton {
  bones?: ReadonlyArray<{ id: string; name?: string; parentId?: string | null }>;
}

export interface CharacterBone {
  id: string;
  /** The bone's name, else its id. */
  label: string;
  /** Nesting depth under the root (the picker indents by it). */
  depth: number;
}

/** True when `layer` is a character (a group with bones). */
export function isCharacter(layer: Pick<LayerInfo, 'character'> | null | undefined): boolean {
  return layer?.character === true;
}

/** The character's bones, parents before their children, each with its depth. */
export function characterBones(skel: CharacterSkeleton | null | undefined): CharacterBone[] {
  const bones = skel?.bones ?? [];
  const ids = new Set(bones.map((b) => b.id));
  const children = new Map<string | null, typeof bones[number][]>();
  for (const b of bones) {
    const p = b.parentId && ids.has(b.parentId) ? b.parentId : null;
    const list = children.get(p) ?? [];
    list.push(b);
    children.set(p, list);
  }
  const out: CharacterBone[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number): void => {
    for (const b of children.get(parent) ?? []) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push({ id: b.id, label: b.name || b.id, depth });
      walk(b.id, depth + 1);
    }
  };
  walk(null, 0);
  // A bone on a parent cycle never hangs from the root: list it last rather than lose it.
  for (const b of bones) if (!seen.has(b.id)) out.push({ id: b.id, label: b.name || b.id, depth: 0 });
  return out;
}

/** The label of bone `id` in `skel`, else the id itself. */
export function boneLabel(skel: CharacterSkeleton | null | undefined, id: string): string {
  const b = skel?.bones?.find((x) => x.id === id);
  return b?.name || id;
}
