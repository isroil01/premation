/**
 * `premation render …` — argv in, a job out.
 *
 * Pure: no `app`, no filesystem, no process. Every branch a user can hit at a
 * terminal is decided here and unit-tested in `cliArgs.test.ts`, because the
 * alternative is discovering that `--range 10-5` renders backwards on someone's
 * build server at 3am.
 *
 * The command only engages when argv's first non-flag word is one of ours. A
 * desktop app's argv is not private property — Chromium puts its own switches
 * there, the OS appends a `premation://` deep link on Windows, and packagers
 * add their own — so anything unrecognised means "this is a normal launch",
 * never "this is a broken command line".
 *
 * @see electron/cliRender.ts — what drives the job this returns
 * @see src/core/cli/headlessRender.ts — the renderer half
 */

/** Formats `render` accepts, and what each one writes. */
export const CLI_FORMATS = [
  'mp4',
  'mov',
  'webm',
  'gif',
  'hdr10',
  'hlg',
  'png-sequence',
  'jpg-sequence',
  'exr-sequence',
  'png',
] as const;

export type CliFormat = (typeof CLI_FORMATS)[number];

export const CLI_QUALITIES = ['high', 'medium', 'draft'] as const;
export type CliQuality = (typeof CLI_QUALITIES)[number];

export const PRORES_PROFILES = ['proxy', 'lt', '422', 'hq', '4444'] as const;
export type ProresProfile = (typeof PRORES_PROFILES)[number];

/**
 * Target shapes `reframe` accepts.
 *
 * Deliberately the same five the editor offers, spelled the same way, and
 * deliberately duplicated from `ASPECT_PRESETS` rather than shared: the two
 * halves live in TypeScript projects that cannot import each other, and this
 * side only needs to know which words are legal. The renderer resolves the word
 * to a ratio, so a mismatch surfaces as "unknown aspect" there rather than as a
 * silently different crop.
 */
export const CLI_ASPECTS = ['9:16', '1:1', '4:5', '16:9', '4:3'] as const;
export type CliAspect = (typeof CLI_ASPECTS)[number];

/**
 * The render request, exactly as the renderer's `HeadlessRenderRequest` wants
 * it — minus the paths, which only the main process can resolve to absolute.
 *
 * Kept structurally identical to that interface on purpose. It crosses an IPC
 * boundary as plain JSON, and the two halves live in two TypeScript projects
 * that cannot import each other (`electron/tsconfig.json` has its own rootDir),
 * so the contract is upheld the same way the preload bridge's is: by being
 * small enough to read side by side. See `src/types/motionEditor.d.ts`.
 */
export interface CliRenderJob {
  projectPath: string;
  comp?: string;
  outPath: string;
  format: CliFormat;
  startFrame?: number;
  endFrame?: number;
  fps?: number;
  scale?: number;
  width?: number;
  height?: number;
  quality?: CliQuality;
  proresProfile?: ProresProfile;
  transparent?: boolean;
  /**
   * Retarget to this aspect before rendering (the `reframe` command).
   *
   * The render then targets the NEW composition, which is what makes
   * `premation reframe promo.motion --aspect 9:16 --out vertical.mp4` one
   * command instead of three.
   */
  aspect?: CliAspect;
  /**
   * A caption file to import before rendering — burn-in, from a pipeline.
   *
   * The path as typed; `prepareTask` reads it, for the same reason `--data`
   * is read there: a missing file should cost a second, not a GPU boot.
   */
  captionsPath?: string;
  /**
   * Start the batch at this row (0-based, converted from the 1-based flag).
   *
   * A pipeline that lost a machine at row 30 of 40 should be able to ask for
   * the last ten, not for forty.
   */
  startRow?: number;
  /**
   * A CSV/JSON table to render one file per row of.
   *
   * The path as typed; `prepareTask` resolves and READS it, and the renderer
   * receives the text. Reading here rather than there is what makes a missing
   * or unparseable table a two-second failure instead of one that costs a GPU
   * boot to discover.
   */
  dataPath?: string;
}

/** How the invocation should be printed while it runs. */
export interface CliOutputOptions {
  /** One JSON object per line instead of prose — for CI to parse. */
  json: boolean;
  /** Suppress progress; the result line still prints. */
  quiet: boolean;
  /**
   * Mirror every line to this file as well as to stdout.
   *
   * Windows earns this flag. A packaged Electron app is a GUI-subsystem binary
   * with no console attached, so `console.log` from a run started in cmd or
   * PowerShell goes nowhere — the exit code survives, the output does not.
   * `--log` is how a Windows pipeline reads what happened.
   */
  logPath?: string;
}

export type CliInvocation =
  /** Not a CLI launch. Boot the editor normally. */
  | { kind: 'none' }
  | { kind: 'help'; text: string }
  | { kind: 'version' }
  | { kind: 'error'; message: string }
  | { kind: 'render'; job: CliRenderJob; output: CliOutputOptions }
  | { kind: 'comps'; projectPath: string; output: CliOutputOptions }
  | {
      kind: 'captions';
      projectPath: string;
      comp?: string;
      outPath: string;
      language?: string;
      output: CliOutputOptions;
    };

export const CLI_HELP = `premation — render Premation projects without opening the editor

USAGE
  premation render   <project.motion> [options]
  premation reframe  <project.motion> --aspect <ratio> [options]
  premation captions <project.motion> [--out subs.srt]
  premation comps    <project.motion>
  premation --help | --version

RENDER OPTIONS
  --comp <name|id>     Composition to render. Default: the project's first.
  --out <file>         Output file. Default: <project>-<comp>.<ext> beside the project.
  --format <fmt>       ${CLI_FORMATS.join(', ')}
                       Default: inferred from --out's extension, else mp4.
  --range <a-b>        Inclusive frame range, e.g. --range 0-119. Default: the whole comp.
  --start <frame>      First frame (alternative to --range).
  --end <frame>        Last frame, inclusive.
  --fps <n>            Override the composition's frame rate.
  --scale <n>          Uniform output scale, e.g. --scale 0.5 for half resolution.
  --width <px>         Output width. Height follows the comp's aspect unless given.
  --height <px>        Output height.
  --quality <tier>     ${CLI_QUALITIES.join(', ')}. Default: high.
  --prores <profile>   mov only: ${PRORES_PROFILES.join(', ')}. Default: 4444.
  --transparent        Force an alpha channel on regardless of the comp's setting.

REFRAME OPTIONS
  --aspect <ratio>     ${CLI_ASPECTS.join(', ')}. Retargets the composition to that
                       shape — following the subject, jumping at cuts — and
                       renders the result. Every render option above applies.

CAPTION OPTIONS
  --captions <file>    Import an .srt/.vtt before rendering (burn-in).
  --language <code>    Speech language hint for "captions", e.g. en, pt-BR.

DATA-DRIVEN OPTIONS
  --data <file>        CSV or JSON table. Renders one file per row, filling the
                       composition's template fields from columns of the same id.
                       --out must then contain a {token}: a column name, or
                       {index} for the row number.
  --from-row <n>       Start at row n (1-based). For resuming a batch that was
                       interrupted, without re-rendering what already landed.

OUTPUT OPTIONS
  --json               One JSON object per line, for pipelines.
  --quiet              No progress; the final result still prints.
  --log <file>         Also write every line to <file>. Use this on Windows,
                       where a packaged GUI binary has no console to print to.

EXAMPLES
  premation render Promo.motion --comp Main --out promo.mp4
  premation render Promo.motion --format png-sequence --range 0-47 --out frames.zip
  premation render Promo.motion --scale 0.5 --quality draft --out preview.mp4 --json
  premation render LowerThird.motion --data people.csv --out "out/{name}.mp4"
  premation reframe Promo.motion --aspect 9:16 --out vertical.mp4
  premation captions Promo.motion --out promo.srt

EXIT CODES
  0  the file was written
  1  the render failed (the reason is the last line printed)
  2  the command line was wrong`;

/** Options that take a value, so a missing value is reported and not guessed. */
const VALUED_FLAGS = new Set([
  '--comp',
  '--out',
  '--format',
  '--range',
  '--start',
  '--end',
  '--fps',
  '--scale',
  '--width',
  '--height',
  '--quality',
  '--prores',
  '--data',
  '--from-row',
  '--aspect',
  '--captions',
  '--language',
  '--log',
]);

const BOOLEAN_FLAGS = new Set(['--transparent', '--json', '--quiet']);

/**
 * A `{token}` in an output path — the mark of a per-row name.
 *
 * Deliberately duplicated from `patternVariesPerRow` in
 * `@core/template/batchRender` rather than shared: the two live in separate
 * TypeScript projects that cannot import each other, and this side only has
 * to answer "does this vary at all", which is the whole check.
 */
const OUTPUT_TOKEN = /\{[^{}]*}/;

/** A positive integer, or null — used for frames and pixel sizes. */
function positiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

/** A non-negative integer (frame indices start at 0). */
function frameIndex(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function positiveNumber(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Strip the extension from a path, keeping directories intact. */
function stripExtension(p: string): string {
  return p.replace(/\.[A-Za-z0-9]+$/, '');
}

/** The file extension a format writes, for defaulting `--out`. */
export function extensionFor(format: CliFormat): string {
  switch (format) {
    case 'png-sequence':
    case 'jpg-sequence':
    case 'exr-sequence':
      return 'zip';
    // Both HDR presets encode into an MP4 container; a ".hdr10" file has never
    // existed. Same rule as `outputExtFor` in the renderer — deliberately
    // duplicated rather than shared, because the two live in separate
    // TypeScript projects and one three-line switch is cheaper than a bridge.
    case 'hdr10':
    case 'hlg':
      return 'mp4';
    default:
      return format;
  }
}

/** The format implied by an output filename, if any. */
export function formatFromPath(outPath: string): CliFormat | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(outPath)?.[1]?.toLowerCase();
  if (!ext) return null;
  // `.zip` names a sequence but not WHICH one, and `.mp4` could be plain or
  // HDR — both stay null so `--format` remains the only way to say.
  const direct = (CLI_FORMATS as readonly string[]).includes(ext) ? (ext as CliFormat) : null;
  return direct === 'png' || direct === 'mp4' || direct === 'mov' || direct === 'webm' || direct === 'gif'
    ? direct
    : null;
}

/**
 * Parse the arguments AFTER the executable (and, in development, after the
 * script path) — `cliArgs(process.argv, process.defaultApp)` does that slicing.
 */
export function cliArgs(argv: readonly string[], isDefaultApp: boolean): string[] {
  return argv.slice(isDefaultApp ? 2 : 1);
}

/** Parse a sliced argv into something the main process can act on. */
export function parseCli(args: readonly string[]): CliInvocation {
  const first = args.find((a) => !a.startsWith('-'));

  // Nothing of ours in argv: a normal launch, a deep link, or Chromium's own
  // switches. Help and version are only honoured ALONGSIDE a command word or
  // when they are the only thing there, so `--version` from some other tool's
  // wrapper cannot suppress the editor.
  if (!first) {
    if (args.includes('--help') || args.includes('-h')) return { kind: 'help', text: CLI_HELP };
    if (args.includes('--version') || args.includes('-v')) return { kind: 'version' };
    return { kind: 'none' };
  }
  if (first !== 'render' && first !== 'comps' && first !== 'reframe' && first !== 'captions') {
    return { kind: 'none' };
  }
  if (args.includes('--help') || args.includes('-h')) return { kind: 'help', text: CLI_HELP };

  const rest = args.slice(args.indexOf(first) + 1);
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    // `--flag=value` and `--flag value` are both accepted; people type both.
    const eq = token.indexOf('=');
    const name = eq < 0 ? token : token.slice(0, eq);
    if (BOOLEAN_FLAGS.has(name)) {
      bools.add(name);
      continue;
    }
    if (!VALUED_FLAGS.has(name)) {
      return { kind: 'error', message: `Unknown option "${name}". Run "premation --help" for the list.` };
    }
    const value = eq < 0 ? rest[++i] : token.slice(eq + 1);
    if (value === undefined || value.startsWith('--')) {
      return { kind: 'error', message: `"${name}" needs a value.` };
    }
    flags.set(name, value);
  }

  const output: CliOutputOptions = {
    json: bools.has('--json'),
    quiet: bools.has('--quiet'),
    ...(flags.has('--log') ? { logPath: flags.get('--log') as string } : {}),
  };

  const projectPath = positionals[0];
  if (!projectPath) {
    return { kind: 'error', message: `"${first}" needs a project path. Run "premation --help" for usage.` };
  }
  if (positionals.length > 1) {
    return {
      kind: 'error',
      message: `"${first}" takes one project path, but got ${positionals.length}: ${positionals.join(', ')}`,
    };
  }

  if (first === 'comps') {
    for (const name of flags.keys()) {
      if (name !== '--log') return { kind: 'error', message: `"comps" does not take "${name}".` };
    }
    return { kind: 'comps', projectPath, output };
  }

  if (first === 'captions') {
    for (const name of flags.keys()) {
      if (name !== '--log' && name !== '--out' && name !== '--comp' && name !== '--language') {
        return { kind: 'error', message: `"captions" does not take "${name}".` };
      }
    }
    const captionOut = flags.get('--out') ?? `${stripExtension(projectPath)}.srt`;
    if (!/\.(srt|vtt)$/i.test(captionOut)) {
      return { kind: 'error', message: `"${captionOut}" is not a caption file — use .srt or .vtt.` };
    }
    return {
      kind: 'captions',
      projectPath,
      outPath: captionOut,
      ...(flags.has('--comp') ? { comp: flags.get('--comp') as string } : {}),
      ...(flags.has('--language') ? { language: flags.get('--language') as string } : {}),
      output,
    };
  }

  // `reframe` IS `render`, plus a retarget. Sharing the parse below rather than
  // forking it is what keeps --scale, --quality, --range and the rest working
  // on both — a second parser would drift within a release.
  if (first === 'reframe' && !flags.has('--aspect')) {
    return {
      kind: 'error',
      message: `"reframe" needs --aspect. One of: ${CLI_ASPECTS.join(', ')}.`,
    };
  }

  // ── render ──
  const outFlag = flags.get('--out');

  let format: CliFormat;
  const formatFlag = flags.get('--format');
  if (formatFlag) {
    if (!(CLI_FORMATS as readonly string[]).includes(formatFlag)) {
      return {
        kind: 'error',
        message: `Unknown format "${formatFlag}". Choose one of: ${CLI_FORMATS.join(', ')}.`,
      };
    }
    format = formatFlag as CliFormat;
  } else {
    // Inferred from the output name, so `--out promo.gif` needs no --format.
    format = (outFlag && formatFromPath(outFlag)) || 'mp4';
  }

  const job: CliRenderJob = {
    projectPath,
    // Beside the project, named after it — a `render` with no `--out` should
    // still produce a findable file rather than an error about a missing flag.
    outPath: outFlag ?? `${stripExtension(projectPath)}.${extensionFor(format)}`,
    format,
  };

  const comp = flags.get('--comp');
  if (comp !== undefined) job.comp = comp;

  const range = flags.get('--range');
  if (range !== undefined) {
    const m = /^(\d+)-(\d+)$/.exec(range);
    if (!m) return { kind: 'error', message: `"--range" wants two frame numbers, like --range 0-119 (got "${range}").` };
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (end < start) {
      return { kind: 'error', message: `"--range ${range}" ends before it starts. Frames only run forwards.` };
    }
    job.startFrame = start;
    job.endFrame = end;
  }

  for (const [flag, key] of [['--start', 'startFrame'], ['--end', 'endFrame']] as const) {
    const raw = flags.get(flag);
    if (raw === undefined) continue;
    const n = frameIndex(raw);
    if (n === null) return { kind: 'error', message: `"${flag}" wants a whole frame number (got "${raw}").` };
    job[key] = n;
  }
  if (job.startFrame !== undefined && job.endFrame !== undefined && job.endFrame < job.startFrame) {
    return { kind: 'error', message: '"--end" is before "--start". Frames only run forwards.' };
  }

  for (const [flag, key] of [['--width', 'width'], ['--height', 'height']] as const) {
    const raw = flags.get(flag);
    if (raw === undefined) continue;
    const n = positiveInt(raw);
    if (n === null) return { kind: 'error', message: `"${flag}" wants a positive pixel count (got "${raw}").` };
    job[key] = n;
  }

  for (const [flag, key] of [['--fps', 'fps'], ['--scale', 'scale']] as const) {
    const raw = flags.get(flag);
    if (raw === undefined) continue;
    const n = positiveNumber(raw);
    if (n === null) return { kind: 'error', message: `"${flag}" wants a positive number (got "${raw}").` };
    job[key] = n;
  }

  const quality = flags.get('--quality');
  if (quality !== undefined) {
    if (!(CLI_QUALITIES as readonly string[]).includes(quality)) {
      return { kind: 'error', message: `Unknown quality "${quality}". Choose one of: ${CLI_QUALITIES.join(', ')}.` };
    }
    job.quality = quality as CliQuality;
  }

  const prores = flags.get('--prores');
  if (prores !== undefined) {
    if (!(PRORES_PROFILES as readonly string[]).includes(prores)) {
      return { kind: 'error', message: `Unknown ProRes profile "${prores}". Choose one of: ${PRORES_PROFILES.join(', ')}.` };
    }
    if (format !== 'mov') {
      return { kind: 'error', message: '"--prores" only applies to --format mov.' };
    }
    job.proresProfile = prores as ProresProfile;
  }

  if (bools.has('--transparent')) job.transparent = true;

  const aspect = flags.get('--aspect');
  if (aspect !== undefined) {
    if (first !== 'reframe') {
      return { kind: 'error', message: '"--aspect" belongs to the "reframe" command.' };
    }
    if (!(CLI_ASPECTS as readonly string[]).includes(aspect)) {
      return {
        kind: 'error',
        message: `Unknown aspect "${aspect}". Choose one of: ${CLI_ASPECTS.join(', ')}.`,
      };
    }
    job.aspect = aspect as CliAspect;
  }

  const captionsPath = flags.get('--captions');
  if (captionsPath !== undefined) job.captionsPath = captionsPath;

  const language = flags.get('--language');
  if (language !== undefined) {
    return { kind: 'error', message: '"--language" belongs to the "captions" command.' };
  }

  const dataPath = flags.get('--data');
  if (dataPath !== undefined) {
    // The check that separates a working batch from forty renders into one
    // file. An overwriting CLI plus a constant output name means the last row
    // wins and the other thirty-nine are gone, with nothing reported — so a
    // pattern with no token is refused before anything renders.
    if (!OUTPUT_TOKEN.test(job.outPath)) {
      return {
        kind: 'error',
        message: '"--data" renders one file per row, so --out needs a {token} that varies — '
          + 'a column name, or {index}. For example: --out "out/{index}-{name}.mp4".',
      };
    }
    job.dataPath = dataPath;

    const fromRow = flags.get('--from-row');
    if (fromRow !== undefined) {
      const n = frameIndex(fromRow);
      if (n === null || n < 1) {
        return { kind: 'error', message: `"--from-row" wants a row number from 1 (got "${fromRow}").` };
      }
      // The flag is 1-BASED because the log, the CSV and every spreadsheet are.
      job.startRow = n - 1;
    }
  } else if (flags.has('--from-row')) {
    return { kind: 'error', message: '"--from-row" only means something with --data.' };
  } else if (OUTPUT_TOKEN.test(job.outPath)) {
    return {
      kind: 'error',
      message: `"${job.outPath}" contains a {token}, which only means something with --data.`,
    };
  }

  return { kind: 'render', job, output };
}
