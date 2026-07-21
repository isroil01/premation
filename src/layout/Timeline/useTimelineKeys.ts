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
 *
 * Deliberately avoids Arrow keys and Space — those are owned by the viewport
 * (nudge / temporary-hand) when it has focus. Ignores events originating from
 * text inputs. Mount once near the editor root.
 */

import { useEffect } from 'react';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useSelectionStore } from '@stores/selectionStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { copyKeyframes, pasteKeyframes } from '@core/animation/keyframeClipboard';
import { smoothMotionPath } from '@core/motion/motionPath';
import { runAnimEdit } from '@core/animation/animationCommands';

export function useTimelineKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const c = getTimelineController();

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
            if (redo) history.redo();
            else history.undo();
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
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export default useTimelineKeys;
