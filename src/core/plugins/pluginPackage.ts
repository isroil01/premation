/**
 * Reading a plugin package — the only thing that turns bytes on disk into
 * something installable.
 *
 * Two shapes are accepted because they are the two shapes that actually exist:
 * a **`.zip`/`.mplugin` archive** (what a user downloads) and a **folder** (what
 * an author is working in). Both reduce to the same thing: a map of
 * package-relative paths to text, with `plugin.json` at the root.
 *
 * Nothing here executes anything. The manifest is parsed and validated first,
 * precisely so the manager can show the user what a package claims and what it
 * wants BEFORE any of its code is handed to a sandbox.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { parseManifest, type PluginManifest } from './manifest';

/** A plugin package that parsed and validated. */
export interface PluginPackage {
  manifest: PluginManifest;
  /** Package-relative path → file text. Entry module and panel included. */
  files: Record<string, string>;
}

export interface PackageResult {
  pkg: PluginPackage | null;
  errors: string[];
}

/**
 * Per-file and total size ceilings.
 *
 * A plugin is source code, not an asset library — a package in the megabytes is
 * either a mistake or an attempt to fill the user's storage quota, and installed
 * packages are persisted, so the ceiling is what keeps a bad one from taking the
 * whole `localStorage` budget with it.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 200;

/** Text extensions a package may contain. Anything else is dropped. */
const TEXT_EXT = /\.(js|mjs|json|html|htm|css|svg|txt|md)$/i;

const MANIFEST_NAME = 'plugin.json';

/** Normalise a zip/dir entry path: forward slashes, no leading `./`. */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Strip the single wrapping directory a zip usually has.
 *
 * Zipping a folder produces `my-plugin/plugin.json`, not `plugin.json`, and
 * refusing that would fail for the most ordinary way of producing a package.
 * Only stripped when EVERY entry shares the prefix, so a flat archive and a
 * multi-folder one are both left alone.
 */
function stripCommonRoot(files: Record<string, string>): Record<string, string> {
  const paths = Object.keys(files);
  if (paths.length === 0 || paths.includes(MANIFEST_NAME)) return files;
  const first = paths[0]!.split('/')[0];
  if (!first || !paths.every((p) => p.startsWith(`${first}/`))) return files;
  const out: Record<string, string> = {};
  for (const [p, v] of Object.entries(files)) out[p.slice(first.length + 1)] = v;
  return out;
}

/** Validate a raw path→text map as a package. Shared by both entry points. */
export function readPluginFiles(rawFiles: Record<string, string>): PackageResult {
  const files = stripCommonRoot(rawFiles);
  const manifestText = files[MANIFEST_NAME];
  if (manifestText === undefined) {
    return {
      pkg: null,
      errors: [`No ${MANIFEST_NAME} found at the root of the package.`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch (err) {
    return { pkg: null, errors: [`${MANIFEST_NAME} is not valid JSON: ${(err as Error).message}`] };
  }

  const { manifest, errors } = parseManifest(parsed);
  if (!manifest) return { pkg: null, errors };

  const main = normalize(manifest.main);
  if (files[main] === undefined) {
    return { pkg: null, errors: [`"main" points at ${manifest.main}, which is not in the package.`] };
  }
  if (manifest.panel !== undefined && files[normalize(manifest.panel)] === undefined) {
    return { pkg: null, errors: [`"panel" points at ${manifest.panel}, which is not in the package.`] };
  }

  return { pkg: { manifest, files }, errors: [] };
}

/** Read a `.zip` / `.mplugin` archive. Never throws. */
export function readPluginZip(bytes: Uint8Array): PackageResult {
  if (bytes.byteLength > MAX_PACKAGE_BYTES) {
    return { pkg: null, errors: [`Package is larger than ${Math.round(MAX_PACKAGE_BYTES / 1024 / 1024)} MB.`] };
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    return { pkg: null, errors: [`Could not read the archive: ${(err as Error).message}`] };
  }

  const files: Record<string, string> = {};
  let total = 0;
  let count = 0;
  for (const [rawPath, data] of Object.entries(entries)) {
    const path = normalize(rawPath);
    if (path.endsWith('/')) continue; // directory entry
    if (path.split('/').includes('..')) continue; // zip-slip
    if (path.split('/').some((s) => s.startsWith('__MACOSX') || s === '.DS_Store')) continue;
    if (path !== MANIFEST_NAME && !TEXT_EXT.test(path)) continue;
    if (data.byteLength > MAX_FILE_BYTES) {
      return { pkg: null, errors: [`${path} is larger than ${Math.round(MAX_FILE_BYTES / 1024)} KB.`] };
    }
    total += data.byteLength;
    count += 1;
    if (total > MAX_PACKAGE_BYTES) {
      return { pkg: null, errors: [`Package is larger than ${Math.round(MAX_PACKAGE_BYTES / 1024 / 1024)} MB.`] };
    }
    if (count > MAX_FILES) return { pkg: null, errors: [`Package contains more than ${MAX_FILES} files.`] };
    files[path] = strFromU8(data);
  }
  return readPluginFiles(files);
}

/**
 * Read the `FileList` from a folder picker (`<input webkitdirectory>`).
 *
 * The browser hands back every file with a `webkitRelativePath` rooted at the
 * chosen folder, which is exactly the "single wrapping directory" case above.
 */
export async function readPluginFolder(fileList: readonly File[]): Promise<PackageResult> {
  if (fileList.length === 0) return { pkg: null, errors: ['That folder is empty.'] };
  if (fileList.length > MAX_FILES) return { pkg: null, errors: [`Folder contains more than ${MAX_FILES} files.`] };

  const files: Record<string, string> = {};
  let total = 0;
  for (const f of fileList) {
    const rel = normalize((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
    if (rel.split('/').includes('..')) continue;
    if (rel.endsWith('.DS_Store')) continue;
    const base = rel.split('/').pop() ?? rel;
    if (base !== MANIFEST_NAME && !TEXT_EXT.test(base)) continue;
    if (f.size > MAX_FILE_BYTES) return { pkg: null, errors: [`${rel} is larger than ${Math.round(MAX_FILE_BYTES / 1024)} KB.`] };
    total += f.size;
    if (total > MAX_PACKAGE_BYTES) {
      return { pkg: null, errors: [`Folder is larger than ${Math.round(MAX_PACKAGE_BYTES / 1024 / 1024)} MB.`] };
    }
    files[rel] = await f.text();
  }
  return readPluginFiles(files);
}

/** Route a picked file by extension. Zip magic is checked, not trusted from the name. */
export async function readPluginFile(file: File): Promise<PackageResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"
  if (isZip) return readPluginZip(bytes);
  return {
    pkg: null,
    errors: [
      `“${file.name}” is not a plugin package. A package is a .zip (or .mplugin) archive containing plugin.json — or pick the plugin's folder instead.`,
    ],
  };
}
