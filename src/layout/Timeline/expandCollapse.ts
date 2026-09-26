/**
 * Expand-all / collapse-all, and the recursive twirl (Alt+click a disclosure).
 *
 * Track expansion is OWNED BY THE HOST (`expandedTrackIds` + `onTrackToggleExpand`),
 * so the timeline cannot set it — it can only toggle ids one at a time. These
 * helpers therefore produce a PLAN: which ids to toggle to reach the wanted
 * state. Category (Transform / Effects …) collapse is the timeline's own.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import type { TimelineTrack } from './TimelineModel';

const expandable = (t: TimelineTrack): boolean =>
  t.canExpand === true || (t.properties?.length ?? 0) > 0 || t.isGroup === true;

/**
 * The tracks nested under `trackId` — the rows after it whose depth is
 * greater, up to the next row at the same or a shallower depth. Only the rows
 * the model currently lists: a collapsed group ships no children at all, so
 * a recursive expand reaches one level per model rebuild.
 */
export function descendantTrackIds(tracks: ReadonlyArray<TimelineTrack>, trackId: string): string[] {
  const i = tracks.findIndex((t) => t.id === trackId);
  if (i < 0) return [];
  const depth = tracks[i]!.depth ?? 0;
  const out: string[] = [];
  for (let j = i + 1; j < tracks.length; j++) {
    const t = tracks[j]!;
    if ((t.depth ?? 0) <= depth) break;
    out.push(t.id);
  }
  return out;
}

/** Ids to toggle so every expandable track is open. */
export function expandAllPlan(tracks: ReadonlyArray<TimelineTrack>, expanded: ReadonlySet<string>): string[] {
  return tracks.filter((t) => expandable(t) && !expanded.has(t.id)).map((t) => t.id);
}

/** Ids to toggle so every track is closed. */
export function collapseAllPlan(tracks: ReadonlyArray<TimelineTrack>, expanded: ReadonlySet<string>): string[] {
  return tracks.filter((t) => expanded.has(t.id)).map((t) => t.id);
}

/**
 * Alt+click on one disclosure: the track and everything under it go the way
 * the clicked one is going. Opening also uncollapses its categories, which is
 * what "show me all of it" means.
 */
export function recursiveTogglePlan(
  tracks: ReadonlyArray<TimelineTrack>,
  expanded: ReadonlySet<string>,
  trackId: string,
): { toggle: string[]; open: boolean } {
  const open = !expanded.has(trackId);
  const ids = [trackId, ...descendantTrackIds(tracks, trackId)];
  const byId = new Map<string, TimelineTrack>(tracks.map((t) => [t.id, t]));
  const toggle = ids.filter((id) => {
    const t = byId.get(id);
    if (!t) return false;
    return open ? expandable(t) && !expanded.has(id) : expanded.has(id);
  });
  return { toggle, open };
}

// ── Commands ──────────────────────────────────────────────────────────────

export interface TimelineExpansionActions {
  expandAll(): void;
  collapseAll(): void;
}

let actions: TimelineExpansionActions | null = null;

/** The mounted timeline registers how to reach its host's expansion state. */
export function registerTimelineExpansion(a: TimelineExpansionActions): () => void {
  actions = a;
  return () => {
    if (actions === a) actions = null;
  };
}

export const TIMELINE_EXPAND_ALL_COMMAND = asCommandId('timeline.expandAll');
export const TIMELINE_COLLAPSE_ALL_COMMAND = asCommandId('timeline.collapseAll');

export function buildTimelineExpandCommands(): ReadonlyArray<Command> {
  return [
    {
      id: TIMELINE_EXPAND_ALL_COMMAND,
      label: 'Expand All Layers',
      description: 'Reveal every layer’s property tree in the timeline.',
      icon: 'expand',
      shortcut: { key: '`', ctrl: true, shift: true },
      enabled: () => actions !== null,
      execute: () => actions?.expandAll(),
    },
    {
      id: TIMELINE_COLLAPSE_ALL_COMMAND,
      label: 'Collapse All Layers',
      description: 'Close every expanded layer in the timeline.',
      icon: 'collapse',
      shortcut: { key: '`', ctrl: true },
      enabled: () => actions !== null,
      execute: () => actions?.collapseAll(),
    },
  ];
}

let installed = false;

export function installTimelineExpandCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const command of buildTimelineExpandCommands()) registry.register(command);
  getShortcutManager().rehydrateFromRegistry();
}
