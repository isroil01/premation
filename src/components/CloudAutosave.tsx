import { useEffect, useRef } from 'react';
import { api } from '@core/api/client';
import { captureDocument } from '@core/api/cloudDocument';
import { clearRecovery } from '@core/persistence/recovery';
import { useWorkspaceStore } from '@stores/index';
import { getEventBus } from '@core/events/EventBus';

/**
 * Autosave component with configurable debounce.
 * AUTOSAVE_DEBOUNCE_MS defines the initial arm delay before any saves are allowed.
 * Subsequent rapid changes are coalesced into a single request via a 1.2 s debounce.
 */
const AUTOSAVE_DEBOUNCE_MS = 3000; // 3 seconds (adjustable)

export function CloudAutosave({ projectId }: { projectId: string }): null {
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>();
  const inFlightRef = useRef(false);
  const armedRef = useRef(false);

  useEffect(() => {
    // Arm after initial delay
    armTimerRef.current = setTimeout(() => {
      armedRef.current = true;
    }, AUTOSAVE_DEBOUNCE_MS);

    const flush = async () => {
      if (inFlightRef.current) {
        schedule();
        return;
      }
      inFlightRef.current = true;
      try {
        await api.autosave(projectId, captureDocument());
        const ws = useWorkspaceStore.getState();
        if (ws.activeTabId) ws.actions.markDirty(ws.activeTabId, false);
        clearRecovery();
      } catch (e) {
        // Transient/network errors will retry on next edit.
      } finally {
        inFlightRef.current = false;
      }
    };

    const schedule = () => {
      if (!armedRef.current) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void flush();
      }, 1200);
    };

    const bus = getEventBus();
    const subs = [
      bus.on('AnimationChanged', schedule),
      bus.on('NodeUpdated', schedule),
      bus.on('SceneGraphChanged', schedule),
      bus.on('DocumentChanged', schedule),
    ];

    return () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
      subs.forEach((s) => s.dispose());
    };
  }, [projectId]);

  return null;
}
