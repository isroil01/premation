/**
 * A project's display name, derived from where it lives on disk.
 *
 * `ProjectManager.openPath` used to name a project `path.replace(/\.[^.]+$/, '')`
 * — the WHOLE path minus its extension — so a project opened from disk was
 * titled "C:/Users/…/files/qa1" in the title bar and written into the recent
 * list under that name, while the very same project came back from Save as
 * "qa1". One rule, stated once, for every route that turns a path into a name.
 *
 * Kept free of imports on purpose: ProjectManager and RecentProjects are both
 * engine-free, and the index writer's own `projectNameFromPath` drags the local
 * index in with it.
 */

/** The extensions a project file (or a `.motion` directory bundle) carries. */
const PROJECT_EXT = /\.(motion|json)$/i;

/** True when `value` reads as a filesystem path rather than a name or an id. */
export function looksLikeFilePath(value: string): boolean {
  return /[\\/]/.test(value);
}

/**
 * The base name without its project extension, on either slash style.
 *
 * A `.motion` bundle is a DIRECTORY, and directory paths arrive with and
 * without a trailing separator depending on which picker produced them, so
 * trailing separators are dropped before the last segment is taken. Falls back
 * to `fallback` (default: the input) when nothing usable is left — a bare
 * "/" or ".motion" must not become an empty title.
 */
export function projectNameFromFilePath(path: string, fallback: string = path): string {
  const base = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const stem = base.replace(PROJECT_EXT, '').trim();
  return stem || fallback;
}

/**
 * Repair a name that was stored as a path.
 *
 * Recent-list entries written before the fix above carry the full path as
 * their name, and they live in the user's settings, not in anything a release
 * can rewrite. A real project name cannot contain a path separator (it is a
 * file stem), so anything that does is one of those entries.
 */
export function displayProjectName(name: string): string {
  return looksLikeFilePath(name) ? projectNameFromFilePath(name) : name;
}
