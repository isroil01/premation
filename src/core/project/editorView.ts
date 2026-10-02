/**
 * Editor state that used to ride inside the project document — and must not
 * (CLAUDE.md: "Editor state never enters the project document"; ENGINE_API.md
 * §2.5 #10, left for B4).
 *
 * Until B4 `captureDocument` wrote:
 *   - `openTabs`: which compositions are open as tabs, the active one, each
 *     tab's breadcrumb and PLAYHEAD (time/frame);
 *   - each timeline's `view` (zoom = pixels per frame, horizontal/vertical
 *     scroll, viewport width) and `currentFrame` (the playhead again).
 * None of it is authored content: undo must not restore it (§5.4), the C++
 * engine's document has no place for it, and saving it made a file dirty /
 * different every time someone scrolled.
 *
 * Now the document carries none of it, and this module keeps it per project
 * FILE on this machine (`projectViewStore`, localStorage keyed by path) —
 * remembered on save and on close, re-applied when that path is opened.
 *
 * Migration: a document written before B4 still carries the fields; restore
 * keeps applying them (cloudDocument.ts reads `openTabs` and a timeline's
 * `view` / `currentFrame` when present), so an existing project opens exactly
 * where it was left the first time, and its next save drops them.
 */

import type { SerializedTimeline } from '@motion/timeline';
import { useProjectStore, type SerializedWorkspaceTabs } from '@stores/projectStore';
import { commitAllTimes, getClock } from '@stores/playbackClockStore';
import { patchTimelineView, useTimelineViewStore } from '@stores/timelineViewStore';
import { rememberProjectView, recallProjectView } from '@stores/projectViewStore';

/** What is saved per project file on this machine. */
export interface EditorViewState {
  version: 1;
  openTabs?: SerializedWorkspaceTabs;
  /** Per composition: the timeline's zoom/scroll and the playhead frame. */
  timelines?: Record<string, { view?: SerializedTimeline['view']; currentFrame?: number }>;
}

/** The open tabs, as `captureDocument` used to write them. */
export function captureOpenTabs(): SerializedWorkspaceTabs {
  commitAllTimes();
  const ws = useProjectStore.getState();
  return {
    tabOrder: [...ws.tabOrder],
    activeTabId: ws.activeTabId,
    tabs: Object.fromEntries(
      Object.values(ws.tabs).map((t) => [
        t.id,
        {
          id: t.id,
          compositionId: t.compositionId,
          breadcrumbPath: [...t.breadcrumbPath],
          ...(t.breadcrumbVia && t.breadcrumbVia.length > 0 ? { breadcrumbVia: [...t.breadcrumbVia] } : {}),
          title: t.title,
          time: t.time,
          frame: t.frame,
        },
      ]),
    ),
  };
}

/** A timeline document without its editor state (the saved form). */
export function withoutTimelineView(t: SerializedTimeline): SerializedTimeline {
  const { view: _view, currentFrame: _frame, ...rest } = t;
  return rest as SerializedTimeline;
}

/** Everything this module keeps, from the live editor. */
export function captureEditorView(): EditorViewState {
  const openTabs = captureOpenTabs();
  const timelines: EditorViewState['timelines'] = {};
  const tabOf = (comp: string): string | undefined => Object.values(openTabs.tabs).find((t) => t.compositionId === comp)?.id;
  for (const [comp, v] of Object.entries(useTimelineViewStore.getState().views)) {
    const tab = tabOf(comp);
    timelines[comp] = {
      ...(v.pixelsPerFrame !== undefined ? { view: { pixelsPerFrame: v.pixelsPerFrame, scrollX: v.scrollX, scrollY: v.scrollY, viewportWidth: 0 } } : {}),
      ...(tab ? { currentFrame: getClock(tab).frame } : {}),
    };
  }
  return { version: 1, openTabs, timelines };
}

/** Put a remembered view back (after the document it belongs to was restored). */
export function applyEditorView(v: EditorViewState | null | undefined): void {
  if (!v) return;
  if (v.timelines) {
    for (const [comp, tv] of Object.entries(v.timelines)) {
      // View state only: no history, no document change. (The playhead comes
      // back with the open tabs below; `currentFrame` is written for old builds.)
      const ppf = tv.view?.pixelsPerFrame;
      if (typeof ppf === 'number' && ppf > 0) patchTimelineView(comp, { pixelsPerFrame: ppf, scrollX: Math.max(0, tv.view?.scrollX ?? 0), scrollY: Math.max(0, tv.view?.scrollY ?? 0) });
    }
  }
  if (v.openTabs) {
    try {
      useProjectStore.getState().actions.hydrateWorkspaceTabs(v.openTabs);
    } catch {
      // Tabs naming compositions that are gone: keep the defaults.
    }
  }
}

/** Remember the live view for a project file (Save, Close). */
export function rememberEditorView(path: string | null | undefined): void {
  if (!path) return;
  try {
    rememberProjectView(path, captureEditorView());
  } catch {
    // Storage is optional.
  }
}

/** Re-apply what this machine remembers for a project file (Open). */
export function recallEditorView(path: string | null | undefined): void {
  if (!path) return;
  applyEditorView(recallProjectView(path) as EditorViewState | null);
}
