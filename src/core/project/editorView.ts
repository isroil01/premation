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
import { commitAllTimes } from '@stores/playbackClockStore';
import { getTimelineController } from '@core/timeline/TimelineController';
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
  const timelines: EditorViewState['timelines'] = {};
  for (const [id, t] of Object.entries(getTimelineController().capture())) {
    timelines[id] = { ...(t.view ? { view: { ...t.view } } : {}), currentFrame: t.currentFrame };
  }
  return { version: 1, openTabs: captureOpenTabs(), timelines };
}

/** Put a remembered view back (after the document it belongs to was restored). */
export function applyEditorView(v: EditorViewState | null | undefined): void {
  if (!v) return;
  if (v.timelines) {
    const c = getTimelineController();
    for (const [comp, tv] of Object.entries(v.timelines)) {
      try {
        const reg = c.peekTimeline(comp);
        if (!reg) continue; // a composition the document no longer has
        // View state only: no history, no document change.
        if (tv.view) reg.timeline._internal().setView(tv.view);
        if (typeof tv.currentFrame === 'number') reg.timeline.playhead.set(tv.currentFrame);
      } catch {
        // Tolerant: a remembered view never blocks an open.
      }
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
