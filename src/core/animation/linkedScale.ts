/**
 * After Effects' Constrain Proportions: with Scale linked, changing one
 * dimension multiplies the others by the same factor, so 100 x 50 taken to 200
 * in X lands on 200 x 100 rather than 200 x 200.
 *
 * Pure, so the timeline and the inspector share one rule. A scrub passes the
 * values from the START of the gesture: reading the live ones would lose the
 * ratio for good the moment a drag crossed zero.
 */

const SCALE_MEMBERS: ReadonlySet<string> = new Set(['scaleX', 'scaleY', 'scaleZ']);

/** Whether a track is one of a layer's Scale dimensions. */
export function isScaleMember(prop: string): boolean {
  return SCALE_MEMBERS.has(prop);
}

/**
 * The other property's value once `from` has become `to`. From zero there is
 * no ratio to keep, so the other side takes the edited number, which is what
 * lets a layer scaled to 0 be scaled back up at all.
 */
export function linkedValue(from: number, to: number, other: number): number {
  return Math.abs(from) < 1e-9 ? to : other * (to / from);
}

/** Every dimension's value after `edited` is set to `next`; `basis` names the dimensions the property has. */
export function linkedScaleValues(
  edited: string,
  next: number,
  basis: Readonly<Record<string, number>>,
): Record<string, number> {
  const from = basis[edited] ?? 0;
  const out: Record<string, number> = {};
  for (const [member, value] of Object.entries(basis)) {
    out[member] = member === edited ? next : linkedValue(from, next, value);
  }
  out[edited] = next;
  return out;
}
