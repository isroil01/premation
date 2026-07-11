/**
 * A tiny, strongly-typed event emitter. No dependencies, no DOM. Handlers are
 * stored in insertion order; `on` returns a disposer for easy cleanup.
 */

export interface Disposable {
  dispose(): void;
}

export type EventMap = Record<string, unknown>;
export type Handler<T> = (payload: T) => void;

// `object` (not an index-signature record) so specific event-map *interfaces*
// satisfy the constraint; access is always via `keyof M`.
export class TypedEmitter<M extends object> {
  private readonly handlers = new Map<keyof M, Set<Handler<unknown>>>();
  private readonly anyHandlers = new Set<(event: keyof M, payload: M[keyof M]) => void>();
  /** When true, handler exceptions are swallowed so one bad listener can't
   *  break an engine operation. Defaults to true. */
  swallowErrors = true;

  on<K extends keyof M>(event: K, handler: Handler<M[K]>): Disposable {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<unknown>);
    return { dispose: () => this.off(event, handler) };
  }

  once<K extends keyof M>(event: K, handler: Handler<M[K]>): Disposable {
    const sub = this.on(event, (payload) => {
      sub.dispose();
      handler(payload);
    });
    return sub;
  }

  /** Subscribe to every event (useful for logging / devtools). */
  onAny(handler: (event: keyof M, payload: M[keyof M]) => void): Disposable {
    this.anyHandlers.add(handler);
    return { dispose: () => { this.anyHandlers.delete(handler); } };
  }

  off<K extends keyof M>(event: K, handler: Handler<M[K]>): void {
    this.handlers.get(event)?.delete(handler as Handler<unknown>);
  }

  emit<K extends keyof M>(event: K, payload: M[K]): void {
    const set = this.handlers.get(event);
    if (set) {
      // Copy so handlers can subscribe/unsubscribe during emit safely.
      for (const h of [...set]) this.dispatch(h, payload);
    }
    if (this.anyHandlers.size) {
      for (const h of [...this.anyHandlers]) {
        try { h(event, payload as M[keyof M]); }
        catch (e) { if (!this.swallowErrors) throw e; }
      }
    }
  }

  removeAll(): void {
    this.handlers.clear();
    this.anyHandlers.clear();
  }

  private dispatch(handler: Handler<unknown>, payload: unknown): void {
    try {
      handler(payload);
    } catch (e) {
      if (!this.swallowErrors) throw e;
    }
  }
}
