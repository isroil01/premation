import { baseName, flattenMediaRoots, flattenMediaTree, isMediaFile, mediaKindOf, sortEntries, type DirEntry } from './mediaBrowserTree';

const dir = (name: string, path = `/root/${name}`): DirEntry => ({ name, path, kind: 'dir' });
const file = (name: string, path = `/root/${name}`): DirEntry => ({ name, path, kind: 'file', size: 10 });

describe('mediaBrowserTree', () => {
  it('recognises media by extension and classes it', () => {
    expect(isMediaFile('a.MP4')).toBe(true);
    expect(isMediaFile('notes.txt')).toBe(false);
    expect(mediaKindOf('a.mov')).toBe('video');
    expect(mediaKindOf('a.wav')).toBe('audio');
    expect(mediaKindOf('a.png')).toBe('image');
    expect(mediaKindOf('a.doc')).toBeNull();
  });

  it('lists folders first, drops non-media, sorts naturally', () => {
    const out = sortEntries([file('clip 10.mp4'), file('readme.txt'), dir('b'), file('clip 2.mp4'), dir('A')]);
    expect(out.map((e) => e.name)).toEqual(['A', 'b', 'clip 2.mp4', 'clip 10.mp4']);
  });

  it('takes the base name across separators', () => {
    expect(baseName('C:\\Footage\\Day 1\\')).toBe('Day 1');
    expect(baseName('/Volumes/Cam/take.mov')).toBe('take.mov');
  });

  it('flattens only expanded, listed folders and marks pending ones', () => {
    const root = [dir('shots'), file('logo.png'), dir('audio')];
    const listings = new Map<string, DirEntry[]>([
      ['/root/shots', [file('b.mp4', '/root/shots/b.mp4'), file('a.mp4', '/root/shots/a.mp4')]],
    ]);
    const rows = flattenMediaTree(root, new Set(['/root/shots', '/root/audio']), listings, new Set(['/root/audio']));
    expect(rows.map((r) => `${r.depth}:${r.entry.name}`)).toEqual(['0:audio', '0:shots', '1:a.mp4', '1:b.mp4', '0:logo.png']);
    expect(rows[0]!.loading).toBe(true);
    expect(rows[1]!.expanded).toBe(true);
    expect(rows[4]!.expanded).toBe(false);
  });

  it('lists several added folders side by side, each with its own contents', () => {
    const listings = new Map<string, DirEntry[] | null>([
      ['/root', [file('logo.png'), dir('shots')]],
      ['/root/shots', [file('a.mp4', '/root/shots/a.mp4')]],
      ['/renders', null],
      ['/music', [file('song.wav', '/music/song.wav')]],
    ]);
    const rows = flattenMediaRoots(['/root', '/renders', '/music'], new Set(['/root', '/root/shots', '/renders']), listings, new Set());
    expect(rows.map((r) => `${r.depth}:${r.entry.name}${r.root ? '*' : ''}`)).toEqual([
      '0:root*', '1:shots', '2:a.mp4', '1:logo.png', '0:renders*', '0:music*',
    ]);
    expect(rows[4]!.unreadable).toBe(true);
    expect(rows[5]!.expanded).toBe(false);
  });
});
