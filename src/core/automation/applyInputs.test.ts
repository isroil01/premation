import { applyTemplateInputs, readFieldsFromDocument, missingRequiredInputs } from './applyInputs';
import type { EditorDocument } from '@core/api/cloudDocument';
import type { TemplateField } from '@core/template/templateTypes';
import type { SceneNode } from '@core/types';

function node(id: string, extras: Partial<SceneNode> = {}): SceneNode {
  return {
    id,
    name: id,
    parent: 'root',
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [],
    ...extras,
  };
}

function docWith(fields: TemplateField[], layers: SceneNode[]): EditorDocument {
  const root = node('root', {
    parent: null,
    children: layers.map((l) => l.id),
    components: [{ id: 'root_meta', type: 'group', props: { __templateFields: fields } }],
  });
  return {
    version: '1.6.0',
    scene: { version: '1.0.0', nodes: [root, ...layers] },
    animation: {
      tracks: {
        'char:x': [{ t: 0, value: 0 }, { t: 1, value: 200 }],
      },
      expressions: {},
    } as never,
  };
}

const character: TemplateField = {
  id: 'character',
  label: 'Character',
  kind: 'media',
  default: '',
  target: { nodeId: 'char', componentType: 'Transform', prop: 'src' },
};

const caption: TemplateField = {
  id: 'caption',
  label: 'Caption',
  kind: 'text',
  default: 'Hello',
  target: { nodeId: 'text', componentType: 'Text', prop: 'content' },
};

describe('applyTemplateInputs', () => {
  const charLayer = node('char', {
    name: 'Character',
    components: [{ id: 't', type: 'Transform', props: { src: 'old.png', x: 10 } }],
  });
  const textLayer = node('text', {
    name: 'Caption',
    components: [{ id: 'tx', type: 'Text', props: { content: 'Hello' } }],
  });

  it('replaces media and text without touching animation tracks', () => {
    const src = docWith([character, caption], [charLayer, textLayer]);
    const { document, applied, errors } = applyTemplateInputs(src, {
      character: 'https://cdn.example.com/anime.png',
      caption: 'Making ramen',
    });
    expect(errors).toEqual([]);
    expect(applied.sort()).toEqual(['caption', 'character']);
    const char = document.scene.nodes.find((n) => n.id === 'char')!;
    const text = document.scene.nodes.find((n) => n.id === 'text')!;
    expect((char.components[0]!.props as { src: string }).src).toBe('https://cdn.example.com/anime.png');
    expect((text.components[0]!.props as { content: string }).content).toBe('Making ramen');
    expect(document.animation).toEqual(src.animation);
    expect(src.scene.nodes.find((n) => n.id === 'char')!.components[0]!.props).toMatchObject({
      src: 'old.png',
    });
  });

  it('reports unknown keys and private URLs', () => {
    const src = docWith([character], [charLayer]);
    const { errors, applied } = applyTemplateInputs(src, {
      character: 'http://127.0.0.1/x.png',
      nope: 'x',
    });
    expect(applied).toEqual([]);
    expect(errors.map((e) => e.field).sort()).toEqual(['character', 'nope']);
  });

  it('reads fields from the document when none are passed', () => {
    const src = docWith([caption], [textLayer]);
    expect(readFieldsFromDocument(src).map((f) => f.id)).toEqual(['caption']);
    const { applied } = applyTemplateInputs(src, { caption: 'Hi' });
    expect(applied).toEqual(['caption']);
  });
});

describe('missingRequiredInputs', () => {
  it('flags media slots without a URL', () => {
    expect(missingRequiredInputs([character, caption], { caption: 'x' })).toEqual(['character']);
    expect(
      missingRequiredInputs([character], { character: 'https://cdn.example.com/a.png' }),
    ).toEqual([]);
  });
});
