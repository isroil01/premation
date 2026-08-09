/**
 * The README frame is only a boundary if its CSP actually matches its script.
 *
 * `HEIGHT_REPORTER_SHA256` is a hardcoded constant — `crypto.subtle.digest` is
 * asynchronous and the document is built while rendering, so the hash cannot be
 * computed at the point of use. That makes it exactly the kind of value that
 * drifts: someone reformats the reporter, the hash no longer covers it, the
 * browser refuses to run it, and the only symptom is a frame stuck at 60 px —
 * which reads as a CSS bug and gets "fixed" by loosening the CSP.
 *
 * So the hash is recomputed here from the string it is supposed to cover.
 */

import { createHash } from 'node:crypto';
import {
  buildReadmeDocument,
  HEIGHT_REPORTER,
  HEIGHT_REPORTER_SHA256,
  README_HEIGHT_MESSAGE,
} from './readmeDocument';

describe('the pinned script hash', () => {
  it('covers the script it is pinned to', () => {
    const actual = createHash('sha256').update(HEIGHT_REPORTER, 'utf-8').digest('base64');
    expect(actual).toBe(HEIGHT_REPORTER_SHA256);
  });

  it('is the hash the document declares', () => {
    expect(buildReadmeDocument('')).toContain(`script-src 'sha256-${HEIGHT_REPORTER_SHA256}'`);
  });

  it('reports the height under the name the host listens for', () => {
    expect(HEIGHT_REPORTER).toContain(README_HEIGHT_MESSAGE);
  });
});

describe('what the frame is allowed to do', () => {
  const doc = buildReadmeDocument('<p>hello</p>');

  it.each([
    ["default-src 'none'", 'nothing loads unless named below'],
    ["connect-src 'none'", 'an escaped script has nowhere to send anything'],
    ["img-src 'none'", 'no publisher-controlled request reporting the viewer'],
    ["form-action 'none'", 'no navigation on submit'],
    ["base-uri 'none'", 'no rewriting of every relative URL in the document'],
  ])('declares %s — %s', (directive) => {
    expect(doc).toContain(directive);
  });

  it('allows inline style, because the theme travels with the document', () => {
    // The frame cannot read the editor's stylesheet; without this a README is
    // black on white inside a dark editor.
    expect(doc).toContain("style-src 'unsafe-inline'");
  });

  it('never allows inline script', () => {
    /*
      The distinction the whole design rests on. `'unsafe-inline'` here would
      mean a payload that survived the registry's renderer executes — sandboxed
      and useless, but executing. The hash means it does not run at all.
    */
    expect(doc).not.toContain("script-src 'unsafe-inline'");
    expect(doc).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('carries the README through unchanged', () => {
    // This module frames; it does not re-render or re-filter. A second
    // transformation here would be a second thing that can disagree with the
    // registry's renderer about what the bytes mean.
    expect(doc).toContain('<p>hello</p>');
  });
});
