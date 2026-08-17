/**
 * Properties inspector: one column, one scroller, stingy defaults.
 *
 * Parent & Blend used to start open next to Transform, so selecting a shape
 * dumped three accordions on screen. The extras (mograph / template / versions)
 * used a 14px gutter that did not match the accordion's 12px. These pins keep
 * the shell from drifting back into that pile.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, 'DemoPanels.tsx');

describe('Properties panel structure', () => {
  const src = readFileSync(SRC, 'utf8');

  it('owns its own scroll so the layer header and search stay put', () => {
    expect(src).toMatch(/id="properties"[\s\S]*?noScroll/);
    expect(src).toMatch(/inspectorShell/);
    expect(src).toMatch(/layerHead/);
    expect(src).toMatch(/inspectorBody/);
  });

  it('does not open Parent or Blend by default — Transform is the first screen', () => {
    expect(src).toMatch(/id: 'parenting'[\s\S]*?defaultOpen: false/);
    expect(src).toMatch(/id: 'compositing'[\s\S]*?defaultOpen: false/);
    expect(src).toMatch(/id: 'transform'[\s\S]*?defaultOpen: true/);
  });

  it('does not pad extras with a one-off 14px gutter', () => {
    expect(src).not.toMatch(/padding: '0 14px'/);
    expect(src).toMatch(/inspectorExtras/);
  });
});
