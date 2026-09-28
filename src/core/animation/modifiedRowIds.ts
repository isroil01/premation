/**
 * AE's UU rule, pure (modifiedProps.ts reads a layer and feeds it): a Transform group is modified
 * when any member is animated / expressed or set away from its default (Position's default is the
 * comp centre in the parent's space); every other animated property is its own row. The ids are the
 * timeline's row ids.
 */

import { POSITION_PSEUDO_PROP } from '@motion/animation';

/** The timeline's Transform group placeholder row (propertyMeta.groupPlaceholderPath). */
const groupRow = (key: string): string => `__static:${key}`;

export const TRANSFORM_GROUPS: ReadonlyArray<{ key: string; members: ReadonlyArray<string> }> = [
  { key: 'anchor', members: ['anchorX', 'anchorY', 'anchorZ'] },
  { key: 'position', members: ['x', 'y', 'z'] },
  { key: 'scale', members: ['scaleX', 'scaleY', 'scaleZ', 'scale'] },
  { key: 'rotation', members: ['rotation', 'rotationX', 'rotationY'] },
  { key: 'orientation', members: ['orientationX', 'orientationY', 'orientationZ'] },
  { key: 'opacity', members: ['opacity'] },
];

/**
 * A transform prop's default, per the centred-origin convention new layers are
 * born with: position at the composition centre (in the layer's parent space),
 * scale 1 (100 %), opacity 100 %, everything else 0.
 */
export function transformDefault(prop: string, centre: { x: number; y: number }): number {
  if (prop === 'x') return centre.x;
  if (prop === 'y') return centre.y;
  if (prop === 'scaleX' || prop === 'scaleY' || prop === 'scaleZ' || prop === 'scale') return 1;
  if (prop === 'opacity') return 100;
  return 0;
}

const EPS = 1e-6;

export interface ModifiedInput {
  /** Static values the layer carries, by prop. Absent = never set = default. */
  values: Readonly<Record<string, number | undefined>>;
  /** Props that are keyframed or expression-driven. */
  animated: ReadonlySet<string>;
  /** The composition centre in the layer's parent space. */
  centre: { x: number; y: number };
}

/** Row ids AE's UU reveals for one layer's TRANSFORM group and animated rows. */
export function modifiedRowIds(input: ModifiedInput): string[] {
  const out = new Set<string>();
  const inGroups = new Set<string>();
  for (const group of TRANSFORM_GROUPS) {
    let modified = false;
    for (const m of group.members) {
      inGroups.add(m);
      if (input.animated.has(m)) { modified = true; continue; }
      const v = input.values[m];
      if (typeof v === 'number' && Math.abs(v - transformDefault(m, input.centre)) > EPS) modified = true;
    }
    if (!modified) continue;
    out.add(groupRow(group.key));
    for (const m of group.members) out.add(m);
    if (group.key === 'position') out.add(POSITION_PSEUDO_PROP);
  }
  // Every other animated / expressed property is its own row (effect params,
  // text animators, audio levels…).
  for (const p of input.animated) if (!inGroups.has(p)) out.add(p);
  return [...out];
}
