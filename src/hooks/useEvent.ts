/**
 * useEvent — subscribe to a typed event from the EventBus.
 * Returns an unsubscribe function. Safe to call inside React effects.
 */

import { useEffect } from 'react';
import { getEventBus } from '@core/events/EventBus';
import type { AppEventName, AppEventPayloads } from '@core/events/EventTypes';

export function useEvent<E extends AppEventName>(
  event: E,
  handler: (payload: AppEventPayloads[E]) => void,
): void {
  useEffect(() => {
    const bus = getEventBus();
    const disp = bus.on(event, handler);
    return () => disp.dispose();
  }, [event, handler]);
}
