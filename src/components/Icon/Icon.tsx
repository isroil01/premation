/**
 * Icon system — backed entirely by the Phosphor Icon library.
 *
 * The app-wide API is unchanged (`<Icon name="play" size="md" />`) and the
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
  Image, FilmStrip, SpeakerHigh, SpeakerSlash, Shapes, Stack,
  MagnifyingGlassPlus, MagnifyingGlassMinus, CornersOut, ArrowsOut, ArrowsIn,
  Info, Warning, XCircle, CheckCircle, DotsSixVertical, DotsSix, Hand,
  CaretDoubleUp, CaretDoubleDown, ListBullets, Flag,
  Sparkle, Cube, Heart, Moon, Diamond, Sliders, Ghost, Camera, Lightbulb, User,
  AlignLeft, AlignCenterHorizontal, AlignRight, AlignTop, AlignCenterVertical, AlignBottom,
  ArrowsHorizontal, ArrowsVertical, Magnet, GridFour, Ruler, Scissors,
  Timer, ArrowUUpLeft, ArrowUUpRight, Queue, PuzzlePiece, Path, WaveSine,
  FrameCorners, NavigationArrow, SlidersHorizontal, PaintBrush,
  Lightning, Images, CubeFocus, Package, FolderPlus, FolderOpen, UploadSimple,
  Repeat, Wind, ArrowLineLeft, ArrowLineRight, Rectangle, ChartLine, Gauge, Resize,
  Export, ClockCounterClockwise, ShareNetwork, Link, PushPin, Bone, House,
  Globe, HandGrabbing, Perspective, VectorThree, GridNine, Sphere, Cylinder,
  Textbox, PictureInPicture, GraphicsCard,
  // Effect-browser folder glyphs. Every folder in the browser used to carry the
  // same mark, which is a label rather than a distinction — eight identical
  // rows tell you nothing about which one holds Gaussian Blur.
  Drop, Palette, Gradient, Waves, Eraser, Clock, SquareHalf, MagicWand,
  type Icon as PhosphorIcon, type IconWeight
} from '@phosphor-icons/react';

import { ICON_NAMES, type IconName } from './iconNames';

export type { IconWeight };

const TRANSFORMS: Partial<Record<IconName, string>> = {
  'panel-right': 'scaleX(-1)',
  'panel-bottom': 'rotate(-90deg)',
};

// The vocabulary itself lives in `iconNames.ts` — pure data, no React — so the
// plugin manifest validator can check a third-party icon name without importing
// a component. Re-exported here so `@components/Icon` stays the single import
// site for everything else.
export { ICON_NAMES };
export type { IconName };

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
  'audio-off': SpeakerSlash,
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
  // The keyframe diamond, singular. `DiamondsFour` — a 2×2 arrangement of four
  // diamonds — was standing in for it everywhere the app draws a keyframe: the
  // timeline, the property-row navigator, the stopwatch column. It reads as a
  // grid glyph, not as the mark AE users are looking for.
  keyframe: Diamond,
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
  orbit: Globe,
  'hand-grab': HandGrabbing,
  'pan-camera': HandGrabbing,
  perspective: Perspective,
  'axis-3d': VectorThree,
  'ground-grid': GridNine,
  sphere: Sphere,
  cylinder: Cylinder,
  'text-3d': Textbox,
  'pop-out': PictureInPicture,
  gpu: GraphicsCard,
  blur: Drop,
  palette: Palette,
  gradient: Gradient,
  waves: Waves,
  eraser: Eraser,
  clock: Clock,
  wipe: SquareHalf,
  'magic-wand': MagicWand,
};

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
 * `iconScaleGuard.test.ts` fails on any new numeric size in the chrome band.
 */
export const ICON_SIZE = {
  /** Row glyphs, tree twisties, inline chips. */
  sm: 13,
  /** Toolbar and panel buttons, asset type icons. */
  md: 16,
  /** Empty states, section headers. */
  lg: 22,
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

import { usePreferenceStore } from '@stores/preferenceStore';

function IconInner({
  name,
  size = 'md',
  weight = 'regular',
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

  if (name === 'pan-camera') {
    return (
      <span
        className={className}
        style={mergedStyle}
        onClick={onClick}
        aria-label={ariaLabel ?? title}
        aria-hidden={(ariaLabel ?? title) ? undefined : true}
      >
        <svg width={computedSize} height={computedSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          <path d="m9.5 3.5 2.5-2.5 2.5 2.5M9.5 20.5l2.5 2.5 2.5-2.5M3.5 9.5 1 12l2.5 2.5M20.5 9.5l2.5 2.5-2.5 2.5" />
          <rect x="7" y="7" width="10" height="10" rx="2" />
          <circle cx="12" cy="12" r="2.5" />
        </svg>
      </span>
    );
  }

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
