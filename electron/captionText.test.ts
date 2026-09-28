/**
 * The caption file main hands the engine (`premation render --captions`):
 * both formats, both separators, BOM + CRLF, overlaps trimmed, long lines
 * wrapped — the editor's import rules (captionFormat.ts).
 */

import { captionCuesFromFile, deoverlap, parseCaptions, parseTimestamp, wrapCaption } from './captionText';

describe('caption files for the engine', () => {
  it('reads SRT and VTT timestamps with either separator', () => {
    expect(parseTimestamp('00:00:01,500')).toBe(1.5);
    expect(parseTimestamp('01:02.5')).toBe(62.5);
    expect(parseTimestamp('1:00:00.000')).toBe(3600);
    expect(parseTimestamp('00:61:00')).toBeNull();
  });

  it('parses SRT with a BOM and CRLF, and VTT with cue settings', () => {
    const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nWorld\r\n';
    expect(parseCaptions(srt)).toEqual([{ start: 1, end: 2, text: 'Hello' }, { start: 3, end: 4, text: 'World' }]);
    const vtt = 'WEBVTT\n\n00:00.500 --> 00:01.500 align:middle\nOne\ntwo\n';
    expect(parseCaptions(vtt)).toEqual([{ start: 0.5, end: 1.5, text: 'One\ntwo' }]);
    expect(() => parseCaptions('no cues here')).toThrow(/No captions found/);
  });

  it('trims overlaps and wraps long captions', () => {
    expect(deoverlap([{ start: 0, end: 3, text: 'a' }, { start: 2, end: 4, text: 'b' }])).toEqual([
      { start: 0, end: 2, text: 'a' }, { start: 2, end: 4, text: 'b' },
    ]);
    const long = 'The quick brown fox jumps over the lazy dog and keeps running far away';
    const wrapped = wrapCaption(long);
    expect(wrapped.split('\n')).toHaveLength(2);
    expect(wrapped.replace('\n', ' ')).toBe(long);
    const { cues, skipped } = captionCuesFromFile('00:00:00,000 --> 00:00:02,000\nA\n\n00:00:00,000 --> 00:00:01,000\nB\n');
    // Same start: the first is trimmed to nothing and dropped (the editor's rule).
    expect(cues.map((c) => c.text)).toEqual(['B']);
    expect(skipped).toBe(1);
  });
});
