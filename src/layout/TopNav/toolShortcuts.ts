/**
 * The keyboard chord a toolbar tool ACTUALLY responds to, formatted the way
 * every menu in the app formats one.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * The toolbar used to carry its own hand-written shortcut strings —
 * `{ id: 'select', label: 'Selection Tool', shortcut: 'V' }` — a second copy of
 * a fact the command registry already owns. A second copy of a shortcut is not
 * a cosmetic duplication: it cannot follow a rebinding. Customize… writes
 * `shortcutOverrides` and the AE preset rewrites a whole set of them, so the
 * moment a user (or a preset) moves a tool, every tooltip in the toolbar starts
 * lying, silently and permanently. Two of the strings were already wrong before
 * anyone touched a preference: `Ctrl+T` and `Ctrl+B` were written by hand while
 * the commands are declared `{ key: 't', meta: true }`, which `resolveChord`
 * turns into Ctrl only on non-Mac.
 *
 * ── Why the registry and NOT `Tool.shortcut` ────────────────────────────────
 *
 * `@motion/workspace`'s tool classes each declare a `shortcut` (`'v'`, `'b'`,
 * `'shift+r'`, `'alt+w'`…) and it is tempting to read them here, since they sit
 * right on the tool definition. They are NOT the app's tool-key channel and
 * advertising them would promise keys that do nothing:
 *
 *   • The only consumer is `ToolManager.activateByShortcut`, reached from
 *     `Workspace.onKeyDown` — and the app never calls `onKeyDown`. It calls
 *     `onToolKey` (see `Workspace.tsx`, and `toolKeyChannel.test.ts`, which
 *     exists to pin exactly this distinction), which routes a key to the ACTIVE
 *     tool and never switches tools.
 *   • Even inside the engine, `activateByShortcut` compares a whole
 *     `KeyboardEvent.key` against the string, so a chord like `'shift+r'` can
 *     never match anything — `e.key` for Shift+R is `'R'`.
 *
 * The command registry is the live channel: `ShortcutManager` binds `tool.<id>`
 * and `Customize…` rebinds it. So that is what is read here, through the same
 * `resolveChord` + `formatChord` pair the menu bar, the context menus and the
 * Command Palette use — which is also what makes a toolbar tooltip and the menu
 * row for the same tool agree, including after a rebinding.
 *
 * A tool with no live binding returns `undefined` and shows no keycap. That is
 * the honest answer for the seven tools Providers deliberately left unbound
 * ("every sensible key is taken… inventing collisions is worse than leaving
 * them unbound"), and it means a keycap in this toolbar is always a key that
 * works.
 */

import { getCommandRegistry } from '@core/commands/Command';
import { resolveChord, getShortcutOverrides } from '@core/commands/shortcutOverrides';
import { formatChord } from '@core/commands/formatChord';
import { asCommandId } from '@app-types/common';
import type { Tool } from '@stores/uiStore';

/**
 * The chord for a tool, or `undefined` when it has none.
 *
 * Deliberately NOT memoised: an override is written by a dialog this module
 * cannot see, and a stale keycap is the precise failure this file exists to
 * remove. The work is one Map lookup and a handful of string pushes, on a
 * render that is already drawing twenty icons.
 */
export function toolShortcut(tool: Tool | string): string | undefined {
  const cmd = getCommandRegistry().get(asCommandId(`tool.${tool}`));
  if (!cmd) return undefined;
  const chord = resolveChord(cmd.id as unknown as string, cmd.shortcut, getShortcutOverrides());
  return chord ? formatChord(chord) : undefined;
}

/**
 * "Selection Tool (V)" — the ACCESSIBLE name, for `aria-label` and for the
 * native `title` on surfaces that have no tooltip.
 *
 * The visual tooltip draws the chord as keycaps instead (see `Tooltip`'s
 * `shortcut` prop); a screen reader gets it inline here, because a keycap
 * rendered beside a label is not part of the button's name.
 */
export function toolLabelWithShortcut(label: string, tool: Tool | string): string {
  const chord = toolShortcut(tool);
  return chord ? `${label} (${chord})` : label;
}
