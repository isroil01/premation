/**
 * Chapters are the one export feature whose output nobody looks at.
 *
 * A wrong chapter list does not make a broken file — ffmpeg accepts it, the
 * player accepts it, and the only symptom is a menu that seeks to the wrong
 * place. So the rules live in a pure module and are pinned here: what earns a
 * chapter, where each one ends, and the escaping that decides whether a title
 * survives the ffmetadata parser at all.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chaptersFromMarkers, formatFfmetadata, formatCarriesChapters } from './chapters';

describe('chaptersFromMarkers', () => {
  it('turns labelled markers into contiguous chapters ending at the comp end', () => {
    const chapters = chaptersFromMarkers(
      [
        { time: 0, label: 'Intro' },
        { time: 2, label: 'Body' },
        { time: 5, label: 'Outro' },
      ],
      30,
      8,
    );
    expect(chapters).toEqual([
      { startMs: 0, endMs: 2000, title: 'Intro' },
      { startMs: 2000, endMs: 5000, title: 'Body' },
      { startMs: 5000, endMs: 8000, title: 'Outro' },
    ]);
  });

  it('orders by time regardless of the order markers arrive in', () => {
    const chapters = chaptersFromMarkers(
      [
        { time: 4, label: 'Third' },
        { time: 1, label: 'First' },
        { time: 2.5, label: 'Second' },
      ],
      25,
      6,
    );
    expect(chapters.map((c) => c.title)).toEqual(['First', 'Second', 'Third']);
    // 2.5 s is BETWEEN frames at 25 fps; it snaps forward to frame 63 (2.52 s)
    // rather than landing a chapter where no frame exists.
    expect(chapters.map((c) => c.startMs)).toEqual([1000, 2520, 4000]);
    expect(chapters.map((c) => c.endMs)).toEqual([2520, 4000, 6000]);
  });

  it('ignores markers with no usable label', () => {
    const chapters = chaptersFromMarkers(
      [
        { time: 0, label: 'Kept' },
        { time: 1 },
        { time: 2, label: '' },
        { time: 3, label: '   ' },
        // The placeholder the controller substitutes for an unnamed marker is
        // not a title — it would deliver a menu of rows all called "Marker".
        { time: 4, label: 'Marker' },
      ],
      30,
      6,
    );
    expect(chapters).toEqual([{ startMs: 0, endMs: 6000, title: 'Kept' }]);
  });

  it('drops markers at or past the composition end', () => {
    const chapters = chaptersFromMarkers(
      [
        { time: 1, label: 'Inside' },
        { time: 5, label: 'Exactly at the end' },
        { time: 9, label: 'Past the end' },
      ],
      30,
      5,
    );
    expect(chapters).toEqual([{ startMs: 1000, endMs: 5000, title: 'Inside' }]);
  });

  it('drops markers before the start — a work-area export shifts them negative', () => {
    // The caller subtracts the range start, so a marker two seconds before a
    // work area arrives as −2. Clamping it to 0 would chapter a section the
    // delivered file does not contain.
    const chapters = chaptersFromMarkers(
      [
        { time: -2, label: 'Before the range' },
        { time: 0, label: 'First frame of the file' },
      ],
      30,
      4,
    );
    expect(chapters).toEqual([{ startMs: 0, endMs: 4000, title: 'First frame of the file' }]);
  });

  it('collapses markers that land on the same millisecond', () => {
    // Two markers one frame apart at 30 fps are 33 ms apart, so this needs the
    // SAME frame to collide — which is exactly what two markers dropped at the
    // playhead do.
    const chapters = chaptersFromMarkers(
      [
        { time: 2, label: 'First here' },
        { time: 2, label: 'Also here' },
        { time: 3, label: 'Later' },
      ],
      30,
      4,
    );
    expect(chapters).toEqual([
      { startMs: 2000, endMs: 3000, title: 'First here' },
      { startMs: 3000, endMs: 4000, title: 'Later' },
    ]);
  });

  it('snaps to the frame grid for a rational frame rate', () => {
    const fps = 30000 / 1001;
    // Frame 100 of a 29.97 comp — the float value a marker actually carries.
    const chapters = chaptersFromMarkers([{ time: 100 / fps, label: 'Cue' }], fps, 20);
    expect(chapters[0]?.startMs).toBe(Math.round((100 / fps) * 1000));
  });

  it('returns nothing for an empty marker list or a zero-length comp', () => {
    expect(chaptersFromMarkers([], 30, 10)).toEqual([]);
    expect(chaptersFromMarkers([{ time: 0, label: 'Intro' }], 30, 0)).toEqual([]);
  });
});

describe('formatFfmetadata', () => {
  it('writes the header and one record per chapter', () => {
    const text = formatFfmetadata([
      { startMs: 0, endMs: 2000, title: 'Intro' },
      { startMs: 2000, endMs: 5000, title: 'Body' },
    ]);
    expect(text).toBe(
      ';FFMETADATA1\n'
      + '[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=Intro\n'
      + '[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=5000\ntitle=Body\n',
    );
  });

  it('is empty for no chapters, so the caller writes no file and maps nothing', () => {
    expect(formatFfmetadata([])).toBe('');
  });

  describe('escaping', () => {
    const titleLine = (title: string): string => {
      const line = formatFfmetadata([{ startMs: 0, endMs: 1000, title }])
        .split('\n')
        .find((l) => l.startsWith('title='));
      return line ?? '';
    };

    it('escapes "=" — otherwise the parser reads a second assignment', () => {
      expect(titleLine('A = B')).toBe('title=A \\= B');
    });

    it('escapes ";" — otherwise the rest of the title is a comment', () => {
      expect(titleLine('Act 1; Act 2')).toBe('title=Act 1\\; Act 2');
    });

    it('escapes "#" — the other comment character', () => {
      expect(titleLine('Take #3')).toBe('title=Take \\#3');
    });

    it('escapes the backslash itself, first', () => {
      expect(titleLine('A\\B')).toBe('title=A\\\\B');
      // A backslash before a special character must not eat its escape.
      expect(titleLine('A\\=B')).toBe('title=A\\\\\\=B');
    });

    it('collapses newlines instead of escaping them — a record ends at one', () => {
      expect(titleLine('Two\nlines')).toBe('title=Two lines');
      expect(titleLine('  padded\t\tout  ')).toBe('title=padded out');
    });
  });
});

/*
  The encode options are written out TWICE — once inline in `electron/main.ts`
  for the main process, once in `src/types/motionEditor.d.ts` for the renderer —
  because the renderer must not import main-process sources. That is the same
  shape as `UpdateStatus` (see updaterStatusContract.test.ts), and it drifts the
  same silent way: the sink starts sending a field the handler never reads, the
  export succeeds, and the only symptom is a delivered file with no chapters.

  Checked as text, for the same reason: neither side imports the other, so no
  compiler is ever in a position to notice.
*/
describe('the chapter payload crosses the IPC boundary intact', () => {
  const ROOT = join(__dirname, '..', '..', '..');
  const mainSrc = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8');
  const bridgeSrc = readFileSync(join(ROOT, 'src', 'types', 'motionEditor.d.ts'), 'utf8');

  it('declares the same field name on both sides', () => {
    expect(bridgeSrc).toContain('chaptersFfmetadata?: string;');
    expect(mainSrc).toContain('chaptersFfmetadata?: string;');
  });

  it('the main process maps chapters onto the output', () => {
    // `-map_chapters` and not `-map_metadata`: the latter would also replace the
    // output's global metadata with the metadata of a chapters-only file.
    expect(mainSrc).toContain("'-map_chapters'");
  });

  it('the sink sends the field the handler reads', () => {
    const sinkSrc = readFileSync(join(__dirname, 'videoSink.ts'), 'utf8');
    expect(sinkSrc).toContain('chaptersFfmetadata:');
  });
});

describe('formatCarriesChapters', () => {
  it('accepts the MP4/MOV family, including the HDR presets that mux to MP4', () => {
    expect(formatCarriesChapters('mp4')).toBe(true);
    expect(formatCarriesChapters('mov')).toBe(true);
    expect(formatCarriesChapters('hdr10')).toBe(true);
    expect(formatCarriesChapters('hlg')).toBe(true);
  });

  it('rejects WebM — this repo\'s muxer writes no Chapters element', () => {
    expect(formatCarriesChapters('webm')).toBe(false);
    expect(formatCarriesChapters('gif')).toBe(false);
    expect(formatCarriesChapters('png-sequence')).toBe(false);
  });
});
