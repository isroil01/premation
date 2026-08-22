/**
 * Generates `src/components/Icon/sharpIconPaths.ts` from Material Symbols Sharp.
 *
 * WHY A GENERATOR. The app used to import ~235 React components from an icon
 * package, which meant the icon set was a RUNTIME dependency: every glyph
 * arrived as a component carrying all six of its weight variants, and the whole
 * package sat in the bundle so that 171 names could be drawn. Here the path data
 * is extracted once, at author time, into one plain data module. The icon
 * package is a devDependency — nothing ships but the 171 paths actually used.
 *
 * WHY MATERIAL SYMBOLS SHARP, WEIGHT 700. "Sharp" is a literal design axis in
 * this family, not a rendering hint: the glyphs are drawn with zero corner
 * radius (`square` is `M95-95v-771h771v771H95Z` — pure orthogonal geometry).
 * That distinction is the whole reason for the switch. Stroke-outline sets like
 * Lucide and Tabler bake their corner rounding into the path data as arc
 * segments, so `stroke-linejoin="miter"` cannot sharpen them — measured, 15/19
 * and 11/16 of their shape glyphs respectively. There is no attribute that turns
 * a rounded icon set sharp. You have to draw from a sharp one.
 *
 * Weight 700 is the family's heaviest grade, so "bold" is the geometry rather
 * than a stroke width the renderer picks. See `Icon.tsx` for what that means for
 * the `weight` prop.
 *
 * TO REGENERATE: npm run icons:generate
 * TO ADD AN ICON: add the name to `iconNames.ts`, add its mapping to `MAP`
 * below, and regenerate. The script fails loudly if the two disagree.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'node_modules', '@material-symbols', 'svg-700', 'sharp');
const ICON_DIR = join(ROOT, 'src', 'components', 'Icon');
const OUT = join(ICON_DIR, 'sharpIconPaths.ts');

/**
 * `IconName` → Material Symbols glyph.
 *
 * Where the family has no glyph for a concept the app cares about, the entry
 * names the nearest honest substitute rather than something merely adjacent —
 * those are collected in SUBSTITUTIONS below so the compromises stay visible
 * instead of dissolving into the table.
 */
const MAP = {
  'arrow-down': 'arrow_downward', 'arrow-left': 'arrow_back', 'arrow-right': 'arrow_forward', 'arrow-up': 'arrow_upward',
  download: 'download', check: 'check', close: 'close', plus: 'add', minus: 'remove',
  'chevron-down': 'keyboard_arrow_down', 'chevron-up': 'keyboard_arrow_up',
  'chevron-left': 'keyboard_arrow_left', 'chevron-right': 'keyboard_arrow_right',
  search: 'search', settings: 'settings', menu: 'menu', 'more-horizontal': 'more_horiz', 'more-vertical': 'more_vert',
  eye: 'visibility', 'eye-off': 'visibility_off', lock: 'lock', unlock: 'lock_open',
  play: 'play_arrow', pause: 'pause', stop: 'stop', 'skip-back': 'skip_previous', 'skip-forward': 'skip_next',
  refresh: 'sync', 'rotate-cw': 'rotate_right', rotate: 'rotate_left', anchor: 'anchor', move: 'open_with',

  // Real left/right/bottom glyphs. The previous set had only ONE sidebar mark,
  // so `panel-right` and `panel-bottom` were the same glyph under a CSS
  // `scaleX(-1)` / `rotate(-90deg)`. A rotated icon is a guess about symmetry,
  // and it was wrong here — the rotated version put the panel's divider on the
  // wrong side of its own frame.
  'panel-left': 'left_panel_open', 'panel-right': 'right_panel_open', 'panel-bottom': 'bottom_panel_open',

  layout: 'dashboard', crosshair: 'center_focus_strong', theme: 'contrast', undo: 'undo', redo: 'redo',
  'select-all': 'select_all', deselect: 'deselect', 'mouse-pointer': 'arrow_selector_tool',
  pen: 'ink_pen', type: 'text_fields', square: 'square', circle: 'circle',
  // NOT `crop_square`/`radio_button_unchecked`: those are byte-identical to
  // `square`/`circle` in this family, so the mask would have been the shape tool
  // wearing a different name. A matte has to look like a matte.
  'mask-square': 'filter_frames', 'mask-circle': 'vignette',
  // The Pen Mask tool had been drawing the SAME glyph as the Pen tool, three
  // buttons away in the same bar. `draw` is a pen laying down a path behind it,
  // which separates them without either becoming a worse picture of itself.
  'mask-pen': 'draw',
  pencil: 'edit', line: 'shape_line', star: 'star', polygon: 'pentagon', curvature: 'line_curve',
  // Arrows-in / arrows-out rather than the family's `group_work`/`workspaces`,
  // which are both clusters of circles and unreadable as opposites at 13px.
  copy: 'content_copy', group: 'collapse_content', ungroup: 'expand_content', trash: 'delete',
  folder: 'folder', 'folder-open': 'folder_open', 'folder-plus': 'create_new_folder', upload: 'upload',
  file: 'draft', image: 'image', video: 'movie', audio: 'volume_up', 'audio-off': 'volume_off',
  media: 'photo_library', shape: 'shapes', layers: 'layers', component: 'widgets', zap: 'bolt',
  'zoom-in': 'zoom_in', 'zoom-out': 'zoom_out', fit: 'fit_screen', maximize: 'open_in_full', minimize: 'close_fullscreen',
  info: 'info', warning: 'warning', error: 'error', success: 'check_circle',
  drag: 'drag_indicator', 'grip-vertical': 'drag_indicator', 'grip-horizontal': 'drag_handle', hand: 'pan_tool',
  collapse: 'keyboard_double_arrow_up', expand: 'keyboard_double_arrow_down',

  // `keyframe` and `diamond` are drawn here rather than mapped — see HAND_DRAWN.
  keyframe: null, diamond: null,

  track: 'format_list_bulleted', marker: 'flag', stopwatch: 'timer', sparkles: 'star_shine',
  // `scale` is the 3D SCALE GIZMO, not a page-fit control: arrows driven
  // outward from the centre. `aspect_ratio` was a framing mark and said nothing
  // about resizing a selection.
  '3d': '3d_rotation', box: 'deployed_code', cube: 'deployed_code', scale: 'zoom_out_map',
  heart: 'favorite', cross: 'add', crescent: 'dark_mode', adjustment: 'tune', shy: 'hide_source',
  camera: 'videocam', light: 'lightbulb', user: 'person',
  'align-left': 'align_horizontal_left', 'align-center': 'align_horizontal_center', 'align-right': 'align_horizontal_right',
  'align-top': 'align_vertical_top', 'align-middle': 'align_vertical_center', 'align-bottom': 'align_vertical_bottom',
  'distribute-horizontal': 'horizontal_distribute', 'distribute-vertical': 'vertical_distribute',
  // `point_scan` — a crosshair inside registration brackets — is what snapping
  // DOES. `grid_goldenratio` was a picture of guides, which is the thing being
  // snapped to, not the act, and at 18px it read as a second grid toggle right
  // next to the real one.
  magnet: 'point_scan', grid: 'grid_on', ruler: 'straighten', scissors: 'content_cut', queue: 'list_alt',
  plugin: 'extension', path: 'polyline', ease: 'animation', frame: 'crop_free',
  'select-arrow': 'arrow_selector_tool', 'sliders-h': 'tune', brush: 'brush', '3d-focus': 'filter_center_focus',
  loop: 'repeat', 'motion-blur': 'motion_blur', 'trim-in': 'first_page', 'trim-out': 'last_page',
  solid: 'rectangle', 'graph-value': 'show_chart', 'graph-speed': 'speed',
  export: 'ios_share', history: 'history', share: 'share', link: 'link',
  // `device_hub` is a joint with limbs radiating off it, which is what a bone
  // chain looks like. `account_tree` was a file-explorer tree.
  'puppet-pin': 'keep', 'push-pin': 'keep', bone: 'device_hub', home: 'home', app: 'apps',
  voice: 'graphic_eq', sound: 'volume_up', mic: 'mic', ai: 'star_shine', brain: 'psychology',
  tv: 'tv', tour: 'tour',
  'text-left': 'format_align_left', 'text-center': 'format_align_center', 'text-right': 'format_align_right',
  // These three are the toolbar's camera cluster and gizmo cluster, and each
  // needs to say what its BUTTON does, not what its noun is:
  //   perspective → the Dolly tool, so arrows converging inward (pushing in).
  //     `view_in_ar` was a cube in brackets — a 3D-view mark, not a move.
  //   axis-3d → the Universal Gizmo, so the transform mark. `line_axis` is a
  //     plotted chart, which is what it looked like sitting next to Position.
  orbit: 'orbit', 'hand-grab': 'back_hand', 'pan-camera': 'control_camera', perspective: 'zoom_in_map',
  'axis-3d': 'transform', 'ground-grid': 'grid_4x4', sphere: 'globe', cylinder: 'database',
  'text-3d': 'font_download', 'pop-out': 'picture_in_picture_alt', gpu: 'memory',
  blur: 'blur_on', palette: 'palette', gradient: 'gradient', waves: 'waves', eraser: 'ink_eraser',
  clock: 'schedule', wipe: 'transition_slide', 'magic-wand': 'wand_stars',
  code: 'code',
};

/**
 * Names with no exact glyph in the family, and what was chosen instead.
 *
 * Recorded because a substitution is a judgement, and a judgement that leaves no
 * trace gets re-litigated from scratch by whoever notices it next. If a future
 * release of the family adds the real thing, this is the list to re-check.
 */
const SUBSTITUTIONS = {
  bone: 'no bone glyph; `device_hub` is a joint with limbs radiating off it',
  magnet: 'no magnet glyph; `point_scan` is the crosshair-in-brackets snap mark',
  queue: 'no plain `queue`; `list_alt` is the render-queue panel it opens',
  'mask-circle': 'no circular-mask glyph; `vignette` is the circular matte',
  'mask-square': 'no square-mask glyph; `filter_frames` is the frame-within-frame matte',
  'text-3d': 'no 3D-text glyph; `font_download` is the boxed glyph mark',
  perspective: 'named for the concept but used for the DOLLY tool; `zoom_in_map` is the inward push',
  'axis-3d': 'named for the concept but used for the UNIVERSAL GIZMO; `transform` is the gizmo mark',
};

/**
 * Glyphs drawn here because the family's nearest match means something else.
 *
 * The keyframe diamond is the case that forced this: Material's `diamond` is a
 * faceted GEM, and a gem is not what an animator is looking for on a timeline
 * row. A diamond is four straight edges, so drawing it sharp costs nothing.
 *
 * Geometry matches the family's own metrics — a 960 grid, 95 units of padding,
 * a 94-unit border (measured off `square`, whose outer box is 95..866 and inner
 * 189..771). The outline's inner contour is wound OPPOSITE to its outer one so
 * the nonzero fill rule punches it out as a hole; every other path here relies
 * on that same rule, so switching to evenodd to avoid thinking about winding
 * would break the imported glyphs that self-overlap.
 */
const HAND_DRAWN = {
  // Half-diagonal 420 out, and 420 - 94*sqrt(2) = 287 in, so the border reads
  // at the same 94 units perpendicular as every imported glyph.
  keyframe: {
    d: 'M480-900 900-480 480-60 60-480Z M480-767 193-480 480-193 767-480Z',
    fill: 'M480-900 900-480 480-60 60-480Z',
  },
};
HAND_DRAWN.diamond = HAND_DRAWN.keyframe;

function readPath(glyph, variant) {
  const file = join(SRC, `${glyph}${variant}.svg`);
  if (!existsSync(file)) throw new Error(`missing glyph svg: ${file}`);
  const svg = readFileSync(file, 'utf8');
  const ds = [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
  if (ds.length === 0) throw new Error(`no path data in ${file}`);
  // Material ships one <path> per glyph; more than one would silently drop
  // geometry if we took only the first.
  if (ds.length > 1) throw new Error(`expected 1 path in ${file}, found ${ds.length}`);
  return ds[0];
}

function main() {
  const namesSrc = readFileSync(join(ICON_DIR, 'iconNames.ts'), 'utf8');
  const body = namesSrc.slice(namesSrc.indexOf('ICON_NAMES = ['), namesSrc.indexOf('] as const'));
  const names = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const unmapped = names.filter((n) => !(n in MAP));
  const orphaned = Object.keys(MAP).filter((n) => !names.includes(n));
  if (unmapped.length) throw new Error(`ICON_NAMES entries with no mapping: ${unmapped.join(', ')}`);
  if (orphaned.length) throw new Error(`mappings for names not in ICON_NAMES: ${orphaned.join(', ')}`);

  const rows = names.map((name) => {
    const glyph = MAP[name];
    if (glyph === null) {
      const drawn = HAND_DRAWN[name];
      if (!drawn) throw new Error(`${name} is mapped to null but has no HAND_DRAWN entry`);
      return { name, d: drawn.d, fill: drawn.fill, glyph: 'hand-drawn' };
    }
    return { name, d: readPath(glyph, ''), fill: readPath(glyph, '-fill'), glyph };
  });

  const entries = rows
    .map((r) => `  ${JSON.stringify(r.name)}: { d: ${JSON.stringify(r.d)}, fill: ${JSON.stringify(r.fill)} },`)
    .join('\n');

  const subs = Object.entries(SUBSTITUTIONS)
    .map(([name, why]) => ` *   ${name.padEnd(14)} ${why}`)
    .join('\n');

  const out = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source: Material Symbols Sharp, weight 700 (@material-symbols/svg-700).
 * Regenerate with: npm run icons:generate
 * The name→glyph mapping lives in scripts/generate-sharp-icons.mjs.
 *
 * Each entry carries both grades of the family's FILL axis: \`d\` is the outline
 * and \`fill\` the solid. That is what backs \`<Icon weight="fill">\` — see
 * Icon.tsx for how the prop resolves.
 *
 * Substitutions made where the family has no exact glyph:
${subs}
 */

import type { IconName } from './iconNames';

/** Material's grid: a 960 box with the origin at its BOTTOM-left, hence -960. */
export const SHARP_ICON_VIEWBOX = '0 -960 960 960';

export interface SharpIconPath {
  /** Outline grade (FILL 0). */
  readonly d: string;
  /** Solid grade (FILL 1). */
  readonly fill: string;
}

export const SHARP_ICON_PATHS: Record<IconName, SharpIconPath> = {
${entries}
};
`;

  writeFileSync(OUT, out, 'utf8');
  const drawn = rows.filter((r) => r.glyph === 'hand-drawn').length;
  console.log(`wrote ${OUT}`);
  console.log(`${rows.length} icons (${rows.length - drawn} from Material Symbols Sharp 700, ${drawn} hand-drawn)`);
}

main();
