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
  refresh: 'sync', 'rotate-cw': 'rotate_right', rotate: 'rotate_right', anchor: 'recenter', move: 'open_with',

  // Real left/right/bottom glyphs. The previous set had only ONE sidebar mark,
  // so `panel-right` and `panel-bottom` were the same glyph under a CSS
  // `scaleX(-1)` / `rotate(-90deg)`. A rotated icon is a guess about symmetry,
  // and it was wrong here — the rotated version put the panel's divider on the
  // wrong side of its own frame.
  'panel-left': 'left_panel_open', 'panel-right': 'right_panel_open', 'panel-bottom': 'bottom_panel_open',

  layout: 'dashboard', crosshair: 'center_focus_strong', theme: 'contrast', undo: 'undo', redo: 'redo',
  'select-all': 'select_all', deselect: 'deselect', 'mouse-pointer': 'arrow_selector_tool',
  'direct-select': 'near_me', 'pan-behind': 'recenter', 'layer-plus': null,
  pen: 'ink_pen', type: 'text_fields', square: 'square', circle: 'circle',
  'mask-square': null, 'mask-circle': null, 'mask-pen': null,
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
  keyframe: null, diamond: null, magnet: null,

  track: 'format_list_bulleted', marker: 'flag', stopwatch: 'timer', sparkles: 'star_shine',
  // `scale` is the 3D SCALE GIZMO, not a page-fit control: arrows driven
  // outward from the centre. `aspect_ratio` was a framing mark and said nothing
  // about resizing a selection.
  '3d': '3d_rotation', box: 'deployed_code', cube: 'deployed_code', scale: 'zoom_out_map',
  'draft-3d': '3d',
  heart: 'favorite', cross: 'add', crescent: 'dark_mode', adjustment: 'tune', shy: 'hide_source',
  camera: 'videocam', light: 'lightbulb', user: 'person',
  'align-left': 'align_horizontal_left', 'align-center': 'align_horizontal_center', 'align-right': 'align_horizontal_right',
  'align-top': 'align_vertical_top', 'align-middle': 'align_vertical_center', 'align-bottom': 'align_vertical_bottom',
  'distribute-horizontal': 'horizontal_distribute', 'distribute-vertical': 'vertical_distribute',
  grid: 'grid_on', ruler: 'straighten', scissors: 'content_cut', queue: 'list_alt',
  plugin: 'extension', path: 'polyline', ease: 'animation', frame: 'crop_free',
  'select-arrow': 'arrow_selector_tool', 'sliders-h': 'tune', brush: 'brush', '3d-focus': 'filter_center_focus',
  loop: 'repeat', 'motion-blur': 'motion_blur', 'trim-in': 'first_page', 'trim-out': 'last_page',
  solid: 'rectangle', 'graph-value': 'show_chart', 'graph-speed': 'speed',
  export: 'file_export', history: 'history', share: 'share', link: 'link',
  'puppet-pin': null, 'push-pin': 'keep', 'puppet-starch': 'texture', 'puppet-bend': '360', 'puppet-advanced': 'transform', 'puppet-overlap': 'layers', bone: null,
  home: 'home', app: 'apps',
  voice: 'graphic_eq', sound: 'volume_up', mic: 'mic', ai: 'star_shine', brain: 'psychology',
  tv: 'tv', tour: 'tour',
  'text-left': 'format_align_left', 'text-center': 'format_align_center', 'text-right': 'format_align_right',
  orbit: null, 'hand-grab': 'back_hand', 'pan-camera': 'control_camera', perspective: null,
  'axis-3d': 'transform', 'ground-grid': null,
  'axis-local': null, 'axis-world': null, 'axis-view': null,
  'gizmo-universal': null, 'gizmo-position': null, 'gizmo-scale': null, 'gizmo-rotation': null,
  sphere: 'globe', cylinder: 'database',
  'text-3d': 'font_download', 'pop-out': 'picture_in_picture_alt', gpu: 'memory',
  blur: 'blur_on', palette: 'palette', gradient: 'gradient', waves: 'waves', eraser: 'ink_eraser',
  clock: 'schedule', wipe: 'transition_slide', 'magic-wand': 'wand_stars',
  code: 'code',
};

/**
 * Names with no exact glyph in the family, and what was chosen instead.
 */
const SUBSTITUTIONS = {
  'puppet-starch': 'no starch glyph; `texture` is the stiffened hatch it paints',
  queue: 'no plain `queue`; `list_alt` is the render-queue panel it opens',
  'text-3d': 'no 3D-text glyph; `font_download` is the boxed glyph mark',
};

/**
 * Glyphs drawn here because the family's nearest match means something else.
 */
const HAND_DRAWN = {
  keyframe: {
    d: 'M480-900 900-480 480-60 60-480Z M480-767 193-480 480-193 767-480Z',
    fill: 'M480-900 900-480 480-60 60-480Z',
  },
  magnet: {
    d: 'M180-840 h200 v140 H180 Z M580-840 h200 v140 H580 Z M180-660 h200 v180 q0 42 29 71 t71 29 q42 0 71-29 t29-71 v-180 h200 v180 q0 124-88 212 t-212 88 q-124 0-212-88 t-88-212 Z',
    fill: 'M180-840 h200 v140 H180 Z M580-840 h200 v140 H580 Z M180-660 h200 v180 q0 42 29 71 t71 29 q42 0 71-29 t29-71 v-180 h200 v180 q0 124-88 212 t-212 88 q-124 0-212-88 t-88-212 Z',
  },
  'gizmo-position': {
    // Three arms off a solid hub, all three capped with the SAME terminal so
    // the mode reads from the cap alone: a triangle = translate.
    d: 'M395-565 H565 V-395 H395 Z M425-700 H535 V-440 H425 Z M480-880 L620-680 L340-680 Z M440-535 H700 V-425 H440 Z M880-480 L680-340 L680-620 Z M441-519 L519-441 L299-221 L221-299 Z M120-120 L162-360 L360-162 Z',
    fill: 'M395-565 H565 V-395 H395 Z M425-700 H535 V-440 H425 Z M480-880 L620-680 L340-680 Z M440-535 H700 V-425 H440 Z M880-480 L680-340 L680-620 Z M441-519 L519-441 L299-221 L221-299 Z M120-120 L162-360 L360-162 Z',
  },
  'gizmo-scale': {
    // Same skeleton, square terminals — the box handle every 3D app uses for
    // scale. Blocky vs pointed is the difference that survives 15px.
    d: 'M395-565 H565 V-395 H395 Z M425-690 H535 V-440 H425 Z M375-880 H585 V-670 H375 Z M440-535 H690 V-425 H440 Z M670-585 H880 V-375 H670 Z M441-519 L519-441 L299-221 L221-299 Z M100-310 H310 V-100 H100 Z',
    fill: 'M395-565 H565 V-395 H395 Z M425-690 H535 V-440 H425 Z M375-880 H585 V-670 H375 Z M440-535 H690 V-425 H440 Z M670-585 H880 V-375 H670 Z M441-519 L519-441 L299-221 L221-299 Z M100-310 H310 V-100 H100 Z',
  },
  'gizmo-rotation': {
    // A ring segment of the same 120-unit weight as the arms, its gap closed
    // by a head twice that wide, turning about the same hub as its siblings.
    d: 'M664-742 A320 320 0 1 1 452-799 L462-689 A210 210 0 1 0 600-652 Z M445-884 L666-762 L469-604 Z M395-565 H565 V-395 H395 Z',
    fill: 'M664-742 A320 320 0 1 1 452-799 L462-689 A210 210 0 1 0 600-652 Z M445-884 L666-762 L469-604 Z M395-565 H565 V-395 H395 Z',
  },
  'gizmo-universal': {
    // The universal manipulator carries ONE OF EACH terminal — triangle,
    // square, disc — which is exactly what the mode does. That mix, not a
    // separate silhouette, is what separates it from `gizmo-position`.
    d: 'M395-565 H565 V-395 H395 Z M425-700 H535 V-440 H425 Z M480-880 L620-680 L340-680 Z M440-535 H660 V-425 H440 Z M640-600 H880 V-360 H640 Z M441-519 L519-441 L299-221 L221-299 Z M95-215 A120 120 0 1 1 335-215 A120 120 0 1 1 95-215 Z',
    fill: 'M395-565 H565 V-395 H395 Z M425-700 H535 V-440 H425 Z M480-880 L620-680 L340-680 Z M440-535 H660 V-425 H440 Z M640-600 H880 V-360 H640 Z M441-519 L519-441 L299-221 L221-299 Z M95-215 A120 120 0 1 1 335-215 A120 120 0 1 1 95-215 Z',
  },
  'mask-square': {
    // The three MASK tools used to borrow `crop_square` / `circle` / `draw`,
    // which are the Rectangle, Ellipse and Pen tools sitting four buttons to
    // their left in the same toolbar — six buttons, three glyphs. A mask is
    // not its shape, it is a field with that shape cut out of it, so that is
    // what these draw: one matte, three holes.
    d: 'M80-880 H880 V-80 H80 Z M220-680 V-280 H740 V-680 Z',
    fill: 'M80-880 H880 V-80 H80 Z M220-680 V-280 H740 V-680 Z',
  },
  'mask-circle': {
    d: 'M80-880 H880 V-80 H80 Z M230-480 A250 250 0 1 0 730-480 A250 250 0 1 0 230-480 Z',
    fill: 'M80-880 H880 V-80 H80 Z M230-480 A250 250 0 1 0 730-480 A250 250 0 1 0 230-480 Z',
  },
  'mask-pen': {
    d: 'M80-880 H880 V-80 H80 Z M470-730 L200-420 L560-200 L760-460 Z',
    fill: 'M80-880 H880 V-80 H80 Z M470-730 L200-420 L560-200 L760-460 Z',
  },
  'puppet-pin': {
    // Material's `pin` is a PIN CODE — it renders the digits 1 2 3 in a box.
    // The Puppet tool places a PUSH pin, so this is one drawn side-on: cap,
    // shaft, flange, needle.
    d: 'M290-880 H670 V-750 H290 Z M375-750 H585 V-560 H375 Z M245-560 H715 V-450 H245 Z M420-450 L540-450 L480-120 Z',
    fill: 'M290-880 H670 V-750 H290 Z M375-750 H585 V-560 H375 Z M245-560 H715 V-450 H245 Z M420-450 L540-450 L480-120 Z',
  },
  'bone': {
    // Was `device_hub`, a network node with three legs. A bone is two joint
    // knobs on a shaft, which is also what the rig draws in the viewport.
    d: 'M125-590 A125 125 0 1 1 375-590 A125 125 0 1 1 125-590 Z M125-370 A125 125 0 1 1 375-370 A125 125 0 1 1 125-370 Z M585-590 A125 125 0 1 1 835-590 A125 125 0 1 1 585-590 Z M585-370 A125 125 0 1 1 835-370 A125 125 0 1 1 585-370 Z M250-550 H710 V-410 H250 Z',
    fill: 'M125-590 A125 125 0 1 1 375-590 A125 125 0 1 1 125-590 Z M125-370 A125 125 0 1 1 375-370 A125 125 0 1 1 125-370 Z M585-590 A125 125 0 1 1 835-590 A125 125 0 1 1 585-590 Z M585-370 A125 125 0 1 1 835-370 A125 125 0 1 1 585-370 Z M250-550 H710 V-410 H250 Z',
  },
  'orbit': {
    // Was `3d_rotation`, which spells the literal characters "3D" — and the
    // Draft 3D toggle four buttons along is ALSO a "3D" wordmark. A body with
    // a ring around it says orbit without spelling anything.
    d: 'M870-662 A430 210 -25 1 1 90-298 A430 210 -25 1 1 870-662 Z M779-620 A330 105 -25 1 0 181-340 A330 105 -25 1 0 779-620 Z M325-480 A155 155 0 1 1 635-480 A155 155 0 1 1 325-480 Z',
    fill: 'M870-662 A430 210 -25 1 1 90-298 A430 210 -25 1 1 870-662 Z M779-620 A330 105 -25 1 0 181-340 A330 105 -25 1 0 779-620 Z M325-480 A155 155 0 1 1 635-480 A155 155 0 1 1 325-480 Z',
  },
  'perspective': {
    // Dolly. Was `zoom_in_map` — four arrows pointing inward, which reads as
    // "collapse". A dolly runs along the view axis in both directions, so
    // this is one double-headed arrow drawn IN perspective: the near head is
    // large, the far head small, and the shaft tapers between them.
    d: 'M70-480 L260-640 L260-560 L620-625 L620-770 L890-480 L620-190 L620-335 L260-400 L260-320 Z',
    fill: 'M70-480 L260-640 L260-560 L620-625 L620-770 L890-480 L620-190 L620-335 L260-400 L260-320 Z',
  },
  'ground-grid': {
    // Was `grid_4x4`, a flat square grid — which is the 2D grid OVERLAY, a
    // different control. The ground plane is a plane in perspective, so it is
    // drawn receding to a vanishing point.
    d: 'M320-580 L640-580 L900-160 L60-160 Z M400-490 L190-250 L770-250 L560-490 Z M190-415 H770 V-325 H190 Z M440-580 H520 V-160 H440 Z',
    fill: 'M320-580 L640-580 L900-160 L60-160 Z M400-490 L190-250 L770-250 L560-490 Z M190-415 H770 V-325 H190 Z M440-580 H520 V-160 H440 Z',
  },
  'layer-plus': {
    // Was `add_box` — a plus in a box, which describes "add" and nothing
    // else. This button adds a LAYER, so the stack is in the glyph.
    d: 'M70-800 H520 V-660 H70 Z M70-550 H520 V-410 H70 Z M70-300 H520 V-160 H70 Z M655-660 H785 V-300 H655 Z M540-545 H900 V-415 H540 Z',
    fill: 'M70-800 H520 V-660 H70 Z M70-550 H520 V-410 H70 Z M70-300 H520 V-160 H70 Z M655-660 H785 V-300 H655 Z M540-545 H900 V-415 H540 Z',
  },
  'axis-local': {
    // Local / World / View were three BOLD LETTERS — L, W, V — because three
    // near-identical axis glyphs were judged harder to tell apart than
    // initials. That reasoning holds for three glyphs that differ only in
    // orientation; it does not hold if what differs is the FRAME. So the
    // tripod is identical in all three and the box around it carries the
    // meaning: the layer's own bounds here, the world next, the camera's
    // view last. It also stops the control being English-only.
    d: 'M80-880 H880 V-80 H80 Z M160-800 V-160 H800 V-800 Z M438-620 H522 V-428 H438 Z M470-512 H650 V-428 H470 Z M450-500 L510-440 L370-300 L310-360 Z',
    fill: 'M80-880 H880 V-80 H80 Z M160-800 V-160 H800 V-800 Z M438-620 H522 V-428 H438 Z M470-512 H650 V-428 H470 Z M450-500 L510-440 L370-300 L310-360 Z',
  },
  'axis-world': {
    d: 'M80-480 A400 400 0 1 1 880-480 A400 400 0 1 1 80-480 Z M160-480 A320 320 0 1 0 800-480 A320 320 0 1 0 160-480 Z M438-620 H522 V-428 H438 Z M470-512 H650 V-428 H470 Z M450-500 L510-440 L370-300 L310-360 Z',
    fill: 'M80-480 A400 400 0 1 1 880-480 A400 400 0 1 1 80-480 Z M160-480 A320 320 0 1 0 800-480 A320 320 0 1 0 160-480 Z M438-620 H522 V-428 H438 Z M470-512 H650 V-428 H470 Z M450-500 L510-440 L370-300 L310-360 Z',
  },
  'axis-view': {
    d: 'M300-880 L660-880 L900-80 L60-80 Z M355-800 L120-160 L840-160 L605-800 Z M438-620 H522 V-428 H438 Z M470-512 H650 V-428 H470 Z M450-500 L510-440 L370-300 L310-360 Z',
    fill: 'M300-880 L660-880 L900-80 L60-80 Z M355-800 L120-160 L840-160 L605-800 Z M438-620 H522 V-428 H438 Z M470-512 H650 V-428 H470 Z M450-500 L510-440 L370-300 L310-360 Z',
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
