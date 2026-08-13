/**
 * Tabs in the editor's main body.
 *
 * Two decisions here are load-bearing, and both are about what a tab is NOT.
 *
 * **Scene is not a tab.** It is the permanent background. It holds a
 * WebGL/WebGPU context, the playback state and the viewport transform, and all
 * three are destroyed if it unmounts — so opening a plugin's page and coming
 * back would reset the user's view and re-acquire a GPU context, which is both
 * visible and slow. Scene therefore has no entry in `tabs` at all; it is what
 * shows when nothing else does, it cannot be closed, and it cannot be reordered
 * into a position where something could close it. The renderer hides it with
 * CSS and never conditionally renders it — see `EditorTabs.tsx`.
 *
 * **Tab state is workspace state, not document state.** It persists next to the
 * user's layout, never in the project file. A `.premation` that opened plugin
 * tabs on a collaborator's machine — for plugins they do not have — would be a
 * bug that takes a week to trace, because the symptom appears on a machine that
 * never opened those tabs and the cause is inside a file nobody suspects.
 */

import { create } from 'zustand';

/** The kinds of thing that can occupy a tab. Deliberately a closed set. */
export type EditorTabKind = 'plugin';

export interface EditorTab {
  /** `plugin:<pluginId>` — stable, so reopening the same subject reuses a tab. */
  id: string;
  kind: EditorTabKind;
  title: string;
  /** The subject: a plugin id, for `kind: 'plugin'`. */
  ref: string;
  /**
   * A preview tab is shown in italics and REPLACED by the next preview.
   *
   * Without it, browsing twenty plugins in the sidebar opens twenty tabs and
   * the strip is useless by the time you have found the one you wanted. Single
   * click previews; double click, or any interaction inside the tab, pins it.
   */
  preview: boolean;
}

/** Not a member of `tabs`. Used by the renderer to mean "show the viewport". */
export const SCENE_TAB_ID = 'scene';

const PERSIST_KEY = 'motion-editor.workspace.tabs.v1';

/** A tab id that is safe to persist and to route on. */
const TAB_ID_RE = /^plugin:[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

interface PersistedShape {
  tabs: EditorTab[];
  activeId: string;
}

function load(): PersistedShape {
  const empty: PersistedShape = { tabs: [], activeId: SCENE_TAB_ID };
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return empty;
    const p = parsed as Partial<PersistedShape>;
    if (!Array.isArray(p.tabs)) return empty;

    // Shape-checked on read, and the id pattern is re-checked here rather than
    // trusted. This survived a reload and possibly a hand-edited localStorage,
    // and the id is used to look a plugin up — so a malformed one is dropped
    // rather than carried into a store lookup.
    const tabs = p.tabs.filter((t): t is EditorTab =>
      !!t && typeof t === 'object'
      && typeof t.id === 'string' && TAB_ID_RE.test(t.id)
      && t.kind === 'plugin'
      && typeof t.title === 'string' && typeof t.ref === 'string',
    // A restored tab is never a preview: preview-ness describes an in-progress
    // browse, and restoring one as italic-and-replaceable would surprise
    // someone who deliberately left it open.
    ).map((t) => ({ ...t, preview: false }));

    const activeId = typeof p.activeId === 'string' && (p.activeId === SCENE_TAB_ID || tabs.some((t) => t.id === p.activeId))
      ? p.activeId
      : SCENE_TAB_ID;
    return { tabs, activeId };
  } catch {
    return empty;
  }
}

function save(state: PersistedShape): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(state));
  } catch {
    // Full or private-mode storage costs the user their tab layout on next
    // launch and nothing else. Not worth surfacing.
  }
}

interface EditorTabStore extends PersistedShape {
  /** Open, or focus if already open. `preview` opens the reusable italic tab. */
  open(tab: Omit<EditorTab, 'preview'>, opts?: { preview?: boolean }): void;
  /** Promote the preview tab to a permanent one. */
  pin(id: string): void;
  close(id: string): void;
  closeAll(): void;
  activate(id: string): void;
  /** Move focus along the strip. Scene counts as the first position. */
  focusRelative(delta: number): void;
}

export const useEditorTabStore = create<EditorTabStore>((set, get) => ({
  ...load(),

  open: (tab, opts = {}) => {
    const { tabs } = get();
    const existing = tabs.find((t) => t.id === tab.id);

    let next: EditorTab[];
    if (existing) {
      // Already open. Opening it again as a non-preview PINS it — that is what
      // "double click a tab you were previewing" means.
      next = tabs.map((t) =>
        t.id === tab.id ? { ...t, ...tab, preview: opts.preview === true && t.preview } : t,
      );
    } else if (opts.preview) {
      // One preview slot, reused. Replacing rather than appending is the entire
      // reason preview tabs exist.
      const withoutPreview = tabs.filter((t) => !t.preview);
      next = [...withoutPreview, { ...tab, preview: true }];
    } else {
      next = [...tabs, { ...tab, preview: false }];
    }

    const state = { tabs: next, activeId: tab.id };
    set(state);
    save(state);
  },

  pin: (id) => {
    const { tabs, activeId } = get();
    if (!tabs.some((t) => t.id === id && t.preview)) return;
    const state = { tabs: tabs.map((t) => (t.id === id ? { ...t, preview: false } : t)), activeId };
    set(state);
    save(state);
  },

  close: (id) => {
    const { tabs, activeId } = get();
    const index = tabs.findIndex((t) => t.id === id);
    if (index === -1) return;
    const next = tabs.filter((t) => t.id !== id);
    // Focus the neighbour, falling back to Scene. Jumping to Scene from the
    // middle of a row of tabs is disorienting when a sibling is right there.
    const nextActive = activeId !== id
      ? activeId
      : (next[index]?.id ?? next[index - 1]?.id ?? SCENE_TAB_ID);
    const state = { tabs: next, activeId: nextActive };
    set(state);
    save(state);
  },

  closeAll: () => {
    const state = { tabs: [], activeId: SCENE_TAB_ID };
    set(state);
    save(state);
  },

  activate: (id) => {
    const { tabs } = get();
    if (id !== SCENE_TAB_ID && !tabs.some((t) => t.id === id)) return;
    const state = { tabs, activeId: id };
    set(state);
    save(state);
  },

  focusRelative: (delta) => {
    const { tabs, activeId } = get();
    // Scene occupies index 0 of the strip without being a member of `tabs`.
    const strip = [SCENE_TAB_ID, ...tabs.map((t) => t.id)];
    const at = strip.indexOf(activeId);
    if (at === -1) return;
    const target = strip[Math.min(strip.length - 1, Math.max(0, at + delta))];
    if (target) get().activate(target);
  },
}));

/** The tab id for a plugin's detail view. One per plugin, so reopening reuses. */
export function pluginTabId(pluginId: string): string {
  return `plugin:${pluginId}`;
}

export { PERSIST_KEY as TAB_PERSIST_KEY, TAB_ID_RE };
