/**
 * Plugin Developer Mode, main side (electron/pluginDevMode.ts): settings are checked and written
 * safely, a launch adds the dev folders and its own shadow folder (older ones removed), and a
 * rebuild — however many writes the linker makes — becomes ONE reload of the right plugin.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bundleOf, cleanDevSettings, devLaunchArgs, DevWatcher, readDevSettings, writeDevSettings } from './pluginDevMode';
import { pluginDevHandlers } from './ipc/nativePlugins';

describe('plugin Developer Mode', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'plugin-dev-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps only valid settings', () => {
    const abs = path.resolve(root, 'a');
    expect(cleanDevSettings({ enabled: true, folders: [abs, abs] })).toEqual({ enabled: true, folders: [abs] });
    expect(cleanDevSettings({ enabled: true, folders: ['relative/path'] })).toBeNull();
    expect(cleanDevSettings({ enabled: 'yes', folders: [] })).toBeNull();
    expect(cleanDevSettings({ enabled: true, folders: Array.from({ length: 17 }, (_, i) => path.resolve(root, String(i))) })).toBeNull();
  });

  it('reads defaults when nothing is saved, and reads back what was written', async () => {
    expect(await readDevSettings(root)).toEqual({ enabled: false, folders: [] });
    const s = { enabled: true, folders: [path.resolve(root, 'build', 'plugins')] };
    await writeDevSettings(root, s);
    expect(await readDevSettings(root)).toEqual(s);
    expect(existsSync(path.join(root, '.dev.json.tmp'))).toBe(false);
  });

  it('a launch adds each dev folder and its own shadow folder; older shadow folders go', async () => {
    const shadow = path.join(root, 'shadow');
    mkdirSync(path.join(shadow, 'old-launch', 'com.x.y'), { recursive: true });
    const f = path.resolve(root, 'dev');
    expect(await devLaunchArgs({ enabled: false, folders: [f] }, shadow, 'l2')).toEqual([]);
    expect(await devLaunchArgs({ enabled: true, folders: [f] }, shadow, 'l2')).toEqual(['--plugins', f, '--plugin-shadow', path.join(shadow, 'l2')]);
    expect(existsSync(path.join(shadow, 'old-launch'))).toBe(false);
  });

  it('finds the bundle a changed file belongs to, never above the watched folder', () => {
    const watched = path.join(root, 'build', 'plugins');
    const bundle = path.join(watched, 'glow');
    mkdirSync(path.join(bundle, 'sub'), { recursive: true });
    writeFileSync(path.join(bundle, 'premation-plugin.json'), '{}');
    expect(bundleOf(path.join(bundle, 'glow.dll'), watched)).toBe(bundle);
    expect(bundleOf(path.join(bundle, 'sub', 'dep.dll'), watched)).toBe(bundle);
    writeFileSync(path.join(root, 'premation-plugin.json'), '{}');
    expect(bundleOf(path.join(watched, 'stray.dll'), watched)).toBeNull();
  });

  it('turns a burst of writes into one reload of that plugin', () => {
    const watched = path.join(root, 'plugins');
    const bundle = path.join(watched, 'glow');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(path.join(bundle, 'premation-plugin.json'), JSON.stringify({ id: 'com.you.glow' }));
    const timers: { fn: () => void; cancelled: boolean }[] = [];
    let emit: (file: string) => void = () => undefined;
    const notified: string[] = [];
    const w = new DevWatcher({
      watch: (_folder, onChange) => {
        emit = onChange;
        return { close: () => undefined };
      },
      notify: (id) => notified.push(id),
      setTimer: (fn) => {
        const t = { fn, cancelled: false };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        (t as { cancelled: boolean }).cancelled = true;
      },
    });
    w.setFolders([watched]);
    emit(path.join(bundle, 'glow.dll'));
    emit(path.join(bundle, 'glow.dll'));
    emit(path.join(bundle, 'glow.pdb'));  // not a binary or manifest: ignored
    emit(path.join(bundle, 'glow.dll'));
    const live = timers.filter((t) => !t.cancelled);
    expect(live).toHaveLength(1);
    live[0]!.fn();
    expect(notified).toEqual(['com.you.glow']);
    w.close();
  });

  it('saving changed folders restarts the engine; saving the same ones does not', async () => {
    const restarts: string[] = [];
    const watched: unknown[] = [];
    const h = pluginDevHandlers({
      dir: () => root,
      pickFolder: async () => null,
      restartEngine: (r) => restarts.push(r),
      watch: (s) => watched.push(s),
    });
    const f = path.resolve(root, 'dev');
    expect(await h.setSettings({ enabled: true, folders: [f] })).toEqual({ enabled: true, folders: [f] });
    expect(restarts).toHaveLength(1);
    await h.setSettings({ enabled: true, folders: [f] });
    expect(restarts).toHaveLength(1);
    expect(await h.setSettings({ enabled: 1, folders: [] })).toBeNull();
    expect(JSON.parse(readFileSync(path.join(root, '.dev.json'), 'utf8'))).toEqual({ enabled: true, folders: [f] });
    expect(watched).toHaveLength(2);
  });
});
