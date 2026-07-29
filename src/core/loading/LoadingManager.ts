/**
 * LoadingManager — tracks named async work so the UI can show a coherent
 * busy / splash / progress state without every caller inventing its own flag.
 *
 * Any subsystem (boot, project open, future engine warm-up) begins a task,
 * optionally reports progress, then ends it. The manager aggregates all active
 * tasks into a single busy state + overall progress and notifies subscribers.
 *
 *   const task = loading.begin('project-open', 'Opening project…');
 *   task.progress(0.5);
 *   task.end;
 */

export interface LoadingTask {
  readonly id: string;
  readonly label: string;
  /** 0..1, or null when indeterminate. */
  progress: number | null;
}

export interface LoadingHandle {
  update(progress: number | null, label?: string): void;
  end(): void;
}

export type LoadingListener = (snapshot: LoadingSnapshot) => void;

export interface LoadingSnapshot {
  readonly busy: boolean;
  readonly tasks: ReadonlyArray<LoadingTask>;
  /** Aggregate progress across determinate tasks (0..1), or null if any is indeterminate. */
  readonly progress: number | null;
}

export class LoadingManager {
  private readonly tasks = new Map<string, LoadingTask>();
  private readonly listeners = new Set<LoadingListener>();
  private counter = 0;

  begin(id: string | undefined, label: string, progress: number | null = null): LoadingHandle {
    const taskId = id ?? `task_${(this.counter += 1)}`;
    this.tasks.set(taskId, { id: taskId, label, progress });
    this.notify();

    return {
      update: (p, nextLabel) => {
        const task = this.tasks.get(taskId);
        if (!task) return;
        this.tasks.set(taskId, {
          ...task,
          progress: p,
          label: nextLabel ?? task.label,
        });
        this.notify();
      },
      end: () => {
        if (this.tasks.delete(taskId)) this.notify();
      },
    };
  }

  /** Convenience: run a promise as a tracked task. */
  async track<T>(label: string, work: Promise<T> | (() => Promise<T>), id?: string): Promise<T> {
    const handle = this.begin(id, label);
    try {
      return await (typeof work === 'function' ? work() : work);
    } finally {
      handle.end();
    }
  }

  snapshot(): LoadingSnapshot {
    const tasks = Array.from(this.tasks.values());
    let progress: number | null = null;
    if (tasks.length > 0) {
      const determinate = tasks.filter((t) => t.progress !== null);
      progress = determinate.length === tasks.length
        ? determinate.reduce((sum, t) => sum + (t.progress ?? 0), 0) / tasks.length
        : null;
    }
    return { busy: tasks.length > 0, tasks, progress };
  }

  subscribe(listener: LoadingListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) {
      try { l(snap); } catch { /* isolate listener failures */ }
    }
  }
}
