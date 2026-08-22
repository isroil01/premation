/**
 * Premiere .mogrt foothold — Essential Graphics package as a zip of JSON.
 *
 * Real Adobe .mogrt is a proprietary zip (manifest + project binary). This
 * exporter writes an open interchange that Premiere cannot open natively, but
 * that Premation (and scripts) can re-import: template fields + document snapshot.
 * Filename uses `.mogrt.zip` so the intent is clear without claiming AME parity.
 */

import { zipBytes, type ZipEntry } from '@core/export/zip';
import { readAuthoredFields } from '@core/template/templateAuthoring';
import { captureDocument } from '@core/api/cloudDocument';
import type { TemplateField } from '@core/template/templateTypes';

export interface MogrtPackage {
  format: 'premation-mogrt-v1';
  name: string;
  createdAt: string;
  fields: TemplateField[];
  /** Full editor document (same shape as File ▸ Export JSON). */
  document: unknown;
}

export function buildMogrtPackage(name = 'Untitled'): MogrtPackage {
  return {
    format: 'premation-mogrt-v1',
    name,
    createdAt: new Date().toISOString(),
    fields: readAuthoredFields(),
    document: captureDocument(),
  };
}

/** Zip bytes for download (manifest.json + package.json). */
export function exportMogrtZip(name = 'Untitled'): Uint8Array {
  const pkg = buildMogrtPackage(name);
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
