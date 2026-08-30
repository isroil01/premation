/**
 * The renderer half of `premation render` — open a project, render one
 * composition (or one per data row), write the files, report what happened.
 *
 * The whole editor is loaded around this: a hidden window, the real engine, the
 * real scene graph. That is not laziness, it is the requirement. The export
 * pipeline is a DOM pipeline — 20+ render-path modules touch `document`, the
 * texture provider builds HTMLImage/HTMLVideo elements, and page-loaded web
 * fonts are invisible to a worker's OffscreenCanvas — so a "pure Node" renderer
 * would produce different pixels from the preview for any comp with text. A
 * CLI that ships a file the editor would not have produced is worse than no CLI.
 * See `docs/AE_COMPARISON.md` §3 Tier 1b for the same argument about
 * multi-frame rendering.
 *
 * So: same `renderJobOutput` the Render Queue calls, same options builder, same
 * deterministic frame loop. The only thing this module adds is getting a
 * project open before it and files on disk after it.
 *
 * @see electron/cliRender.ts — the main-process half that drives this
 * @see electron/cliArgs.ts — argv → the request this takes
 * @see @core/template/batchRender — the one-render-per-row loop
 */

import { getProjectManager } from '@core/services/coreServices';
import { captureDocument } from '@core/api/cloudDocument';
import { findMissingAssets } from '@core/project/missingAssets';
import { renderJobOutput, outputExtFor, type OutputFormat, type RenderJobSpec } from '@core/export/renderJob';
import { renderStillFrame } from '@core/export/offlineRenderer';
import { useProjectStore, type CompositionSettings } from '@stores/projectStore';
import { useAssetStore } from '@stores/assetStore';
import { restoreBundleAssets } from '@core/assets/local/bundleAssetCollect';
import { compSizeOf } from '@core/composition/compSizes';
import { parseDataTable } from '@core/template/dataTable';
import { readAuthoredFields } from '@core/template/templateAuthoring';
import {
  renderDataRows,
  resolveOutputName,
  type BatchRenderSummary,
} from '@core/template/batchRender';
import { parseCaptions, toSrt, toVtt } from '@core/captions/captionFormat';
import { DEFAULT_CAPTION_STYLE, insertCaptionLayers, removeCaptionLayers } from '@core/captions/captionLayers';
import { transcribeComposition } from '@core/captions/transcribe';
import { ASPECT_PRESETS, autoReframeComposition, targetSizeFor } from '@core/reframe/autoReframe';

/** Formats the CLI can deliver. The queue's set, plus a single still frame. */
export type CliRenderFormat = OutputFormat | 'png';

/**
 * One `premation render` invocation, as the renderer sees it.
 *
 * Deliberately flat and JSON-shaped: it crosses an IPC boundary from the main
 * process, so it may hold nothing but data. Every size/rate field is an
 * OVERRIDE — absent means "whatever the composition says", which is what makes
 * the common invocation a project path and an output path.
 */
export interface HeadlessRenderRequest {
  /** Absolute path to a `.motion` bundle or a legacy single-file project. */
  projectPath: string;
  /** Composition id or name (case-insensitive). Absent: the project's first. */
  comp?: string;
  /**
   * Absolute path of the file to write. Its directory already exists — the
   * main process created it. With `data`, this is a PATTERN containing at
   * least one `{token}`.
   */
  outPath: string;
  format: CliRenderFormat;
  /** Inclusive frame range within the composition. Absent: the whole comp. */
  startFrame?: number;
  endFrame?: number;
  fps?: number;
  /** Uniform output scale (0.5 = half resolution). Ignored if width/height set. */
  scale?: number;
  width?: number;
  height?: number;
  quality?: 'high' | 'medium' | 'draft';
  proresProfile?: 'proxy' | 'lt' | '422' | 'hq' | '4444';
  /** Force an alpha channel on, regardless of the composition's own setting. */
  transparent?: boolean;
  /**
   * A CSV/JSON table, already read by the main process. Present turns this
   * into a batch: one file per row, each filled through the composition's
   * template fields.
   */
  data?: { text: string; filename: string };
  /** Start the batch at this row (0-based) — resuming an interrupted run. */
  startRow?: number;
  /**
   * Retarget to this aspect before rendering.
   *
   * The render then targets the composition auto-reframe CREATED, not the one
   * that was opened — which is the whole point of the `reframe` verb: a
   * vertical cut of an edit, in one command, without opening anything.
   */
  aspect?: string;
  /**
   * A caption file's TEXT, already read by the main process. Present replaces
   * any captions in the composition before the render, so a pipeline can burn
   * subtitles into a delivery without a person opening the project.
   */
  captions?: { text: string; filename: string };
}

export interface HeadlessRenderResult {
  outPath: string;
  compositionName: string;
  compositionId: string;
  frames: number;
  width: number;
  height: number;
  fps: number;
  /**
   * Non-fatal problems worth printing. Today: media the document points at
   * that this machine cannot resolve — which renders as a hole in the picture
   * rather than as a failure, and is therefore exactly the kind of thing a CI
   * log has to say out loud.
   */
  warnings: string[];
}

export interface HeadlessBatchResult {
  batch: {
    rendered: number;
    failed: number;
    rows: Array<{ outputPath: string; error?: string }>;
  };
  warnings: string[];
}

/** Progress 0–1, reported per frame (the caller decides how often to print). */
export type HeadlessProgress = (fraction: number) => void;

/**
 * Pick the composition to render.
 *
 * Id first, then an exact name, then a case-insensitive name — an id is
 * unambiguous, and a name typed at a shell is not going to match case. With no
 * selector, the first comp the user actually owns: a fresh document always
 * carries one auto-minted `pristine` comp (see `CompositionSettings.pristine`),
 * and rendering that instead of the real one would deliver an empty frame while
 * reporting success.
 */
export function resolveComposition(
  comps: Record<string, CompositionSettings>,
  selector?: string,
): CompositionSettings | null {
  const all = Object.values(comps);
  if (all.length === 0) return null;

  if (selector) {
    const byId = comps[selector];
    if (byId) return byId;
    const exact = all.find((c) => c.name === selector);
    if (exact) return exact;
    const lower = selector.toLowerCase();
    return all.find((c) => c.name.toLowerCase() === lower) ?? null;
  }

  return all.find((c) => !c.pristine) ?? all[0] ?? null;
}

/** Every composition in the open project, for `comps` and error text. */
export function describeCompositions(comps: Record<string, CompositionSettings>): string[] {
  return Object.values(comps).map(
    (c) => `${c.name}  (${c.width}×${c.height} @ ${c.fps}fps, ${c.durationSeconds.toFixed(2)}s, id ${c.id})`,
  );
}

/** Split an absolute path into the directory and the file name within it. */
function splitPath(full: string): { dir: string; name: string } {
  const cut = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'));
  return cut < 0 ? { dir: '.', name: full } : { dir: full.slice(0, cut), name: full.slice(cut + 1) };
}

/** The output size a request asks for, in composition terms. */
function outputSize(
  comp: CompositionSettings,
  req: HeadlessRenderRequest,
): { width: number; height: number } {
  if (req.width || req.height) {
    // One dimension given: keep the comp's aspect rather than squashing to a
    // square, which is what "render this vertically at 1080 wide" means.
    const aspect = comp.width / comp.height;
    const width = req.width ?? Math.round((req.height as number) * aspect);
    const height = req.height ?? Math.round((req.width as number) / aspect);
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }
  const scale = req.scale && req.scale > 0 ? req.scale : 1;
  return {
    width: Math.max(1, Math.round(comp.width * scale)),
    height: Math.max(1, Math.round(comp.height * scale)),
  };
}

/**
 * The inclusive frame range, in the seconds-based form the exporter wants.
 *
 * `endSec` is EXCLUSIVE — the same convention `exportRange` uses — and the
 * conversion is its exact inverse, so a `--range 0-23` renders 24 frames and
 * not 25. Getting this off by one is the bug the export path has already had
 * once (see `offlineParams`), and a CLI is where nobody would notice it.
 */
export function frameRangeToSeconds(
  startFrame: number,
  endFrame: number,
  fps: number,
): { rangeStartSec: number; rangeEndSec: number } {
  const start = Math.max(0, Math.floor(startFrame));
  const end = Math.max(start, Math.floor(endFrame));
  return { rangeStartSec: start / fps, rangeEndSec: (end + 1) / fps };
}

/** Write bytes to an absolute path through the desktop bridge. */
async function writeBytes(outPath: string, bytes: Uint8Array): Promise<void> {
  const write = window.motionEditor?.file?.writeBytes;
  if (!write) throw new Error('This build has no filesystem bridge, so it cannot write a file.');
  await write(outPath, bytes);
}

/** The render spec for one composition, minus where the file goes. */
function specFor(
  comp: CompositionSettings,
  req: HeadlessRenderRequest,
  fps: number,
  size: { width: number; height: number },
  outPath: string,
): RenderJobSpec {
  return {
    compositionName: comp.name,
    compositionId: comp.id,
    outputPath: outPath,
    format: req.format as OutputFormat,
    width: size.width,
    height: size.height,
    compWidth: comp.width,
    compHeight: comp.height,
    fps,
    durationSec: comp.durationSeconds,
    transparent: req.transparent ?? comp.transparent,
    background: comp.background,
    quality: req.quality ?? 'high',
    ...(req.proresProfile ? { proresProfile: req.proresProfile } : {}),
    ...(req.startFrame !== undefined || req.endFrame !== undefined
      ? frameRangeToSeconds(
          req.startFrame ?? 0,
          req.endFrame ?? Math.max(0, Math.round(comp.durationSeconds * fps) - 1),
          fps,
        )
      : {}),
  };
}

/**
 * Render the document AS IT IS NOW into `outPath`. Returns the frame count.
 *
 * The one funnel every CLI render passes through — single and per-row alike —
 * so the delivery rule (overwrite, exactly where you were told) cannot differ
 * between them.
 */
async function renderToPath(
  comp: CompositionSettings,
  req: HeadlessRenderRequest,
  fps: number,
  size: { width: number; height: number },
  outPath: string,
  onProgress: HeadlessProgress,
  signal: AbortSignal,
): Promise<number> {
  if (req.format === 'png') {
    // A still never reaches a sink: `renderStillFrame` is the same offline loop
    // bounded to one frame, which is what makes a CLI still and an exported
    // video frame identical.
    const blob = await renderStillFrame(
      {
        width: size.width,
        height: size.height,
        fps,
        durationSec: comp.durationSeconds,
        comp: {
          width: comp.width,
          height: comp.height,
          transparent: req.transparent ?? comp.transparent,
          background: comp.background,
          rootId: comp.id,
          compSizeOf,
        },
      },
      req.startFrame ?? 0,
    );
    if (!blob) throw new Error('The frame could not be encoded as a PNG.');
    await writeBytes(outPath, new Uint8Array(await blob.arrayBuffer()));
    onProgress(1);
    return 1;
  }

  const spec = specFor(comp, req, fps, size, outPath);
  const output = await renderJobOutput(spec, onProgress, signal);
  if (output.kind === 'paused') {
    // Unreachable — pausing needs an abort, and a CLI's only cancellation is
    // the process going away — but the union says it can happen, and a silent
    // `outPath` that was never written is the worst way to find out otherwise.
    throw new Error('The render paused unexpectedly and produced no file.');
  }

  const { dir, name } = splitPath(outPath);
  if (output.kind === 'blob') {
    await writeBytes(outPath, new Uint8Array(await output.blob.arrayBuffer()));
    return Math.max(
      1,
      Math.round((spec.rangeEndSec ?? comp.durationSeconds) * fps) - Math.round((spec.rangeStartSec ?? 0) * fps),
    );
  }

  // Overwriting, unlike the Render Queue: a queued render suffixing " (2)"
  // protects a file the user forgot about, but a CLI told exactly where to
  // write must land there — a build that renders to `out (7).mp4` on the
  // seventh CI run is a build whose artifact path is a guess.
  await output.saveTo(dir, name, true);
  return output.frames;
}

/** Open the project and report anything about it worth printing. */
async function openForRender(projectPath: string): Promise<string[]> {
  // AWAITED, where the editor fires this and forgets: the boot path can afford
  // for footage to pop in a moment late, and a render cannot. A frame
  // rasterised before its media hydrated is a frame with a hole in it, and the
  // export path would refuse it — correctly, but for a reason that would read
  // as "your project is broken" rather than "the CLI raced itself".
  await useAssetStore.getState().initialize();

  const ref = await getProjectManager().openPath(projectPath);
  if (!ref) throw new Error(`Could not open project "${projectPath}".`);

  // AWAITED here, where the editor fires it and forgets: on a machine that has
  // never seen this project there is no IndexedDB library at all, so the
  // bundle's own registry is the ONLY thing that can bind a layer whose stored
  // src died with the session that wrote it. Rendering before it lands is
  // rendering a hole.
  await restoreBundleAssets(ref.path);

  // Reported, never fatal. A document can legitimately reference footage this
  // machine does not have (a bundle rendered on a build agent), and the choice
  // between "render the rest" and "refuse" belongs to whoever reads the log —
  // but they can only make it if the log says so.
  return findMissingAssets(captureDocument()).map(
    (miss) => `Layer "${miss.nodeName}" points at media this machine cannot resolve (${miss.reason}): ${miss.src}`,
  );
}

/**
 * Everything that changes the DOCUMENT before a render: the caption import and
 * the retarget, in that order.
 *
 * Order matters and is not arbitrary. Captions go on first so that a retarget
 * carries them — auto-reframe places the source composition inside a new one as
 * an instance, so anything added afterwards would land in the wrapper and float
 * over the crop rather than inside it.
 *
 * Returns the composition the render should actually target.
 */
async function prepareComposition(
  req: HeadlessRenderRequest,
  warnings: string[],
): Promise<CompositionSettings> {
  let comp = requireComposition(req.comp);

  if (req.captions) {
    const cues = parseCaptions(req.captions.text);
    // Replacing, not adding — the same rule the editor's import follows. A
    // pipeline that re-runs would otherwise stack a second set of layers on
    // top of the first and deliver doubled text.
    removeCaptionLayers(comp.id);
    // TARGETED at the composition being rendered. Headless has no active tab to
    // speak of, and the store's fallback is a 1920×1080 default — which placed
    // captions off the bottom of any smaller frame, silently.
    const inserted = insertCaptionLayers(cues, DEFAULT_CAPTION_STYLE, {
      rootId: comp.id,
      width: comp.width,
      height: comp.height,
    });
    if (inserted.skipped > 0) {
      warnings.push(`${inserted.skipped} overlapping caption cue(s) were dropped.`);
    }
  }

  if (req.aspect) {
    const preset = ASPECT_PRESETS.find((a) => a.id === req.aspect);
    if (!preset) {
      throw new Error(
        `Unknown aspect "${req.aspect}". Choose one of: ${ASPECT_PRESETS.map((a) => a.id).join(', ')}.`,
      );
    }
    const result = await autoReframeComposition({
      sourceCompId: comp.id,
      target: targetSizeFor(comp, preset.ratio),
    });
    const reframed = useProjectStore.getState().comps[result.compId];
    if (!reframed) throw new Error('The reframed composition could not be read back.');
    comp = reframed;
  }

  return comp;
}

/** Resolve the composition named by the request, or explain what exists. */
function requireComposition(selector: string | undefined): CompositionSettings {
  const comps = useProjectStore.getState().comps;
  const comp = resolveComposition(comps, selector);
  if (comp) return comp;
  const known = describeCompositions(comps);
  throw new Error(
    selector
      ? `Composition "${selector}" not found. This project has:\n  ${known.join('\n  ')}`
      : 'This project has no compositions to render.',
  );
}

/**
 * Open `projectPath`, render one composition, write `outPath`.
 *
 * Throws with a message meant to be printed at a terminal — every failure here
 * ends up as the last line a CI log shows, so `Composition "Titles" not found`
 * beats a stack trace.
 */
export async function runHeadlessRender(
  req: HeadlessRenderRequest,
  onProgress: HeadlessProgress = () => undefined,
  signal?: AbortSignal,
): Promise<HeadlessRenderResult> {
  const warnings = await openForRender(req.projectPath);
  const comp = await prepareComposition(req, warnings);
  const fps = req.fps && req.fps > 0 ? req.fps : comp.fps;
  const size = outputSize(comp, req);

  const frames = await renderToPath(
    comp,
    req,
    fps,
    size,
    req.outPath,
    onProgress,
    signal ?? new AbortController().signal,
  );

  return {
    outPath: req.outPath,
    compositionName: comp.name,
    compositionId: comp.id,
    frames,
    width: size.width,
    height: size.height,
    fps,
    warnings,
  };
}

/**
 * Open `projectPath` and render one file per row of the request's data table.
 *
 * The loop, the fill and the put-the-template-back are `renderDataRows`; this
 * supplies the project, the composition, the naming and the delivery. A
 * template with no exposed fields fails here rather than rendering N identical
 * files — that is not a batch, it is the same render N times, and it is always
 * a mistake in the invocation rather than something the user wanted.
 */
export async function runHeadlessBatchRender(
  req: HeadlessRenderRequest & { data: { text: string; filename: string } },
  onProgress: HeadlessProgress = () => undefined,
  signal?: AbortSignal,
): Promise<HeadlessBatchResult> {
  const warnings = await openForRender(req.projectPath);
  const comp = await prepareComposition(req, warnings);
  const fps = req.fps && req.fps > 0 ? req.fps : comp.fps;
  const size = outputSize(comp, req);

  const table = parseDataTable(req.data.text, req.data.filename);
  if (table.rows.length === 0) throw new Error(`"${req.data.filename}" has no rows.`);

  const fields = readAuthoredFields(comp.id);
  if (fields.length === 0) {
    throw new Error(
      `Composition "${comp.name}" exposes no template fields, so there is nothing for the data to fill. `
      + 'Expose the layers you want driven by data first (Templates ▸ expose a layer as a field).',
    );
  }

  const summary: BatchRenderSummary = await renderDataRows({
    table,
    fields,
    ...(req.startRow !== undefined ? { startRow: req.startRow } : {}),
    namer: (row, index) => resolveOutputName(req.outPath, row, index, table.rows.length),
    renderRow: (outputPath, rowProgress, rowSignal) =>
      renderToPath(comp, req, fps, size, outputPath, rowProgress, rowSignal).then(() => undefined),
    onProgress,
    ...(signal ? { signal } : {}),
  });

  return {
    batch: {
      rendered: summary.rendered,
      failed: summary.failed,
      rows: summary.rows.map((r) => ({
        outputPath: r.outputPath,
        ...(r.error ? { error: r.error } : {}),
      })),
    },
    warnings,
  };
}

export interface HeadlessCaptionsResult {
  outPath: string;
  compositionName: string;
  cues: number;
  /** The caption file's contents, for the main process to write. */
  text: string;
  warnings: string[];
}

/**
 * Transcribe a composition and hand back a caption file.
 *
 * The renderer produces the TEXT and the main process writes it, rather than
 * the renderer writing through the file bridge — because the main process
 * already resolved and validated the output path, and a second place that
 * decides where a file goes is a second place for them to disagree.
 *
 * Format follows the extension: `.vtt` writes WebVTT, anything else SubRip.
 */
export async function runHeadlessCaptions(
  projectPath: string,
  outPath: string,
  compSelector?: string,
  language?: string,
): Promise<HeadlessCaptionsResult> {
  const warnings = await openForRender(projectPath);
  const comp = requireComposition(compSelector);

  const cues = await transcribeComposition({
    startSec: 0,
    endSec: comp.durationSeconds,
    rootId: comp.id,
    ...(language ? { language } : {}),
  });

  return {
    outPath,
    compositionName: comp.name,
    cues: cues.length,
    text: /\.vtt$/i.test(outPath) ? toVtt(cues) : toSrt(cues),
    warnings,
  };
}

/** Open a project and list its compositions, for `premation comps <project>`. */
export async function listProjectCompositions(projectPath: string): Promise<string[]> {
  const ref = await getProjectManager().openPath(projectPath);
  if (!ref) throw new Error(`Could not open project "${projectPath}".`);
  return describeCompositions(useProjectStore.getState().comps);
}

/** The extension a CLI format produces, for defaulting `--out`. */
export function cliOutputExt(format: CliRenderFormat): string {
  return format === 'png' ? 'png' : outputExtFor(format);
}
