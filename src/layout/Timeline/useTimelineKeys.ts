/**
 * useTimelineKeys — global, frame-accurate transport keyboard shortcuts routed
 * through the Timeline Engine. After Effects muscle memory:
 *
 *   Home / End              → go to start / end
 *   Page Up / Page Down     → previous / next frame
 *   Shift+Page Up / Page Dn → previous / next marker
 *   J / K                   → previous / next keyframe
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
import { getTimelineController } from '@core/timeline/TimelineController';
import { useSelectionStore } from '@stores/selectionStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { performRedo, performUndo } from '@stores/historyStore';
import { copyKeyframes, pasteKeyframes } from '@core/animation/keyframeClipboard';
import { smoothMotionPath } from '@core/motion/motionPath';
import { runAnimEdit } from '@core/animation/animationCommands';
import { createSelectionNudger, nudgeForKey } from './keyframeNudge';

export function useTimelineKeys(): void {
  useEffect(() => {
    // One batcher for the hook's lifetime: a BURST of presses is one undo
    // step (holding → for a second must cost one Ctrl+Z, not thirty), and the
    // batch is what remembers that a burst is in progress.
    const nudger = createSelectionNudger();
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const c = getTimelineController();

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
            1 / (c.fps || 30),
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
          c.splitSelectedAtPlayhead(useSelectionStore.getState().ids);
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
            copyKeyframes(kfIds);
          }
          return;
        }
        // Ctrl+V — paste keyframes from clipboard at the playhead.
        if (!e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
          const targetIds = useSelectionStore.getState().ids;
          if (targetIds.length > 0) {
            e.preventDefault();
            const playhead = getTimelineController().currentSeconds;
            pasteKeyframes(targetIds, playhead);
          }
          return;
        }
        // Ctrl+Alt+S — smooth motion path for selected layers.
        if (e.altKey && (e.key === 's' || e.key === 'S')) {
          e.preventDefault();
          const ids = useSelectionStore.getState().ids;
          if (ids.length > 0) {
            runAnimEdit('Smooth motion path', () => {
              for (const id of ids) smoothMotionPath(id);
            });
          }
          return;
        }
        return; // don't fall through to single-key handling
      }

      // ── Single-key ───────────────────────────────────────────────
      // Alt is allowed through for [ and ] only: those are AE's Trim In/Out
      // (Alt+[ / Alt+]), and their branches below test altKey themselves. A
      // blanket `if (e.altKey) return` made both permanently unreachable while
      // the transport tooltips went on advertising them.
      const altTrim = e.key === '[' || e.key === ']';
      if (e.altKey && !altTrim) return;
      switch (e.key) {
        case 'Home':
          e.preventDefault();
          c.goToStart();
          break;
        case 'End':
          e.preventDefault();
          c.goToEnd();
          break;
        case 'PageDown':
          e.preventDefault();
          if (e.shiftKey) c.goToNextMarker();
          else c.nextFrame();
          break;
        case 'PageUp':
          e.preventDefault();
          if (e.shiftKey) c.goToPrevMarker();
          else c.previousFrame();
          break;
        case 'j':
        case 'J':
          e.preventDefault();
          c.goToPrevKeyframe();
          break;
        case 'k':
        case 'K':
          e.preventDefault();
          c.goToNextKeyframe();
          break;
        case 'b':
          e.preventDefault();
          c.setWorkAreaIn();
          break;
        case 'B': // Shift+B
          e.preventDefault();
          c.clearWorkArea();
          break;
        case 'n':
        case 'N':
          e.preventDefault();
          c.setWorkAreaOut();
          break;
        case '[':
          e.preventDefault();
          if (e.altKey) c.trimSelectedStartToPlayhead(useSelectionStore.getState().ids);
          else c.moveSelectedStartToPlayhead(useSelectionStore.getState().ids);
          break;
        case ']':
          e.preventDefault();
          if (e.altKey) c.trimSelectedEndToPlayhead(useSelectionStore.getState().ids);
          else c.moveSelectedEndToPlayhead(useSelectionStore.getState().ids);
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
