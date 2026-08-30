/**
 * The caption formats, against the files people actually have.
 *
 * SRT has no specification — only a consensus — so most of these cases are
 * transcribed from what real exporters produce: CRLF line endings, a BOM, a
 * `.vtt` written with SRT's comma, WebVTT cue settings trailing the end time,
 * and two-line captions. A parser that is right about a spec and wrong about
 * those files is not useful.
 */

import {
  CaptionFormatError,
  deoverlap,
  formatTimestamp,
  parseCaptions,
  parseTimestamp,
  toSrt,
  toVtt,
  wrapCaption,
} from './captionFormat';

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  'The first caption',
  '',
  '2',
  '00:00:04,000 --> 00:00:06,000',
  'A caption that runs',
  'across two lines',
  '',
].join('\n');

describe('parseTimestamp', () => {
  it('reads SRT commas and VTT periods alike', () => {
    expect(parseTimestamp('00:00:01,500')).toBe(1.5);
    expect(parseTimestamp('00:00:01.500')).toBe(1.5);
  });

  it('reads the MM:SS form WebVTT allows', () => {
    expect(parseTimestamp('01:30.000')).toBe(90);
  });

  it('pads a short fraction, so .5 is half a second and not five milliseconds', () => {
    expect(parseTimestamp('00:00:00.5')).toBe(0.5);
    expect(parseTimestamp('00:00:00.05')).toBe(0.05);
  });

  it('reads hours', () => {
    expect(parseTimestamp('01:02:03,004')).toBeCloseTo(3723.004, 6);
  });

  it('refuses nonsense rather than guessing', () => {
    expect(parseTimestamp('tomorrow')).toBeNull();
    expect(parseTimestamp('00:99:00,000')).toBeNull();
  });
});

describe('formatTimestamp', () => {
  it('writes SRT and VTT separators', () => {
    expect(formatTimestamp(1.5, ',')).toBe('00:00:01,500');
    expect(formatTimestamp(1.5, '.')).toBe('00:00:01.500');
  });

  it('carries a rounded millisecond instead of writing ",1000"', () => {
    expect(formatTimestamp(3.9996)).toBe('00:00:04,000');
  });

  it('never writes a negative time', () => {
    expect(formatTimestamp(-5)).toBe('00:00:00,000');
  });

  it('writes hours past the first', () => {
    expect(formatTimestamp(3723.004)).toBe('01:02:03,004');
  });
});

describe('parseCaptions', () => {
  it('reads a plain SRT file', () => {
    const cues = parseCaptions(SRT);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ start: 1, end: 3.5, text: 'The first caption' });
  });

  it('keeps a two-line caption as two lines', () => {
    expect(parseCaptions(SRT)[1]?.text).toBe('A caption that runs\nacross two lines');
  });

  it('survives CRLF and a BOM, which is what a Windows tool hands you', () => {
    const windows = `\uFEFF${SRT.replace(/\n/g, '\r\n')}`;
    expect(parseCaptions(windows)).toHaveLength(2);
  });

  it('reads WebVTT, header and all', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n';
    expect(parseCaptions(vtt)).toEqual([{ start: 1, end: 2, text: 'Hello' }]);
  });

  it('ignores WebVTT cue settings after the end time', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:middle line:90%\nHello\n';
    expect(parseCaptions(vtt)[0]?.end).toBe(2);
  });

  it('skips NOTE and STYLE blocks rather than failing on them', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE this file was machine generated',
      '',
      'STYLE',
      '::cue { color: yellow }',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'Hello',
      '',
    ].join('\n');
    expect(parseCaptions(vtt)).toHaveLength(1);
  });

  it('reads a file with no blank line between cues, which SRT exporters produce', () => {
    const tight = '1\n00:00:01,000 --> 00:00:02,000\nOne\n2\n00:00:03,000 --> 00:00:04,000\nTwo\n';
    const cues = parseCaptions(tight);
    expect(cues.map((c) => c.text)).toEqual(['One', 'Two']);
  });

  it('gives a zero-length cue the visibility floor instead of dropping its words', () => {
    const cues = parseCaptions('1\n00:00:01,000 --> 00:00:01,000\nBlink\n');
    expect(cues[0]?.end).toBeGreaterThan(1);
  });

  it('sorts out-of-order cues', () => {
    const messy = '1\n00:00:05,000 --> 00:00:06,000\nSecond\n\n2\n00:00:01,000 --> 00:00:02,000\nFirst\n';
    expect(parseCaptions(messy).map((c) => c.text)).toEqual(['First', 'Second']);
  });

  it('throws for a file with no cues at all — the one case worth reporting', () => {
    expect(() => parseCaptions('just some prose\nwith no timings')).toThrow(CaptionFormatError);
  });
});

describe('round trip', () => {
  it('SRT survives parse → write → parse', () => {
    const once = parseCaptions(SRT);
    expect(parseCaptions(toSrt(once))).toEqual(once);
  });

  it('VTT survives parse → write → parse', () => {
    const once = parseCaptions(SRT);
    expect(parseCaptions(toVtt(once))).toEqual(once);
  });

  it('writes a WEBVTT header, without which nothing will open the file', () => {
    expect(toVtt([{ start: 0, end: 1, text: 'x' }]).startsWith('WEBVTT\n')).toBe(true);
  });

  it('numbers SRT cues from 1', () => {
    expect(toSrt([{ start: 0, end: 1, text: 'x' }, { start: 1, end: 2, text: 'y' }])).toMatch(/^1\n/);
  });
});

describe('deoverlap', () => {
  it('trims a cue that runs into the next one', () => {
    const fixed = deoverlap([
      { start: 0, end: 5, text: 'long' },
      { start: 2, end: 4, text: 'next' },
    ]);
    expect(fixed[0]?.end).toBe(2);
  });

  it('drops a cue left too short to read, rather than flashing it', () => {
    const fixed = deoverlap([
      { start: 0, end: 5, text: 'long' },
      { start: 0.001, end: 4, text: 'next' },
    ]);
    expect(fixed.map((c) => c.text)).toEqual(['next']);
  });

  it('leaves non-overlapping cues alone', () => {
    const cues = [
      { start: 0, end: 1, text: 'a' },
      { start: 2, end: 3, text: 'b' },
    ];
    expect(deoverlap(cues)).toEqual(cues);
  });
});

describe('wrapCaption', () => {
  it('leaves a short caption alone', () => {
    expect(wrapCaption('Short enough')).toBe('Short enough');
  });

  it('breaks on words at roughly the line budget', () => {
    const wrapped = wrapCaption('one two three four five six seven eight nine ten eleven twelve', 20);
    expect(wrapped.split('\n').length).toBe(2);
    expect(wrapped.split('\n')[0]!.length).toBeLessThanOrEqual(20);
  });

  it('keeps every word even when the line budget runs out', () => {
    // An over-long caption is a visible problem someone can fix; missing words
    // are a problem nobody can see.
    const text = 'one two three four five six seven eight nine ten eleven twelve thirteen';
    expect(wrapCaption(text, 10, 2).replace(/\n/g, ' ')).toBe(text);
  });

  it('never splits a word that is longer than the budget', () => {
    expect(wrapCaption('supercalifragilistic', 5)).toBe('supercalifragilistic');
  });
});
