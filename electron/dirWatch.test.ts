import { DIR_EVENT_DEBOUNCE_MS, DirWatcher, type DirWatchDeps } from './dirWatch';

function harness() {
  const live = new Map<string, () => void>();
  const closed: string[] = [];
  const emitted: string[][] = [];
  let pendingTimer: { fn: () => void; ms: number } | null = null;
  const deps: DirWatchDeps = {
    watch: (dir, onEvent) => {
      if (dir.includes('unwatchable')) return null;
      live.set(dir, onEvent);
      return { close: () => { live.delete(dir); closed.push(dir); } };
    },
    setTimeout: (fn, ms) => { pendingTimer = { fn, ms }; return pendingTimer; },
    clearTimeout: (h) => { if (pendingTimer === h) pendingTimer = null; },
    emit: (dirs) => emitted.push(dirs),
  };
  const fire = (): void => { const t = pendingTimer; pendingTimer = null; t?.fn(); };
  return { w: new DirWatcher(deps), live, closed, emitted, fire, timer: () => pendingTimer };
}

describe('DirWatcher', () => {
  it('watches the set it is given and keeps watches that stay', () => {
    const h = harness();
    h.w.setDirs(['/a', '/b']);
    h.w.setDirs(['/b', '/c']);
    expect(h.w.watched().sort()).toEqual(['/b', '/c']);
    expect(h.closed).toEqual(['/a']);
  });

  it('batches a burst of changes into one debounced emit per folder', () => {
    const h = harness();
    h.w.setDirs(['/renders', '/stills']);
    h.live.get('/renders')!();
    h.live.get('/renders')!();
    h.live.get('/stills')!();
    expect(h.timer()?.ms).toBe(DIR_EVENT_DEBOUNCE_MS);
    expect(h.emitted).toEqual([]);
    h.fire();
    expect(h.emitted).toEqual([['/renders', '/stills']]);
  });

  it('skips folders it cannot watch, and stops everything on an empty set', () => {
    const h = harness();
    h.w.setDirs(['/ok', '/unwatchable']);
    expect(h.w.watched()).toEqual(['/ok']);
    h.w.setDirs([]);
    expect(h.w.watched()).toEqual([]);
    expect(h.closed).toEqual(['/ok']);
  });

  it('drops a pending change for a folder that is no longer watched', () => {
    const h = harness();
    h.w.setDirs(['/a', '/b']);
    h.live.get('/a')!();
    h.w.setDirs(['/b']);
    h.fire();
    expect(h.emitted).toEqual([]);
  });
});
