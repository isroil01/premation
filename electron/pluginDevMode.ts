/**
 * Plugin Developer Mode (docs/PLUGIN_SDK.md "Hot reload", W2): a plugin author points the editor at
 * their build output and sees each rebuild without restarting anything.
 *
 *  - Settings (`<native-plugins>/.dev.json`, per user, never the document): on/off and the dev
 *    folders — a bundle folder or a folder of bundles, e.g. `<plugin>/build/plugins`.
 *  - Launch: each dev folder is one more `--plugins`, and `--plugin-shadow <root>/<launch>` makes the
 *    engine load plugin binaries from copies, so the author's linker can overwrite the originals
 *    (Windows locks a loaded DLL). Each launch gets its own shadow folder; older ones are removed
 *    when nothing holds them any more.
 *  - Watch: a changed binary (.dll / .so / .dylib) or manifest under a dev folder names its bundle's
 *    plugin id; after the writes settle (a link writes the file more than once) the page is told,
 *    and it sends the engine `reloadPlugin` (src/core/nativePlugins/pluginStore.ts).
 */

import { existsSync, readFileSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface PluginDevSettings {
  enabled: boolean;
  /** Absolute folders: each a bundle (has premation-plugin.json) or a folder of bundles. */
  folders: string[];
}

const SETTINGS_FILE = '.dev.json';
const MAX_FOLDERS = 16;
const MANIFEST = 'premation-plugin.json';

export const defaultDevSettings = (): PluginDevSettings => ({ enabled: false, folders: [] });

/** Keep only what the settings may hold: a boolean and up to 16 distinct absolute folders. */
export function cleanDevSettings(raw: unknown): PluginDevSettings | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { enabled, folders } = raw as { enabled?: unknown; folders?: unknown };
  if (typeof enabled !== 'boolean' || !Array.isArray(folders)) return null;
  const out: string[] = [];
  for (const f of folders) {
    if (typeof f !== 'string' || !path.isAbsolute(f) || f.length > 1024) return null;
    const norm = path.resolve(f);
    if (!out.includes(norm)) out.push(norm);
  }
  return out.length > MAX_FOLDERS ? null : { enabled, folders: out };
}

export async function readDevSettings(dir: string): Promise<PluginDevSettings> {
  try {
    return cleanDevSettings(JSON.parse(await readFile(path.join(dir, SETTINGS_FILE), 'utf8'))) ?? defaultDevSettings();
  } catch {
    return defaultDevSettings();
  }
}

/** Temp file + rename: a crash never leaves half a settings file. */
export async function writeDevSettings(dir: string, s: PluginDevSettings): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, SETTINGS_FILE);
  await writeFile(`${file}.tmp`, JSON.stringify(s, null, 2));
  await rename(`${file}.tmp`, file);
}

/**
 * The engine arguments Developer Mode adds to a launch. `launchId` names this launch's shadow
 * folder under `shadowRoot`; folders of earlier launches are removed best-effort (one an engine
 * still has loaded stays until it is free).
 */
export async function devLaunchArgs(s: PluginDevSettings, shadowRoot: string, launchId: string): Promise<string[]> {
  if (!s.enabled) return [];
  const args: string[] = [];
  for (const f of s.folders) args.push('--plugins', f);
  try {
    for (const old of await readdir(shadowRoot)) {
      if (old !== launchId) await rm(path.join(shadowRoot, old), { recursive: true, force: true }).catch(() => undefined);
    }
  } catch {
    // no shadow folder yet
  }
  args.push('--plugin-shadow', path.join(shadowRoot, launchId));
  return args;
}

/** The bundle a changed file belongs to: the nearest folder (up to `root`) holding a manifest. */
export function bundleOf(file: string, root: string, exists: (p: string) => boolean = existsSync): string | null {
  let dir = path.dirname(file);
  const top = path.resolve(root);
  for (;;) {
    if (exists(path.join(dir, MANIFEST))) return dir;
    if (path.resolve(dir) === top) return null;
    const up = path.dirname(dir);
    if (up === dir || !path.resolve(up).startsWith(top)) return null;
    dir = up;
  }
}

const WATCHED = /(\.(dll|so|dylib)|premation-plugin\.json)$/i;

export interface DevWatcherDeps {
  /** fs.watch (recursive), injected for the test. */
  watch?: (folder: string, onChange: (file: string) => void) => { close(): void };
  /** The plugin id in a bundle's manifest (null when unreadable). */
  readId?: (bundleDir: string) => string | null;
  exists?: (p: string) => boolean;
  /** A dev plugin's build changed and has settled. */
  notify: (pluginId: string) => void;
  /** How long writes must stop before the reload (a link rewrites the binary several times). */
  settleMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

function defaultWatch(folder: string, onChange: (file: string) => void): { close(): void } {
  let w: FSWatcher | null = null;
  try {
    w = fsWatch(folder, { recursive: true }, (_event, name) => {
      if (name) onChange(path.join(folder, name.toString()));
    });
    w.on('error', () => undefined);  // a folder deleted under us: the watch just ends
  } catch {
    // a folder that does not exist (yet): nothing to watch
  }
  return { close: () => w?.close() };
}

function defaultReadId(bundleDir: string): string | null {
  try {
    const id = (JSON.parse(readFileSync(path.join(bundleDir, MANIFEST), 'utf8')) as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

/** Watches the dev folders; one `notify(id)` per settled rebuild. */
export class DevWatcher {
  private watchers: { close(): void }[] = [];
  private readonly timers = new Map<string, unknown>();

  constructor(private readonly deps: DevWatcherDeps) {}

  setFolders(folders: readonly string[]): void {
    this.close();
    const watch = this.deps.watch ?? defaultWatch;
    for (const root of folders) this.watchers.push(watch(root, (file) => this.changed(file, root)));
  }

  close(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    const clear = this.deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
    for (const t of this.timers.values()) clear(t);
    this.timers.clear();
  }

  private changed(file: string, root: string): void {
    if (!WATCHED.test(file)) return;
    const bundle = bundleOf(file, root, this.deps.exists);
    if (!bundle) return;
    const key = path.resolve(bundle);
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clear = this.deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
    const pending = this.timers.get(key);
    if (pending !== undefined) clear(pending);
    this.timers.set(key, set(() => {
      this.timers.delete(key);
      const id = (this.deps.readId ?? defaultReadId)(bundle);
      if (id) this.deps.notify(id);
    }, this.deps.settleMs ?? 800));
  }
}
