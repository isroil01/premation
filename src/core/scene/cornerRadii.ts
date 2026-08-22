/**
 * Per-corner border radii (TL → TR → BR → BL), CSS / Figma order.
 *
 * `cornerRadius` remains the uniform/"All" value for backward compatibility.
 * Optional `cornerRadiusTL|TR|BR|BL` override individual corners; missing
 * corners fall back to `cornerRadius`.
 */

export type CornerRadiiTuple = readonly [number, number, number, number];

export const CORNER_RADIUS_KEYS = [
  'cornerRadiusTL',
  'cornerRadiusTR',
  'cornerRadiusBR',
  'cornerRadiusBL',
] as const;

export type CornerRadiusKey = (typeof CORNER_RADIUS_KEYS)[number];

export interface CornerRadiiProps {
  cornerRadius?: number;
  cornerRadiusTL?: number;
  cornerRadiusTR?: number;
  cornerRadiusBR?: number;
  cornerRadiusBL?: number;
  /** When true (default), Appearance treats corners as linked. */
  cornersLinked?: boolean;
}

export function uniformCornerRadii(r: number): CornerRadiiTuple {
  const v = Math.max(0, r);
  return [v, v, v, v];
}

export function isUniformCornerRadii(r: CornerRadiiTuple): boolean {
  return r[0] === r[1] && r[1] === r[2] && r[2] === r[3];
}

export function resolveCornerRadii(props: CornerRadiiProps): CornerRadiiTuple {
  const base = Math.max(0, props.cornerRadius ?? 0);
  const n = (v: number | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : base;
  return [
    n(props.cornerRadiusTL),
    n(props.cornerRadiusTR),
    n(props.cornerRadiusBR),
    n(props.cornerRadiusBL),
  ];
}

/**
 * CSS border-radius clamping: adjacent corners on an edge must not sum past
 * that edge's length — otherwise the path self-intersects.
 */
export function clampCornerRadii(
  width: number,
  height: number,
  radii: CornerRadiiTuple,
): CornerRadiiTuple {
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  let [tl, tr, br, bl] = radii;
  tl = Math.max(0, tl);
  tr = Math.max(0, tr);
  br = Math.max(0, br);
  bl = Math.max(0, bl);
  const scale = (a: number, b: number, limit: number): number => {
    const sum = a + b;
    if (sum <= limit || sum <= 1e-6) return 1;
    return limit / sum;
  };
  const s = Math.min(
    scale(tl, tr, w),
    scale(tr, br, h),
    scale(br, bl, w),
    scale(bl, tl, h),
    1,
  );
  return [tl * s, tr * s, br * s, bl * s];
}

/** True when at least one corner differs from the others (needs 4-radii draw). */
export function hasIndependentCornerRadii(radii: CornerRadiiTuple): boolean {
  return !isUniformCornerRadii(radii) && radii.some((r) => r > 0.5);
}

export function cornersAreLinked(props: CornerRadiiProps): boolean {
  if (typeof props.cornersLinked === 'boolean') return props.cornersLinked;
  // Legacy docs only store `cornerRadius` — treat as linked.
  const hasIndividual = CORNER_RADIUS_KEYS.some((k) => {
    const v = props[k];
    return typeof v === 'number' && Number.isFinite(v);
  });
  if (!hasIndividual) return true;
  return isUniformCornerRadii(resolveCornerRadii(props));
}
