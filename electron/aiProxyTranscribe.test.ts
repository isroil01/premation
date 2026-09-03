/**
 * Whisper's `verbose_json` body, as the proxy reads it.
 *
 * The HTTPS call itself is not unit-tested (a live key, a paid request). What
 * is load-bearing and easy to get wrong is the SHAPE: the segment list is what
 * becomes captions, and the word list — newly asked for alongside it — is what
 * lets the Transcript panel stop estimating chip times from character counts.
 * The two arrays are read by different parsers because whisper names the text
 * field differently in each (`text` vs `word`), which is exactly the kind of
 * detail a copied parser gets wrong silently.
 */

// `aiProxy` registers IPC handlers at import through `ipcGuard`, which pulls
// the real `electron` module. CI installs with `--ignore-scripts`, so the
// Electron binary is absent there and that import throws before the first
// test runs. Stub it the way the other main-process suites do.
jest.mock('electron', () => ({
  app: { getPath: () => '/tmp/motion-test' },
  ipcMain: { handle: () => undefined, on: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { parseWhisperSegments, parseWhisperWords } from './aiProxy';

describe('parseWhisperSegments', () => {
  it('reads the timed segments and trims their text', () => {
    expect(
      parseWhisperSegments({
        segments: [
          { start: 0, end: 1.5, text: ' Hello there. ' },
          { start: 1.5, end: 3, text: 'General Kenobi.' },
        ],
      }),
    ).toEqual([
      { start: 0, end: 1.5, text: 'Hello there.' },
      { start: 1.5, end: 3, text: 'General Kenobi.' },
    ]);
  });

  it('skips a malformed segment rather than failing the transcription', () => {
    expect(
      parseWhisperSegments({
        segments: [
          { start: 0, end: 1, text: 'kept' },
          { start: 'soon', end: 2, text: 'dropped' },
          { start: 2, end: 3, text: '   ' },
        ],
      }),
    ).toEqual([{ start: 0, end: 1, text: 'kept' }]);
  });

  it('is null when the body has no segments at all', () => {
    // Distinct from an empty list: null is "this is not a verbose_json body",
    // which the caller reports as a provider error rather than as silence.
    expect(parseWhisperSegments({ text: 'just prose' })).toBeNull();
    expect(parseWhisperSegments(null)).toBeNull();
  });
});

describe('parseWhisperWords', () => {
  it('reads word granularity from the `word` field', () => {
    expect(
      parseWhisperWords({
        words: [
          { start: 0.1, end: 0.4, word: 'Hello' },
          { start: 0.5, end: 0.9, word: 'there' },
        ],
      }),
    ).toEqual([
      { start: 0.1, end: 0.4, text: 'Hello' },
      { start: 0.5, end: 0.9, text: 'there' },
    ]);
  });

  it('accepts `text` too, for whisper-compatible servers that use it', () => {
    expect(parseWhisperWords({ words: [{ start: 0, end: 1, text: 'hi' }] }))
      .toEqual([{ start: 0, end: 1, text: 'hi' }]);
  });

  it('is EMPTY, not null, when the model returned no word timings', () => {
    // The renderer treats empty as "estimate the word times inside each
    // segment" — the behaviour that shipped before word granularity was
    // requested. A missing word list must never fail a transcription.
    expect(parseWhisperWords({ segments: [{ start: 0, end: 1, text: 'hi' }] })).toEqual([]);
    expect(parseWhisperWords(null)).toEqual([]);
  });

  it('skips malformed entries and never lets a word end before it starts', () => {
    expect(
      parseWhisperWords({
        words: [
          { start: 1, end: 0.5, word: 'backwards' },
          { start: 2, end: 3 },
          { start: 'x', end: 4, word: 'bad' },
          { start: 4, end: 5, word: '  ' },
        ],
      }),
    ).toEqual([{ start: 1, end: 1, text: 'backwards' }]);
  });
});
