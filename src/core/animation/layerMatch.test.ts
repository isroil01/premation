/**
 * The correspondence, tested on the cases that produce confidently wrong
 * motion rather than no motion.
 *
 * A missed match is cheap: the layer fades, which reads as a deliberate cut.
 * A WRONG match is expensive: a headline flies across the screen and turns
 * into a logo, and the user cannot tell whether they mis-named something or
 * the app is broken. So most of this file is about refusing.
 */

import { matchLayers, type LayerDescriptor } from './layerMatch';

let seq = 0;
function layer(over: Partial<LayerDescriptor> & { name: string }): LayerDescriptor {
  seq += 1;
  return { id: `n${seq}`, kind: 'shape', path: [], ...over };
}

const namesOf = (pairs: ReturnType<typeof matchLayers>['pairs']): string[] =>
  pairs.map((p) => `${p.from.name}→${p.to.name}`);

describe('matchLayers', () => {
  it('matches the obvious case by name and place', () => {
    const a = [layer({ name: 'Title' }), layer({ name: 'Subtitle' })];
    const b = [layer({ name: 'Subtitle' }), layer({ name: 'Title' })];
    const out = matchLayers(a, b);

    expect(namesOf(out.pairs).sort()).toEqual(['Subtitle→Subtitle', 'Title→Title']);
    expect(out.pairs.every((p) => p.reason === 'name-and-place')).toBe(true);
    expect(out.onlyFrom).toEqual([]);
    expect(out.onlyTo).toEqual([]);
  });

  it('ignores case and surrounding whitespace in names', () => {
    const out = matchLayers([layer({ name: ' Title ' })], [layer({ name: 'title' })]);
    expect(out.pairs).toHaveLength(1);
  });

  it('refuses to match across kinds, however identical the name', () => {
    // Morphing a headline into a video is never what "same name" meant.
    const out = matchLayers(
      [layer({ name: 'Hero', kind: 'text' })],
      [layer({ name: 'Hero', kind: 'video' })],
    );
    expect(out.pairs).toEqual([]);
    expect(out.onlyFrom).toHaveLength(1);
    expect(out.onlyTo).toHaveLength(1);
  });

  it('prefers the layer in the same place when a name is reused', () => {
    // "Label" exists inside two different groups on both sides. Position in
    // the tree is what tells them apart.
    const a = [
      layer({ name: 'Label', path: ['Card A'] }),
      layer({ name: 'Label', path: ['Card B'] }),
    ];
    const b = [
      layer({ name: 'Label', path: ['Card B'] }),
      layer({ name: 'Label', path: ['Card A'] }),
    ];
    const out = matchLayers(a, b);

    expect(out.pairs).toHaveLength(2);
    for (const pair of out.pairs) {
      expect(pair.from.path).toEqual(pair.to.path);
      expect(pair.reason).toBe('name-and-place');
    }
  });

  it('still matches a layer that moved to another group', () => {
    const out = matchLayers(
      [layer({ name: 'Logo', path: ['Header'] })],
      [layer({ name: 'Logo', path: ['Footer'] })],
    );
    expect(out.pairs).toHaveLength(1);
    expect(out.pairs[0]!.reason).toBe('name');
  });

  it('matches renamed footage by its source', () => {
    const out = matchLayers(
      [layer({ name: 'Clip 1', kind: 'video', assetId: 'asset_x' })],
      [layer({ name: 'Background Plate', kind: 'video', assetId: 'asset_x' })],
    );
    expect(out.pairs).toHaveLength(1);
    expect(out.pairs[0]!.reason).toBe('source');
  });

  it('matches renamed text by its content', () => {
    const out = matchLayers(
      [layer({ name: 'Text 1', kind: 'text', text: 'Hello world' })],
      [layer({ name: 'Headline', kind: 'text', text: 'hello world' })],
    );
    expect(out.pairs).toHaveLength(1);
    expect(out.pairs[0]!.reason).toBe('text');
  });

  it('does not treat two layers with NO text as a text match', () => {
    // The bug this guards: an empty key is not a shared identity. Letting
    // empties collide matched every untitled shape to the first one.
    const out = matchLayers(
      [layer({ name: 'A', kind: 'text', text: '' }), layer({ name: 'B', kind: 'text', text: '   ' })],
      [layer({ name: 'C', kind: 'text', text: '' }), layer({ name: 'D', kind: 'text' })],
    );
    expect(out.pairs).toEqual([]);
  });

  it('does not treat two layers with no source as a source match', () => {
    const out = matchLayers(
      [layer({ name: 'A' }), layer({ name: 'B' })],
      [layer({ name: 'C' }), layer({ name: 'D' })],
    );
    expect(out.pairs).toEqual([]);
    expect(out.onlyFrom).toHaveLength(2);
    expect(out.onlyTo).toHaveLength(2);
  });

  it('lets the strongest signal win — a name match is never undone by text', () => {
    // "Title" matches "Title" by name. If the text pass ran unguarded it would
    // rather pair the two layers whose CONTENT agrees, and the stronger,
    // earlier match would be replaced by a weaker one.
    const a = [
      layer({ name: 'Title', kind: 'text', text: 'One' }),
      layer({ name: 'Other', kind: 'text', text: 'Two' }),
    ];
    const b = [
      layer({ name: 'Title', kind: 'text', text: 'Two' }),
      layer({ name: 'Elsewhere', kind: 'text', text: 'One' }),
    ];
    const out = matchLayers(a, b);
    expect(namesOf(out.pairs)).toContain('Title→Title');
    expect(out.pairs.find((p) => p.from.name === 'Title')!.reason).toBe('name-and-place');
  });

  it('pairs each layer at most once', () => {
    const a = [layer({ name: 'Dot' }), layer({ name: 'Dot' }), layer({ name: 'Dot' })];
    const b = [layer({ name: 'Dot' }), layer({ name: 'Dot' })];
    const out = matchLayers(a, b);

    expect(out.pairs).toHaveLength(2);
    expect(new Set(out.pairs.map((p) => p.from.id)).size).toBe(2);
    expect(new Set(out.pairs.map((p) => p.to.id)).size).toBe(2);
    expect(out.onlyFrom).toHaveLength(1);
    expect(out.onlyTo).toHaveLength(0);
  });

  it('is not confused by ids that collide across the two sides', () => {
    // Comps built by duplication reuse names freely, and hand-built scenes can
    // reuse ids. One shared "seen" set would let a source block its own target.
    const a: LayerDescriptor[] = [{ id: 'same', name: 'Title', kind: 'text', path: [] }];
    const b: LayerDescriptor[] = [{ id: 'same', name: 'Title', kind: 'text', path: [] }];
    const out = matchLayers(a, b);
    expect(out.pairs).toHaveLength(1);
    expect(out.onlyFrom).toEqual([]);
    expect(out.onlyTo).toEqual([]);
  });

  it('reports arrivals and departures', () => {
    const out = matchLayers(
      [layer({ name: 'Stays' }), layer({ name: 'Leaves' })],
      [layer({ name: 'Stays' }), layer({ name: 'Arrives' })],
    );
    expect(namesOf(out.pairs)).toEqual(['Stays→Stays']);
    expect(out.onlyFrom.map((l) => l.name)).toEqual(['Leaves']);
    expect(out.onlyTo.map((l) => l.name)).toEqual(['Arrives']);
  });

  it('ignores unnamed layers rather than matching them to each other', () => {
    const out = matchLayers([layer({ name: '' })], [layer({ name: '  ' })]);
    expect(out.pairs).toEqual([]);
  });

  it('handles empty compositions', () => {
    expect(matchLayers([], [])).toEqual({ pairs: [], onlyFrom: [], onlyTo: [] });
    const one = matchLayers([layer({ name: 'A' })], []);
    expect(one.pairs).toEqual([]);
    expect(one.onlyFrom).toHaveLength(1);
  });

  it('is deterministic and order-stable', () => {
    const a = [layer({ name: 'X' }), layer({ name: 'Y' }), layer({ name: 'Z' })];
    const b = [layer({ name: 'Z' }), layer({ name: 'X' })];
    expect(namesOf(matchLayers(a, b).pairs)).toEqual(namesOf(matchLayers(a, b).pairs));
    expect(namesOf(matchLayers(a, b).pairs)).toEqual(['X→X', 'Z→Z']);
  });
});
