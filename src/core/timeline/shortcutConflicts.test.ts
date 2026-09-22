/**
 * No chord means two things — across the command SETS, not just inside one.
 *
 * `markerShortcuts.test.ts` already guards `buildStaticCommands()` against two
 * always-enabled commands on one chord, and `viewportCommands.test.ts` guards
 * the viewport set against itself. Neither can see a clash BETWEEN sets, and
 * that is where the reported ones lived: the viewport's Show Snapshot took the
 * Render Queue's `F6`, and the timeline's `J` / `K` (not registry commands at
 * all — `useTimelineKeys`) overlapped the transport's shuttle.
 *
 * Sharing a chord is legal here and used deliberately — `ShortcutManager`
 * skips a disabled binding, so `Escape` is a fallthrough chain. So this does
 * not ban sharing; it PINS it. Every shared chord has to be in `DELIBERATE`
 * with the reason it is safe, and a new one fails here with both command ids
 * in the message instead of shipping as a key that does one of two things.
 *
 * Compared on `chordKey` after the meta → ctrl rewrite `resolveChord` applies
 * off macOS (it skips that rewrite under NODE_ENV=test), because that is the
 * string the dispatcher matches: `{ key: '`', meta }` and `{ key: '`', ctrl }`
 * are one key on Windows.
 */

import { buildStaticCommands } from '@providers/Providers';
import { chordKey, type Command } from '@core/commands/Command';
import { buildViewportCommands } from '@layout/Workspace/viewportCommands';
import { buildTimelineExpandCommands } from '@layout/Timeline/expandCollapse';
import { buildTimelineClipEditCommands } from '@layout/Timeline/clipEditCommands';
import { buildTimelineMarkerCommands } from '@layout/Timeline/markerCommands';
import { buildTimelineSnapCommands } from '@layout/Timeline/snapCommands';
import { buildTimelineEditModeCommands } from '@layout/Timeline/timelineEditMode';
import { buildTimelineFitCommands } from '@layout/Timeline/timelineFitCommands';
import { buildPreviewCacheCommands } from '@layout/Timeline/previewCacheCommands';
import { buildTransitionCommands } from '@layout/Timeline/transitionCommands';
import { buildGraphNormalizeCommands } from '@layout/Timeline/graphNormalize';
import type { KeyChord } from '@app-types/common';

/** The key the dispatcher binds on Windows / Linux. */
function boundKey(chord: KeyChord): string {
  return chordKey(chord.meta ? { ...chord, meta: false, ctrl: true } : chord);
}

function allCommands(): Command[] {
  return [
    ...buildStaticCommands(),
    ...buildViewportCommands(),
    ...buildTimelineExpandCommands(),
    ...buildTimelineClipEditCommands(),
    ...buildTimelineMarkerCommands(),
    ...buildTimelineSnapCommands(),
    ...buildTimelineEditModeCommands(),
    ...buildTimelineFitCommands(),
    ...buildPreviewCacheCommands(),
    ...buildTransitionCommands(),
    ...buildGraphNormalizeCommands(),
  ];
}

/** chord → the ids bound to it, for every chord bound more than once. */
function sharedChords(): Map<string, string[]> {
  const byChord = new Map<string, Set<string>>();
  for (const c of allCommands()) {
    if (!c.shortcut) continue;
    const k = boundKey(c.shortcut);
    // A Set: `buildStaticCommands` may already include one of the smaller
    // sets, and a command is not in conflict with itself.
    byChord.set(k, (byChord.get(k) ?? new Set()).add(String(c.id)));
  }
  const shared = new Map<string, string[]>();
  for (const [k, ids] of byChord) if (ids.size > 1) shared.set(k, [...ids].sort());
  return shared;
}

/**
 * Chords shared ON PURPOSE. Each entry is safe only because of the gate named
 * beside it — if that gate goes, the entry has to go with it.
 */
const DELIBERATE: Readonly<Record<string, ReadonlyArray<string>>> = {
  // A fallthrough chain, innermost mode first: leaving a camera tool or a
  // timeline edit mode is `enabled` only while that mode is active, and only
  // then does Escape not reach Deselect.
  escape: ['edit.deselect', 'timeline.editMode.exit', 'tool.cameraExit'],
};

describe('shortcut conflicts across command sets', () => {
  it('POSITIVE CONTROL: the sets are real and carry chords', () => {
    const withChord = allCommands().filter((c) => c.shortcut);
    expect(withChord.length).toBeGreaterThan(50);
  });

  it('every shared chord is a deliberate, documented one', () => {
    const undocumented = [...sharedChords()]
      .filter(([k, ids]) => JSON.stringify(DELIBERATE[k]) !== JSON.stringify(ids))
      .map(([k, ids]) => `${k}: ${ids.join(' vs ')}`);
    expect(undocumented).toEqual([]);
  });

  it('DELIBERATE lists nothing that stopped being shared', () => {
    // A stale allow-list entry is a hole: it would wave through a NEW clash on
    // that chord the day someone reuses it.
    const shared = sharedChords();
    expect(Object.keys(DELIBERATE).filter((k) => !shared.has(k))).toEqual([]);
  });

  // ── The reported clashes, stated positively ─────────────────────────
  it('F6 is the Render Queue’s alone — Show Snapshot moved to Shift+F5', () => {
    // The Render Queue registers from a mounted effect in Providers rather than
    // from a builder, so "nothing HERE binds F6" is the whole assertion: any
    // builder that did would be sharing it with the queue.
    const onF6 = allCommands().filter((c) => c.shortcut && boundKey(c.shortcut) === 'f6');
    expect(onF6.map((c) => String(c.id))).toEqual([]);
    const onShiftF5 = allCommands().filter((c) => c.shortcut && boundKey(c.shortcut) === 'Shift+f5');
    expect(onShiftF5.map((c) => String(c.id))).toEqual(['view.compareToggle']);
  });

  it('` and Shift+` are Focus mode; Expand / Collapse All are Ctrl+` chords', () => {
    const idsOn = (k: string): string[] =>
      allCommands().filter((c) => c.shortcut && boundKey(c.shortcut) === k).map((c) => String(c.id));
    expect(idsOn('`')).toEqual(['view.focusMode.viewportTimeline']);
    expect(idsOn('Shift+`')).toEqual(['view.focusMode.viewport']);
    expect(idsOn('Ctrl+`')).toEqual(['timeline.collapseAll']);
    expect(idsOn('Ctrl+Shift+`')).toEqual(['timeline.expandAll']);
  });
});
