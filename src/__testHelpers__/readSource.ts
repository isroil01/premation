/**
 * Read a source file, for the tests that assert against source TEXT.
 *
 * ## Why these tests exist at all
 *
 * A whole family of guards in this repo check the SOURCE rather than behaviour,
 * because the thing they are guarding is a wiring fact that no runtime
 * assertion can see: that a Canvas2D-only effect has a `case` in the dispatch
 * switch, that an inspector control is gated on the predicate that decides
 * whether it can do anything, that a component is actually mounted. Invoking
 * the code would only prove the paths the test remembered to exercise.
 *
 * ## Why this file exists
 *
 * Nineteen test files read source; seven had independently written the same
 * `readFileSync(resolve(__dirname, '../..', rel), 'utf8')` one-liner, each with
 * its own relative-depth prefix baked in. That prefix is the bug waiting to
 * happen: it is correct only for the directory the test currently sits in, so
 * moving a test file silently changes which file it reads — and a guard that
 * reads the wrong file passes vacuously.
 *
 * Paths here are relative to `src/`, resolved from THIS file's location, so
 * they do not depend on the caller's depth at all.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

/** `src/` — resolved from this helper, not from the caller. */
const SRC_ROOT = resolve(__dirname, '..');

/**
 * Source text of a file, addressed relative to `src/`.
 *
 * Throws rather than returning '' when the path is wrong: an empty string makes
 * every `expect(src).not.toMatch(...)` pass, which turns a broken guard into a
 * green one. That failure mode is the entire reason this is a function and not
 * an inlined `readFileSync`.
 */
export function readSource(relativeToSrc: string): string {
  const path = resolve(SRC_ROOT, relativeToSrc);
  const text = readFileSync(path, 'utf8');
  if (text.trim() === '') {
    throw new Error(`readSource: ${relativeToSrc} is empty — a guard reading it would pass vacuously`);
  }
  return text;
}

/**
 * The body of a source file from `marker` onwards.
 *
 * Several guards slice a file to scope their assertions to one function or one
 * JSX branch, and each hand-rolled `src.slice(src.indexOf(...))`. Doing it here
 * lets the slice FAIL when the marker is gone, instead of silently returning
 * the whole file (`indexOf` → -1 → `slice(-1)` → the last character) and
 * asserting against nothing.
 */
export function sourceFrom(relativeToSrc: string, marker: string): string {
  const text = readSource(relativeToSrc);
  const at = text.indexOf(marker);
  if (at === -1) {
    throw new Error(`sourceFrom: marker ${JSON.stringify(marker)} not found in ${relativeToSrc}`);
  }
  return text.slice(at);
}
