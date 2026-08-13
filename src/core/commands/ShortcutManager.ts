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
    // Auto-attach on first instantiation. In tests, call attach manually.
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

  private readonly DOUBLE_TAP_MS = 400;
  private lastKey = '';
  private lastKeyTime = 0;

  private onKeyDown = (e: KeyboardEvent): void => {
    // Ignore when focus is in editable text. We can't tell perfectly, but
    // common form elements are a strong signal.
    const t = e.target as HTMLElement | null;
    if (t && this.isEditable(t)) return;

    const chord = chordFromEvent(e);
    const key = chordKey(chord);

    // A focused surface may CLAIM particular chords — see `isClaimed`.
    if (t && this.isClaimed(t, key)) return;

    // ── Double-tap UU = Reveal Modified Properties (AE exact) ─────────────
    // Single U dispatches 'timeline.revealAnimated' via the registry binding.
    // A second U within DOUBLE_TAP_MS upgrades to 'timeline.revealModified'.
    const now = Date.now();
    if (
      chord.key === 'u' &&
      !chord.ctrl && !chord.meta && !chord.alt && !chord.shift &&
      this.lastKey === key &&
      now - this.lastKeyTime < this.DOUBLE_TAP_MS
    ) {
      this.lastKey = '';
      this.lastKeyTime = 0;
      if (this.isCommandEnabled('timeline.revealModified')) {
        e.preventDefault();
        e.stopPropagation();
        void getCommandSystem().execute(asCommandId('timeline.revealModified'));
        getEventBus().emit('WorkspaceFocused', { workspaceId: 'global' });
        return;
      }
    }
    this.lastKey = key;
    this.lastKeyTime = now;

    // Exact match only. Order = most recently added first, so user overrides win.
    for (let i = this.bindings.length - 1; i >= 0; i--) {
      const b = this.bindings[i];
      if (!b) continue;
      if (chordKey(b.chord) !== key) continue;
      // Only consume the event when the command can actually run — a disabled
      // command must let the chord fall through to other handlers (e.g. Escape
      // closing a menu instead of being eaten by a no-op deselect).
      if (!this.isCommandEnabled(b.commandId)) continue;
      if (b.preventDefault) e.preventDefault();
      e.stopPropagation();
      // Dispatch by commandId (not chord) so rebound shortcuts resolve even
      // when the registry still holds the command's original chord.
      void getCommandSystem().execute(asCommandId(b.commandId));
      getEventBus().emit('WorkspaceFocused', { workspaceId: 'global' });
      return;
    }
  };

  private isCommandEnabled(commandId: string): boolean {
    try {
      const cmd = getCommandRegistry().get(asCommandId(commandId));
      if (!cmd) return false;
      return cmd.enabled ? cmd.enabled() !== false : true;
    } catch {
      // A throwing enabled must not kill the dispatcher — treat as enabled.
      return true;
    }
  }

  private isClaimed(el: HTMLElement, key: string): boolean {
    return claimsChord(el, key);
  }

  private isEditable(el: HTMLElement): boolean {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }
}

/**
 * Does a focused surface claim this chord for itself?
 *
 * WHY THIS EXISTS. `ShortcutManager` listens on `window` in the CAPTURE phase
 * and calls `stopPropagation()` whenever a binding matches, so a global chord
 * reaches its command before any panel's own handler is offered the event at
 * all. That is right for most of them — Space should play from wherever you
 * are — but it silently breaks the chords whose meaning depends on what has
 * focus. Delete is the case that forced this: it is bound to "delete the
 * selected LAYERS", so the Assets panel could not implement Delete for a
 * selection of files. Its handler was correct and simply never ran, which is
 * the worst shape of bug this codebase keeps finding — code that reads right,
 * ships, and does nothing.
 *
 * The escape hatch that already existed, `isEditable`, is all-or-nothing and
 * covers only form elements. This is deliberately the narrow version: a
 * surface names the chords it wants, as `data-shortcut-claim` on any ancestor
 * of the focused element, and every OTHER chord still reaches the global
 * command. A surface that opted out of everything would be one where Space
 * stops playing, which is why claiming is per-chord rather than a boolean.
 *
 *   <div tabIndex={0} data-shortcut-claim="delete backspace Ctrl+a Meta+a">
 *
 * Values are `chordKey` strings, matched case-insensitively so a claim cannot
 * fail on a capital letter. Exported — and pure — so the behaviour is testable
 * without standing up the window listener that made it hard to see in the
 * first place.
 */
export function claimsChord(el: EventTarget | null, key: string): boolean {
  // `EventTarget`, not `Element`: a keydown's target is `window` or `document`
  // whenever nothing focusable has focus, and those have no `closest`. Typing
  // the parameter as `Element` did not prevent that — the call site casts —
  // it only moved the failure to runtime, where it took out every global
  // shortcut at once.
  if (!el || typeof (el as Element).closest !== 'function') return false;
  const owner = (el as Element).closest('[data-shortcut-claim]');
  if (!owner) return false;
  const wanted = key.toLowerCase();
  return (owner.getAttribute('data-shortcut-claim') ?? '')
    .split(/\s+/)
    .some((c) => c.length > 0 && c.toLowerCase() === wanted);
}

let shortcutInstance: ShortcutManager | null = null;

export function getShortcutManager(): ShortcutManager {
  if (!shortcutInstance) shortcutInstance = new ShortcutManager();
  return shortcutInstance;
}

export function setShortcutManager(s: ShortcutManager): void {
  shortcutInstance = s;
}
