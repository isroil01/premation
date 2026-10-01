/**
 * Per-component React render counter for tests — no changes to the components.
 *
 * Installs a minimal React DevTools global hook, so React reports every
 * committed root; each commit is diffed against its alternate (the way the
 * DevTools profiler does) and every function / class / forwardRef component
 * that actually RAN its render function in that commit is counted by name. A
 * subtree React bailed out of (memo, unchanged context, no update below) is
 * not entered, so it costs nothing here either.
 *
 * With the hook present React's dev build also fills the fibers' profiler
 * timings, so the tracker reports render time per component (jsdom + a dev
 * build: compare runs, do not read the milliseconds as production numbers).
 *
 * MUST be imported BEFORE `react-dom` (react-dom looks for the hook once, at
 * module init): make it the first import of the test file.
 *
 *   import { renderTracker } from '@layout/__testHelpers__/renderTracker';
 *   renderTracker.reset();  …drive the UI…  renderTracker.snapshot();
 */

interface Fiber {
  tag: number;
  type: unknown;
  elementType: unknown;
  flags: number;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  actualDuration?: number;
}

const FUNCTION_COMPONENT = 0;
const CLASS_COMPONENT = 1;
const FORWARD_REF = 11;
const SIMPLE_MEMO = 15;
const PERFORMED_WORK = 1;

function nameOf(f: Fiber): string {
  const pick = (t: unknown): string | undefined => {
    if (typeof t === 'function') {
      const fn = t as { displayName?: string; name?: string };
      return fn.displayName || fn.name || undefined;
    }
    if (t && typeof t === 'object') {
      const o = t as { displayName?: string; render?: unknown; type?: unknown };
      return o.displayName || pick(o.render) || pick(o.type);
    }
    return undefined;
  };
  return pick(f.elementType) ?? pick(f.type) ?? '(anonymous)';
}

class RenderTracker {
  private counts = new Map<string, number>();
  private selfMs = new Map<string, number>();
  private inclMs = new Map<string, number>();
  private commitsValue = 0;
  private renderMsValue = 0;
  private enabled = true;

  /** Commits (of any root) since the last reset. */
  get commits(): number { return this.commitsValue; }

  /** Milliseconds React spent rendering, all commits since the last reset. */
  get renderMs(): number { return this.renderMsValue; }

  reset(): void {
    this.counts = new Map();
    this.selfMs = new Map();
    this.inclMs = new Map();
    this.commitsValue = 0;
    this.renderMsValue = 0;
  }

  pause(): void { this.enabled = false; }
  resume(): void { this.enabled = true; }

  /** Component name → renders since the last reset. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  /** Renders of one component since the last reset. */
  count(name: string): number {
    return this.counts.get(name) ?? 0;
  }

  /** Total component renders since the last reset. */
  total(): number {
    let n = 0;
    for (const v of this.counts.values()) n += v;
    return n;
  }

  /** The `n` busiest components, most renders first. */
  top(n = 25): Array<[string, number]> {
    return [...this.counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
  }

  /** Self render time (ms, excluding children) of one component since the last reset. */
  selfTime(name: string): number {
    return this.selfMs.get(name) ?? 0;
  }

  /** Inclusive render time (ms, with everything below it that re-rendered) of one component. */
  inclusiveTime(name: string): number {
    return this.inclMs.get(name) ?? 0;
  }

  /** The `n` components with the most self render time. */
  topByTime(n = 25): Array<[string, number]> {
    return [...this.selfMs].sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  /** @internal */
  onCommit(root: { current: Fiber }): void {
    if (!this.enabled) return;
    this.commitsValue += 1;
    const next = root.current;
    const prev = next.alternate;
    this.renderMsValue += next.actualDuration ?? 0;
    if (prev) this.walk(next, prev);
  }

  private walk(next: Fiber, prev: Fiber): void {
    this.record(next);
    if (next.child === prev.child) return; // React bailed out of this subtree
    for (let c = next.child; c; c = c.sibling) {
      if (c.alternate) this.walk(c, c.alternate);
      // A freshly MOUNTED child is not an update: not counted.
    }
  }

  private record(f: Fiber): void {
    if (f.tag !== FUNCTION_COMPONENT && f.tag !== CLASS_COMPONENT && f.tag !== FORWARD_REF && f.tag !== SIMPLE_MEMO) return;
    if ((f.flags & PERFORMED_WORK) === 0) return;
    const n = nameOf(f);
    this.counts.set(n, (this.counts.get(n) ?? 0) + 1);
    let self = f.actualDuration ?? 0;
    for (let c = f.child; c; c = c.sibling) self -= c.actualDuration ?? 0;
    this.selfMs.set(n, (this.selfMs.get(n) ?? 0) + Math.max(0, self));
    this.inclMs.set(n, (this.inclMs.get(n) ?? 0) + (f.actualDuration ?? 0));
  }
}

export const renderTracker = new RenderTracker();

const g = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
if (!g.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
  let nextId = 1;
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => nextId++,
    checkDCE: () => undefined,
    onScheduleFiberRoot: () => undefined,
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => renderTracker.onCommit(root),
    onPostCommitFiberRoot: () => undefined,
    onCommitFiberUnmount: () => undefined,
  };
}
