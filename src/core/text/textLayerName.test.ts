/**
 * The naming rule behind "a text layer is named after what it says" — and the
 * half of it that matters more: it stops the moment the user names the layer.
 */

import { isAutoTextLayerName, textLayerNameFor, TEXT_LAYER_NAME_MAX } from './textLayerName';

describe('textLayerNameFor', () => {
  it('uses short content as the name, verbatim', () => {
    expect(textLayerNameFor('Every frame tells a story')).toBe('Every frame tells a story');
  });

  it('flattens line breaks — a layer name is one line', () => {
    expect(textLayerNameFor('Premium\nmotion\n\ndesign')).toBe('Premium motion design');
  });

  it('truncates long content to ~30 characters, marked with an ellipsis', () => {
    const name = textLayerNameFor('Premium motion design made simple for everyone');
    expect(name.endsWith('…')).toBe(true);
    expect([...name].length).toBeLessThanOrEqual(TEXT_LAYER_NAME_MAX + 1);
    expect('Premium motion design made simple for everyone'.startsWith(name.slice(0, -1))).toBe(true);
  });

  it('has nothing to offer for empty content, so the caller keeps the old name', () => {
    expect(textLayerNameFor('   \n ')).toBe('');
  });
});

describe('isAutoTextLayerName', () => {
  it('treats the tool defaults as ours to replace', () => {
    expect(isAutoTextLayerName('Text', 'Text')).toBe(true);
    expect(isAutoTextLayerName('Text 3', 'anything')).toBe(true);
    expect(isAutoTextLayerName(undefined, '')).toBe(true);
  });

  it('keeps following the content while the name still matches it', () => {
    expect(isAutoTextLayerName('Hello', 'Hello')).toBe(true);
  });

  it('REGRESSION GUARD: a name the user typed survives a text edit', () => {
    expect(isAutoTextLayerName('Hero headline', 'Hello')).toBe(false);
  });
});
