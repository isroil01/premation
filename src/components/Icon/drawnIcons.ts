/**
 * Hand-drawn glyphs — the tool, 3D-scene and chrome icons.
 *
 * WHY THESE ARE NOT FROM THE SET. A tool icon has to picture the TOOL, and the
 * Material family has no pen nib with a plus, no puppet pin, no bone, no mask
 * matte; the stand-ins it offered (a bare plus for Add Vertex, scissors for the
 * Knife, a map arrow for Direct Selection) each meant something else. These are
 * drawn as one family instead, in the manner of After Effects' own tool bar.
 *
 * THE GRID. 18 x 18, which is the toolbar's `md` icon size, so one unit is one
 * pixel where these are mostly seen. 1.5 outlines with round joins; solid only
 * where the object itself is solid (the selection arrow, the type T, the mask
 * mattes, gizmo handles). The wrapper <svg> in Icon.tsx supplies
 * `fill="none" stroke="currentColor" stroke-width="1.5"` and round caps and
 * joins; an element overrides those only where it differs.
 *
 * Each value is the INNER markup of that <svg>. It is authored here and never
 * built from input, which is what makes handing it to the parser as markup
 * acceptable. A name listed here is skipped by scripts/generate-sharp-icons.mjs,
 * so no Material path ships for a glyph that is never drawn — run
 * `npm run icons:generate` after adding or removing a key.
 *
 * One grade only: there is no outline/solid pair for `weight` to choose between.
 */

import type { IconName } from './iconNames';

export const DRAWN_ICON_VIEWBOX = '0 0 18 18';

const GLYPHS = {
  // Selection & navigation
  'mouse-pointer': '<path fill="currentColor" stroke="none" d="M4 1.8 V14.9 L7.3 11.9 L9.5 16.6 L11.6 15.6 L9.4 11 H13.8 Z"/>',
  'direct-select': '<path stroke-width="1.3" d="M4.6 3.3 V13.5 L7.5 10.9 L9.7 15.6 L11 15 L8.8 10.3 H12.4 Z"/>',
  'rotate': '<path d="M15 9 A6 6 0 1 1 12 3.8"/><path fill="currentColor" stroke="none" d="M10.9 1.6 L14.9 4.6 L10.6 6.2 Z"/>',
  'pan-behind': '<rect x="2.75" y="2.75" width="12.5" height="12.5" stroke-dasharray="2.2 2.2" stroke-linecap="butt" stroke-width="1.2"/><circle cx="9" cy="9" r="2.1"/><path d="M9 5 V6.9 M9 11.1 V13 M5 9 H6.9 M11.1 9 H13"/>',
  'hand': '<path d="M5.3 9.6 V4.7 a1.1 1.1 0 0 1 2.2 0 V8.2 M7.5 8.2 V3.3 a1.15 1.15 0 0 1 2.3 0 V8.2 M9.8 8.2 V4 a1.15 1.15 0 0 1 2.3 0 V8.6 M12.1 8.6 V6 a1.1 1.1 0 0 1 2.2 0 V11 c0 3 -2 5.2 -5 5.2 h-.9 c-1.6 0 -2.7 -.6 -3.6 -1.7 L2.7 11.7 a1.15 1.15 0 0 1 1.7 -1.5 L5.3 11.3 V9.6"/>',
  'zoom-in': '<circle cx="7.75" cy="7.75" r="5"/><path d="M11.5 11.5 L15.75 15.75"/><path d="M7.75 5.6 V9.9 M5.6 7.75 H9.9" stroke-width="1.3"/>',

  // Pen & paint
  'pen': '<g transform="translate(-.5 .5) rotate(45 9 9)"><path d="M9 16.2 L5.5 9.8 L6.9 5.2 H11.1 L12.5 9.8 Z"/><path d="M9 16.2 V11"/><circle cx="9" cy="9.7" r="1.15"/><path d="M6.9 5.2 V2.6 H11.1 V5.2"/></g>',
  'pencil': '<g transform="translate(-.5 .5) rotate(45 9 9)"><path d="M7 2 H11 V11.8 L9 16.4 L7 11.8 Z"/><path d="M7 4.8 H11"/><path fill="currentColor" stroke="none" d="M8.1 14 L9 16.4 L9.9 14 Z"/></g>',
  'brush': '<g transform="translate(-.5 .5) rotate(45 9 9)"><path d="M8.1 1.2 H9.9 L10.5 8 H7.5 Z"/><path d="M7.1 8 H10.9 V10.3 H7.1 Z"/><path fill="currentColor" d="M7.1 10.3 C7.1 12.8 8.2 14.2 9 16.8 C9.8 14.2 10.9 12.8 10.9 10.3 Z"/></g>',
  'paint': '<g transform="translate(1.6 -2.2) scale(.86) rotate(45 9 9)" stroke-width="1.7"><path d="M8.1 1.2 H9.9 L10.5 8 H7.5 Z"/><path d="M7.1 8 H10.9 V10.3 H7.1 Z"/><path fill="currentColor" d="M7.1 10.3 C7.1 12.8 8.2 14.2 9 16.8 C9.8 14.2 10.9 12.8 10.9 10.3 Z"/></g><path d="M2.4 14.6 C4.6 12.8 6.2 16.8 8.6 15.2 C10 14.3 11 14.4 12.2 15.2"/>',
  'eraser': '<g transform="rotate(-45 9 8.2)"><rect x="3.4" y="5" width="11.2" height="6.4" rx="1"/><path d="M7.6 5 V11.4"/></g><path d="M9.5 15.75 H15.5"/>',
  'curvature': '<path d="M3.5 13.5 C4.5 3 13.5 3 14.5 13.5"/><rect fill="currentColor" stroke="none" x="2" y="12" width="3" height="3"/><rect fill="currentColor" stroke="none" x="13" y="12" width="3" height="3"/><circle cx="9" cy="5.6" r="1.6" fill="currentColor"/>',
  'add-vertex': '<g transform="translate(-0.6 2.6) scale(.84) rotate(45 9 9)" stroke-width="1.75"><path d="M9 16.2 L5.5 9.8 L6.9 5.2 H11.1 L12.5 9.8 Z"/><path d="M9 16.2 V11"/><circle cx="9" cy="9.7" r="1.15"/><path d="M6.9 5.2 V2.6 H11.1 V5.2"/></g><path d="M14 1.9 V6.9 M11.5 4.4 H16.5"/>',
  'delete-vertex': '<g transform="translate(-0.6 2.6) scale(.84) rotate(45 9 9)" stroke-width="1.75"><path d="M9 16.2 L5.5 9.8 L6.9 5.2 H11.1 L12.5 9.8 Z"/><path d="M9 16.2 V11"/><circle cx="9" cy="9.7" r="1.15"/><path d="M6.9 5.2 V2.6 H11.1 V5.2"/></g><path d="M11.5 4.4 H16.5"/>',
  'convert-vertex': '<path d="M3.2 14.6 L9 4.4 L14.8 14.6"/><rect fill="currentColor" stroke="none" x="7.3" y="2.7" width="3.4" height="3.4"/>',
  'mask-feather': '<circle cx="9" cy="9" r="3.1" fill="currentColor"/><circle cx="9" cy="9" r="6.6" stroke-dasharray="1.6 2.55" stroke-width="1.4"/>',
  'knife': '<path d="M14.8 2.2 C15.6 7.2 13.2 11.2 8.6 13.4 L6.6 11.4 Z"/><path d="M7.4 12.6 L3.6 16.4" stroke-width="2.6"/>',

  // Type & shapes
  'type': '<path fill="currentColor" stroke="none" d="M3.5 3 H14.5 V6.2 H13.1 V4.6 H9.9 V13.5 H11.7 V15 H6.3 V13.5 H8.1 V4.6 H4.9 V6.2 H3.5 Z"/>',
  'type-vertical': '<path fill="currentColor" stroke="none" d="M1.8 3 H10.2 V5.9 H8.9 V4.5 H6.8 V13.5 H8.3 V15 H3.7 V13.5 H5.2 V4.5 H3.1 V5.9 H1.8 Z"/><path d="M14 3 V14.4 M11.8 12 L14 14.6 L16.2 12"/>',
  'square': '<rect x="2.75" y="3.75" width="12.5" height="10.5" rx=".5"/>',
  'circle': '<circle cx="9" cy="9" r="6.25"/>',
  'polygon': '<path d="M9.00 2.80 L15.56 7.57 L13.06 15.28 L4.94 15.28 L2.44 7.57 Z"/>',
  'star': '<path d="M9.00 2.30 L10.82 7.09 L15.94 7.34 L11.95 10.56 L13.29 15.51 L9.00 12.70 L4.71 15.51 L6.05 10.56 L2.06 7.34 L7.18 7.09 Z"/>',
  'line': '<path d="M4 14 L14 4"/><rect fill="currentColor" stroke="none" x="2.3" y="12.7" width="3" height="3"/><rect fill="currentColor" stroke="none" x="12.7" y="2.3" width="3" height="3"/>',

  // Masks, puppet & rig
  'mask-square': '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M3.5 2 H14.5 A1.5 1.5 0 0 1 16 3.5 V14.5 A1.5 1.5 0 0 1 14.5 16 H3.5 A1.5 1.5 0 0 1 2 14.5 V3.5 A1.5 1.5 0 0 1 3.5 2 Z M5 6 V12 H13 V6 Z"/>',
  'mask-circle': '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M3.5 2 H14.5 A1.5 1.5 0 0 1 16 3.5 V14.5 A1.5 1.5 0 0 1 14.5 16 H3.5 A1.5 1.5 0 0 1 2 14.5 V3.5 A1.5 1.5 0 0 1 3.5 2 Z M9 5 A4 4 0 1 0 9 13 A4 4 0 1 0 9 5 Z"/>',
  'mask-pen': '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M3.5 2 H14.5 A1.5 1.5 0 0 1 16 3.5 V14.5 A1.5 1.5 0 0 1 14.5 16 H3.5 A1.5 1.5 0 0 1 2 14.5 V3.5 A1.5 1.5 0 0 1 3.5 2 Z M5 12.6 C5 8.6 7 5.2 12.8 5 C13.2 9.4 10.6 12.6 5 12.6 Z"/>',
  'puppet-pin': '<g transform="translate(-.5 .5) rotate(45 9 9)"><path d="M6 2.4 H12"/><path d="M7.2 2.4 V7 L5 10.4 H13 L10.8 7 V2.4"/><path d="M9 10.4 V16.4"/></g>',
  'puppet-starch': '<g transform="translate(-0.9 -1.3) scale(.84) rotate(45 9 9)" stroke-width="1.75"><path d="M6 2.4 H12"/><path d="M7.2 2.4 V7 L5 10.4 H13 L10.8 7 V2.4"/><path d="M9 10.4 V16.4"/></g><path d="M11.2 16.4 L16.4 11.2 M13.9 16.6 L16.6 13.9 M10.9 13.6 L13.6 10.9" stroke-width="1.3"/>',
  'puppet-bend': '<g transform="translate(-0.9 -1.3) scale(.84) rotate(45 9 9)" stroke-width="1.75"><path d="M6 2.4 H12"/><path d="M7.2 2.4 V7 L5 10.4 H13 L10.8 7 V2.4"/><path d="M9 10.4 V16.4"/></g><path d="M11 16 A5 5 0 0 0 16 11"/><path d="M13.7 11.2 L16.1 10.8 L16.6 13.2" stroke-width="1.3"/>',
  'puppet-advanced': '<g transform="translate(-0.9 -1.3) scale(.84) rotate(45 9 9)" stroke-width="1.75"><path d="M6 2.4 H12"/><path d="M7.2 2.4 V7 L5 10.4 H13 L10.8 7 V2.4"/><path d="M9 10.4 V16.4"/></g><circle cx="13.7" cy="13.7" r="2.7" stroke-width="1.3"/><circle cx="13.7" cy="13.7" r=".95" fill="currentColor" stroke="none"/>',
  'puppet-overlap': '<g transform="translate(-0.9 -1.3) scale(.84) rotate(45 9 9)" stroke-width="1.75"><path d="M6 2.4 H12"/><path d="M7.2 2.4 V7 L5 10.4 H13 L10.8 7 V2.4"/><path d="M9 10.4 V16.4"/></g><rect x="10.4" y="10.4" width="4.2" height="4.2" stroke-width="1.3"/><rect fill="currentColor" stroke="none" x="12.6" y="12.6" width="4.4" height="4.4"/>',
  'bone': '<circle cx="4.6" cy="13.4" r="2.2"/><circle cx="13.9" cy="4.1" r="1.5"/><path d="M3.04 11.84 L12.84 3.04 M6.16 14.96 L14.96 5.16"/>',

  // Layer, animate & snapping
  'layer-plus': '<path d="M8 2.8 L14.6 6.1 L8 9.4 L1.4 6.1 Z"/><path d="M1.4 9.6 L8 12.9 L10.2 11.8"/><path d="M14 10.6 V16.2 M11.2 13.4 H16.8"/>',
  'magic-wand': '<path d="M2.8 15.2 L9.6 8.4" stroke-width="2.2"/><path fill="currentColor" stroke="none" d="M12.6 1.6 L13.6 4.4 L16.4 5.4 L13.6 6.4 L12.6 9.2 L11.6 6.4 L8.8 5.4 L11.6 4.4 Z"/><path d="M14.8 11.2 V14 M13.4 12.6 H16.2 M5.6 3 V5.4 M4.4 4.2 H6.8" stroke-width="1.2"/>',
  'magnet': '<path d="M3.75 3 H7.25 V9.6 a1.75 1.75 0 0 0 3.5 0 V3 H14.25 V9.6 a5.25 5.25 0 0 1 -10.5 0 Z"/><path d="M3.75 6 H7.25 M10.75 6 H14.25"/>',
  'undo': '<path d="M6.4 3.4 L2.9 6.9 L6.4 10.4"/><path d="M2.9 6.9 H11 A4 4 0 0 1 11 14.9 H7.4"/>',
  'redo': '<path d="M11.6 3.4 L15.1 6.9 L11.6 10.4"/><path d="M15.1 6.9 H7 A4 4 0 0 0 7 14.9 H10.6"/>',
  'more-horizontal': '<circle fill="currentColor" stroke="none" cx="3.8" cy="9" r="1.35"/><circle fill="currentColor" stroke="none" cx="9" cy="9" r="1.35"/><circle fill="currentColor" stroke="none" cx="14.2" cy="9" r="1.35"/>',
  'arrow-left': '<path d="M15 9 H3.4 M8 4.4 L3.4 9 L8 13.6"/>',
  'chevron-down': '<path d="M4.8 7 L9 11.2 L13.2 7"/>',

  // 3D scene controls
  'camera': '<rect x="1.75" y="4.75" width="10" height="8.5" rx="1.25"/><path d="M11.75 8 L16.25 5.6 V12.4 L11.75 10"/>',
  'orbit': '<circle cx="9" cy="9" r="2.6" fill="currentColor" stroke="none"/><ellipse cx="9" cy="9" rx="7.5" ry="3.1" transform="rotate(-28 9 9)" stroke-width="1.3"/>',
  'pan-camera': '<path d="M9 2 V16 M2 9 H16"/><path d="M6.9 4.1 L9 2 L11.1 4.1 M6.9 13.9 L9 16 L11.1 13.9 M4.1 6.9 L2 9 L4.1 11.1 M13.9 6.9 L16 9 L13.9 11.1"/>',
  'perspective': '<path d="M9 2.6 V15.4"/><path d="M7.3 4.3 L9 2.6 L10.7 4.3" stroke-width="1.3"/><path d="M5.2 11.6 L9 15.4 L12.8 11.6"/><path d="M2.4 8 H5.6 M12.4 8 H15.6" stroke-width="1.3"/>',
  'gizmo-universal': '<path d="M6.5 11.5 V5 M6.5 11.5 H12.6 M6.5 11.5 L3.8 14.2"/><path fill="currentColor" stroke="none" d="M6.5 1.6 L8.6 5.2 H4.4 Z"/><rect fill="currentColor" stroke="none" x="12.6" y="9.8" width="3.4" height="3.4"/><circle fill="currentColor" stroke="none" cx="3" cy="15" r="1.8"/>',
  'gizmo-position': '<path d="M6.5 11.5 V5 M6.5 11.5 H13 M6.5 11.5 L4 14"/><path fill="currentColor" stroke="none" d="M6.5 1.6 L8.6 5.2 H4.4 Z"/><path fill="currentColor" stroke="none" d="M16.4 11.5 L12.8 13.6 V9.4 Z"/><path fill="currentColor" stroke="none" d="M1.6 16.4 L2.4 12.6 L5.4 15.6 Z"/>',
  'gizmo-scale': '<path d="M6.5 11.5 V5 M6.5 11.5 H13 M6.5 11.5 L4 14"/><rect fill="currentColor" stroke="none" x="4.8" y="1.8" width="3.4" height="3.4"/><rect fill="currentColor" stroke="none" x="12.8" y="9.8" width="3.4" height="3.4"/><rect fill="currentColor" stroke="none" x="1.6" y="13" width="3.4" height="3.4"/>',
  'gizmo-rotation': '<path d="M15 9 A6 6 0 1 1 12 3.8"/><path fill="currentColor" stroke="none" d="M10.9 1.6 L14.9 4.6 L10.6 6.2 Z"/><circle fill="currentColor" stroke="none" cx="9" cy="9" r="1.6"/>',
  'axis-local': '<rect x="2.25" y="2.25" width="13.5" height="13.5" rx="1" stroke-width="1.3"/><path d="M8 5.6 V10 H12.6 M8 10 L5.6 12.4"/>',
  'axis-world': '<circle cx="9" cy="9" r="6.9" stroke-width="1.3"/><path d="M8 5.6 V10 H12.6 M8 10 L5.6 12.4"/>',
  'axis-view': '<path d="M5.4 2.4 H12.6 L16 15.6 H2 Z" stroke-width="1.3"/><path d="M8 5.6 V10 H12.6 M8 10 L5.6 12.4"/>',
  'cube': '<path d="M9 1.9 L15.2 5.4 V12.6 L9 16.1 L2.8 12.6 V5.4 Z"/><path d="M2.8 5.4 L9 9 L15.2 5.4 M9 9 V16.1"/>',
} as const satisfies Partial<Record<IconName, string>>;

/** Names that draw the same object as another name (kept: call sites spell them). */
const ALIASES = {
  'select-arrow': 'mouse-pointer',
  'rotate-cw': 'rotate',
  box: 'cube',
} as const satisfies Partial<Record<IconName, keyof typeof GLYPHS>>;

export const DRAWN_ICONS: Partial<Record<IconName, string>> = {
  ...GLYPHS,
  ...Object.fromEntries(Object.entries(ALIASES).map(([alias, target]) => [alias, GLYPHS[target]])),
};
