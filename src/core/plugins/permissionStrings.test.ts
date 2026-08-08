/**
 * One description per permission, everywhere it is shown.
 *
 * The permission list is the screen that carries the whole security model, and
 * it now appears in four places: the editor's consent sheet, the editor's
 * plugin detail tab, the dashboard's detail page, and the registry's own
 * listing. Two different sentences describing one permission is worse than
 * none — whichever the user read last is the one they believe they agreed to,
 * and if they disagree at all, one of them is a lie told at the exact moment
 * trust is being established.
 *
 * So every surface imports `PERMISSIONS` from `manifest.ts`, and this test is
 * what makes that a rule rather than a habit: it fails if a surface starts
 * carrying its own copy of the text.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_PERMISSIONS, PERMISSIONS } from './manifest';

const SRC = join(__dirname, '..', '..');

/** Every surface that renders permission text to a user. */
const SURFACES = [
  'layout/Plugins/ConsentSheet.tsx',
  'layout/Plugins/PluginDetailTab.tsx',
];

describe('permission strings have one source', () => {
  it('describes every permission it declares', () => {
    // A permission with no label renders as a raw key like `assets:read` on the
    // one screen where plain language matters most.
    for (const p of ALL_PERMISSIONS) {
      const entry = PERMISSIONS[p];
      expect({ p, hasLabel: !!entry?.label, hasDetail: !!entry?.detail })
        .toEqual({ p, hasLabel: true, hasDetail: true });
    }
  });

  it('writes labels as plain language, not as identifiers', () => {
    for (const p of ALL_PERMISSIONS) {
      const { label } = PERMISSIONS[p];
      // No colons, no camelCase, no snake_case — a label that looks like the
      // key it came from teaches the user nothing.
      expect({ p, looksLikeAKey: /[:_]|[a-z][A-Z]/.test(label) }).toEqual({ p, looksLikeAKey: false });
      expect(label[0]).toBe(label[0]!.toUpperCase());
    }
  });

  it('states the network guarantee on the permissions that need it', () => {
    // `assets:read` is the scariest-sounding permission in the list, and the
    // reason it was safe to grant was that the pixels could not leave. That
    // used to be unconditional ("Plugins cannot access the internet") and
    // stopped being true the day `net:fetch` shipped. The sentence now states
    // the condition instead, which is the honest version of the same promise.
    expect(PERMISSIONS['assets:read'].detail).toMatch(/no network access unless/i);
  });

  it('names the network permission in the text that defers to it', () => {
    /*
      The `assets:read` reassurance is only meaningful if the user can find the
      permission it points at. It quotes `net:fetch`'s LABEL, so this asserts
      the two agree rather than asserting a hardcoded phrase — rename the label
      and this fails, which is the moment to fix the sentence, instead of the
      sentence silently referring to a permission that no longer exists by that
      name on the screen right above it.
    */
    expect(PERMISSIONS['assets:read'].detail).toContain(`"${PERMISSIONS['net:fetch'].label}"`);
  });

  it('says the host list is exhaustive, on the permission that grants it', () => {
    // "Contact websites" is not a decision anyone can make. The whole reason
    // hosts are declared and rendered verbatim is that the answer is bounded,
    // and the detail has to say so — otherwise the list beneath it reads as
    // examples rather than as the limit.
    expect(PERMISSIONS['net:fetch'].detail).toMatch(/and only those/i);
  });

  it.each(SURFACES)('%s imports the strings rather than restating them', (rel) => {
    const src = readFileSync(join(SRC, rel), 'utf8');
    // It must pull them from the one definition…
    expect({ rel, imports: /PERMISSIONS/.test(src) }).toEqual({ rel, imports: true });

    // …and must not contain a hardcoded copy of any label or detail. This is
    // the assertion that actually catches drift: a surface that "just inlines
    // the text for now" fails here on the day it is written.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const inlined = ALL_PERMISSIONS.filter((p) => {
      const { label, detail } = PERMISSIONS[p];
      return code.includes(`"${label}"`) || code.includes(`'${label}'`)
        || code.includes(`"${detail}"`) || code.includes(`'${detail}'`);
    });
    expect({ rel, inlined }).toEqual({ rel, inlined: [] });
  });
});

/**
 * The cross-repo half.
 *
 * `motion-back` renders the same permission list on the marketplace listing,
 * and it cannot import this file — different process, different machine,
 * different deployable. So agreement is enforced the same way the manifest
 * corpus enforces validator agreement: one byte-identical fixture, and a test
 * on each side that fails when its own copy drifts from it.
 */
describe('the shared permission fixture', () => {
  const fixture = require('./__fixtures__/permissions.json') as {
    permissions: Record<string, { label: string; detail: string }>;
  };

  it('covers exactly the permissions this host grants', () => {
    // A permission missing from the fixture is one the marketplace will render
    // as a raw key; one that lingers after removal is text for a capability
    // that no longer exists.
    expect(Object.keys(fixture.permissions).sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('matches this host word for word', () => {
    for (const p of ALL_PERMISSIONS) {
      expect({ p, ...PERMISSIONS[p] }).toEqual({ p, ...fixture.permissions[p] });
    }
  });
});
