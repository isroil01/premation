/**
 * Properties inspector: one column, one scroller, stingy defaults.
 *
 * Parent & Blend used to start open next to Transform, so selecting a shape
 * dumped three accordions on screen. The extras (mograph / template / versions)
 * used a 14px gutter that did not match the accordion's 12px. These pins keep
 * the shell from drifting back into that pile.
 *
 * The subjects are now TWO files, because the panel was split into a shell and
 * a registry: `PropertiesPanel.tsx` owns the header, the search box and the
 * scroller, and `Inspector/inspectorSections.ts` owns which sections exist and
 * which of them open on their own. Asserting the defaults against the registry
 * rather than against inline JSX is the point of the split — the answer is now
 * in one row of one array instead of somewhere in a 280-line push chain.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SHELL = join(__dirname, 'PropertiesPanel.tsx');
const REGISTRY = join(__dirname, '..', 'Inspector', 'inspectorSections.ts');

describe('Properties panel structure', () => {
  const shell = readFileSync(SHELL, 'utf8');
  const registry = readFileSync(REGISTRY, 'utf8');

  it('owns its own scroll so the layer header and search stay put', () => {
    expect(shell).toMatch(/id="properties"[\s\S]*?noScroll/);
    expect(shell).toMatch(/inspectorShell/);
    expect(shell).toMatch(/layerHead/);
    expect(shell).toMatch(/inspectorBody/);
  });

  it('does not open Compositing by default — Transform is the first screen', () => {
    // Compositing carries no `defaultOpen` at all, which is the same "closed"
    // the explicit `false` used to spell — and one fewer thing to get wrong.
    expect(registry).toMatch(/id: 'compositing'[\s\S]*?defaultOpen: false/);
    expect(registry).toMatch(/id: 'transform'[\s\S]*?defaultOpen: true/);
  });

  it('does not pad extras with a one-off 14px gutter', () => {
    expect(shell).not.toMatch(/padding: '0 14px'/);
    expect(shell).toMatch(/inspectorExtras/);
  });
});
