/**
 * Template authoring — exposing layers of the current comp as editable fields:
 *  • infer the right field kind from a layer (text/image/shape);
 *  • persist the manifest on the comp root and read it back;
 *  • the exposed field then drives a real edit through templateFields.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { buildTitleCard } from './templates/titleCard';
import {
  readAuthoredFields, exposeNodeAsField, removeAuthoredField, renameAuthoredField, inferFieldForNode,
} from './templateAuthoring';
import { readTemplateFieldValue, writeTemplateField } from './templateFields';

describe('template authoring', () => {
  beforeEach(() => {
    // buildTitleCard gives us a comp root ('tpl_root') + text/shape layers to expose.
    buildTitleCard();
  });

  it('infers field kind from the layer', () => {
    expect(inferFieldForNode('tpl_headline')?.kind).toBe('text');
    expect(inferFieldForNode('tpl_bg')?.kind).toBe('color'); // a shape → Style.fill
  });

  it('exposes a layer, persists it on the comp, and reads it back', () => {
    expect(readAuthoredFields()).toHaveLength(0);
    const field = exposeNodeAsField('tpl_headline');
    expect(field).toBeTruthy();
    const stored = readAuthoredFields();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.target).toEqual({ nodeId: 'tpl_headline', componentType: 'Text', prop: 'content' });
  });

  it('is idempotent — re-exposing the same layer does not duplicate', () => {
    exposeNodeAsField('tpl_headline');
    exposeNodeAsField('tpl_headline');
    expect(readAuthoredFields()).toHaveLength(1);
  });

  it('rename + remove mutate the manifest', () => {
    const f = exposeNodeAsField('tpl_headline')!;
    renameAuthoredField(f.id, 'Title');
    expect(readAuthoredFields()[0]!.label).toBe('Title');
    removeAuthoredField(f.id);
    expect(readAuthoredFields()).toHaveLength(0);
  });

  it('exposes a public slug id from the layer name', () => {
    const f = exposeNodeAsField('tpl_headline')!;
    expect(f.id).toMatch(/^[a-z][a-zA-Z0-9]*$/);
  });

  it('an authored field drives a real edit', () => {
    const f = exposeNodeAsField('tpl_headline')!;
    expect(writeTemplateField(f, 'Launch Day')).toBe(true);
    expect(readTemplateFieldValue(f)).toBe('Launch Day');
    // And the change is on the actual node.
    const node = defaultSceneGraph.getNode('tpl_headline')!;
    const text = node.components.find((c) => c.type === 'Text')!;
    expect((text.props as Record<string, unknown>).content).toBe('Launch Day');
  });
});
