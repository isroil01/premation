/**
 * ShortcutManager — global keyboard shortcut dispatcher.
 *
 * The manager listens at the window level, normalizes events into KeyChord
 * objects, and asks CommandSystem to execute the matching command. It is
 * intentionally decoupled from React: components never register shortcuts
 * directly. Instead, commands declare their chord in metadata.
 *
 * Future: chord sequences (g g), context-sensitive bindings, and per-workspace
 * remapping. The current implementation is single-chord.
 */

import { chordFromEvent, getCommandSystem } from '@core/commands/CommandSystem';
import { getCommandRegistry, chordKey } from '@core/commands/Command';
import type { Disposable, KeyChord } from '@app-types/common';
import { asCommandId } from '@app-types/common';
import { getEventBus } from '@core/events/EventBus';
import { getShortcutOverrides, resolveChord } from '@core/commands/shortcutOverrides';

interface ShortcutBinding {
  chord: KeyChord;
  commandId: string;
  /** When true, propagation stops and the browser default is prevented. */
  preventDefault: boolean;
  /** Optional textual description (for help / cheat sheet UI). */
  description?: string;
}

export class ShortcutManager {
  private readonly bindings: ShortcutBinding[] = [];
  private attached = false;

  constructor() {
    // Auto-attach on first instantiation. In tests, call attach() manually.
    this.attach();
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener('keydown', this.onKeyDown, { capture: true } as EventListenerOptions);
  }

  /**
   * Add a binding. The commandId is resolved at key-down time, so a binding
   * can point to a command registered later.
   */
  add(binding: ShortcutBinding): Disposable {
    this.bindings.push(binding);
    return {
      dispose: () => {
        const i = this.bindings.indexOf(binding);
        if (i >= 0) this.bindings.splice(i, 1);
      },
    };
  }

  /** All currently registered bindings — used by the help / shortcuts UI. */
  all(): ReadonlyArray<ShortcutBinding> {
    return this.bindings;
  }

  /** Re-scan commands in the registry and re-bind them, applying the user's
   *  persisted overrides (rebind / disable) over each command's default chord. */
  rehydrateFromRegistry(): void {
    this.bindings.length = 0;
    const overrides = getShortcutOverrides();
    for (const cmd of getCommandRegistry().all()) {
      const chord = resolveChord(cmd.id as unknown as string, cmd.shortcut, overrides);
      if (!chord) continue; // no default and no override, or override = disabled
      this.add({
        chord,
        commandId: cmd.id as unknown as string,
        preventDefault: true,
        description: cmd.description ?? cmd.label,
      });
    }
  }

  /** Re-apply overrides after the user edits shortcuts (same as rehydrate). */
  applyOverrides(): void {
    this.rehydrateFromRegistry();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Ignore when focus is in editable text. We can't tell perfectly, but
    // common form elements are a strong signal.
    const t = e.target as HTMLElement | null;
    if (t && this.isEditable(t)) return;

    const chord = chordFromEvent(e);
    const key = chordKey(chord);

    // Exact match only. Order = most recently added first, so user overrides win.
    for (let i = this.bindings.length - 1; i >= 0; i--) {
      const b = this.bindings[i];
      if (!b) continue;
      if (chordKey(b.chord) !== key) continue;
      if (b.preventDefault) e.preventDefault();
      e.stopPropagation();
      // Dispatch by commandId (not chord) so rebound shortcuts resolve even
      // when the registry still holds the command's original chord.
      void getCommandSystem().execute(asCommandId(b.commandId));
      getEventBus().emit('WorkspaceFocused', { workspaceId: 'global' });
      return;
    }
  };

  private isEditable(el: HTMLElement): boolean {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }
}

let shortcutInstance: ShortcutManager | null = null;

export function getShortcutManager(): ShortcutManager {
  if (!shortcutInstance) shortcutInstance = new ShortcutManager();
  return shortcutInstance;
}

export function setShortcutManager(s: ShortcutManager): void {
  shortcutInstance = s;
}
