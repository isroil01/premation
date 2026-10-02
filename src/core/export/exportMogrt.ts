/**
 * Premiere .mogrt foothold — Essential Graphics package as a zip of JSON.
 *
 * Real Adobe .mogrt is a proprietary zip (manifest + project binary). This
 * exporter writes an open interchange that Premiere cannot open natively, but
 * that Premation (and scripts) can re-import: template fields + document snapshot.
 * Filename uses `.mogrt.zip` so the intent is clear without claiming AME parity.
 */

import { zipBytes, type ZipEntry } from '@core/export/zip';
import { authoredFieldsOf } from '@core/mirror/templateFields';
import { documentMirror } from '@stores/documentMirror';
import { useProjectStore } from '@stores/projectStore';
import { liveDocument } from '@core/project/liveDocument';
import type { TemplateField } from '@core/template/templateTypes';

export interface MogrtPackage {
  format: 'premation-mogrt-v1';
  name: string;
  createdAt: string;
  fields: TemplateField[];
  /** Full editor document (same shape as File ▸ Export JSON). */
  document: unknown;
}

/** The composition in view (the active tab's), else the document's first. */
function activeComp(): string {
  const s = useProjectStore.getState();
  const id = s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined;
  const m = documentMirror();
  return id && m.comp(id) ? id : m.compIds[0] ?? '';
}

/** F2: the document is the owner's (the engine's exportDocument when it owns it). */
export async function buildMogrtPackage(name = 'Untitled'): Promise<MogrtPackage> {
  return {
    format: 'premation-mogrt-v1',
    name,
    createdAt: new Date().toISOString(),
    fields: authoredFieldsOf(documentMirror().comp(activeComp())?.settings),
    document: await liveDocument(),
  };
}

/** Zip bytes for download (manifest.json + package.json). */
export async function exportMogrtZip(name = 'Untitled'): Promise<Uint8Array> {
  const pkg = await buildMogrtPackage(name);
  const enc = new TextEncoder();
  const entries: ZipEntry[] = [
    {
      name: 'manifest.json',
      data: enc.encode(JSON.stringify({
        version: 1,
        type: 'premation-mogrt',
        name: pkg.name,
        fieldCount: pkg.fields.length,
      }, null, 2)),
    },
    { name: 'package.json', data: enc.encode(JSON.stringify(pkg, null, 2)) },
  ];
  return zipBytes(entries);
}
