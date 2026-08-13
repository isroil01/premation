/**
 * Icon system — Material Symbols Sharp, weight 700.
 *
 * The app-wide API is unchanged (`<Icon name="play" size="md" />`) and the
 * `IconName` union is stable, so every call site keeps working.
 *
 * WHY THIS SET. "Sharp" here is the family's own design axis, not a rendering
 * option: the glyphs are drawn with zero corner radius, and weight 700 is the
 * heaviest grade, so both the sharpness and the boldness are GEOMETRY. That
 * matters because the obvious alternative does not work — stroke-outline
 * families (Lucide, Tabler, and the Phosphor set this replaced) bake their
 * corner rounding into the path data as arc segments, so `stroke-linejoin`
 * cannot sharpen them. Measured on the glyphs this app actually uses, 15 of 19
 * Lucide and 11 of 16 Tabler shape marks round their corners in the path. There
 * is no attribute that makes a rounded set sharp; you have to draw from a sharp
 * one.
 *
 * WHY PATHS AND NOT COMPONENTS. The set is a devDependency, not a runtime one.
 * `scripts/generate-sharp-icons.mjs` extracts the 171 paths this app uses into
 * `sharpIconPaths.ts`, so nothing ships but the glyphs actually drawn — where
 * before an icon PACKAGE was in the bundle, and each of its components carried
 * all six of its weight variants to draw one.
 *
 * Everything is a filled path, which is also why there is no stroke width to
 * tune and nothing to go blurry: at 13px a filled contour is still a contour.
 */

import { memo, type CSSProperties } from 'react';

import { usePreferenceStore } from '@stores/preferenceStore';

import { ICON_NAMES, type IconName } from './iconNames';
import { SHARP_ICON_PATHS, SHARP_ICON_VIEWBOX } from './sharpIconPaths';

// The vocabulary itself lives in `iconNames.ts` — pure data, no React — so the
// plugin manifest validator can check a third-party icon name without importing
// a component. Re-exported here so `@components/Icon` stays the single import
// site for everything else.
export { ICON_NAMES };
export type { IconName };

/**
 * Kept as the union the old Phosphor-backed API exposed, because call sites
 * spell these strings and there is no reason to churn them.
 *
 * What it SELECTS is different. This family varies FILL, not stroke, so there
 * are two grades rather than six, and the names are bucketed onto them by what
 * they were reaching for: the heavy names draw the solid grade, the light names
 * draw the outline. `weight="bold"` therefore still means "heavier than usual"
 * even though no stroke is involved.
 *
 * The DEFAULT is solid. An outline set at this weight reads as chrome you look
 * past; the solid grade is what makes a 15px glyph land as an object on the
 * row. Outline is still one prop away where a control wants to recede.
 */
export type IconWeight = 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';

const OUTLINE_WEIGHTS = new Set<IconWeight>(['thin', 'light', 'regular']);

/**
 * The icon scale. THREE sizes, and that is the whole point.
 *
 * Before this there was no icon token at all, so every call site guessed and
 * the app ended up with twenty distinct sizes — including 9, 10, 11, 12 and 13
 * all doing the same job of "a glyph on a row", separated by a pixel each. That
 * is not a design decision made twenty times, it is the absence of one: there
 * was nothing to be consistent WITH.
 *
 * Named rather than numeric at the call site, because `size="sm"` states intent
 * and `size={13}` states a measurement — and a measurement is what drifts. The
 * numeric form still works for the handful of DISPLAY graphics (empty-state art,
 * the 320px logo) that are not chrome and do not belong on a chrome scale.
 *
 * `sizeScaleGuard.test.ts` fails on any new numeric size in the chrome band,
 * and pins these three numbers so that moving the scale is a decision rather
 * than a drift.
 *
 * The scale moved up from 13/16/22 with the switch to this family, because the
 * same number no longer buys the same glyph. Material draws inside a 960 box
 * with roughly 95 units of margin, so its artwork fills about 80% of the size
 * it is given, where the stroke-outline set before it ran nearly edge to edge.
 * Matching the old OPTICAL size therefore takes a larger box. Trimming the
 * viewBox instead would have been free, and was measured first — but `deselect`,
 * `mask-square` and `folder-open` do reach all four edges, so there is no
 * uniform margin to reclaim without clipping them.
 */
export const ICON_SIZE = {
  /** Row glyphs, tree twisties, inline chips. */
  sm: 15,
  /** Toolbar and panel buttons, asset type icons. */
  md: 18,
  /** Empty states, section headers. */
  lg: 25,
} as const;

export type IconSizeName = keyof typeof ICON_SIZE;

export interface IconProps {
  name: IconName;
  /** A scale name (preferred) or a raw px number for display graphics. */
  size?: number | IconSizeName;
  weight?: IconWeight;
  className?: string;
  style?: CSSProperties;
  title?: string;
  onClick?: () => void;
  'aria-label'?: string;
}

function IconInner({
  name,
  size = 'md',
  weight = 'fill',
  className,
  style,
  title,
  onClick,
  'aria-label': ariaLabel,
}: IconProps): JSX.Element {
  const iconScale = usePreferenceStore((s) => s.iconSize);
  const scaleMult = iconScale === 'sm' ? 0.82 : iconScale === 'lg' ? 1.25 : 1.0;
  const basePx = typeof size === 'number' ? size : ICON_SIZE[size];
  const computedSize = Math.max(10, Math.round(basePx * scaleMult));

  const mergedStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: computedSize,
    height: computedSize,
    minWidth: computedSize,
    minHeight: computedSize,
    maxWidth: computedSize,
    maxHeight: computedSize,
    flexShrink: 0,
    color: 'currentColor',
    lineHeight: 1,
    verticalAlign: 'middle',
    overflow: 'hidden',
    ...style,
  };

  // The AI mark is a WORDMARK, not a glyph from the set — it spells the product
  // affordance rather than picturing it, so it is drawn here. Its frame is
  // square-cornered to sit in the same visual language as everything else.
  if (name === 'ai') {
    return (
      <span
        className={className}
        style={mergedStyle}
        onClick={onClick}
        aria-label={ariaLabel ?? title}
        aria-hidden={(ariaLabel ?? title) ? undefined : true}
      >
        <svg width={computedSize} height={computedSize} viewBox="0 0 34 34" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M22.9417 11.8835C23.7621 11.8835 24.4272 11.2184 24.4272 10.3981C24.4272 9.57767 23.7621 8.91262 22.9417 8.91262C22.1214 8.91262 21.4563 9.57767 21.4563 10.3981C21.4563 11.2184 22.1214 11.8835 22.9417 11.8835Z" />
          <path fillRule="evenodd" clipRule="evenodd" d="M7.26214 25.0874L11.8835 9.24272H14.6893L19.4757 25.0874H16.835L15.5146 20.6311H11.0583L9.57281 25.0874H7.26214ZM11.5534 18.1553L13.2039 11.8835L14.8544 18.1553H11.5534Z" />
          <path d="M21.6214 13.3689V25.0874H24.2621V13.3689H21.6214Z" />
          {/* Outer contour clockwise, inner counter-clockwise, so nonzero
              punches the middle out as a hole rather than filling the box. */}
          <path d="M0 0h34v34H0z M1.65 1.65v30.7h30.7V1.65z" />
        </svg>
      </span>
    );
  }

  const glyph = SHARP_ICON_PATHS[name] ?? SHARP_ICON_PATHS.square;
  return (
    <span
      className={className}
      style={mergedStyle}
      onClick={onClick}
      aria-label={ariaLabel ?? title}
      aria-hidden={(ariaLabel ?? title) ? undefined : true}
    >
      <svg
        width={computedSize}
        height={computedSize}
        viewBox={SHARP_ICON_VIEWBOX}
        fill="currentColor"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d={OUTLINE_WEIGHTS.has(weight) ? glyph.d : glyph.fill} />
      </svg>
    </span>
  );
}

export const Icon = memo(IconInner);
