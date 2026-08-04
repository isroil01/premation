/**
 * Every tool with a toolbar button must also have a command.
 *
 * WHY THIS EXISTS. `buildToolCommands` registered 14 of the 21 tools. The other
 * seven — pencil, curvature, line, polygon, star, and both mask tools — had a
 * button and nothing else, which meant:
 *
 *   • absent from the Command Palette, and
 *   • impossible to bind a shortcut to in Customize…, because that screen walks
 *     the command REGISTRY.
 *
 * So half the drawing tools were rebindable and half silently were not, with
 * nothing in the UI explaining the difference. Nothing was broken, which is why
 * it went unnoticed — it is an inconsistent surface rather than a defect, and
 * exactly the kind that never gets found without a check.
 *
 * Both lists are parsed from source rather than imported: `TopNav` pulls in the
 * whole editor (stores, engine, workspace singleton) and `Providers` boots the
 * application, neither of which belongs in a unit test asserting a naming
 * correspondence.
 *
 * IF THIS FAILS you added a tool to the toolbar without registering
 * `tool.<id>`. Add it to the `tools` array in `buildToolCommands`.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const TOPNAV = resolve(__dirname, 'TopNav.tsx');
const PROVIDERS = resolve(__dirname, '../../providers/Providers.tsx');

/** Tool ids named in TopNav's toolbar definitions. */
function toolbarTools(): Set<string> {
  const src = readFileSync(TOPNAV, 'utf8');
  const ids = new Set<string>();
  // POINTER_TOOLS / PEN_TOOLS / SHAPE_TOOLS / MASK_TOOLS entries and the two
  // standalone consts all share the shape `{ id: '<tool>', icon: … }`.
  for (const m of src.matchAll(/\{\s*id:\s*'([a-z-]+)',\s*icon:/g)) ids.add(m[1]!);
  return ids;
}

/** Tool ids `buildToolCommands` registers as `tool.<id>`. */
function commandTools(): Set<string> {
  const src = readFileSync(PROVIDERS, 'utf8');
  const block = /const tools: Array<\{[\s\S]*?\n {2}\];/.exec(src)?.[0] ?? '';
  const ids = new Set<string>();
  for (const m of block.matchAll(/\{\s*tool:\s*'([a-z-]+)'/g)) ids.add(m[1]!);
  return ids;
}

describe('toolbar tools ⇄ tool commands', () => {
  const toolbar = toolbarTools();
  const commands = commandTools();

  it('parses both lists out of source', () => {
    // Guards the guard: two empty sets would satisfy the subset check below.
    expect(toolbar.size).toBeGreaterThanOrEqual(18);
    expect(commands.size).toBeGreaterThanOrEqual(18);
    expect(toolbar.has('pencil')).toBe(true);
  });

  it('every toolbar tool is registered as a command', () => {
    const missing = [...toolbar].filter((t) => !commands.has(t)).sort();
    expect(missing).toEqual([]);
  });
});
