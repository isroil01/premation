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
 *
 * Deliberately avoids Arrow keys and Space — those are owned by the viewport
 * (nudge / temporary-hand) when it has focus. Ignores events originating from
 * text inputs. Mount once near the editor root.
 */

import { useEffect } from 'react';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useSelectionStore } from '@stores/selectionStore';
import { getCommandSystem } from '@core/commands/CommandSystem';

export function useTimelineKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const c = getTimelineController();
      // Split selected layers at the playhead (After Effects: Ctrl/Cmd+Shift+D).
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        c.splitSelectedAtPlayhead(useSelectionStore.getState().ids);
        return;
      }
      // Undo / redo via the unified global CommandSystem history.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        const redo = e.shiftKey;
        const history = getCommandSystem().getHistory();
        if (redo ? history.canRedo() : history.canUndo()) {
          e.preventDefault();
          if (redo) history.redo();
          else history.undo();
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
