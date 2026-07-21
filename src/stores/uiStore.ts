/**
 * UI store — ephemeral, non-persisted UI state.
 *
 * Holds things that don't belong in the panel or preference stores: focus,
 * hover, transient modals, tooltips, drag state. Anything a single user
 * action would set then immediately unset.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { subscribeWithSelector } from 'zustand/middleware';
import type { Disposable } from '@app-types/common';

export type Tool =
  | 'select'
  | 'direct-select'
  | 'rotate'
  | 'pan-behind'
  | 'hand'
  | 'zoom'
  | 'move'
  | 'pen'
  | 'pencil'
  | 'brush'
  | 'curvature'
  | 'line'
  | 'text'
  | 'shape'
  | 'ellipse'
  | 'polygon'
  | 'star'
  | 'mask-rect'
  | 'mask-ellipse'
  | 'puppet-pin'
  | 'bone';

interface UIState {
  /** Active tool in the toolbar. */
  activeTool: Tool;
  /** Whether the user is currently dragging. */
  isDragging: boolean;
  /** ID of the panel currently focused (for keyboard routing). */
  focusedPanelId: string | null;
  /** Generic "toast"-style notifications. */
  notifications: ReadonlyArray<Notification>;
  /** Mouse position in screen coords, updated by the app shell. */
  pointer: { x: number; y: number };
  /** Snap-to-grid / snap-to-object enabled. */
  snap: boolean;
  /** Show grid overlay in the workspace canvas. */
  showGrid: boolean;
  /** Show rulers along the workspace edges. */
  showRulers: boolean;
  /** Whether the graph editor is currently open. */
  graphEditorOpen: boolean;
  /** Whether the global Shy layers toggle is active. */
  globalShy: boolean;
}

export interface Notification {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  /** Auto-dismiss after this many ms. 0 means manual dismiss only. */
  durationMs: number;
  createdAt: number;
}

interface UIActions {
  setActiveTool(tool: Tool): void;
  setDragging(isDragging: boolean): void;
  setFocusedPanel(id: string | null): void;
  setPointer(x: number, y: number): void;
  notify(notification: Omit<Notification, 'id' | 'createdAt'>): string;
  dismissNotification(id: string): void;
  toggleSnap(): void;
  toggleGrid(): void;
  toggleRulers(): void;
  setGraphEditorOpen(open: boolean): void;
  setGlobalShy(open: boolean): void;
}

export type UIStore = UIState & UIActions;

export const useUIStore = create<UIStore>()(
  subscribeWithSelector(
    immer((set) => ({
      activeTool: 'select',
      isDragging: false,
      focusedPanelId: null,
      notifications: [],
      pointer: { x: 0, y: 0 },
      snap: true,
      showGrid: false,
      showRulers: false,
      graphEditorOpen: false,
      globalShy: false,

      setActiveTool: (tool) =>
        set((s) => {
          s.activeTool = tool;
        }),
      setDragging: (isDragging) =>
        set((s) => {
          s.isDragging = isDragging;
        }),
      setFocusedPanel: (id) =>
        set((s) => {
          s.focusedPanelId = id;
        }),
      setPointer: (x, y) =>
        set((s) => {
          s.pointer.x = x;
          s.pointer.y = y;
        }),
      notify: (n) => {
        const id = `n_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        set((s) => {
          s.notifications.push({
            ...n,
            id,
            createdAt: Date.now(),
          });
        });
        if (n.durationMs > 0) {
          window.setTimeout(() => {
            useUIStore.getState().dismissNotification(id);
          }, n.durationMs);
        }
        return id;
      },
      dismissNotification: (id) =>
        set((s) => {
          s.notifications = s.notifications.filter((n) => n.id !== id);
        }),
      toggleSnap: () =>
        set((s) => {
          s.snap = !s.snap;
        }),
      toggleGrid: () =>
        set((s) => {
          s.showGrid = !s.showGrid;
        }),
      toggleRulers: () =>
        set((s) => {
          s.showRulers = !s.showRulers;
        }),
      setGraphEditorOpen: (open) =>
        set((s) => {
          s.graphEditorOpen = open;
        }),
      setGlobalShy: (open) =>
        set((s) => {
          s.globalShy = open;
        }),
    })),
  ),
);

/** Subscribe to a slice without React — for engines. */
export function subscribeUI(
  selector: (s: UIState) => unknown,
  listener: () => void,
): Disposable {
  const unsub = useUIStore.subscribe(selector, listener);
  return { dispose: unsub };
}
