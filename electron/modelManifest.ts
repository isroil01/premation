/**
 * The ML model manifest (models.json): the one list of every model the engine
 * runs, with where each one lives.
 *
 * Kept free of Electron imports so engineHost.ts and the build scripts can
 * read the same facts the IPC installer (modelInstaller.ts) does:
 *
 *   <userData>/models/<id>/     the user's install (PREMATION_<env>_USER_DIR)
 *   <resources>/models/<id>/    the bundled copy, when `bundled` (PREMATION_<env>_DIR;
 *                               dist/models/<id> in development — scripts/fetchModels.cjs)
 *
 * The engine reads the user's folder first and the bundled one second, per
 * job, so an install or a removal applies to the next click.
 */

import * as path from 'node:path';
import manifest from './models.json';

export type ModelId = 'object-matte' | 'object-matte-gpu' | 'face-landmarks' | 'depth-anything' | 'hand-landmarks' | 'sam2-video' | 'vitmatte';

export interface ManifestFile {
  /** The file name on disk, the one the engine looks for. */
  name: string;
  /** The pinned download (`source: pinned`) or the default (`source: user`); null when the person must supply it. */
  url: string | null;
  /** Hex SHA-256 of the bytes, or null when none is known today (never invented). */
  sha256: string | null;
  /** The exact size, when known (progress totals before the first byte). */
  bytes: number | null;
  /** Without a checksum, the smallest size that could be the model. */
  minBytes?: number;
}

export interface ManifestModel {
  id: ModelId;
  /** The IPC channel prefix the renderer uses: `<ipc>:status` / `:install` / `:remove` / `:downloadProgress`. */
  ipc: string;
  /** PREMATION_<env>_USER_DIR / PREMATION_<env>_DIR, the engine's variables. */
  env: string;
  name: string;
  description: string;
  licence: string;
  /** Shipped in the installer (scripts/fetchModels.cjs stages it under public/models/<id>). */
  bundled: boolean;
  /** `pinned`: only the manifest's URLs + checksums are accepted. `user`: the install request carries the URLs. */
  source: 'pinned' | 'user';
  files: ManifestFile[];
}

export const MODELS: readonly ManifestModel[] = (manifest as { models: ManifestModel[] }).models;

export function modelById(id: ModelId): ManifestModel {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`models.json has no model '${id}'`);
  return m;
}

/** The user's install folder for `id`. */
export function modelUserDir(userData: string, id: ModelId): string {
  return path.join(userData, 'models', id);
}

export interface AppPaths {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}

/** The bundled copy's folder: <resources>/models/<id> packaged, dist/models/<id> in development. */
export function bundledModelDir(o: AppPaths, id: ModelId): string {
  return o.isPackaged ? path.join(o.resourcesPath, 'models', id) : path.join(o.appPath, 'dist', 'models', id);
}

/** The sum of the manifest's byte counts, or null when any file's size is unknown. */
export function manifestBytes(model: ManifestModel): number | null {
  let sum = 0;
  for (const f of model.files) {
    if (f.bytes === null) return null;
    sum += f.bytes;
  }
  return sum;
}

/**
 * The engine's variables for every bundled model's folder
 * (PREMATION_SAM_DIR, PREMATION_HAND_DIR, …). An explicit value in `vars`
 * wins — a developer pointing the engine at a model folder of their own.
 */
export function bundledModelEnv(o: AppPaths, vars: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const m of MODELS) {
    if (!m.bundled) continue;
    const key = `PREMATION_${m.env}_DIR`;
    env[key] = vars[key] ?? bundledModelDir(o, m.id);
  }
  return env;
}
