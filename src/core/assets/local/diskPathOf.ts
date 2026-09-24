/**
 * The disk path of a picked or dropped browser `File`, when the desktop shell
 * can tell (kept as the imported item's origin path).
 *
 * Electron 32 removed the non-standard `File.path`; the path now comes from
 * `webUtils.getPathForFile`, which the preload exposes as
 * `motionEditor.file.pathOf`. It returns '' for a File with no disk backing
 * (built in the page, or an ingest transcode) — that is `undefined` here, as
 * it is everywhere in the browser build.
 */
export function diskPathOf(file: File): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const pathOf = window.motionEditor?.file?.pathOf;
  if (typeof pathOf !== 'function') return undefined;
  try {
    const p = pathOf(file);
    return typeof p === 'string' && p.length > 0 ? p : undefined;
  } catch {
    // Not a real File (a contextBridge refusal) — no path, not an import failure.
    return undefined;
  }
}
