/**
 * Workspace store — represents a single editing context (composition / scene).
 *
 * A "workspace" is the unit of state that future engines (Scene Graph,
 * Animation, Render) operate on. The UI doesn't know about those engines
 * — it just shows a viewport and a timeline. When a future engine boots,
 * it will:
 *   1. Register a workspace factory via `application.registerPlugin`.
 *   2. Update the active workspace id on load.
 *   3. Publish state changes to the event bus.
 *
 * For now the store holds only metadata (id, title, dirty flag) so the UI
 * can render a title bar and status indicators.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { getEventBus } from '@core/events/EventBus';
import { shortId } from '@utils/lang';

export interface WorkspaceInfo {
  id: string;
  title: string;
  dirty: boolean;
  /** Current playback time in seconds (driven by future engine). */
  time: number;
  /** Current frame number (rounded from time * frameRate). */
  frame: number;
  playing: boolean;
}

interface WorkspaceActions {
  setActive(id: string): void;
  rename(id: string, title: string): void;
  markDirty(id: string, dirty: boolean): void;
  setTime(time: number, frame: number): void;
  setPlaying(playing: boolean): void;
  createWorkspace(title?: string): WorkspaceInfo;
  removeWorkspace(id: string): void;
}

interface WorkspaceStoreShape {
  workspaces: Record<string, WorkspaceInfo>;
  order: ReadonlyArray<string>;
  activeId: string | null;
  actions: WorkspaceActions;
}

let _activeDefaultSet = false;

export const useWorkspaceStore = create<WorkspaceStoreShape>()(
  immer((set, get) => {
    const defaultId = `ws_${shortId()}`;
    const initial: WorkspaceInfo = {
      id: defaultId,
      title: 'Untitled',
      dirty: false,
      time: 0,
      frame: 0,
      playing: false,
    };

    const actions: WorkspaceActions = {
      setActive: (id) => {
        const previous = get().activeId;
        set((s) => {
          if (!s.workspaces[id]) return;
          s.activeId = id;
        });
        if (previous !== id) {
          getEventBus().emit('WorkspaceChanged', { from: previous ?? '', to: id });
        }
      },
      rename: (id, title) =>
        set((s) => {
          if (s.workspaces[id]) s.workspaces[id]!.title = title;
        }),
      markDirty: (id, dirty) => {
        set((s) => {
          if (s.workspaces[id]) s.workspaces[id]!.dirty = dirty;
        });
        getEventBus().emit('ProjectDirtyChanged', { dirty });
      },
      setTime: (time, frame) => {
        set((s) => {
          const active = s.activeId ? s.workspaces[s.activeId] : null;
          if (active) {
            active.time = time;
            active.frame = frame;
          }
        });
        getEventBus().emit('TimeChanged', { time, frame });
      },
      setPlaying: (playing) => {
        set((s) => {
          const active = s.activeId ? s.workspaces[s.activeId] : null;
          if (active) active.playing = playing;
        });
        getEventBus().emit('PlayStateChanged', { playing });
      },
      createWorkspace: (title) => {
        const id = `ws_${shortId()}`;
        const ws: WorkspaceInfo = {
          id,
          title: title ?? 'Untitled',
          dirty: false,
          time: 0,
          frame: 0,
          playing: false,
        };
        set((s) => {
          s.workspaces[id] = ws;
          s.order = [...s.order, id];
          if (!_activeDefaultSet) {
            s.activeId = id;
            _activeDefaultSet = true;
          }
        });
        return ws;
      },
      removeWorkspace: (id) =>
        set((s) => {
          if (!s.workspaces[id]) return;
          delete s.workspaces[id];
          s.order = s.order.filter((x) => x !== id);
          if (s.activeId === id) s.activeId = s.order[0] ?? null;
        }),
    };

    return {
      workspaces: { [defaultId]: initial },
      order: [defaultId],
      activeId: defaultId,
      actions,
    };
  }),
);

export function useActiveWorkspace(): WorkspaceInfo | null {
  return useWorkspaceStore((s) => (s.activeId ? s.workspaces[s.activeId] ?? null : null));
}
