import { packPortableMotion, unpackPortableMotion, PortableMotionError } from './portableMotion';
import type { EditorDocument } from '@core/api/cloudDocument';

function doc(): EditorDocument {
  return {
    version: '1.6.0',
    scene: {
      version: '1.0.0',
      nodes: [
        {
          id: 'char',
          name: 'Character',
          parent: null,
          children: [],
          transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
          components: [{ id: 't', type: 'Transform', props: { src: 'https://cdn.example.com/a.png' } }],
        },
      ],
    } as never,
    animation: {
      tracks: { 'char:x': [{ t: 0, value: 0, easing: 'ease' }, { t: 1, value: 40 }] },
      expressions: {},
    } as never,
    comps: {
      main: {
        id: 'main', name: 'Main', width: 1080, height: 1920, fps: 30,
        durationSeconds: 4, background: '#000', transparent: false, startFrame: 0,
      },
    } as never,
  };
}

describe('portable .motion pack/unpack', () => {
  it('round-trips scene, animation and comps', () => {
    const src = doc();
    const bytes = packPortableMotion(src);
    const opened = unpackPortableMotion(bytes);
    expect(opened.document.scene.nodes[0]!.id).toBe('char');
    expect(opened.document.animation).toEqual(src.animation);
    expect(opened.document.comps).toEqual(src.comps);
    expect(opened.missing).toEqual([]);
  });

  it('embeds named assets and lists them on unpack', () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const bytes = packPortableMotion(doc(), [
      { fileName: 'char.png', mime: 'image/png', bytes: png, nodeIds: ['char'] },
    ]);
    const opened = unpackPortableMotion(bytes);
    expect(opened.assets).toHaveLength(1);
    expect(opened.assets[0]!.fileName).toBe('char.png');
    expect(Array.from(opened.assets[0]!.bytes)).toEqual(Array.from(png));
  });

  it('opens a legacy monolithic JSON document', () => {
    const json = new TextEncoder().encode(JSON.stringify(doc()));
    const opened = unpackPortableMotion(json);
    expect(opened.document.scene.nodes[0]!.id).toBe('char');
  });

  it('rejects random bytes', () => {
    expect(() => unpackPortableMotion(new Uint8Array([1, 2, 3, 4]))).toThrow(PortableMotionError);
  });
});
