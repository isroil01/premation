/**
 * What a path from the project Save dialog is allowed to be.
 *
 * The dialog's filters are [Motion Project: motion, json] and [All Files: *],
 * and a filter is a SUGGESTION: type "oops.mp4" and the dialog hands back
 * "oops.mp4". The renderer then wrote the project JSON into a file called
 * oops.mp4 and titled the project "oops.mp4" — and had there been a real
 * oops.mp4 in that folder, the OS's own "replace?" prompt is the only thing
 * that would have stood between the user and their footage.
 *
 * Enforced HERE, where the path comes back from the dialog, because every save
 * route (Save, Save As, Increment and Save, Save Portable Copy) asks through
 * the same `project:chooseSavePath` channel — so none of them can forget.
 *
 * Pure, and kept out of main.ts, so the decision table can be tested without
 * an Electron runtime.
 */

/** The extensions a project may be saved under. Mirrors PROJECT_FILTERS. */
export const PROJECT_SAVE_EXTENSIONS = ['motion', 'json'] as const;

const PROJECT_EXT = /\.(motion|json)$/i;

export interface EnforcedSavePath {
  /** The path to actually write. */
  path: string;
  /**
   * True when `path` is NOT what the dialog returned. The OS asked about
   * overwriting the path the user TYPED; it has said nothing about this one,
   * so the caller must check it and ask for itself.
   */
  changed: boolean;
}

/**
 * Append `.motion` unless the path already ends in a project extension.
 *
 * Appended, not substituted: "oops.mp4" becomes "oops.mp4.motion", never
 * "oops.motion". Substituting would rewrite a name the user chose ("v1.2" is
 * a version, not an extension) and appending can never land on the foreign
 * file the user typed.
 */
export function enforceProjectExtension(filePath: string): EnforcedSavePath {
  const trimmed = filePath.replace(/[\\/]+$/, '');
  if (PROJECT_EXT.test(trimmed)) return { path: trimmed, changed: trimmed !== filePath };
  // A trailing dot ("name.") is how Windows users ask for "no extension";
  // "name..motion" is not what anybody meant.
  return { path: `${trimmed.replace(/\.+$/, '')}.motion`, changed: true };
}
