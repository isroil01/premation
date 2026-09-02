/**
 * The icon vocabulary, as data.
 *
 * Split out of `Icon.tsx` so that code which needs to *validate* an icon name
 * does not have to import a React component and the whole Phosphor set to do
 * it. The plugin manifest validator is the case that forced this: it checks a
 * third-party `contributes.commands[].icon` at install time, runs in the same
 * module graph as the sandbox loader, and has no business pulling a renderer in.
 *
 * `Icon.tsx` re-exports both of these, so `@components/Icon` remains the one
 * place anything else imports them from.
 */

export const ICON_NAMES = [
  'arrow-down', 'arrow-left', 'arrow-right', 'arrow-up', 'download',
  'check', 'close', 'plus', 'minus',
  'chevron-down', 'chevron-up', 'chevron-left', 'chevron-right',
  'search', 'settings', 'menu', 'more-horizontal', 'more-vertical',
  'eye', 'eye-off', 'lock', 'unlock',
  'play', 'pause', 'stop', 'skip-back', 'skip-forward',
  'refresh', 'rotate-cw', 'rotate', 'anchor',
  'move',
  'panel-left', 'panel-right', 'panel-bottom', 'layout',
  'crosshair', 'theme', 'undo', 'redo',
  'select-all', 'deselect', 'mouse-pointer', 'pen', 'type', 'square', 'circle',
  'mask-square', 'mask-circle', 'mask-pen',
  'pencil', 'line', 'star', 'polygon', 'curvature',
  'copy', 'group', 'ungroup', 'trash',
  'folder', 'folder-open', 'folder-plus', 'upload', 'file', 'image', 'video', 'audio', 'audio-off', 'media', 'shape', 'layers',
  'component', 'zap',
  'zoom-in', 'zoom-out', 'fit', 'maximize', 'minimize',
  'info', 'warning', 'error', 'success',
  'drag', 'grip-vertical', 'grip-horizontal', 'hand',
  'collapse', 'expand',
  'keyframe', 'track', 'marker', 'stopwatch',
  'sparkles',
  '3d', 'box', 'cube', 'scale', 'heart', 'cross', 'crescent', 'diamond', 'adjustment', 'shy',
  'camera', 'light',
  'user',
  'align-left', 'align-center', 'align-right',
  'align-top', 'align-middle', 'align-bottom',
  'distribute-horizontal', 'distribute-vertical',
  'magnet', 'grid', 'ruler',
  'scissors',
  'queue', 'plugin', 'path', 'ease', 'frame', 'select-arrow', 'sliders-h',
  'brush', '3d-focus',
  'loop', 'motion-blur', 'trim-in', 'trim-out', 'solid',
  'graph-value', 'graph-speed', 'export', 'history', 'share', 'link', 'puppet-pin', 'push-pin', 'bone',
  'direct-select', 'pan-behind', 'draft-3d', 'layer-plus', 'puppet-starch', 'puppet-bend', 'puppet-advanced', 'puppet-overlap',
  'home', 'app', 'voice', 'sound', 'mic', 'ai', 'brain', 'tv', 'tour', 'text-left', 'text-center', 'text-right',
  // 3D viewport vocabulary — each of these exists because the glyph it replaced
  // was already spoken for by a DIFFERENT action in the same toolbar (orbit was
  // refresh = undo-ish, pan-camera was hand = the Hand tool, dolly was
  // zoom-in = the Zoom tool, the ground plane was grid = the 2D grid
  // overlay, and the 3D primitives borrowed the shape/text tool glyphs).
  'orbit', 'hand-grab', 'pan-camera', 'perspective', 'axis-3d', 'ground-grid',
  // The REFERENCE FRAME the gizmo aligns to: one axis tripod drawn inside
  // three different frames — layer bounds, world, camera view. NB: no
  // apostrophes here, per the note further down.
  'axis-local', 'axis-world', 'axis-view',
  'gizmo-universal', 'gizmo-position', 'gizmo-scale', 'gizmo-rotation',
  'sphere', 'cylinder', 'text-3d', 'pop-out', 'gpu',
  // Effect-browser folder vocabulary, one glyph per AE folder.
  'blur', 'palette', 'gradient', 'waves', 'eraser', 'clock', 'wipe', 'magic-wand',
  // Developer / API, in the dashboard sidebar. NB: no apostrophes in comments
  // here — generate-sharp-icons.mjs scrapes this list with a quote regex and
  // reads one as the start of a name.
  'code',
] as const;

export type IconName = (typeof ICON_NAMES)[number];
