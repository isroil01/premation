import { findMissingAssets, isLocalFilesystemPath, relinkNodeSrc } from './missingAssets';
import type { EditorDocument } from '@core/api/cloudDocument';
import type { SceneNode } from '@core/types';

function doc(src: string): EditorDocument {
  const layer: SceneNode = {
    id: 'char',
    name: 'Character',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 't', type: 'Transform', props: { src } }],
  };
  return {
    version: '1.6.0',
    scene: { version: '1.0.0', nodes: [layer] },
    animation: { tracks: {}, expressions: {} } as never,
  };
}

describe('isLocalFilesystemPath', () => {
  it('detects Windows, UNC and file URLs', () => {
    expect(isLocalFilesystemPath('C:\\Users\\me\\x.png')).toBe(true);
    expect(isLocalFilesystemPath('D:/art/x.png')).toBe(true);
    expect(isLocalFilesystemPath('\\\\nas\\share\\x.png')).toBe(true);
    expect(isLocalFilesystemPath('file:///Users/me/x.png')).toBe(true);
    expect(isLocalFilesystemPath('/Users/me/x.png')).toBe(true);
  });

  it('leaves portable sources alone', () => {
    expect(isLocalFilesystemPath('https://cdn.example.com/x.png')).toBe(false);
    expect(isLocalFilesystemPath('/files/abc')).toBe(false);
    expect(isLocalFilesystemPath('assets/char.png')).toBe(false);
  });
});

describe('findMissingAssets', () => {
  it('flags local paths and blob URLs, not https', () => {
    expect(findMissingAssets(doc('https://cdn.example.com/a.png'))).toEqual([]);
    expect(findMissingAssets(doc('assets/a.png'))).toEqual([]);
    expect(findMissingAssets(doc('blob:https://app/uuid'))[0]?.reason).toBe('blob');
    expect(findMissingAssets(doc('C:\\Users\\me\\a.png'))[0]?.reason).toBe('local-path');
  });
});

describe('relinkNodeSrc', () => {
  it('rewrites the source', () => {
    const d = doc('C:\\old.png');
    expect(relinkNodeSrc(d, 'char', 'https://cdn.example.com/new.png')).toBe(true);
    expect(findMissingAssets(d)).toEqual([]);
  });
});
