/**
 * The workspace event map. Every viewport/camera/tool/selection change emits a
 * typed event so panels, the renderer, and future systems (timeline, AI) react
 * without polling. Mirrors the `@motion/scene` emitter convention.
 */

import type { Vec2 } from '../math/Vec2';
import type { Rect } from '../math/Rect';
import type { NodeId } from '../ports';
import type { CameraState } from '../camera/Camera';
import type { ViewportState } from '../viewport/Viewport';
import type { Guide } from '../guides/Guides';
import type { GridState } from '../grid/Grid';

export interface WorkspaceEventMap {
  WorkspaceFocused: { focused: boolean };
  ViewportChanged: { viewport: ViewportState };
  ZoomChanged: { zoom: number; previous: number };
  PanChanged: { center: Vec2; previous: Vec2 };
  CameraChanged: { camera: CameraState };
  SelectionChanged: { selected: readonly NodeId[]; previous: readonly NodeId[] };
  HoverChanged: { hovered: NodeId | null; previous: NodeId | null };
  ToolChanged: { tool: string; previous: string | null };
  CursorChanged: { cursor: string };
  GuideAdded: { guide: Guide };
  GuideRemoved: { guideId: string };
  GuideMoved: { guide: Guide };
  GridChanged: { grid: GridState };
  MarqueeChanged: { rect: Rect | null };
  InteractionStarted: { tool: string };
  InteractionEnded: { tool: string };
}

export type WorkspaceEventName = keyof WorkspaceEventMap;
