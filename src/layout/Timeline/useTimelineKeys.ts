/**
 * useTimelineKeys — global, frame-accurate transport keyboard shortcuts routed
 * through the Timeline Engine. After Effects muscle memory:
 *
 *   Home / End              → go to start / end
 *   Page Up / Page Down     → previous / next frame
 *   Shift+Page Up / Page Dn → previous / next marker
 *   J / K                   → previous / next keyframe (timeline focused only)
 *   Alt+Page Dn / Page Up   → nudge selected LAYERS one frame later / earlier
 *   Alt+Shift+Page Dn / Up  → … ten frames
 *   B / N                   → set work-area in / out at the playhead
 *   Shift+B                 → clear the work area
 *   Ctrl/Cmd+Shift+D        → split selected clips at the playhead
 *   Ctrl/Cmd+Z / +Shift     → undo / redo timeline edits (clip move/trim/split)
 *   Ctrl/Cmd+C              → copy selected keyframes to clipboard
 *   Ctrl/Cmd+V              → paste keyframes at playhead (onto selected layers)
 *   Ctrl/Cmd+Alt+S          → smooth motion path for selected layers
 *   ← / →                   → nudge selected KEYFRAMES one frame (Shift: ten)
 *   Ctrl/Cmd+← / →          → nudge them a TENTH of a frame (sub-frame)
 *   Alt+↑ / Alt+↓           → nudge their VALUE by one (Shift: ten)
 *
 * Space is owned by the viewport. Arrow keys are shared with it by SELECTION:
 * they nudge keyframes only while some are selected, which is exactly when the
 * viewport's layer-nudge is not what you meant — and when nothing is selected
 * here the event is left entirely alone, so the viewport keeps its gesture.
 * Ignores events originating from text inputs. Mount once near the editor root.
 */

import { useEffect } from 'react';
import {
  goToEnd,
  goToNextKeyframe,
  goToNextMarker,
  goToPrevKeyframe,
  goToPrevMarker,
  goToStart,
  playheadSeconds,
  stepBackward,
  stepForward,
} from '@core/timeline/timelineView';
import { settingsFps } from '@core/mirror/compFacts';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { useSelectionStore } from '@stores/selectionStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { claimsChord } from '@core/commands/ShortcutManager';
import { performRedo, performUndo } from '@stores/historyStore';
import { copyKeyframes } from '@core/animation/keyframeClipboard';
import { pasteKeyframesAt } from './keyframeEdits';
import { smoothMotionPath } from '@core/motion/motionPath';
import { assistantKeyframesEdit } from '@core/engine/assistantKeys';
import { createSelectionNudger, nudgeForKey } from './keyframeNudge';
import {
  moveSelectedEndToPlayhead,
  moveSelectedStartToPlayhead,
  nudgeSelectedLayers,
  setWorkAreaIn,
  clearWorkArea,
  setWorkAreaOut,
  splitSelectedAtPlayhead,
  trimSelectedEndToPlayhead,
  trimSelectedStartToPlayhead,
} from './timelineEdits';

export function useTimelineKeys(): void {
  useEffect(() => {
    // One batcher for the hook's lifetime: a BURST of presses is one undo
    // step (holding → for a second must cost one Ctrl+Z, not thirty), and the
    // batch is what remembers that a burst is in progress.
    const nudger = createSelectionNudger();
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      // ── Arrow-key keyframe nudge ────────────────────────────────
      // Before the Ctrl branch, and gated on a keyframe selection so the
      // viewport keeps the arrows whenever this is not what you meant.
      //
      // Ctrl/Cmd is INCLUDED here rather than falling through to the Ctrl
      // combos below, because Ctrl+Arrow is the sub-frame nudge. The combos
      // below are all letter chords, so nothing is shadowed — and an arrow
      // that reaches them today is simply swallowed by their trailing return.
      if (e.key.startsWith('Arrow')) {
        const meta = e.ctrlKey || e.metaKey;
        if (useKeyframeSelectionStore.getState().ids.size > 0) {
          const delta = nudgeForKey(
            e.key,
            { shift: e.shiftKey, alt: e.altKey, meta },
            1 / (settingsFps(activeCompSettingsNow()) || 30),
          );
          if (delta) {
            e.preventDefault();
            e.stopPropagation();
            nudger.push(delta);
            return;
          }
        }
        // With nothing selected the arrows belong to the viewport — but only
        // the UNMODIFIED ones ever did. A Ctrl+Arrow with no keyframe
        // selection falls through to the Ctrl branch exactly as before.
        if (!meta) return;
      }
      // Anything else lands while a burst is open — commit it first, so the
      // nudge and whatever follows are two undo entries and not one.
      if (nudger.isOpen()) nudger.flush();

      // ── Ctrl/Cmd combos ─────────────────────────────────────────
      if (e.ctrlKey || e.metaKey) {
        // Split selected layers at the playhead (After Effects: Ctrl/Cmd+Shift+D).
        if (e.shiftKey && (e.key === 'd' || e.key === 'D')) {
          e.preventDefault();
          void splitSelectedAtPlayhead(useSelectionStore.getState().ids);
          return;
        }
        // Undo / redo via the unified global CommandSystem history.
        if (e.key === 'z' || e.key === 'Z') {
          const redo = e.shiftKey;
          const history = getCommandSystem().getHistory();
          if (redo ? history.canRedo() : history.canUndo()) {
            e.preventDefault();
            if (redo) performRedo();
            else performUndo();
          }
          return;
        }
        // Ctrl+C — copy selected keyframes to clipboard.
        if (!e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
          const kfIds = useKeyframeSelectionStore.getState().ids;
          if (kfIds.size > 0) {
            e.preventDefault();
            // B4-gap: the clipboard captures the TS keyframe records (stored axis, si/so, roving) — shared with propertyRowMenu.
            copyKeyframes(kfIds);
          }
          return;
        }
        // Ctrl+V — paste keyframes from clipboard at the playhead.
        if (!e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
          const targetIds = useSelectionStore.getState().ids;
          if (targetIds.length > 0) {
            e.preventDefault();
            const playhead = playheadSeconds();
            void pasteKeyframesAt(targetIds, playhead);
          }
          return;
        }
        // Ctrl+Alt+S — smooth motion path for selected layers.
        if (e.altKey && (e.key === 's' || e.key === 'S')) {
          e.preventDefault();
          const ids = useSelectionStore.getState().ids;
          if (ids.length > 0) {
            // Off-document, sent as setKeyframes per property: one entry
            // (core/engine/assistantKeys.ts). B4-gap: the assistant runs on the
            // stored member tracks (keyframe assistants, B4_MIRROR.md §5).
            void assistantKeyframesEdit('Smooth motion path', ids, () => {
              for (const id of ids) smoothMotionPath(id);
            });
          }
          return;
        }
        return; // don't fall through to single-key handling
      }

      // ── Single-key ───────────────────────────────────────────────
      // Alt is allowed through for the keys that HAVE an Alt meaning, and for
      // nothing else: [ and ] are AE's Trim In/Out (Alt+[ / Alt+]), Page
      // Up/Down its layer nudge (Alt+Page Up / Down). Their branches below test
      // altKey themselves. A blanket `if (e.altKey) return` made the trims
      // permanently unreachable while the transport tooltips went on
      // advertising them — and the allow-list written to fix that named only
      // the brackets, which left the nudge unreachable in exactly the same way.
      const altAware = e.key === '[' || e.key === ']' || e.key === 'PageDown' || e.key === 'PageUp';
      if (e.altKey && !altAware) return;
      // J / K belong to whichever surface has focus: the comp transport's
      // shuttle takes them in the viewport (and with nothing focused), and
      // they mean "previous / next keyframe" only where the timeline CLAIMED
      // them — the same `data-shortcut-claim` that keeps ShortcutManager's
      // hands off, so the two rules cannot drift apart. Before this, J stepped
      // keyframes from any panel the shuttle did not own while K, its twin,
      // was eaten by a global chord and never got here at all.
      const timelineOwns = (k: string): boolean => claimsChord(el, k);
      switch (e.key) {
        case 'Home':
          e.preventDefault();
          goToStart();
          break;
        case 'End':
          e.preventDefault();
          goToEnd();
          break;
        case 'PageDown':
        case 'PageUp': {
          const later = e.key === 'PageDown';
          if (e.altKey) {
            // Alt — nudge the selected layers in time; Shift makes it ten
            // frames. One undoable engine transaction per press. The key is
            // left alone (no preventDefault) when there was nothing to nudge.
            const frames = (later ? 1 : -1) * (e.shiftKey ? 10 : 1);
            if (nudgeSelectedLayers(useSelectionStore.getState().ids, frames)) e.preventDefault();
            break;
          }
          e.preventDefault();
          if (e.shiftKey) {
            if (later) goToNextMarker();
            else goToPrevMarker();
          } else if (later) stepForward();
          else stepBackward();
          break;
        }
        case 'j':
        case 'J':
          if (!timelineOwns('j')) break;
          e.preventDefault();
          goToPrevKeyframe();
          break;
        case 'k':
        case 'K':
          if (!timelineOwns('k')) break;
          e.preventDefault();
          goToNextKeyframe();
          break;
        case 'b':
          e.preventDefault();
          void setWorkAreaIn();
          break;
        case 'B': // Shift+B
          e.preventDefault();
          void clearWorkArea();
          break;
        case 'n':
        case 'N':
          e.preventDefault();
          void setWorkAreaOut();
          break;
        case '[':
          e.preventDefault();
          if (e.altKey) void trimSelectedStartToPlayhead(useSelectionStore.getState().ids);
          else void moveSelectedStartToPlayhead(useSelectionStore.getState().ids);
          break;
        case ']':
          e.preventDefault();
          if (e.altKey) void trimSelectedEndToPlayhead(useSelectionStore.getState().ids);
          else void moveSelectedEndToPlayhead(useSelectionStore.getState().ids);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      // An unmount mid-burst must still record the moves that were applied.
      nudger.flush();
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}

export default useTimelineKeys;
