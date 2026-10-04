/**
 * The glyph a layer draws, wherever it is drawn.
 *
 * Two reports, one table:
 *   • the same kind drew two different marks in two panels — a group was a
 *     `folder` on its timeline track and a `layers` stack on its Layers row,
 *     because each panel kept its own copy of the map and they had drifted;
 *   • a shape's SUBTYPE came from its NAME: `fx.solid === true ||
 *     node.name.toLowerCase().includes('solid')`, so a shape called "Solid
 *     Ground" drew the solid mark and a solid renamed "Backdrop" stopped
 *     drawing it. A layer's kind is not a function of what it is called.
 */


import { KIND_ICON, KIND_LABEL, KIND_GLYPH_COLOR } from './sceneDerive';

import { ICON_NAMES } from '@components/Icon/iconNames';
import {  type SceneKind } from '@core/scene/sceneKind';

beforeEach(() => {
});

describe('the tables are complete and real', () => {
  const kinds = Object.keys(KIND_LABEL) as SceneKind[];

  it('names a glyph, a label and a colour for every kind', () => {
    for (const k of kinds) {
      expect(KIND_ICON[k]).toBeTruthy();
      expect(KIND_LABEL[k]).toBeTruthy();
      expect(KIND_GLYPH_COLOR[k]).toMatch(/^var\(--color-kind-/);
    }
  });

  it('names glyphs that the icon set actually has', () => {
    // A missing glyph renders as nothing, which reads as "this row has no
    // kind" rather than as a bug in a table.
    for (const k of kinds) {
      expect(ICON_NAMES).toContain(KIND_ICON[k]);
    }
  });
});
