/**
 * Icon system — backed entirely by the Phosphor Icon library.
 *
 * The app-wide API is unchanged (`<Icon name="play" size={16} />`) and the
 * `IconName` union is stable, so every call site keeps working. Each name maps
 * to a single Phosphor glyph in `PHOSPHOR_MAP`; glyphs inherit `currentColor`.
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
  Repeat, Wind, ArrowLineLeft, ArrowLineRight, Rectangle, ChartLine, Gauge, Resize,
  Export, ClockCounterClockwise, ShareNetwork, Link, PushPin, Bone, House,
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
  'home', 'app', 'voice', 'sound', 'mic', 'ai', 'brain', 'tv', 'tour', 'text-left', 'text-center', 'text-right',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

const PHOSPHOR_MAP: Record<IconName, PhosphorIcon> = {
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
  'panel-left': SidebarSimple,
  'panel-right': SidebarSimple,
  'panel-bottom': SidebarSimple,
  layout: Layout,
  crosshair: Crosshair,
  theme: SunDim,
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
  component: Package,
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
  track: ListBullets,
  marker: Flag,
  stopwatch: Timer,
  sparkles: Sparkle,
  '3d': CubeFocus,
  box: Cube,
  cube: Cube,
  scale: Resize,
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
  loop: Repeat,
  'motion-blur': Wind,
  'trim-in': ArrowLineLeft,
  'trim-out': ArrowLineRight,
  solid: Rectangle,
  'graph-value': ChartLine,
  'graph-speed': Gauge,
  export: Export,
  history: ClockCounterClockwise,
  share: ShareNetwork,
  link: Link,
  'puppet-pin': PushPin,
  'push-pin': PushPin,
  bone: Bone,
  home: House,
  app: Package,
  voice: SpeakerHigh,
  sound: SpeakerHigh,
  mic: SpeakerHigh,
  ai: Sparkle,
  brain: Sparkle,
  tv: Layout,
  tour: Flag,
  'text-left': AlignLeft,
  'text-center': AlignCenterHorizontal,
  'text-right': AlignRight,
};

export interface IconProps {
  name: IconName;
  size?: number;
  weight?: IconWeight;
  className?: string;
  style?: CSSProperties;
  title?: string;
  onClick?: () => void;
  'aria-label'?: string;
}

import { usePreferenceStore } from '@stores/preferenceStore';

function IconInner({
  name,
  size = 16,
  weight = 'regular',
  className,
  style,
  title,
  onClick,
  'aria-label': ariaLabel,
}: IconProps): JSX.Element {
  const iconScale = usePreferenceStore((s) => s.iconSize);
  const scaleMult = iconScale === 'sm' ? 0.82 : iconScale === 'lg' ? 1.25 : 1.0;
  const computedSize = Math.max(10, Math.round(size * scaleMult));

  const transform = TRANSFORMS[name];
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
    ...(transform ? { transform: [transform, style?.transform].filter(Boolean).join(' ') } : {}),
  };

  if (name === 'ai') {
    return (
      <span
        className={className}
        style={mergedStyle}
        onClick={onClick}
        aria-label={ariaLabel ?? title}
        aria-hidden={(ariaLabel ?? title) ? undefined : true}
      >
        <svg width={computedSize} height={computedSize} viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M22.9417 11.8835C23.7621 11.8835 24.4272 11.2184 24.4272 10.3981C24.4272 9.57767 23.7621 8.91262 22.9417 8.91262C22.1214 8.91262 21.4563 9.57767 21.4563 10.3981C21.4563 11.2184 22.1214 11.8835 22.9417 11.8835Z" fill="currentColor"/>
          <path fillRule="evenodd" clipRule="evenodd" d="M7.26214 25.0874L11.8835 9.24272H14.6893L19.4757 25.0874H16.835L15.5146 20.6311H11.0583L9.57281 25.0874H7.26214ZM11.5534 18.1553L13.2039 11.8835L14.8544 18.1553H11.5534Z" fill="currentColor"/>
          <path d="M21.6214 13.3689V25.0874H24.2621V13.3689H21.6214Z" fill="currentColor"/>
          <path fillRule="evenodd" clipRule="evenodd" d="M0 6.27184C0 2.808 2.808 0 6.27184 0H27.7282C31.192 0 34 2.808 34 6.27184V27.7282C34 31.192 31.192 34 27.7282 34H6.27184C2.808 34 0 31.192 0 27.7282V6.27184ZM6.27184 1.65049H27.7282C30.2805 1.65049 32.3495 3.71954 32.3495 6.27184V27.7282C32.3495 30.2805 30.2805 32.3495 27.7282 32.3495H6.27184C3.71954 32.3495 1.65049 30.2805 1.65049 27.7282V6.27184C1.65049 3.71954 3.71954 1.65049 6.27184 1.65049Z" fill="currentColor"/>
        </svg>
      </span>
    );
  }

  const Glyph = PHOSPHOR_MAP[name] ?? Square;
  return (
    <span
      className={className}
      style={mergedStyle}
      onClick={onClick}
      aria-label={ariaLabel ?? title}
      aria-hidden={(ariaLabel ?? title) ? undefined : true}
    >
      <Glyph size={computedSize} weight={weight} />
    </span>
  );
}

export const Icon = memo(IconInner);
