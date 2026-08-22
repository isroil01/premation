import { useEffect, useRef } from 'react';
import { api } from '@core/api/client';
import { captureDocument } from '@core/api/cloudDocument';
import { clearRecovery } from '@core/persistence/recovery';
import { useWorkspaceStore } from '@stores/index';
import { useEntitlementStore, canWriteCloud } from '@stores/entitlementStore';
import { getEventBus } from '@core/events/EventBus';

/**
 * Autosave component with configurable debounce and exponential backoff.
 * AUTOSAVE_DEBOUNCE_MS defines the initial arm delay before any saves are allowed.
 * Subsequent rapid changes are coalesced into a single request via a 1.2 s debounce.
 * On network failure the retry delay grows exponentially (up to 30 s) so a bad
 * connection doesn't hammer the server on every user edit.
 */
const AUTOSAVE_DEBOUNCE_MS = 3000; // 3 seconds (adjustable)
const BACKOFF_MAX_MS = 30_000;

export function CloudAutosave({ projectId }: { projectId: string }): null {
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>();
  const inFlightRef = useRef(false);
  const armedRef = useRef(false);
  // A change arrived while still arming — save once armed, don't drop it.
  const pendingRef = useRef(false);
  // Consecutive failure count — resets to 0 on success.
  const failureCountRef = useRef(0);

  useEffect(() => {
    // Arm after initial delay
    armTimerRef.current = setTimeout(() => {
      armedRef.current = true;
      // Changes during the arm window are DEFERRED, not dropped. The window
      // exists so the load's own restore events don't hammer a save, but the
      // "start from a video" footage import lands right inside it — dropping
      // that event meant the inserted clip was never persisted, and a project
      // created from an upload REOPENED AS AN EMPTY SCENE unless the user
      // happened to edit something afterwards. One possibly-redundant save of
      // a freshly loaded doc is the cheap end of that trade.
      if (pendingRef.current) {
        pendingRef.current = false;
        schedule();
      }
    }, AUTOSAVE_DEBOUNCE_MS);

    const flush = async () => {
      // A read-only account cannot autosave, and trying is actively harmful: the
      // server answers 403 and this loop would treat it as a transient failure and
      // retry forever with backoff. Skip the round trip — but leave the tab marked
      // dirty, because it honestly IS unsaved. The read-only banner explains why
      // and offers export; the local recovery snapshot (elsewhere) still protects
      // the work. The server write guard is the real enforcement.
      if (!canWriteCloud(useEntitlementStore.getState().access)) return;
      if (inFlightRef.current) {
        schedule();
        return;
      }
      inFlightRef.current = true;
      try {
        // Yield to the event loop before the potentially-large serialization so
        // the current React paint completes first and the UI stays responsive.
        const doc = await new Promise<ReturnType<typeof captureDocument>>((resolve) => {
          setTimeout(() => resolve(captureDocument()), 0);
        });
        await api.autosave(projectId, doc);
        const ws = useWorkspaceStore.getState();
        if (ws.activeTabId) ws.actions.markDirty(ws.activeTabId, false);
        clearRecovery();
        // Success — reset backoff.
        failureCountRef.current = 0;
      } catch (e) {
        // Transient/network errors will retry on next edit with exponential backoff.
        failureCountRef.current += 1;
      } finally {
        inFlightRef.current = false;
      }
    };

    const schedule = () => {
      if (!armedRef.current) {
        // Defer, don't drop — the arm callback above schedules this change
        // the moment the window closes.
        pendingRef.current = true;
        return;
      }
      if (timerRef.current) clearTimeout(timerRef.current);
      // Backoff: 1.2s * 2^failures, capped at 30s.
      const delay = Math.min(1200 * Math.pow(2, failureCountRef.current), BACKOFF_MAX_MS);
      timerRef.current = setTimeout(() => {
        void flush();
      }, delay);
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

