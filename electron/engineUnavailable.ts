/**
 * What the app does when `premation-engine` cannot run (docs/TS_ENGINE_REMOVAL.md
 * "Flags removed at the end"). There is no other engine to fall back to:
 *
 *  - FATAL (missing executable, no usable GPU, protocol mismatch, spawn
 *    failure): a startup dialog naming the reason, then the app quits.
 *  - CRASH LOOP: a blocking "engine unavailable" dialog (modal on the editor
 *    window) that offers a recovery save — a copy of the engine's last
 *    autosave recovery file, wherever the user chooses — then Try Again (a
 *    fresh engine, main's command log replayed into it) or Quit.
 *
 * Everything Electron is injected, so engineUnavailable.test.ts drives it.
 */

import type { UnavailableInfo } from './engineSupervisor';

export interface EngineUnavailableDeps {
  showErrorBox(title: string, content: string): void;
  /** A modal message box; resolves with the index of the button pressed. */
  showMessageBox(options: { type: 'error'; title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number; noLink: true }): Promise<{ response: number }>;
  showSaveDialog(options: { title: string; defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<{ canceled: boolean; filePath?: string }>;
  /** The engine's autosave recovery file (EngineHostOptions.recoveryPath), or null. */
  recoveryPath: string | null;
  exists(p: string): boolean;
  copyFile(from: string, to: string): Promise<void>;
  retry(): Promise<void>;
  quit(): void;
  /** Where the recovery copy is offered by default (the user's documents folder). */
  defaultDir: string;
  joinPath(...parts: string[]): string;
}

export const ENGINE_UNAVAILABLE_BUTTONS = ['Save Recovery Copy…', 'Try Again', 'Quit'] as const;

/** Handle one `unavailable` report. Resolves once the user has chosen (fatal: at once). */
export async function handleEngineUnavailable(info: UnavailableInfo, d: EngineUnavailableDeps): Promise<'quit' | 'retry'> {
  if (info.fatal) {
    d.showErrorBox(
      'Premation cannot start',
      `The Premation engine could not start on this computer:\n\n${info.reason}\n\n`
      + 'Reinstalling Premation or updating the graphics driver usually fixes this.',
    );
    d.quit();
    return 'quit';
  }
  let saved = '';
  for (;;) {
    const hasRecovery = d.recoveryPath !== null && d.exists(d.recoveryPath);
    const { response } = await d.showMessageBox({
      type: 'error',
      title: 'Engine unavailable',
      message: 'The Premation engine keeps stopping. Editing is paused.',
      detail: `${info.reason}.\n\n`
        + (hasRecovery
          ? 'Save a recovery copy of your project (its last autosave) before trying again or quitting.'
          : 'No autosave of this project exists yet, so there is no recovery copy to save.')
        + (saved ? `\n\nRecovery copy saved to ${saved}` : ''),
      buttons: [...ENGINE_UNAVAILABLE_BUTTONS],
      defaultId: hasRecovery && !saved ? 0 : 1,
      cancelId: 2,
      noLink: true,
    });
    if (response === 1) {
      await d.retry();
      return 'retry';
    }
    if (response !== 0) {
      d.quit();
      return 'quit';
    }
    if (!hasRecovery || d.recoveryPath === null) continue;
    const pick = await d.showSaveDialog({
      title: 'Save Recovery Copy',
      defaultPath: d.joinPath(d.defaultDir, 'Recovered project.motion'),
      filters: [{ name: 'Motion Project', extensions: ['motion', 'json'] }],
    });
    if (pick.canceled || !pick.filePath) continue;
    try {
      await d.copyFile(d.recoveryPath, pick.filePath);
      saved = pick.filePath;
    } catch (e) {
      d.showErrorBox('Recovery copy not saved', e instanceof Error ? e.message : String(e));
    }
  }
}
