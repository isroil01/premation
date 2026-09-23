/**
 * Per-project EDITOR state on this machine — which compositions were open as
 * tabs, the playhead, each timeline's zoom and scroll — keyed by the project's
 * file path (src/core/project/editorView.ts, B4).
 *
 * It used to be written into the project document itself; it is not authored
 * content, so it lives beside the file instead, like the Layers panel's view
 * settings (`sceneViewStore`) and the preferences. localStorage, most recent
 * 50 projects, and optional: a browser with storage disabled simply opens a
 * project at its defaults.
 */

const STORAGE_KEY = 'premation.projectView.v1';
const MAX_PROJECTS = 50;

interface Stored {
  /** Most recently remembered last. */
  order: string[];
  views: Record<string, unknown>;
}

function load(): Stored {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { order: [], views: {} };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      order: Array.isArray(parsed.order) ? parsed.order.filter((p): p is string => typeof p === 'string') : [],
      views: parsed.views && typeof parsed.views === 'object' ? parsed.views : {},
    };
  } catch {
    return { order: [], views: {} };
  }
}

function save(s: Stored): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Storage is optional (private mode, quota).
  }
}

/** Remember the view for one project file (replaces what was there). */
export function rememberProjectView(path: string, view: unknown): void {
  const s = load();
  s.order = [...s.order.filter((p) => p !== path), path];
  s.views[path] = view;
  while (s.order.length > MAX_PROJECTS) {
    const drop = s.order.shift()!;
    delete s.views[drop];
  }
  save(s);
}

/** The remembered view for a project file, or null. */
export function recallProjectView(path: string): unknown {
  return load().views[path] ?? null;
}

/** Forget everything (tests). */
export function clearProjectViews(): void {
  save({ order: [], views: {} });
}
