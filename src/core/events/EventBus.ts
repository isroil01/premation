/**
 * EventBus — strongly-typed pub/sub used across the app.
 *
 * Independent from React. Engines (scene graph, timeline, AI) can both publish
 * and subscribe without depending on the UI layer.
 */

import type { Disposable, Listener } from '@app-types/common';
import type { AppEventName, AppEventPayloads } from './EventTypes';

type AnyListener = (payload: unknown) => void;

export class EventBus {
  private readonly listeners = new Map<AppEventName, Set<AnyListener>>();

  /** Subscribe to an event. Returns a Disposable for clean teardown. */
  on<E extends AppEventName>(
    event: E,
    listener: Listener<AppEventPayloads[E]>,
  ): Disposable {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const wrapped = listener as AnyListener;
    set.add(wrapped);
    return {
      dispose: () => {
        set?.delete(wrapped);
      },
    };
  }

  /** Subscribe to an event, auto-disposed after first invocation. */
  once<E extends AppEventName>(
    event: E,
    listener: Listener<AppEventPayloads[E]>,
  ): Disposable {
    const wrapped = ((payload: AppEventPayloads[E]) => {
      disposable.dispose();
      listener(payload);
    }) as AnyListener;
    const disposable = this.on(event, wrapped as Listener<AppEventPayloads[E]>);
    return disposable;
  }

  /** Publish an event. Listeners are invoked synchronously, in order. */
  emit<E extends AppEventName>(event: E, payload: AppEventPayloads[E]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    // Snapshot to defend against listener removal during dispatch.
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        // One bad listener must not break the rest.

        console.error(`[EventBus] listener for "${event}" threw:`, err);
      }
    }
  }

  /** Remove ALL listeners (used at shutdown or test teardown). */
  clear(): void {
    this.listeners.clear();
  }

  /** Remove all listeners for a specific event. */
  clearEvent(event: AppEventName): void {
    this.listeners.delete(event);
  }

  /** Diagnostics — used by dev tools, not for hot paths. */
  listenerCount(event: AppEventName): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

/** Process-wide singleton. Tests can replace via setInstance. */
let instance: EventBus | null = null;

export function getEventBus(): EventBus {
  if (!instance) instance = new EventBus();
  return instance;
}

/** Replace the singleton — primarily for tests / multi-window isolation. */
export function setEventBus(bus: EventBus): void {
  instance = bus;
}
