/**
 * "Open this After Effects project" — the one entry point every surface uses.
 *
 * The File menu, a drag onto the canvas and the CLI all want the same six
 * steps in the same order, and each one getting them slightly differently is
 * how an importer ends up with three subtly different behaviours. So they all
 * call `importAepBytes`:
 *
 *     bytes → chunk tree → AepProject → plan → the live scene → a report
 *
 * The first step is the only one that branches: an `.aep` is RIFX and an
 * `.aepx` is XML, and both produce the identical chunk tree. Everything after
 * that is unaware of which file it came from.
 *
 * ## Importing REPLACES, it does not merge
 *
 * An AE project is a whole document — its own comps, its own footage, its own
 * folder tree — and merging one into whatever the user already has open would
 * produce a project belonging to neither. So the caller is expected to have a
 * fresh document ready (the menu command starts one), and this adds the
 * imported comps to it. That is also what makes the undo story simple: one
 * import is one document.
 */

import { AepParseError, parseRifx, type AepChunk } from './riff';
import { parseAepx } from './aepx';
import { readAepProject } from './aepRead';
import { planAepImport, type AepImportPlan } from './aepPlan';
import { applyAepPlan, type AepApplyResult } from './aepApply';
import type { AepProject } from './aepModel';

/** File names this importer claims. */
export const AEP_EXTENSIONS = ['aep', 'aepx'] as const;

export function isAepFileName(name: string): boolean {
  return /\.(aep|aepx)$/i.test(name);
}

const isXmlName = (name: string): boolean => /\.aepx$/i.test(name);

/** Does this look like XML rather than RIFX, whatever the name says? */
function looksLikeXml(bytes: Uint8Array): boolean {
  // Skip a UTF-8 BOM and any leading whitespace, then check for `<`.
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i += 1;
  return bytes[i] === 0x3c;
}

const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

/**
 * Bytes → chunk tree, picking the reader by CONTENT first and name second.
 *
 * People rename these files. An `.aep` that is really XML (saved as a copy and
 * renamed) and an `.aepx` that is really binary both turn up, and sniffing the
 * first byte costs nothing and makes the name advisory.
 */
export function parseAepBytes(bytes: Uint8Array, fileName = ''): AepChunk {
  if (looksLikeXml(bytes)) {
    if (!decoder) throw new AepParseError('this build cannot read XML projects');
    return parseAepx(decoder.decode(bytes));
  }
  if (isXmlName(fileName) && !looksLikeXml(bytes)) {
    // Named .aepx but binary — fall through to RIFX rather than refusing.
  }
  return parseRifx(bytes);
}

export interface AepImportResult {
  ok: true;
  project: AepProject;
  plan: AepImportPlan;
  applied: AepApplyResult;
}

export interface AepImportFailure {
  ok: false;
  message: string;
}

/**
 * Read an AE project and build it in the editor.
 *
 * Never throws for a bad file: a project the user picked being unreadable is a
 * message, not a crash. It DOES let a genuine programming error through, which
 * is the distinction worth keeping — `AepParseError` means "this file", and
 * anything else means "this code".
 */
export async function importAepBytes(
  bytes: Uint8Array,
  fileName = '',
): Promise<AepImportResult | AepImportFailure> {
  let tree: AepChunk;
  try {
    tree = parseAepBytes(bytes, fileName);
  } catch (err) {
    if (err instanceof AepParseError) return { ok: false, message: err.message };
    throw err;
  }

  const project = readAepProject(tree);
  if (project.comps.length === 0) {
    return {
      ok: false,
      message:
        'That After Effects project has no compositions in it. Only its footage list could be read, so there is nothing to open.',
    };
  }

  const plan = planAepImport(project);
  const applied = await applyAepPlan(plan);
  return { ok: true, project, plan, applied };
}

/** The same, from a `File` — what a file input and a drop both hand over. */
export async function importAepFile(file: File): Promise<AepImportResult | AepImportFailure> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { ok: false, message: `"${file.name}" could not be read.` };
  }
  return importAepBytes(bytes, file.name);
}

/**
 * The same, from a path — the desktop build's File ▸ Open route.
 *
 * Returns a failure rather than throwing when the build has no disk access, so
 * the browser build's menu can call it and get a sensible message instead of a
 * stack trace.
 */
export async function importAepPath(path: string): Promise<AepImportResult | AepImportFailure> {
  const read = typeof window !== 'undefined' ? window.motionEditor?.file?.readBytes : undefined;
  if (!read) return { ok: false, message: 'Opening a project from a path needs the desktop app.' };
  let bytes: Uint8Array | null = null;
  try {
    bytes = await read(path);
  } catch {
    bytes = null;
  }
  if (!bytes || bytes.byteLength === 0) return { ok: false, message: `"${path}" could not be read.` };
  return importAepBytes(bytes, path);
}

/**
 * A one-line summary of what came across.
 *
 * Deliberately says what was IMPORTED rather than what succeeded: "4
 * compositions, 61 layers, 892 keyframes" is checkable against the AE project
 * sitting next to it, which "imported successfully" is not.
 */
export function summarizeAepImport(result: AepImportResult): string {
  const s = result.plan.summary;
  const parts = [
    `${s.comps} composition${s.comps === 1 ? '' : 's'}`,
    `${s.layers} layer${s.layers === 1 ? '' : 's'}`,
  ];
  if (s.keyframes > 0) parts.push(`${s.keyframes} keyframes`);
  if (s.effects > 0) parts.push(`${s.effects} effect${s.effects === 1 ? '' : 's'}`);
  if (s.masks > 0) parts.push(`${s.masks} mask${s.masks === 1 ? '' : 's'}`);
  return parts.join(', ');
}
