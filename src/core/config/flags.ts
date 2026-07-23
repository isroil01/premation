/**
 * Feature flags.
 *
 * `LOCAL_FIRST` gates the migration to on-disk `.motion` directory bundles as the
 * source of truth. While it is off, the app saves/opens exactly as before
 * (single-file + cloud autosave); while it is on, Save/Save-As write a chunked
 * directory bundle.
 *
 * The value is a module-level boolean set once at boot (`setLocalFirst`) rather
 * than read from `import.meta.env` here — `import.meta` trips Jest under this
 * repo's CJS transform, so the env read lives in the app entry (which tests
 * never import) and tests flip the flag directly.
 */

let localFirst = false;

export function isLocalFirst(): boolean {
  return localFirst;
}

/** Set at boot from the build env; also the test seam. */
export function setLocalFirst(on: boolean): void {
  localFirst = on;
}
