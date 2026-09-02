/**
 * `Command.isChecked` must be implemented by the toggles and READ by the menus.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * The field was declared on the `Command` interface — "Optional check invoked
 * by menus to show toggled state" — with zero implementations and zero readers.
 * Every toggle in the View menu therefore rendered identically whether it was
 * on or off: "Show Grid" told you the action existed and nothing about what it
 * would do. The interface described a feature that did not exist, which is
 * worse than not having the field, because it reads as done.
 *
 * ── Why this is asserted from two ends ──────────────────────────────────────
 *
 * A dead callback has two failure modes and they need different assertions.
 * Implementing `isChecked` on every toggle while no menu reads it is exactly
 * the state this replaces. Reading it in the menus while no command implements
 * it is the same nothing, arrived at from the other side. So one test pins the
 * IMPLEMENTATIONS against the store they report, and another pins that the
 * renderers actually consult it.
 */

import { readSource } from '@/__testHelpers__/readSource';

/**
 * The menu item renderer that must consult `isChecked`.
 *
 * Was a list of two — `AppMenuBar.tsx` and `AppMenuButton.tsx` each carried a
 * byte-identical copy of the item loop. They now share `MenuModelItems`, which
 * is the whole reason a list of two was a smell: the assertion existed because
 * the two copies could drift, and the fix for that is one copy.
 */
const MENU_RENDERERS = ['layout/Menu/MenuModelItems.tsx'];

/**
 * View toggles and the `guidesStore` field each reports.
 *
 * Kept as data so the pairing is checkable: the bug this most invites is an
 * `isChecked` wired to the wrong field, which renders a tick that is confidently
 * about something else. `toggleSnapToGrid` reporting `grid` would look correct
 * in every screenshot.
 */
const TOGGLES: ReadonlyArray<readonly [string, string]> = [
  ['view.safeAreas', 'safeArea'],
  ['view.grid', 'grid'],
  ['view.proportionalGrid', 'proportionalGrid'],
  ['view.snapToGrid', 'snapToGrid'],
  ['view.rulers', 'rulers'],
  ['view.motionPath', 'motionPathVisible'],
];

describe('Command.isChecked', () => {
  const providers = readSource('providers/Providers.tsx');

  it.each(TOGGLES)('%s implements isChecked from guidesStore.%s', (id, field) => {
    // The registration block for this command, up to the next `registry.register`.
    const at = providers.indexOf(`asCommandId('${id}')`);
    expect(at).toBeGreaterThan(0);
    const next = providers.indexOf('registry.register(', at);
    const block = providers.slice(at, next < 0 ? providers.length : next);
    expect(block).toContain('isChecked:');
    expect(block).toMatch(new RegExp(`isChecked:[^\\n]*\\b${field}\\b`));
  });

  it.each(MENU_RENDERERS)('%s reads isChecked and passes it to the item', (file) => {
    const src = readSource(file);
    expect(src).toMatch(/isChecked\?\.\(\)/);
    expect(src).toMatch(/checked=\{checked\}/);
  });

  it.each(['layout/Menu/AppMenuBar.tsx', 'layout/Menu/AppMenuButton.tsx'])(
    '%s draws its items through the shared renderer, so it cannot drift',
    (file) => {
      expect(readSource(file)).toContain('<MenuModelItems');
    },
  );

  it('MenuItem renders a tick and announces it, rather than only drawing one', () => {
    // A glyph with no `aria-checked` is invisible to a screen reader, and the
    // whole point of the field is to communicate state.
    const menu = readSource('components/Menu/Menu.tsx');
    expect(menu).toContain('checked?: boolean;');
    expect(menu).toMatch(/aria-checked=\{checked\}/);
    expect(menu).toMatch(/menuitemcheckbox/);
    // Non-toggles must stay plain `menuitem`; a menu where every entry is a
    // checkbox is worse than one where none is.
    expect(menu).toMatch(/checked === undefined \? 'menuitem' : 'menuitemcheckbox'/);
  });

  it('every command that declares isChecked is a toggle this test knows about', () => {
    // Stops the field being added somewhere new without a paired assertion —
    // which is how it came to be declared and unimplemented in the first place.
    const ids = [...providers.matchAll(/asCommandId\('([^']+)'\)/g)].map((m) => m[1]!);
    const declaredAt = new Set<string>();
    for (const id of ids) {
      const at = providers.indexOf(`asCommandId('${id}')`);
      const next = providers.indexOf('registry.register(', at);
      const block = providers.slice(at, next < 0 ? providers.length : next);
      if (block.includes('isChecked:')) declaredAt.add(id);
    }
    expect([...declaredAt].sort()).toEqual(TOGGLES.map(([id]) => id).sort());
  });
});
