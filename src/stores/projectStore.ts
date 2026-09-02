/**
 * ProjectStore — Tab manager and root state for the multi-composition editor.
 * Replaces WorkspaceStore.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { getEventBus } from '@core/events/EventBus';
import { shortId } from '@utils/lang';
import type { FillPaint } from '@core/paint/fill';
import type { EnvironmentPresetId } from '@core/scene/environmentLight';

export interface TabInfo {
  id: string; // The UI tab ID
  compositionId: string; // The root SceneNode ID for this tab
  breadcrumbPath: string[]; // E.g. ['comp_main', 'comp_lower_third']
  time: number;
  frame: number;
  playing: boolean;
  title: string;
  dirty: boolean;
}

export interface CompositionSettings {
  id: string;
  name: string;
  /**
   * True on the AUTO-MINTED comp a fresh document carries (the engine needs a
   * root; After Effects' "no compositions yet" state cannot exist here), and
   * cleared the moment the user makes it theirs. While a project holds only
   * pristine, layerless comps: the comp tab reads "(none)", the viewport
   * shows the two start cards, and the first New Composition / From Footage
   * ADOPTS this comp (configures it in place) instead of stacking a second
   * one beside a "Main Comp" nobody created. Deleting the LAST comp re-mints
   * one of these (see deleteComposition) — that is what "deleting the only
   * comp" means to the user: back to the empty project. Old documents lack
   * the field, which correctly reads as "real" — a saved project's comp is
   * owned.
   */
  pristine?: boolean;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  /** Solid background colour AND the fallback for GPU/export + gradient first
   *  stop. Always kept in sync with `backgroundPaint` when the latter is set. */
  background: string;
  /**
   * Rich background paint (solid / linear / radial gradient). When present the
   * Canvas2D viewport paints this instead of the flat `background` colour;
   * `background` still mirrors its representative colour so exports and the GPU
   * backend keep working. Undefined = plain solid `background` (back-compat).
   */
  backgroundPaint?: FillPaint;
  transparent: boolean;
  /**
   * Frame the composition's DISPLAYED timecode starts from (AE's "Start
   * Timecode"). Display-only: keyframes and playback stay 0-based; this just
   * labels frame 0. Default 0.
   */
  startFrame: number;
  /**
   * GLOBAL LIGHT — one comp-wide light direction that layer styles can opt into.
   *
   * This is what makes a layer STYLE different from the equivalent effect: a
   * style bound to the global light moves when the light moves, so every shadow
   * and bevel in the composition agrees and can be re-lit from one control.
   * An effect's angle is its own and always will be.
   *
   * Angle is unbounded like layer rotation (a sweep may cross 0 and keep going);
   * altitude is 0-90, where 90 is directly overhead.
   *
   * OPTIONAL because projects saved before global light existed do not carry
   * them, and a required field would make every one of those documents fail to
   * type — and, worse, load as `undefined` and render a shadow at angle NaN.
   * Read them through `resolveGlobalLight`, never directly.
   */
  globalLightAngle?: number;
  globalLightAltitude?: number;

  // ── World (Composition Settings ▸ World) ──────────────────────────
  //
  // All three are OPTIONAL and all three default to exactly the behaviour that
  // existed before them, so a document written without them reads back
  // byte-identical and renders byte-identical. `DEFAULT_COMP_SETTINGS`
  // deliberately does NOT state them: a stated value would be written into
  // every new comp record and change every document on disk.

  /**
   * The sky a NEW environment light starts on (see `insertLight`). A project
   * shot against one HDRI look wants every probe it adds to begin there rather
   * than on Studio; this is per-COMP because that is the unit a look belongs
   * to. Absent = 'studio', the hardcoded default it replaces.
   */
  defaultEnvPreset?: EnvironmentPresetId;
  /**
   * Where the 3D reference floor sits, as an OFFSET in comp units from the
   * comp's bottom edge (positive = further down). The ground grid has always
   * been nailed to y = compHeight; a scene blocked out around a different floor
   * had no way to say so and the grid read as a lie. Absent or 0 = the legacy
   * plane, to the pixel.
   *
   * Reference geometry only — nothing rendered reads it.
   */
  groundLevel?: number;
  /**
   * "Show sky as backdrop" — STORED ONLY. The environment probe is an
   * irradiance field, not a reflection map, so there is nothing to draw behind
   * the scene yet; the setting exists so a project can carry the intent (and so
   * the control has a home) and the UI disables it and says so. No renderer
   * reads this.
   */
  showSkyBackdrop?: boolean;
}

/** The composition's light direction, with the pre-global-light defaults. */
export const DEFAULT_GLOBAL_LIGHT = { angle: 90, altitude: 45 } as const;

/**
 * Resolve a composition's global light, filling in the defaults for documents
 * saved before it existed. Every consumer goes through here so a shadow can
 * never be drawn at `undefined` degrees.
 */
export function resolveGlobalLight(
  comp: Pick<CompositionSettings, 'globalLightAngle' | 'globalLightAltitude'> | undefined,
): { angle: number; altitude: number } {
  return {
    angle: Number.isFinite(comp?.globalLightAngle) ? (comp!.globalLightAngle as number) : DEFAULT_GLOBAL_LIGHT.angle,
    altitude: Number.isFinite(comp?.globalLightAltitude)
      ? (comp!.globalLightAltitude as number)
      : DEFAULT_GLOBAL_LIGHT.altitude,
  };
}

export interface ProjectStoreShape {
  tabs: Record<string, TabInfo>;
  comps: Record<string, CompositionSettings>;
  tabOrder: string[];
  activeTabId: string | null;
  actions: {
    setActiveTab: (tabId: string) => void;
    setActive: (id: string) => void;
    openTab: (compositionId: string, breadcrumbPath?: string[], title?: string) => string;
    closeTab: (tabId: string) => void;
    markDirty: (id: string, dirty: boolean) => void;
    
    // Per-tab playback state (driven by TimelineController)
    setTime: (time: number, frame: number) => void;
    setPlaying: (playing: boolean) => void;
    /**
     * Set the playing flag on a SPECIFIC tab, active or not.
     *
     * `setPlaying` writes only the active tab, which is right for the transport
     * but leaves no way to stop a tab you have already switched away from — and
     * a tab switch during playback did exactly that: the outgoing tab kept
     * `playing: true` forever, so returning to it resumed playback with no user
     * input at all. See `usePlaybackClock`.
     */
    setTabPlaying: (tabId: string, playing: boolean) => void;

    // Breadcrumb drill-down
    pushBreadcrumb: (nodeId: string) => void;
    jumpToBreadcrumb: (index: number) => void;

    // Composition management
    updateComp: (id: string, patch: Partial<CompositionSettings>) => void;
    /** Create a composition if absent; returns the settings either way. */
    ensureComp: (id: string, init?: Partial<CompositionSettings>) => CompositionSettings;
    /**
     * Add a NEW composition and return its id.
     *
     * Nothing ever inserted into `comps` before this: the table was seeded with
     * one entry and `updateComp` only patched existing keys, so "New
     * Composition" could only ever overwrite the one comp and wipe the scene.
     */
    createComp: (init?: Partial<CompositionSettings>) => string;
    /** Drop a composition's settings. Use `deleteComposition` for the whole thing. */
    removeComp: (id: string) => void;
    /** Replace the whole comp table (project load). */
    replaceComps: (comps: Record<string, CompositionSettings>) => void;
    /**
     * Collapse back to a single tab on the default composition (File ▸ New).
     *
     * A new project replaces the comp table, and any precomp tabs the previous
     * project had open then pointed at compositions that no longer exist —
     * silently falling back to DEFAULT_COMPOSITION and dropping every settings
     * edit made through them.
     */
    resetTabs: () => void;
    /**
     * Restore composition tabs from a saved document (open tabs + playhead).
     * Playing/dirty are session state and are not restored.
     */
    hydrateWorkspaceTabs: (snap: SerializedWorkspaceTabs) => void;
  };
}

/** What `captureDocument` persists for the composition tab strip. */
export interface SerializedWorkspaceTabs {
  tabOrder: string[];
  activeTabId: string | null;
  tabs: Record<string, Pick<TabInfo, 'id' | 'compositionId' | 'breadcrumbPath' | 'title' | 'time' | 'frame'>>;
}

export const DEFAULT_COMP_SETTINGS: Omit<CompositionSettings, 'id' | 'name'> = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 10,
  background: '#101014',
  transparent: false,
  startFrame: 0,
};

export const useProjectStore = create<ProjectStoreShape>()(
  immer((set, get) => {
    // We start with one default tab pointing to a "Main Comp"
    const defaultTabId = `tab_${shortId()}`;
    const defaultCompId = 'comp_root';

    const initialTab: TabInfo = {
      id: defaultTabId,
      compositionId: defaultCompId,
      breadcrumbPath: [defaultCompId],
      time: 0,
      frame: 0,
      playing: false,
      title: 'Main Comp',
      dirty: false,
    };

    const initialComp: CompositionSettings = {
      id: defaultCompId,
      name: 'Main Comp',
      // Same flag `createEmpty` writes. Without it, Continue-without-a-project
      // (and any boot that never goes through New Project) paints a dark empty
      // composition frame with no start cards — the desktop "blank window" report.
      pristine: true,
      ...DEFAULT_COMP_SETTINGS,
    };

    return {
      tabs: { [defaultTabId]: initialTab },
      comps: { [defaultCompId]: initialComp },
      tabOrder: [defaultTabId],
      activeTabId: defaultTabId,
      actions: {
        setActiveTab: (tabId) => {
          const previous = get().activeTabId;
          set((s) => {
            if (!s.tabs[tabId]) return;
            s.activeTabId = tabId;
          });
          if (previous !== tabId) {
            getEventBus().emit('WorkspaceChanged', { from: previous ?? '', to: tabId });
          }
        },
        setActive: (id: string) => {
          get().actions.setActiveTab(id);
        },
        openTab: (compositionId, breadcrumbPath, title) => {
          // Re-activating an existing tab beats stacking duplicates — repeated
          // double-clicks on the same group must not spawn parallel tabs.
          const existing = Object.values(get().tabs).find(
            (t) => t.compositionId === compositionId,
          );
          if (existing) {
            get().actions.setActiveTab(existing.id);
            return existing.id;
          }
          const previous = get().activeTabId;
          const tabId = `tab_${shortId()}`;
          const tab: TabInfo = {
            id: tabId,
            compositionId,
            breadcrumbPath: breadcrumbPath ?? [compositionId],
            time: 0,
            frame: 0,
            playing: false,
            title: title ?? 'New Comp',
            dirty: false,
          };
          // A tab without a comp entry falls back to DEFAULT_COMPOSITION and
          // drops every settings edit. Seed one, inheriting the comp the user
          // drilled down from so a precomp opens at the project's real size/fps.
          const parentId = tab.breadcrumbPath[tab.breadcrumbPath.length - 2];
          const parent = parentId ? get().comps[parentId] : undefined;
          const inherited = get().activeTabId
            ? get().comps[get().tabs[get().activeTabId!]?.compositionId ?? '']
            : undefined;
          const base = parent ?? inherited;
          get().actions.ensureComp(compositionId, {
            name: title ?? 'Composition',
            ...(base ? { width: base.width, height: base.height, fps: base.fps, durationSeconds: base.durationSeconds } : {}),
          });
          set((s) => {
            s.tabs[tabId] = tab;
            s.tabOrder.push(tabId);
            s.activeTabId = tabId;
          });
          getEventBus().emit('WorkspaceChanged', { from: previous ?? '', to: tabId });
          return tabId;
        },
        closeTab: (tabId) => {
          set((s) => {
            if (!s.tabs[tabId]) return;
            delete s.tabs[tabId];
            s.tabOrder = s.tabOrder.filter((id) => id !== tabId);
            if (s.activeTabId === tabId) {
              s.activeTabId = s.tabOrder[s.tabOrder.length - 1] ?? null;
            }
          });
        },
        markDirty: (id: string, dirty: boolean) => {
          set((s) => {
            if (s.tabs[id]) s.tabs[id]!.dirty = dirty;
          });
          getEventBus().emit('ProjectDirtyChanged', { dirty });
        },
        setTime: (time, frame) => {
          set((s) => {
            const active = s.activeTabId ? s.tabs[s.activeTabId] : null;
            if (active) {
              active.time = time;
              active.frame = frame;
            }
          });
          getEventBus().emit('TimeChanged', { time, frame });
        },
        setPlaying: (playing) => {
          set((s) => {
            const active = s.activeTabId ? s.tabs[s.activeTabId] : null;
            if (active) active.playing = playing;
          });
          getEventBus().emit('PlayStateChanged', { playing });
        },
        setTabPlaying: (tabId, playing) => {
          const tab = get().tabs[tabId];
          if (!tab || tab.playing === playing) return;
          set((s) => {
            const t = s.tabs[tabId];
            if (t) t.playing = playing;
          });
          // Only the ACTIVE tab's state is the transport's state, so only that
          // one is worth announcing — a background tab being stopped is
          // bookkeeping, and broadcasting it would tell the transport UI that
          // playback stopped when the tab you are looking at is still playing.
          if (get().activeTabId === tabId) {
            getEventBus().emit('PlayStateChanged', { playing });
          }
        },
        pushBreadcrumb: (nodeId) => {
          set((s) => {
            const active = s.activeTabId ? s.tabs[s.activeTabId] : null;
            if (active) {
              active.breadcrumbPath.push(nodeId);
            }
          });
        },
        jumpToBreadcrumb: (index) => {
          set((s) => {
            const active = s.activeTabId ? s.tabs[s.activeTabId] : null;
            if (active && index >= 0 && index < active.breadcrumbPath.length) {
              active.breadcrumbPath = active.breadcrumbPath.slice(0, index + 1);
            }
          });
        },
        updateComp: (id, patch) => {
          set((s) => {
            // Auto-create rather than drop the edit. Comp tabs are opened with a
            // scene node id (precomps/groups), which has no comps entry until
            // something makes one — the old `if (exists)` guard silently
            // swallowed every settings change inside such a tab.
            const existing = s.comps[id];
            if (existing) Object.assign(existing, patch);
            else s.comps[id] = { id, name: id, ...DEFAULT_COMP_SETTINGS, ...patch };
          });
          getEventBus().emit('DocumentChanged', { source: 'composition' });
        },
        ensureComp: (id, init) => {
          const found = get().comps[id];
          if (found) return found;
          const { id: _ignored, ...rest } = init ?? {};
          const created: CompositionSettings = {
            name: 'Composition',
            ...DEFAULT_COMP_SETTINGS,
            ...rest,
            id,
          };
          set((s) => {
            s.comps[id] = created;
          });
          return created;
        },
        createComp: (init) => {
          // An explicit id keeps redo stable: re-creating a comp under a fresh
          // id would orphan every later history entry that targets it.
          const id = init?.id ?? `comp_${shortId()}`;
          const { id: _ignored, ...rest } = init ?? {};
          const created: CompositionSettings = {
            name: 'Composition',
            ...DEFAULT_COMP_SETTINGS,
            ...rest,
            id,
          };
          set((s) => {
            s.comps[id] = created;
          });
          getEventBus().emit('DocumentChanged', { source: 'composition' });
          return id;
        },
        removeComp: (id) => {
          set((s) => {
            delete s.comps[id];
          });
          getEventBus().emit('DocumentChanged', { source: 'composition' });
        },
        replaceComps: (comps) => {
          set((s) => {
            s.comps = { ...comps };
          });
        },
        resetTabs: () => {
          const tabId = `tab_${shortId()}`;
          set((s) => {
            s.tabs = {
              [tabId]: {
                id: tabId,
                compositionId: defaultCompId,
                breadcrumbPath: [defaultCompId],
                time: 0,
                frame: 0,
                playing: false,
                title: 'Main Comp',
                dirty: false,
              },
            };
            s.tabOrder = [tabId];
            s.activeTabId = tabId;
          });
        },
        hydrateWorkspaceTabs: (snap) => {
          const tabs: Record<string, TabInfo> = {};
          for (const id of snap.tabOrder) {
            const t = snap.tabs[id];
            if (!t) continue;
            tabs[id] = {
              id: t.id,
              compositionId: t.compositionId,
              breadcrumbPath: t.breadcrumbPath.length > 0 ? [...t.breadcrumbPath] : [t.compositionId],
              title: t.title,
              time: t.time,
              frame: t.frame,
              playing: false,
              dirty: false,
            };
          }
          if (Object.keys(tabs).length === 0) {
            get().actions.resetTabs();
            return;
          }
          const tabOrder = snap.tabOrder.filter((id) => tabs[id]);
          const activeTabId =
            (snap.activeTabId && tabs[snap.activeTabId] ? snap.activeTabId : tabOrder[0]) ?? null;
          set((s) => {
            s.tabs = tabs;
            s.tabOrder = tabOrder;
            s.activeTabId = activeTabId;
          });
        },
      },
    };
  })
);

export function useActiveTab(): TabInfo | null {
  return useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId] ?? null : null));
}

// Aliases for compatibility
export const useWorkspaceStore = useProjectStore;
export const useActiveWorkspace = useActiveTab;
