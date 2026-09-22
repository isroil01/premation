/**
 * Property paths — how every value inside a layer is addressed (ENGINE_API.md §3.4).
 *
 *   transform/position            transform/position/x (separated dimension)
 *   effects/<effectId>/<param>    effects/<effectId>/<param>/<channel> never exists: colours are one Value
 *   masks/<maskId>/path           masks/<maskId>/feather
 *   text/sourceText               text/animators/<animatorId>/props/<prop>
 *   text/animators/<animatorId>/selectors/<selectorId>/<param>
 *   contents/<groupId>/contents/<groupId>/<param>      (shape layers)
 *   styles/<styleId>/<param>      material/<param>     geometry/<param>
 *   camera/<param>  light/<param>  audio/<param>  timeRemap
 *   paint/<strokeId>/<param>      puppet/<pinId>/<param>
 *
 * Groups (effects, masks, animators, selectors, shape groups, styles, strokes,
 * pins) are addressed by their stable GroupId, never by index, so deleting one
 * never re-points another's keyframes.
 */

export const PROP_ROOTS = [
  'transform',
  'effects',
  'masks',
  'text',
  'contents',
  'styles',
  'material',
  'geometry',
  'camera',
  'light',
  'audio',
  'paint',
  'puppet',
  'timeRemap',
  'layer',
  'plugin',
] as const;

export type PropRoot = (typeof PROP_ROOTS)[number];

const ROOTS: ReadonlySet<string> = new Set(PROP_ROOTS);

/** Join segments into a path, refusing empty segments and embedded separators. */
export function propPath(root: PropRoot, ...segments: string[]): string {
  for (const s of segments) {
    if (s.length === 0 || s.includes('/')) throw new RangeError(`invalid property path segment: '${s}'`);
  }
  return segments.length ? `${root}/${segments.join('/')}` : root;
}

/** Split a path; null when it is malformed or its root is unknown. */
export function parsePropPath(path: string): { root: PropRoot; segments: string[] } | null {
  const parts = path.split('/');
  const root = parts[0]!;
  if (!ROOTS.has(root)) return null;
  const segments = parts.slice(1);
  if (segments.some((s) => s.length === 0)) return null;
  return { root: root as PropRoot, segments };
}
