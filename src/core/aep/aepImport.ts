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

import type { AepImportSummary, EngineClient } from '@motion/engine-api';

/** File names this importer claims. */
export const AEP_EXTENSIONS = ['aep', 'aepx'] as const;

export function isAepFileName(name: string): boolean {
  return /\.(aep|aepx)$/i.test(name);
}

export interface AepImportFailure {
  ok: false;
  message: string;
}

/** What the ENGINE's `importProject` of an `.aep` answered (the C++ engine converts it itself: core/aep). */
export interface EngineAepImport {
  ok: true;
  summary: AepImportSummary;
  warnings: string[];
  missingFootage: string[];
  openComp?: string;
}

/**
 * Import an After Effects project through the engine that owns the document
 * (`importProject{path}`: read, planned and applied in the engine — one undo
 * entry). Null when this engine does not convert `.aep` (the TypeScript
 * engine answers `unsupported`: the page importer above runs instead).
 */
export async function importAepThroughEngine(
  client: EngineClient,
  path: string,
): Promise<EngineAepImport | AepImportFailure | null> {
  const res = await client.execute({ type: 'importProject', path });
  if (!res.ok) {
    if (res.error.code === 'unsupported') return null;
    return { ok: false, message: res.error.message };
  }
  const r = res.value;
  if (!r.summary) return null;
  return {
    ok: true,
    summary: r.summary,
    warnings: r.warnings,
    missingFootage: r.missingFootage,
    ...(r.openComp ? { openComp: r.openComp } : {}),
  };
}

/** summarizeAepImport over the engine's counts. */
export function summarizeEngineAepImport(result: EngineAepImport): string {
  const s = result.summary;
  const parts = [
    `${s.comps} composition${s.comps === 1 ? '' : 's'}`,
    `${s.layers} layer${s.layers === 1 ? '' : 's'}`,
  ];
  if (s.keyframes > 0) parts.push(`${s.keyframes} keyframes`);
  if (s.effects > 0) parts.push(`${s.effects} effect${s.effects === 1 ? '' : 's'}`);
  if (s.masks > 0) parts.push(`${s.masks} mask${s.masks === 1 ? '' : 's'}`);
  return parts.join(', ');
}
