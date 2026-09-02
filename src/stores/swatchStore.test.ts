/**
 * Swatches: the derived list, and the half that has to survive a save.
 *
 * The interesting failure this guards is not "the store forgot a colour" — it
 * is the one every authored subsystem in this repo has hit at least once:
 * state a user can name, order and rely on, captured nowhere, so it looks
 * perfect until the file is reopened. `cloudDocument.ts` says it in its own
 * header ("Anything a user can author that is NOT captured here is silently
 * lost on reload"), and this is the swatch half of that contract.
 */

import {
  useSwatchStore,
  collectDocumentColors,
  canonicalHex,
  normalizeSwatches,
  DOCUMENT_COLOR_LIMIT,
} from './swatchStore';
import { captureDocument, restoreDocument } from '@core/api/cloudDocument';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

/** A node whose `fx` component carries whatever paint the case is about. */
function paintedNode(id: string, fxProps: Record<string, unknown>, parent: string | null = 'comp_root'): SceneNode {
  return {
    id,
    name: id,
    parent,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      { id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'shape' } },
      { id: `${id}_fx`, type: 'fx', props: fxProps },
    ],
  };
}

function solid(color: string): Record<string, unknown> {
  return { fill: { type: 'solid', color } };
}

function clearScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

beforeEach(() => {
  clearScene();
  useSwatchStore.getState().restore([]);
});

describe('canonicalHex', () => {
  it('folds the ways of writing one colour into one string', () => {
    // Three spellings, one colour. A strip that showed them separately would
    // be reporting its storage format, not the document's palette.
    expect(canonicalHex('#FFF')).toBe('#ffffff');
    expect(canonicalHex('ffffff')).toBe('#ffffff');
    expect(canonicalHex('#FFFFFFFF')).toBe('#ffffff');
  });

  it('keeps a real alpha and drops only the opaque one', () => {
    expect(canonicalHex('#11223380')).toBe('#11223380');
    expect(canonicalHex('#112233ff')).toBe('#112233');
  });

  it('rejects what is not a hex colour rather than guessing', () => {
    // Guessing here means a swatch that silently becomes black.
    expect(canonicalHex('rgba(1, 2, 3, 0.5)')).toBeNull();
    expect(canonicalHex('#12345')).toBeNull();
    expect(canonicalHex('')).toBeNull();
    expect(canonicalHex(undefined)).toBeNull();
  });
});

describe('collectDocumentColors', () => {
  it('is pure — it reads the nodes it is given, not the live graph', () => {
    // The graph is empty (beforeEach cleared it); the fixture is not.
    const colors = collectDocumentColors([paintedNode('a', solid('#ff0000'))]);
    expect(colors).toEqual(['#ff0000']);
  });

  it('collects fills, gradient stops, strokes and gradient strokes', () => {
    const colors = collectDocumentColors([
      paintedNode('solid', solid('#ff0000')),
      paintedNode('grad', {
        fill: {
          type: 'linear',
          angle: 90,
          stops: [
            { id: 's1', offset: 0, color: '#00ff00' },
            { id: 's2', offset: 1, color: '#0000ff' },
          ],
        },
      }),
      paintedNode('stroked', {
        stroke: { enabled: true, color: '#123456', width: 2, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter' },
      }),
      paintedNode('gradStroke', {
        stroke: {
          enabled: true,
          color: '#abcdef',
          width: 2,
          opacity: 1,
          align: 'center',
          dash: [],
          cap: 'butt',
          join: 'miter',
          paint: { type: 'radial', cx: 0.5, cy: 0.5, radius: 0.5, stops: [{ id: 's3', offset: 0, color: '#fedcba' }] },
        },
      }),
    ]);
    expect(colors).toEqual(['#ff0000', '#00ff00', '#0000ff', '#123456', '#abcdef', '#fedcba']);
  });

  it('reads the whole fill stack, not just the primary', () => {
    const colors = collectDocumentColors([
      paintedNode('multi', {
        fill: { type: 'solid', color: '#111111' },
        fills: [
          { type: 'solid', color: '#111111' },
          { type: 'solid', color: '#222222' },
        ],
      }),
    ]);
    expect(colors).toEqual(['#111111', '#222222']);
  });

  it('picks up a light colour without a case of its own', () => {
    // A light stores its colour as a bare `fill` STRING on a style component.
    // `readNodeFills` resolves that through its legacy path — so this passes
    // for free, and a dedicated branch here would double-count it.
    const light: SceneNode = {
      id: 'key',
      name: 'Key Light',
      parent: 'comp_root',
      children: [],
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      visible: true,
      locked: false,
      components: [
        { id: 'key_meta', type: 'transform', props: { [SCENE_KIND_PROP]: 'light', intensity: 1 } },
        { id: 'key_style', type: 'style', props: { fill: '#fff3c0' } },
      ],
    };
    expect(collectDocumentColors([light])).toEqual(['#fff3c0']);
  });

  it('deduplicates across nodes and keeps first-seen order', () => {
    const colors = collectDocumentColors([
      paintedNode('a', solid('#AABBCC')),
      paintedNode('b', solid('#aabbcc')),
      paintedNode('c', solid('#ddeeff')),
    ]);
    expect(colors).toEqual(['#aabbcc', '#ddeeff']);
  });

  it('stops at the strip limit instead of returning an inventory', () => {
    const nodes = Array.from({ length: DOCUMENT_COLOR_LIMIT + 20 }, (_, i) =>
      paintedNode(`n${i}`, solid(`#${i.toString(16).padStart(6, '0')}`)));
    expect(collectDocumentColors(nodes)).toHaveLength(DOCUMENT_COLOR_LIMIT);
  });

  it('ignores the layer label colour', () => {
    // `node.color` tints the timeline row. It is chrome, not paint.
    const n = paintedNode('labelled', solid('#ff0000'));
    n.color = '#00ff00';
    expect(collectDocumentColors([n])).toEqual(['#ff0000']);
  });
});

describe('refreshDocumentColors', () => {
  it('is lazy — nothing is derived until it is asked for', () => {
    defaultSceneGraph.addNode(paintedNode('comp_root', {}, null));
    defaultSceneGraph.addNode(paintedNode('shape', solid('#c0ffee')));

    expect(useSwatchStore.getState().documentColors).toEqual([]);
    useSwatchStore.getState().refreshDocumentColors();
    expect(useSwatchStore.getState().documentColors).toContain('#c0ffee');
  });
});

describe('the project palette', () => {
  it('does not grow a second row for a colour it already has', () => {
    const s = useSwatchStore.getState();
    const first = s.addSwatch('#ff0000', 'Brand Red');
    const again = s.addSwatch('#FF0000');
    expect(again).toEqual(first);
    expect(useSwatchStore.getState().swatches).toHaveLength(1);
  });

  it('renames, reorders and removes', () => {
    const s = useSwatchStore.getState();
    const a = s.addSwatch('#ff0000', 'A');
    const b = s.addSwatch('#00ff00', 'B');
    const c = s.addSwatch('#0000ff', 'C');
    expect(a && b && c).toBeTruthy();

    useSwatchStore.getState().renameSwatch(b!.id, 'Middle');
    useSwatchStore.getState().moveSwatch(c!.id, 0);
    expect(useSwatchStore.getState().swatches.map((x) => x.name)).toEqual(['C', 'A', 'Middle']);

    useSwatchStore.getState().removeSwatch(a!.id);
    expect(useSwatchStore.getState().swatches.map((x) => x.name)).toEqual(['C', 'Middle']);
  });

  it('falls back to the hex when a rename empties the name', () => {
    const s = useSwatchStore.getState();
    const sw = s.addSwatch('#ff0000', 'A');
    useSwatchStore.getState().renameSwatch(sw!.id, '   ');
    expect(useSwatchStore.getState().swatches[0]?.name).toBe('#FF0000');
  });

  it('refuses a colour it cannot parse', () => {
    expect(useSwatchStore.getState().addSwatch('not a colour')).toBeNull();
    expect(useSwatchStore.getState().swatches).toEqual([]);
  });
});

describe('normalizeSwatches (documents are user files)', () => {
  it('drops entries it cannot trust rather than repairing them to black', () => {
    const out = normalizeSwatches([
      { id: 'a', name: 'Good', hex: '#FF0000' },
      { id: 'b', name: 'Bad', hex: 'not-a-colour' },
      null,
      'nonsense',
      { id: 'c', hex: '#00ff00' },
    ]);
    expect(out.map((s) => s.hex)).toEqual(['#ff0000', '#00ff00']);
    // A nameless swatch gets its hex as a name; it is never left blank.
    expect(out[1]?.name).toBe('#00FF00');
  });

  it('re-ids duplicates so two swatches can never share an id', () => {
    const out = normalizeSwatches([
      { id: 'dup', name: 'One', hex: '#111111' },
      { id: 'dup', name: 'Two', hex: '#222222' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.id).not.toBe(out[1]?.id);
  });

  it('returns an empty palette for anything that is not a list', () => {
    expect(normalizeSwatches(undefined)).toEqual([]);
    expect(normalizeSwatches({ swatches: [] })).toEqual([]);
  });
});

describe('captureDocument → restoreDocument', () => {
  it('preserves the project palette, names and order included', () => {
    const s = useSwatchStore.getState();
    s.addSwatch('#ff0000', 'Brand Red');
    s.addSwatch('#00ff00', 'Brand Green');
    s.addSwatch('#0000ff', 'Brand Blue');
    const before = useSwatchStore.getState().list();
    expect(before).toHaveLength(3);

    const doc = structuredClone(captureDocument());
    // Not just "clear it" — a different palette, so a restore that no-ops is
    // as red as a restore that wipes.
    useSwatchStore.getState().restore([{ id: 'x', name: 'Wrong', hex: '#cccccc' }]);
    expect(useSwatchStore.getState().swatches.map((x) => x.hex)).toEqual(['#cccccc']);

    restoreDocument(doc);

    expect(useSwatchStore.getState().list()).toEqual(before);
  });

  it('an empty palette round-trips as empty, not as whatever was open before', () => {
    useSwatchStore.getState().restore([]);
    const doc = structuredClone(captureDocument());
    useSwatchStore.getState().addSwatch('#ff0000', 'Leftover');

    restoreDocument(doc);

    expect(useSwatchStore.getState().swatches).toEqual([]);
  });

  it('a document written before swatches existed leaves the palette alone', () => {
    // Absent means "keep" for every optional key in EditorDocument; a legacy
    // file must not be read as "this project has no swatches".
    useSwatchStore.getState().addSwatch('#ff0000', 'Brand Red');
    const doc = structuredClone(captureDocument());
    delete doc.swatches;

    restoreDocument(doc);

    expect(useSwatchStore.getState().swatches.map((s) => s.name)).toEqual(['Brand Red']);
  });
});
