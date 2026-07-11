/**
 * useTimelineKeys — global, frame-accurate transport keyboard shortcuts routed
 * through the Timeline Engine. After Effects muscle memory:
 *
 *   Home / End              → go to start / end
 *   Page Up / Page Down     → previous / next frame
 *   Shift+Page Up / Page Dn → previous / next marker
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
      // Undo / redo timeline edits (clip move/trim/split) via the engine history.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        const redo = e.shiftKey;
        if (redo ? c.canRedo() : c.canUndo()) {
          e.preventDefault();
          if (redo) c.redo();
          else c.undo();
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
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export default useTimelineKeys;
