/**
 * Icon system — backed by Lucide.
 *
 * The app-wide API is unchanged (`<Icon name="play" size={16} />`) and the
 * `IconName` union is stable, so every call site keeps working. Internally each
 * name maps to a crisp Lucide glyph, giving us a consistent, professional
 * 1000+ icon set instead of the old hand-drawn subset.
 */

import { memo, type CSSProperties } from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp,
  Check, X, Plus, Minus,
  ChevronDown, ChevronUp, ChevronLeft, ChevronRight,
  Search, Settings, Menu, MoreHorizontal, MoreVertical,
  Eye, EyeOff, Lock, LockOpen,
  Play, Pause, Square, SkipBack, SkipForward,
  RefreshCw, RotateCw, Move,
  PanelLeft, PanelRight, PanelBottom, LayoutGrid,
  Crosshair, SunMoon, Undo2, Redo2,
  BoxSelect, SquareDashed, MousePointer2, PenTool, Type, Circle,
  Folder, File, Image, Video, AudioLines, Shapes, Layers,
  ZoomIn, ZoomOut, Maximize, Maximize2, Minimize2,
  Info, TriangleAlert, CircleAlert, CircleCheck,
  GripVertical, GripHorizontal, ChevronsDownUp, ChevronsUpDown,
  Diamond, Rows3, Flag, Sparkles,
  Box, Contrast, User,
  Camera, Lightbulb,
  AlignLeft, AlignCenter, AlignRight,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter,
  Magnet, Grid2x2, Ruler,
  type LucideIcon,
} from 'lucide-react';

export const ICON_NAMES = [
  'arrow-down', 'arrow-left', 'arrow-right', 'arrow-up',
  'check', 'close', 'plus', 'minus',
  'chevron-down', 'chevron-up', 'chevron-left', 'chevron-right',
  'search', 'settings', 'menu', 'more-horizontal', 'more-vertical',
  'eye', 'eye-off', 'lock', 'unlock',
  'play', 'pause', 'stop', 'skip-back', 'skip-forward',
  'refresh', 'rotate-cw',
  'move',
  'panel-left', 'panel-right', 'panel-bottom', 'layout',
  'crosshair', 'theme', 'undo', 'redo',
  'select-all', 'deselect', 'mouse-pointer', 'pen', 'type', 'square', 'circle',
  'folder', 'file', 'image', 'video', 'audio', 'shape', 'layers',
  'zoom-in', 'zoom-out', 'fit', 'maximize', 'minimize',
  'info', 'warning', 'error', 'success',
  'drag', 'grip-vertical', 'grip-horizontal',
  'collapse', 'expand',
  'keyframe', 'track', 'marker',
  'sparkles',
  '3d', 'adjustment', 'shy',
  'camera', 'light',
  'user',
  'align-left', 'align-center', 'align-right',
  'align-top', 'align-middle', 'align-bottom',
  'distribute-horizontal', 'distribute-vertical',
  'magnet', 'grid', 'ruler',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** name → Lucide component. */
const MAP: Record<IconName, LucideIcon> = {
  'arrow-down': ArrowDown, 'arrow-left': ArrowLeft, 'arrow-right': ArrowRight, 'arrow-up': ArrowUp,
  check: Check, close: X, plus: Plus, minus: Minus,
  'chevron-down': ChevronDown, 'chevron-up': ChevronUp, 'chevron-left': ChevronLeft, 'chevron-right': ChevronRight,
  search: Search, settings: Settings, menu: Menu, 'more-horizontal': MoreHorizontal, 'more-vertical': MoreVertical,
  eye: Eye, 'eye-off': EyeOff, lock: Lock, unlock: LockOpen,
  play: Play, pause: Pause, stop: Square, 'skip-back': SkipBack, 'skip-forward': SkipForward,
  refresh: RefreshCw, 'rotate-cw': RotateCw,
  move: Move,
  'panel-left': PanelLeft, 'panel-right': PanelRight, 'panel-bottom': PanelBottom, layout: LayoutGrid,
  crosshair: Crosshair, theme: SunMoon, undo: Undo2, redo: Redo2,
  'select-all': BoxSelect, deselect: SquareDashed, 'mouse-pointer': MousePointer2, pen: PenTool, type: Type, square: Square, circle: Circle,
  folder: Folder, file: File, image: Image, video: Video, audio: AudioLines, shape: Shapes, layers: Layers,
  'zoom-in': ZoomIn, 'zoom-out': ZoomOut, fit: Maximize, maximize: Maximize2, minimize: Minimize2,
  info: Info, warning: TriangleAlert, error: CircleAlert, success: CircleCheck,
  drag: GripVertical, 'grip-vertical': GripVertical, 'grip-horizontal': GripHorizontal,
  collapse: ChevronsDownUp, expand: ChevronsUpDown,
  keyframe: Diamond, track: Rows3, marker: Flag,
  sparkles: Sparkles,
  '3d': Box, adjustment: Contrast, shy: User,
  camera: Camera, light: Lightbulb,
  user: User,
  'align-left': AlignLeft, 'align-center': AlignCenter, 'align-right': AlignRight,
  'align-top': AlignStartVertical, 'align-middle': AlignCenterVertical, 'align-bottom': AlignEndVertical,
  'distribute-horizontal': AlignHorizontalDistributeCenter, 'distribute-vertical': AlignVerticalDistributeCenter,
  magnet: Magnet, grid: Grid2x2, ruler: Ruler,
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
  onClick?: () => void;
  'aria-label'?: string;
}

function IconInner({ name, size = 16, className, style, title, onClick, 'aria-label': ariaLabel }: IconProps): JSX.Element {
  const Glyph = MAP[name] ?? Square;
  return (
    <Glyph
      size={size}
      strokeWidth={1.75}
      className={className}
      style={style}
      onClick={onClick}
      aria-label={ariaLabel ?? title}
      aria-hidden={(ariaLabel ?? title) ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
    </Glyph>
  );
}

export const Icon = memo(IconInner);
