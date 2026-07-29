/**
 * Collision-free authoring ids for puppet pins and skeleton bones.
 *
 * WHY: ids used to come from `Date.now` — `pin_${Date.now}` in the puppet
 * overlay, `pin_${now}_${i}` in the AI tool and the starter rig, and
 * `bone_${Date.now.toString(36).slice(2, 8)}` in the bone overlay. Two pins
 * added inside the same millisecond got the SAME id, and the bone form was
 * worse: a 6-character slice of a base-36 timestamp, where the leading digits
 * barely move between calls.
 *
 * A collision is silent and destructive. Pin and bone ids key their animation
 * tracks (`puppet.<pinId>.position`, `bone.<boneId>.rotation`, …), so two
 * colliding pins share one set of keyframes: animating one moves both, and
 * deleting one wipes the other's animation.
 *
 * These ids only need to be unique WITHIN a layer's rig, so we pick the lowest
 * free ordinal for the prefix. That is:
 *   • collision-free by construction — membership is checked, not assumed;
 *   • stable across save/load — a reopened document's existing ids are the
 *     `used` set, so nothing is reissued;
 *   • readable — `pin_1`, `bone_3`, not a 13-digit timestamp;
 *   • deterministic — no clock, no randomness, no module-global counter, so the
 *     same rig state always yields the same next id.
 *
 * Legacy timestamp ids keep working untouched: they simply occupy the `used`
 * set without blocking the short ordinals.
 */

/** Lowest `<prefix><n>` (n >= 1) not present in `used`. */
export function nextRigId(prefix: string, used: Iterable<string>): string {
  const taken = used instanceof Set ? used : new Set(used);
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/**
 * `count` fresh ids in one go — each reserved against the previous ones, so a
 * batch (a starter rig, an AI-authored rig) never collides internally.
 */
export function nextRigIds(prefix: string, used: Iterable<string>, count: number): string[] {
  const taken = new Set(used);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = nextRigId(prefix, taken);
    taken.add(id);
    out.push(id);
  }
  return out;
}

/** Ids already in use by a rig's pins / bones (undefined-safe). */
export function usedRigIds(items: ReadonlyArray<{ id: string }> | undefined): Set<string> {
  return new Set((items ?? []).map((it) => it.id));
}
