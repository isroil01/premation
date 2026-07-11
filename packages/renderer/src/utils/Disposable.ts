/** Anything that owns resources and must release them deterministically. */
export interface Disposable {
  dispose(): void;
}

/** Aggregates disposables and releases them in reverse order (LIFO). */
export class DisposalBag implements Disposable {
  private readonly items: Disposable[] = [];
  private disposed = false;

  add<T extends Disposable>(item: T): T {
    if (this.disposed) {
      item.dispose();
      return item;
    }
    this.items.push(item);
    return item;
  }

  addFn(fn: () => void): void {
    this.add({ dispose: fn });
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = this.items.length - 1; i >= 0; i--) {
      try {
        this.items[i]!.dispose();
      } catch {
        // Disposal must never throw through the bag.
      }
    }
    this.items.length = 0;
  }
}
