/**
 * Icon system — backed by Phosphor Icons.
 *
 * The app-wide API is unchanged (`<Icon name="play" size={16} />`) and the
 * `IconName` union is stable, so every call site keeps working. Internally each
 * name maps to a crisp Phosphor glyph, giving us a consistent, professional
 * icon set.
 */

import { memo, type CSSProperties } from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Download,
  Check, X, Plus, Minus,
  CaretDown, CaretUp, CaretLeft, CaretRight,
  MagnifyingGlass, Gear, List, DotsThree, DotsThreeVertical,
  Eye, EyeSlash, Lock, LockOpen,
  Play, Pause, Square, SkipBack, SkipForward,
  ArrowsCounterClockwise, ArrowClockwise, ArrowCounterClockwise, Anchor,
  ArrowsOutCardinal, SidebarSimple, Layout,
  Crosshair, SunDim, SelectionAll, SelectionSlash, Cursor,
  Pen, TextT, Circle, SelectionBackground, CircleHalf,
  Pencil, LineSegment, Star, Polygon, BezierCurve,
  Copy, FolderSimple, SquaresFour, Trash, Folder, File,
  Image, FilmStrip, SpeakerHigh, Shapes, Stack,
  MagnifyingGlassPlus, MagnifyingGlassMinus, CornersOut, ArrowsOut, ArrowsIn,
  Info, Warning, XCircle, CheckCircle, DotsSixVertical, DotsSix, Hand,
  CaretDoubleUp, CaretDoubleDown, DiamondsFour, ListBullets, Flag,
  Sparkle, Cube, Heart, Moon, Diamond, Sliders, Ghost, Camera, Lightbulb, User,
  AlignLeft, AlignCenterHorizontal, AlignRight, AlignTop, AlignCenterVertical, AlignBottom,
  ArrowsHorizontal, ArrowsVertical, Magnet, GridFour, Ruler, Scissors,
  Timer, ArrowUUpLeft, ArrowUUpRight, Queue, PuzzlePiece, Path, WaveSine,
  FrameCorners, NavigationArrow, SlidersHorizontal, PaintBrush,
  Lightning, Images, CubeFocus, Package, FolderPlus, FolderOpen, UploadSimple,
  Repeat, Wind, ArrowLineLeft, ArrowLineRight, Rectangle, ChartLine, Gauge,
  Export, ClockCounterClockwise, ShareNetwork, Link, PushPin, Bone,
  type Icon as PhosphorIcon, type IconWeight
} from '@phosphor-icons/react';

export type { IconWeight };

const TRANSFORMS: Partial<Record<IconName, string>> = {
  'panel-right': 'scaleX(-1)',
  'panel-bottom': 'rotate(-90deg)',
};

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
  'mask-square', 'mask-circle',
  'pencil', 'line', 'star', 'polygon', 'curvature',
  'copy', 'group', 'ungroup', 'trash',
  'folder', 'folder-open', 'folder-plus', 'upload', 'file', 'image', 'video', 'audio', 'media', 'shape', 'layers',
  'component', 'zap',
  'zoom-in', 'zoom-out', 'fit', 'maximize', 'minimize',
  'info', 'warning', 'error', 'success',
  'drag', 'grip-vertical', 'grip-horizontal', 'hand',
  'collapse', 'expand',
  'keyframe', 'track', 'marker', 'stopwatch',
  'sparkles',
  '3d', 'box', 'heart', 'cross', 'crescent', 'diamond', 'adjustment', 'shy',
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
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** name → Phosphor component. */
const MAP: Record<IconName, PhosphorIcon> = {
  'arrow-down': ArrowDown,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  download: Download,
  check: Check,
  close: X,
  plus: Plus,
  minus: Minus,
  'chevron-down': CaretDown,
  'chevron-up': CaretUp,
  'chevron-left': CaretLeft,
  'chevron-right': CaretRight,
  search: MagnifyingGlass,
  settings: Gear,
  menu: List,
  'more-horizontal': DotsThree,
  'more-vertical': DotsThreeVertical,
  eye: Eye,
  'eye-off': EyeSlash,
  lock: Lock,
  unlock: LockOpen,
  play: Play,
  pause: Pause,
  stop: Square,
  'skip-back': SkipBack,
  'skip-forward': SkipForward,
  refresh: ArrowsCounterClockwise,
  'rotate-cw': ArrowClockwise,
  rotate: ArrowCounterClockwise,
  anchor: Anchor,
  move: ArrowsOutCardinal,
  // Matched, orientation-correct panel-toggle family (right = mirrored,
  // bottom = rotated — see TRANSFORMS above).
  'panel-left': SidebarSimple,
  'panel-right': SidebarSimple,
  'panel-bottom': SidebarSimple,
  layout: Layout,
  crosshair: Crosshair,
  theme: SunDim,
  // Undo/redo get their own arrows — they previously aliased the same glyphs
  // as rotate/rotate-cw, so four different actions shared two icons.
  undo: ArrowUUpLeft,
  redo: ArrowUUpRight,
  'select-all': SelectionAll,
  deselect: SelectionSlash,
  'mouse-pointer': Cursor,
  pen: Pen,
  type: TextT,
  square: Square,
  circle: Circle,
  'mask-square': SelectionBackground,
  'mask-circle': CircleHalf,
  pencil: Pencil,
  line: LineSegment,
  star: Star,
  polygon: Polygon,
  curvature: BezierCurve,
  copy: Copy,
  group: FolderSimple,
  ungroup: SquaresFour,
  trash: Trash,
  folder: Folder,
  'folder-open': FolderOpen,
  'folder-plus': FolderPlus,
  upload: UploadSimple,
  file: File,
  image: Image,
  video: FilmStrip,
  audio: SpeakerHigh,
  media: Images,
  shape: Shapes,
  layers: Stack,
  // Reusable components get their own package glyph, distinct from the 3D cube.
  component: Package,
  // Motion presets. Previously registered as 'zap' with no mapping, so every
  // Motion tab silently fell back to the plain square glyph.
  zap: Lightning,
  'zoom-in': MagnifyingGlassPlus,
  'zoom-out': MagnifyingGlassMinus,
  fit: CornersOut,
  maximize: ArrowsOut,
  minimize: ArrowsIn,
  info: Info,
  warning: Warning,
  error: XCircle,
  success: CheckCircle,
  drag: DotsSixVertical,
  'grip-vertical': DotsSixVertical,
  'grip-horizontal': DotsSix,
  hand: Hand,
  collapse: CaretDoubleUp,
  expand: CaretDoubleDown,
  keyframe: DiamondsFour,
  stopwatch: Timer,
  track: ListBullets,
  marker: Flag,
  sparkles: Sparkle,
  // '3d' (the layer 3D toggle) and 'box' used to share the same Cube glyph.
  // Give the toggle a focused-cube so it reads as an on/off spatial control.
  '3d': CubeFocus,
  box: Cube,
  heart: Heart,
  cross: Plus,
  crescent: Moon,
  diamond: Diamond,
  adjustment: Sliders,
  shy: Ghost,
  camera: Camera,
  light: Lightbulb,
  user: User,
  'align-left': AlignLeft,
  'align-center': AlignCenterHorizontal,
  'align-right': AlignRight,
  'align-top': AlignTop,
  'align-middle': AlignCenterVertical,
  'align-bottom': AlignBottom,
  'distribute-horizontal': ArrowsHorizontal,
  'distribute-vertical': ArrowsVertical,
  magnet: Magnet,
  grid: GridFour,
  ruler: Ruler,
  scissors: Scissors,
  queue: Queue,
  plugin: PuzzlePiece,
  path: Path,
  ease: WaveSine,
  frame: FrameCorners,
  'select-arrow': NavigationArrow,
  'sliders-h': SlidersHorizontal,
  brush: PaintBrush,
  '3d-focus': CubeFocus,
  // Playback loop — a repeat cycle, distinct from the single-arrow rotate/redo
  // glyph the toggle used to borrow.
  loop: Repeat,
  // Motion blur — a wind/streak glyph, not the circular "refresh/reload" arrows.
  'motion-blur': Wind,
  // Timeline trim-to-playhead — line-anchored arrows that read as "clamp the
  // in/out edge", replacing the misused sidebar-panel glyphs.
  'trim-in': ArrowLineLeft,
  'trim-out': ArrowLineRight,
  // Solid/fill layer — a filled rectangle, not the bottom-panel toggle glyph.
  solid: Rectangle,
  // Graph editor tabs: value curve vs speed gauge.
  'graph-value': ChartLine,
  'graph-speed': Gauge,
  // Export (render out) — distinct from `download` (save a file) and `upload`
  // (import media).
  export: Export,
  history: ClockCounterClockwise,
  share: ShareNetwork,
  link: Link,
  'puppet-pin': PushPin,
  'push-pin': PushPin,
  bone: Bone,
};

/**
 * Unified default weight. Keeping every icon on one Phosphor weight is what
 * makes the set read as a single, clean family rather than a mix of stroke
 * thicknesses. Override per-call only when an icon needs emphasis (e.g. a
 * filled state for an active toggle).
 */
const DEFAULT_WEIGHT: IconWeight = 'regular';

interface IconProps {
  name: IconName;
  size?: number;
  /** Phosphor stroke weight. Defaults to the app-wide `DEFAULT_WEIGHT`. */
  weight?: IconWeight;
  className?: string;
  style?: CSSProperties;
  title?: string;
  onClick?: () => void;
  'aria-label'?: string;
}

function IconInner({ name, size = 16, weight = DEFAULT_WEIGHT, className, style, title, onClick, 'aria-label': ariaLabel }: IconProps): JSX.Element {
  const Glyph = MAP[name] ?? Square;
  const transform = TRANSFORMS[name];
  const mergedStyle = transform ? { ...style, transform: [transform, style?.transform].filter(Boolean).join(' ') } : style;
  return (
    <Glyph
      size={size}
      weight={weight}
      className={className}
      style={mergedStyle}
      onClick={onClick}
      aria-label={ariaLabel ?? title}
      aria-hidden={(ariaLabel ?? title) ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
    </Glyph>
  );
}

export const Icon = memo(IconInner);
