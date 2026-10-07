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

/**
 * Route generative prompts through the caster pipeline.
 *
 * ON by default. The caster's quality floor is deterministic — every keyframe
 * comes from a hand-authored library that the timing, design and UI-motion
 * linters verify on 100% of output, including when the model exercises no
 * judgement at all — so it is not the experimental path here; the director is.
 *
 * The flag exists so a bad interaction with a real provider can be turned off
 * without a deploy, and so a run can be A/B'd against the director. Turning it
 * off falls back to the director, which still works.
 */
let caster = true;

export function casterEnabled(): boolean {
  return caster;
}

export function setCasterEnabled(on: boolean): void {
  caster = on;
}

/**
 * Which generative mode a run uses when the composer has not chosen one.
 *
 * `author` (default): the model writes the whole composition as a scene
 * script against the engine's vocabulary, looks at it and revises it
 * (docs/AI_AUTHOR_MODE_PLAN.md). `library`: the caster, which picks templates
 * and techniques from the hand-authored libraries. The caster stays either
 * way — it is the fallback when an author run fails and the baseline the eval
 * harness compares against.
 */
let authorDefault: 'author' | 'library' = 'author';

export function authorModeDefault(): 'author' | 'library' {
  return authorDefault;
}

export function setAuthorModeDefault(mode: 'author' | 'library'): void {
  authorDefault = mode;
}
