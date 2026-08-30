/**
 * Every branch of the command line, because none of them can be reached from
 * the app.
 *
 * A wrong CLI is discovered on someone's build server, at whatever hour their
 * pipeline runs, with only an exit code to go on — so the argv layer is kept
 * pure and its whole decision table lives here. What is NOT here is the render
 * itself: that needs a GPU, a window and ffmpeg, and it is the same render the
 * Render Queue performs (`@core/export/renderJob`), covered where that is.
 */

import {
  CLI_FORMATS,
  cliArgs,
  extensionFor,
  formatFromPath,
  parseCli,
  type CliInvocation,
} from './cliArgs';

/** The render job from an invocation, or a readable failure. */
function job(invocation: CliInvocation) {
  if (invocation.kind !== 'render') {
    throw new Error(`expected a render, got ${invocation.kind}: ${JSON.stringify(invocation)}`);
  }
  return invocation.job;
}

describe('cliArgs — slicing argv', () => {
  it('drops the executable in a packaged build', () => {
    expect(cliArgs(['C:\\Apps\\Premation.exe', 'render', 'a.motion'], false)).toEqual([
      'render',
      'a.motion',
    ]);
  });

  it('drops the electron binary AND the script path in development', () => {
    expect(cliArgs(['electron', 'dist-electron/main.js', 'render', 'a.motion'], true)).toEqual([
      'render',
      'a.motion',
    ]);
  });
});

describe('parseCli — when it declines to engage', () => {
  it('ignores an ordinary launch', () => {
    expect(parseCli([])).toEqual({ kind: 'none' });
  });

  it('ignores a premation:// deep link, which Windows appends on a cold start', () => {
    expect(parseCli(['premation://oauth?code=abc']).kind).toBe('none');
  });

  it("ignores Chromium's own switches", () => {
    expect(parseCli(['--no-sandbox', '--disable-gpu']).kind).toBe('none');
  });

  it('ignores a word that is not one of our commands', () => {
    // A file association, a drag-and-drop, a packager's argument — all of which
    // put a path in argv, and none of which mean "render this headlessly".
    expect(parseCli(['C:\\Users\\me\\Promo.motion']).kind).toBe('none');
  });
});

describe('parseCli — help and version', () => {
  it('prints help when asked with no command', () => {
    const result = parseCli(['--help']);
    expect(result.kind).toBe('help');
    expect(result.kind === 'help' && result.text).toContain('premation render');
  });

  it('prints help for a command, rather than running it', () => {
    expect(parseCli(['render', 'a.motion', '--help']).kind).toBe('help');
  });

  it('reports the version', () => {
    expect(parseCli(['--version']).kind).toBe('version');
  });
});

describe('parseCli — render defaults', () => {
  it('needs only a project path', () => {
    expect(job(parseCli(['render', 'Promo.motion']))).toEqual({
      projectPath: 'Promo.motion',
      outPath: 'Promo.mp4',
      format: 'mp4',
    });
  });

  it('infers the format from the output name', () => {
    expect(job(parseCli(['render', 'a.motion', '--out', 'clip.webm'])).format).toBe('webm');
  });

  it('lets --format win over the output name, which is how HDR is reachable at all', () => {
    // Both HDR presets write .mp4, so the extension can never imply them.
    const parsed = job(parseCli(['render', 'a.motion', '--out', 'clip.mp4', '--format', 'hdr10']));
    expect(parsed.format).toBe('hdr10');
    expect(parsed.outPath).toBe('clip.mp4');
  });

  it('names the output after the project when --out is absent', () => {
    expect(job(parseCli(['render', 'work/Promo.motion', '--format', 'png-sequence'])).outPath).toBe(
      'work/Promo.zip',
    );
  });

  it('accepts --flag=value as well as --flag value', () => {
    expect(job(parseCli(['render', 'a.motion', '--comp=Main Titles'])).comp).toBe('Main Titles');
  });
});

describe('parseCli — ranges', () => {
  it('reads an inclusive range', () => {
    const parsed = job(parseCli(['render', 'a.motion', '--range', '0-119']));
    expect(parsed).toMatchObject({ startFrame: 0, endFrame: 119 });
  });

  it('accepts --start and --end separately', () => {
    expect(job(parseCli(['render', 'a.motion', '--start', '10', '--end', '20']))).toMatchObject({
      startFrame: 10,
      endFrame: 20,
    });
  });

  it('refuses a backwards range rather than rendering one frame', () => {
    const result = parseCli(['render', 'a.motion', '--range', '119-0']);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/ends before it starts/);
  });

  it('refuses a backwards --start/--end pair too', () => {
    expect(parseCli(['render', 'a.motion', '--start', '50', '--end', '10']).kind).toBe('error');
  });

  it('refuses a range that is not two numbers', () => {
    expect(parseCli(['render', 'a.motion', '--range', '0..119']).kind).toBe('error');
  });

  it('keeps frame 0 as a legitimate start, not as a missing value', () => {
    expect(job(parseCli(['render', 'a.motion', '--start', '0'])).startFrame).toBe(0);
  });
});

describe('parseCli — sizes and rates', () => {
  it('takes a scale', () => {
    expect(job(parseCli(['render', 'a.motion', '--scale', '0.5'])).scale).toBe(0.5);
  });

  it('takes one dimension on its own', () => {
    expect(job(parseCli(['render', 'a.motion', '--width', '1080'])).width).toBe(1080);
  });

  it('refuses a zero or negative size', () => {
    expect(parseCli(['render', 'a.motion', '--width', '0']).kind).toBe('error');
    expect(parseCli(['render', 'a.motion', '--scale', '-1']).kind).toBe('error');
  });

  it('refuses a non-numeric frame rate', () => {
    expect(parseCli(['render', 'a.motion', '--fps', 'fast']).kind).toBe('error');
  });
});

describe('parseCli — validation that saves a wasted render', () => {
  it('refuses an unknown format, listing the real ones', () => {
    const result = parseCli(['render', 'a.motion', '--format', 'avi']);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toContain('mp4');
  });

  it('refuses an unknown option instead of ignoring it', () => {
    // Ignoring it is worse: --qulaity high renders at the default and reports
    // success, and nobody looks at the file until the deadline.
    expect(parseCli(['render', 'a.motion', '--qulaity', 'high']).kind).toBe('error');
  });

  it('refuses an option with no value', () => {
    expect(parseCli(['render', 'a.motion', '--comp']).kind).toBe('error');
    expect(parseCli(['render', 'a.motion', '--comp', '--json']).kind).toBe('error');
  });

  it('refuses --prores on anything but mov, where it would be silently dropped', () => {
    expect(parseCli(['render', 'a.motion', '--prores', 'hq']).kind).toBe('error');
    expect(job(parseCli(['render', 'a.motion', '--format', 'mov', '--prores', 'hq'])).proresProfile).toBe('hq');
  });

  it('refuses an unknown ProRes profile', () => {
    expect(parseCli(['render', 'a.motion', '--format', 'mov', '--prores', '8888']).kind).toBe('error');
  });

  it('refuses a second project path rather than picking one', () => {
    const result = parseCli(['render', 'a.motion', 'b.motion']);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toContain('b.motion');
  });

  it('refuses a render with no project at all', () => {
    expect(parseCli(['render']).kind).toBe('error');
  });
});

describe('parseCli — data-driven batches', () => {
  it('takes a table and a per-row output pattern', () => {
    const parsed = job(parseCli(['render', 'a.motion', '--data', 'people.csv', '--out', 'out/{name}.mp4']));
    expect(parsed.dataPath).toBe('people.csv');
    expect(parsed.outPath).toBe('out/{name}.mp4');
  });

  it('accepts {index} as the varying token', () => {
    expect(parseCli(['render', 'a.motion', '--data', 'p.csv', '--out', '{index}.mp4']).kind).toBe('render');
  });

  it('refuses a constant --out, which would render every row over one file', () => {
    // The failure this check exists for is silent: with an overwriting CLI,
    // forty rows leave one file and nothing reports the other thirty-nine.
    const result = parseCli(['render', 'a.motion', '--data', 'people.csv', '--out', 'promo.mp4']);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/{token}/);
  });

  it('refuses the default --out too, since it is also constant', () => {
    expect(parseCli(['render', 'a.motion', '--data', 'people.csv']).kind).toBe('error');
  });

  it('takes a 1-based --from-row for a resume', () => {
    // 1-based because the log, the CSV and every spreadsheet are; the renderer
    // wants 0-based, and exactly one place should do that conversion.
    const parsed = job(parseCli(['render', 'a.motion', '--data', 'p.csv', '--out', '{index}.mp4', '--from-row', '31']));
    expect(parsed.startRow).toBe(30);
  });

  it('refuses row 0, which no spreadsheet has', () => {
    expect(parseCli(['render', 'a.motion', '--data', 'p.csv', '--out', '{index}.mp4', '--from-row', '0']).kind)
      .toBe('error');
  });

  it('refuses --from-row without --data', () => {
    expect(parseCli(['render', 'a.motion', '--from-row', '2']).kind).toBe('error');
  });

  it('refuses a {token} with no --data, rather than writing a literal brace', () => {
    const result = parseCli(['render', 'a.motion', '--out', 'out/{name}.mp4']);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/--data/);
  });
});

describe('parseCli — output options', () => {
  it('defaults to prose on stdout', () => {
    const result = parseCli(['render', 'a.motion']);
    expect(result.kind === 'render' && result.output).toEqual({ json: false, quiet: false });
  });

  it('carries --json, --quiet and --log', () => {
    const result = parseCli(['render', 'a.motion', '--json', '--quiet', '--log', 'render.log']);
    expect(result.kind === 'render' && result.output).toEqual({
      json: true,
      quiet: true,
      logPath: 'render.log',
    });
  });

  it('flags do not become the project path', () => {
    expect(job(parseCli(['render', '--json', 'a.motion'])).projectPath).toBe('a.motion');
  });
});

describe('parseCli — reframe', () => {
  it('is a render, plus a target shape', () => {
    const parsed = job(parseCli(['reframe', 'a.motion', '--aspect', '9:16', '--out', 'v.mp4']));
    expect(parsed.aspect).toBe('9:16');
    expect(parsed.outPath).toBe('v.mp4');
    expect(parsed.format).toBe('mp4');
  });

  it('accepts every render option, because it IS a render', () => {
    // A second parser for reframe would drift from render's within a release.
    const parsed = job(parseCli(['reframe', 'a.motion', '--aspect', '1:1', '--scale', '0.5', '--quality', 'draft']));
    expect(parsed).toMatchObject({ scale: 0.5, quality: 'draft' });
  });

  it('refuses reframe with no aspect, rather than picking one', () => {
    const result = parseCli(['reframe', 'a.motion']);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/--aspect/);
  });

  it('refuses an unknown aspect, listing the real ones', () => {
    const result = parseCli(['reframe', 'a.motion', '--aspect', '21:9']);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toContain('9:16');
  });

  it('refuses --aspect on a plain render, where it would do nothing', () => {
    expect(parseCli(['render', 'a.motion', '--aspect', '9:16']).kind).toBe('error');
  });
});

describe('parseCli — captions', () => {
  it('transcribes to a named file', () => {
    expect(parseCli(['captions', 'a.motion', '--out', 'subs.srt'])).toEqual({
      kind: 'captions',
      projectPath: 'a.motion',
      outPath: 'subs.srt',
      output: { json: false, quiet: false },
    });
  });

  it('names the file after the project by default', () => {
    const result = parseCli(['captions', 'work/Promo.motion']);
    expect(result.kind === 'captions' && result.outPath).toBe('work/Promo.srt');
  });

  it('takes a composition and a language hint', () => {
    const result = parseCli(['captions', 'a.motion', '--comp', 'Main', '--language', 'pt-BR']);
    expect(result).toMatchObject({ comp: 'Main', language: 'pt-BR' });
  });

  it('refuses an output that is not a caption file', () => {
    // .mp4 here means someone typed the wrong command, and writing SubRip into
    // it would produce a file nothing opens and no error to explain it.
    const result = parseCli(['captions', 'a.motion', '--out', 'subs.mp4']);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toMatch(/srt/);
  });

  it('accepts .vtt', () => {
    expect(parseCli(['captions', 'a.motion', '--out', 'subs.vtt']).kind).toBe('captions');
  });

  it('refuses render-only options', () => {
    expect(parseCli(['captions', 'a.motion', '--scale', '0.5']).kind).toBe('error');
  });
});

describe('parseCli — caption burn-in', () => {
  it('takes a caption file to import before rendering', () => {
    expect(job(parseCli(['render', 'a.motion', '--captions', 'subs.srt'])).captionsPath).toBe('subs.srt');
  });

  it('refuses --language on a render, which belongs to captions', () => {
    expect(parseCli(['render', 'a.motion', '--language', 'en']).kind).toBe('error');
  });
});

describe('parseCli — comps', () => {
  it('lists a project', () => {
    expect(parseCli(['comps', 'a.motion'])).toEqual({
      kind: 'comps',
      projectPath: 'a.motion',
      output: { json: false, quiet: false },
    });
  });

  it('refuses render-only options, rather than accepting and ignoring them', () => {
    expect(parseCli(['comps', 'a.motion', '--format', 'mp4']).kind).toBe('error');
  });
});

describe('extensionFor', () => {
  it('gives every format a real file extension', () => {
    for (const format of CLI_FORMATS) {
      expect(extensionFor(format)).toMatch(/^[a-z0-9]+$/);
    }
  });

  it('writes both HDR presets into an .mp4 container, since ".hdr10" is not a file', () => {
    expect(extensionFor('hdr10')).toBe('mp4');
    expect(extensionFor('hlg')).toBe('mp4');
  });

  it('zips every image sequence', () => {
    expect(extensionFor('png-sequence')).toBe('zip');
    expect(extensionFor('exr-sequence')).toBe('zip');
  });
});

describe('formatFromPath', () => {
  it('reads the unambiguous extensions', () => {
    expect(formatFromPath('out.mp4')).toBe('mp4');
    expect(formatFromPath('OUT.GIF')).toBe('gif');
  });

  it('declines .zip, which names three different formats', () => {
    expect(formatFromPath('frames.zip')).toBeNull();
  });

  it('declines a path with no extension', () => {
    expect(formatFromPath('out')).toBeNull();
  });
});
