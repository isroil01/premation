/**
 * WorkspaceState — a flat, serializable snapshot of everything the workspace is
 * currently doing. Panels/devtools read this; it is derived, never the source of
 * truth (the subsystems are). Produced by `Workspace.getState`.
 */

import type { NodeId } from '../ports';
import type { CameraState } from '../camera/Camera';
import type { ViewportState } from '../viewport/Viewport';
import type { GridState } from '../grid/Grid';
import type { Guide } from '../guides/Guides';
import type { SnapSettings } from '../snap/SnapEngine';
import type { CursorType } from '../cursor/CursorManager';

export interface WorkspaceState {
  focused: boolean;
  activeTool: string | null;
  cursor: CursorType;
  camera: CameraState;
  zoom: number;
  viewport: ViewportState;
  grid: GridState;
  guides: Guide[];
  snap: SnapSettings;
  selection: readonly NodeId[];
  hovered: NodeId | null;
}
