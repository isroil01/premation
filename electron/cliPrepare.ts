/**
 * The document half of the CLI, in the ENGINE: `premation-engine --prepare
 * JOB.json` (native/engine/src/cli_prepare.hpp) opens the project, lists its
 * compositions, runs the reframe or transcription job, and saves a copy for
 * `--export` to render. No window, no TypeScript engine.
 *
 * Electron-free: the spawn and the file system are injected (cliPrepare.test.ts
 * drives it with a fake engine, and against the real one when it is built).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface PrepareRequest {
  projectPath: string;
  /** Composition id or name; absent = the first real one. */
  comp?: string;
  listComps?: boolean;
  /** Retarget to width : height = `ratio` (a new composition, the autoReframe job). */
  reframe?: { ratio: number };
  /** Transcribe the composition's sound with the user's speech provider. */
  transcribe?: { language?: string; provider: string; credential?: string };
  /** Save the (edited) document here for `--export`. */
  saveTo?: string;
}

export interface PreparedComp {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  pristine: boolean;
}

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

export interface PrepareResult {
  /** The composition a render should target (the reframed one after a reframe). */
  comp: string;
  comps?: PreparedComp[];
  cues?: CaptionCue[];
  compName?: string;
  reframed?: { comp: string; width: number; height: number };
  saved?: string;
}

export type PrepareOutcome = { ok: true; result: PrepareResult } | { ok: false; message: string };

export interface PrepareDeps {
  enginePath: string | null;
  /** A fresh directory for the job file. */
  workDir: string;
  spawn?: typeof nodeSpawn;
  fs?: { mkdir(p: string): Promise<void>; writeFile(p: string, text: string): Promise<void> };
}

/** The five shapes `reframe` accepts, as width : height. Same words and ratios as the editor's ASPECT_PRESETS. */
export const ASPECT_RATIOS: Readonly<Record<string, number>> = {
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
  '16:9': 16 / 9,
  '4:3': 4 / 3,
};

/** `premation comps`' line for one composition. */
export function describeComposition(c: PreparedComp): string {
  return `${c.name}  (${c.width}×${c.height} @ ${c.fps}fps, ${c.durationSeconds.toFixed(2)}s, id ${c.id})`;
}

/** `HH:MM:SS,mmm` (SubRip) or `HH:MM:SS.mmm` (WebVTT) — captionFormat.ts formatTimestamp. */
export function formatTimestamp(seconds: number, separator: ',' | '.'): string {
  const clamped = Math.max(0, seconds);
  const whole = Math.floor(clamped);
  const millis = Math.round((clamped - whole) * 1000);
  const carry = millis === 1000 ? 1 : 0;
  const total = whole + carry;
  const ms = carry ? 0 : millis;
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}${separator}${String(ms).padStart(3, '0')}`;
}

/** The caption file for `outPath`: WebVTT for `.vtt`, SubRip otherwise (captionFormat.ts toSrt / toVtt). */
export function formatCaptions(cues: readonly CaptionCue[], outPath: string): string {
  if (/\.vtt$/i.test(outPath)) {
    const body = cues.map((c) => `${formatTimestamp(c.start, '.')} --> ${formatTimestamp(c.end, '.')}\n${c.text}\n`).join('\n');
    return `WEBVTT\n\n${body}`;
  }
  return cues.map((c, i) => `${i + 1}\n${formatTimestamp(c.start, ',')} --> ${formatTimestamp(c.end, ',')}\n${c.text}\n`).join('\n');
}

const defaultFs: NonNullable<PrepareDeps['fs']> = {
  mkdir: async (p) => { await mkdir(p, { recursive: true }); },
  writeFile: (p, text) => writeFile(p, text, 'utf8'),
};

function asComp(v: unknown): PreparedComp | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  const n = (k: string): number => (typeof o[k] === 'number' ? (o[k] as number) : 0);
  return { id: o.id, name: typeof o.name === 'string' ? o.name : o.id, width: n('width'), height: n('height'), fps: n('fps'), durationSeconds: n('durationSeconds'), pristine: o.pristine === true };
}

function asCue(v: unknown): CaptionCue | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.start !== 'number' || typeof o.end !== 'number' || typeof o.text !== 'string') return null;
  return { start: o.start, end: o.end, text: o.text };
}

/** Run one prepare job in the engine. Never rejects. */
export async function runEnginePrepare(req: PrepareRequest, deps: PrepareDeps): Promise<PrepareOutcome> {
  if (!deps.enginePath) return { ok: false, message: 'premation-engine is not available (reinstall Premation).' };
  const fs = deps.fs ?? defaultFs;
  const jobPath = path.join(deps.workDir, 'prepare.json');
  try {
    await fs.mkdir(deps.workDir);
    await fs.writeFile(jobPath, JSON.stringify(req));
  } catch (e) {
    return { ok: false, message: `The prepare job could not be written: ${(e as Error).message}` };
  }
  return new Promise<PrepareOutcome>((resolve) => {
    let proc: ReturnType<typeof nodeSpawn>;
    try {
      proc = (deps.spawn ?? nodeSpawn)(deps.enginePath!, ['--prepare', jobPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ ok: false, message: `premation-engine could not start: ${(e as Error).message}` });
      return;
    }
    const result: PrepareResult = { comp: '' };
    let done = false;
    let error: string | null = null;
    let buffered = '';
    let stderrTail = '';
    const onLine = (line: string): void => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (msg.ev) {
        case 'comps':
          result.comps = (Array.isArray(msg.comps) ? msg.comps : []).map(asComp).filter((c): c is PreparedComp => c !== null);
          return;
        case 'cues':
          result.cues = (Array.isArray(msg.cues) ? msg.cues : []).map(asCue).filter((c): c is CaptionCue => c !== null);
          if (typeof msg.compName === 'string') result.compName = msg.compName;
          return;
        case 'reframed':
          result.reframed = { comp: String(msg.comp ?? ''), width: Number(msg.width) || 0, height: Number(msg.height) || 0 };
          return;
        case 'saved':
          result.saved = String(msg.path ?? '');
          return;
        case 'done':
          result.comp = String(msg.comp ?? '');
          done = true;
          return;
        case 'error':
          error = String(msg.message ?? 'the engine could not prepare this job');
          return;
        default:
      }
    };
    proc.stdout?.on('data', (d: Buffer) => {
      buffered += String(d);
      let nl = buffered.indexOf('\n');
      while (nl >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (line) onLine(line);
        nl = buffered.indexOf('\n');
      }
    });
    proc.stderr?.on('data', (d: Buffer) => { stderrTail = (stderrTail + String(d)).slice(-2000); });
    proc.once('error', (e) => resolve({ ok: false, message: `premation-engine could not start: ${e.message}` }));
    proc.once('close', (code) => {
      if (buffered.trim()) onLine(buffered.trim());
      if (error) resolve({ ok: false, message: error });
      else if (code === 0 && done) resolve({ ok: true, result });
      else resolve({ ok: false, message: `premation-engine stopped unexpectedly (exit code ${code})${stderrTail ? `: ${stderrTail.slice(-300)}` : ''}` });
    });
  });
}
