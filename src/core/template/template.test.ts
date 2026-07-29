/**
 * Template fields — the fill-in-the-blanks contract:
 *  • every exposed field targets a node that actually exists after build;
 *  • editing a field writes through the scene graph and reads back changed;
 *  • only the exposed props change — structure/animation are untouched.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { TEMPLATES, getTemplate } from './registry';
import { readTemplateFieldValue, writeTemplateField } from './templateFields';

describe('template fields', () => {
  for (const tpl of TEMPLATES) {
    describe(tpl.name, () => {
      beforeEach(() => tpl.build());

      it('every exposed field targets a real node + component + prop', () => {
        for (const f of tpl.fields) {
          const node = defaultSceneGraph.getNode(f.target.nodeId);
          expect(node).toBeTruthy();
          const comp = node!.components.find((c) => c.type === f.target.componentType);
          expect(comp).toBeTruthy();
          // The authored default should match what's actually on the node.
          expect(readTemplateFieldValue(f)).toBe(f.default);
        }
      });

      it('editing a field writes through and reads back changed', () => {
        for (const f of tpl.fields) {
          const next =
            f.kind === 'text' ? `${f.default} · edited`
            : f.kind === 'color' ? '#abcdef'
            : f.kind === 'image' ? 'blob:https://example/new-image'
            : 42;
          expect(writeTemplateField(f, next)).toBe(true);
          expect(readTemplateFieldValue(f)).toBe(next);
        }
      });
    });
  }

  it('getTemplate resolves by id and rejects unknown ids', () => {
    expect(getTemplate('title-card')).toBeTruthy();
    expect(getTemplate('nope')).toBeNull();
  });
});
