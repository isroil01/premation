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
import type { PinKind } from '@core/rig/puppet';

/**
 * Which of AE's two right-hand column blocks the timeline shows.
 *
 * AE's "Toggle Switches / Modes" button, and the reason its panel fits: the
 * layer switches (shy · fx · blur · adjustment · guide · T · 3D) and the mode
 * columns (Mode · TrkMat · Parent) occupy the same horizontal space, and you
 * see one set at a time. Ours used to render both unconditionally, which needs
 * ~760px of header — so at any normal panel width Mode, TrkMat and Parent were
 * pushed off the right edge and could not be reached at all.
 */
export type TimelineColumns = 'switches' | 'modes' | 'both';

export type BoneRigMode = 'draw' | 'pose' | 'weights';
export type BoneWeightMode = 'add' | 'subtract' | 'smooth' | 'pick';

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
  // AE's Paint effect — strokes onto an EXISTING layer. Split out of `brush`,
  // which used to switch between the two based on what happened to be under
  // the cursor, so a second brush stroke silently became a paint stroke.
  | 'paint'
  // Paint with `mode: 'erase'` forced. Not a checkbox on the brush: an eraser
  // that can lay down colour because a shared setting was left on is not an
  // eraser, it is a trap.
  | 'eraser'
  | 'curvature'
  | 'line'
  | 'text'
  | 'shape'
  | 'ellipse'
  | 'polygon'
  | 'star'
  | 'mask-rect'
  | 'mask-ellipse'
  // The pen, aimed at the selected layer's masks. The plain `pen` used to do
  // this implicitly whenever exactly one layer was selected — which, because
  // drawing selects what it draws, was always.
  | 'mask-pen'
  | 'puppet-pin'
  | 'bone';

interface UIState {
  /** Active tool in the toolbar. */
  activeTool: Tool;
  /**
   * Armed Puppet pin variant while `activeTool` is `puppet-pin`.
   * Default is Position — the same first tool AE's flyout highlights.
   */
  puppetPinKind: PinKind;
  /** Bone workflow mode: construct, animate, or bind the deformation mesh. */
  boneRigMode: BoneRigMode;
  /** Brush/picker armed while `boneRigMode === 'weights'`. */
  boneWeightMode: BoneWeightMode;
  /** Screen-pixel brush radius; intentionally independent of camera zoom. */
  boneBrushRadius: number;
  /** Whether the user is currently dragging. */
  isDragging: boolean;
  /** Generic "toast"-style notifications. */
  notifications: ReadonlyArray<Notification>;
  /** Snap-to-grid / snap-to-object enabled. */
  snap: boolean;
  /** Whether the graph editor is currently open. */
  graphEditorOpen: boolean;
  /** Whether the global Shy layers toggle is active. */
  globalShy: boolean;
  /** AE's Toggle Switches / Modes — which right-hand column block is shown. */
  timelineColumns: TimelineColumns;
}

export interface Notification {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  /** Auto-dismiss after this many ms. 0 means manual dismiss only. */
  durationMs: number;
  createdAt: number;
  /**
   * One optional inline action.
   *
   * For the small class of notice that a user should be able to ACT on without
   * hunting for where. A modal would interrupt; a toast with no action is a
   * dead end.
   *
   * "Update ready ▸ Restart now" was the case this was built for and is no
   * longer one of them: a pending update outlives any toast, and a notice the
   * user can dismiss while the fact stays true is a notice that lies. It is a
   * persistent title-bar button now (`UpdateButton`). What belongs here is the
   * genuinely transient — something that HAPPENED and has a follow-up.
   *
   * One action, not a list: a toast with a row of buttons is a dialog wearing a
   * disguise, and the whole point is not to block.
   */
  action?: {
    label: string;
    onSelect(): void;
  };
}

interface UIActions {
  setActiveTool(tool: Tool): void;
  setPuppetPinKind(kind: PinKind): void;
  setBoneRigMode(mode: BoneRigMode): void;
  setBoneWeightMode(mode: BoneWeightMode): void;
  setBoneBrushRadius(radius: number): void;
  setDragging(isDragging: boolean): void;
  notify(notification: Omit<Notification, 'id' | 'createdAt'>): string;
  dismissNotification(id: string): void;
  toggleSnap(): void;
  setGraphEditorOpen(open: boolean): void;
  setGlobalShy(open: boolean): void;
  setTimelineColumns(columns: TimelineColumns): void;
  /** AE's button: Switches → Modes → Both → Switches. */
  cycleTimelineColumns(): void;
}

export type UIStore = UIState & UIActions;

export const useUIStore = create<UIStore>()(
  subscribeWithSelector(
    immer((set) => ({
      activeTool: 'select',
      puppetPinKind: 'position',
      boneRigMode: 'draw',
      boneWeightMode: 'add',
      boneBrushRadius: 40,
      isDragging: false,
      notifications: [],
      snap: true,
      graphEditorOpen: false,
      globalShy: false,
      // Both, not 'modes': the toggle exists so the panel CAN be narrowed, not
      // so it starts with controls missing. Defaulting to 'modes' hid every
      // per-layer switch (shy · fx · blur · adjustment · guide · T · 3D) until
      // you found the button, which is a worse first run than a wide header.
      timelineColumns: 'both',

      setActiveTool: (tool) =>
        set((s) => {
          s.activeTool = tool;
        }),
      setPuppetPinKind: (kind) =>
        set((s) => {
          s.puppetPinKind = kind;
        }),
      setBoneRigMode: (mode) =>
        set((s) => {
          s.boneRigMode = mode;
        }),
      setBoneWeightMode: (mode) =>
        set((s) => {
          s.boneWeightMode = mode;
        }),
      setBoneBrushRadius: (radius) =>
        set((s) => {
          s.boneBrushRadius = Math.max(4, Math.min(400, radius));
        }),
      setDragging: (isDragging) =>
        set((s) => {
          s.isDragging = isDragging;
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
      setGraphEditorOpen: (open) =>
        set((s) => {
          s.graphEditorOpen = open;
        }),
      setGlobalShy: (open) =>
        set((s) => {
          s.globalShy = open;
        }),
      setTimelineColumns: (columns) =>
        set((s) => {
          s.timelineColumns = columns;
        }),
      cycleTimelineColumns: () =>
        set((s) => {
          s.timelineColumns =
            s.timelineColumns === 'switches'
              ? 'modes'
              : s.timelineColumns === 'modes'
                ? 'both'
                : 'switches';
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
