import { bytesKey, duplicateFootage, footageByIdentity, identityKey, pathKey } from './footageDedupe';

type Item = Parameters<typeof identityKey>[0];

const item = (id: string, path: string, more: Partial<Item> = {}): Item => ({
  id,
  kind: 'footage',
  name: path.replace(/^.*[\\/]/, '') || 'file.png',
  path,
  missing: false,
  mediaType: 'image',
  fileBytes: 100,
  ...more,
});

describe('pathKey', () => {
  it('treats Windows paths as one file regardless of case and separator', () => {
    expect(pathKey('C:\\Footage\\Giraffe.JPG')).toBe(pathKey('c:/footage/giraffe.jpg'));
    expect(pathKey('\\\\nas\\share\\a.mov')).toBe(pathKey('//NAS/share/A.mov'));
  });

  it('keeps case on POSIX paths', () => {
    expect(pathKey('/Users/me/A.png')).not.toBe(pathKey('/Users/me/a.png'));
    expect(pathKey('/Users/me/clips/')).toBe('/Users/me/clips');
  });
});

describe('identityKey', () => {
  it('is the path when there is one, else the name and exact size', () => {
    expect(identityKey(item('a', 'C:\\x\\a.png'))).toBe('c:/x/a.png');
    expect(identityKey(item('b', '', { name: 'Giraffe.jpg', fileBytes: 2048 }))).toBe(bytesKey('giraffe.jpg', 2048));
    expect(bytesKey('a.png', 0)).toBeNull();
  });

  it('never merges missing files, models or non-footage', () => {
    expect(identityKey(item('gone', '/x/a.png', { missing: true }))).toBeNull();
    expect(identityKey(item('model', '/x/m.glb', { mediaType: 'model' }))).toBeNull();
    expect(identityKey(item('comp', '/x/c', { kind: 'composition' }))).toBeNull();
  });
});

describe('footageByIdentity', () => {
  it('maps each file to the first item imported from it', () => {
    const map = footageByIdentity([item('item_1', 'C:\\a\\giraffe.jpg'), item('item_2', 'C:\\A\\giraffe.jpg')]);
    expect(map.get(pathKey('c:/a/giraffe.jpg'))).toBe('item_1');
    expect(map.size).toBe(1);
  });
});

describe('duplicateFootage', () => {
  it('keeps the first item of a file and lists the later copies', () => {
    const groups = duplicateFootage([
      item('item_1', 'C:\\pics\\giraffe.jpg'),
      item('item_2', 'C:\\pics\\giraffe.jpg'),
      item('item_3', 'c:/pics/GIRAFFE.jpg'),
      item('item_4', 'C:\\pics\\zebra.jpg'),
    ]);
    expect(groups).toEqual([{ key: 'c:/pics/giraffe.jpg', keep: 'item_1', remove: ['item_2', 'item_3'] }]);
  });

  it('groups path-less drops by name and size, and keeps different sizes apart', () => {
    const groups = duplicateFootage([
      item('d1', '', { name: 'giraffe.jpg', fileBytes: 500 }),
      item('d2', '', { name: 'giraffe.jpg', fileBytes: 500 }),
      item('d3', '', { name: 'giraffe.jpg', fileBytes: 501 }),
    ]);
    expect(groups.map((g) => [g.keep, g.remove])).toEqual([['d1', ['d2']]]);
  });

  it('finds nothing when every file is imported once', () => {
    expect(duplicateFootage([item('a', '/a.png'), item('b', '/b.png')])).toEqual([]);
  });
});
